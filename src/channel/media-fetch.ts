// [XJC] 出站远程媒体安全下载工具（SSRF 防护 + 大小上限 + 超时）
/**
 * 集中式远程媒体下载安全层。所有渠道出站媒体的 remote 分支都应经此模块：
 *
 * 1. {@link assertSafeRemoteUrl} —— 协议白名单（仅 http/https）+ 内网/环回/链路本地/
 *    保留网段/云元数据地址拦截。URL 主机为 IP 字面量时精确判网段；为域名时拦掉
 *    localhost、单标签和常见局域网/内部域名。
 * 2. {@link fetchRemoteMediaToBuffer} / {@link fetchRemoteMediaToFile} —— 先做 URL 校验，再带超时下载，并在
 *    「响应头声明」与「流式累计字节」两处双重限制大小，任一超限立即中止，避免整包
 *    读入内存/磁盘造成 DoS。
 *
 * ## 残余风险（有意不做的过度工程）
 * - **DNS rebinding**：域名首次解析为公网、下载时重解析为内网的攻击无法仅靠 URL 字面量
 *   拦截（需在建立连接后对已解析 IP 复核，成本高且依赖底层 socket）。此处只保证拦掉
 *   「URL 里直接写内网/元数据 IP 或内部主机名」这一最常见、最省事的攻击面。
 * - **重定向绕过**：下载使用 `redirect: 'error'`，任何 3xx 一律失败，从而杜绝
 *   「先跳公网、再 302 到内网」的绕过；代价是依赖跳转的媒体直链会下载失败。
 * - **已废弃的 IPv4-compatible IPv6（`::a.b.c.d`，无 `ffff`/NAT64 前缀）**：已覆盖
 *   IPv4-mapped(`::ffff:`)、IPv4-translated(`::ffff:0:`)、NAT64(`64:ff9b::`) 三种会真实
 *   路由的内嵌形态；纯 `::a.b.c.d` 早已废弃且现代栈通常不路由，未单独拦截。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** 无 content-length 时的默认下载超时（毫秒）。 */
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000

export interface FetchRemoteMediaOptions {
  /** 允许的最大字节数；响应头声明或实际累计超过即中止。 */
  maxBytes: number
  /** 整体下载超时（毫秒），含建连与流式读取。默认 {@link DEFAULT_MEDIA_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 注入的 fetch 实现（渠道可传各自的 this.fetchFn；默认全局 fetch）。 */
  fetchFn?: typeof fetch
}

export interface RemoteMedia {
  buffer: Buffer
  /** 从 URL 路径推断的文件名；无法推断时回退到 `media-<时间戳>`。 */
  fileName: string
}

export interface RemoteMediaFile {
  /** 从 URL 路径推断的文件名；无法推断时回退到 `media-<时间戳>`。 */
  fileName: string
  /** 实际写入目标文件的字节数。 */
  bytesWritten: number
}

/**
 * 校验远程媒体 URL 是否可安全下载：
 * - 仅允许 http/https；
 * - 主机是 IP 字面量（含被 WHATWG URL 归一化的十进制/十六进制写法、IPv4-mapped IPv6）时，
 *   拦截私有/环回/链路本地/保留网段与云元数据地址；
 * - 主机是域名时，拦截 `localhost`、单标签及常见局域网/内部域名。
 *
 * 校验通过返回解析后的 {@link URL}；否则抛出中文错误。
 */
export function assertSafeRemoteUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`无效的媒体 URL：${rawUrl}`)
  }

  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`不支持的媒体 URL 协议：${url.protocol}（仅允许 http/https）：${rawUrl}`)
  }

  // WHATWG URL 会把 IPv6 主机保留方括号，这里剥掉再判断；同时统一小写并去掉 DNS 尾点。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) {
    throw new Error(`媒体 URL 缺少主机名：${rawUrl}`)
  }

  const ipv4 = parseIpv4(host)
  if (ipv4) {
    if (isBlockedIpv4(ipv4)) {
      throw new Error(`拒绝下载指向内网/保留地址的媒体 URL：${rawUrl}`)
    }
    return url
  }

  if (host.includes(':')) {
    // 含冒号即视为 IPv6 字面量（域名不含冒号）。
    if (isBlockedIpv6(host)) {
      throw new Error(`拒绝下载指向内网/保留地址的媒体 URL：${rawUrl}`)
    }
    return url
  }

  if (isBlockedHostname(host)) {
    throw new Error(`拒绝下载指向本机/内网主机的媒体 URL：${rawUrl}`)
  }

  // 其余按域名处理：DNS rebinding 属已知残余风险（见文件头说明）。
  return url
}

/**
 * 安全下载远程媒体到内存 Buffer：SSRF 校验 → 带超时 fetch（禁重定向）→ 双重大小限制。
 */
export async function fetchRemoteMediaToBuffer(
  rawUrl: string,
  options: FetchRemoteMediaOptions,
): Promise<RemoteMedia> {
  const buffer = await withSafeRemoteResponse(
    rawUrl,
    options,
    (res, signal) => readCapped(res, options.maxBytes, rawUrl, signal),
  )
  return { buffer, fileName: inferMediaFileNameFromUrl(rawUrl) }
}

/**
 * 安全、流式地把远程媒体写入文件。先写同目录随机临时文件，完整下载且未超限后再原子改名；
 * 失败时删除临时文件，避免留下可被误用的半截产物。
 */
export async function fetchRemoteMediaToFile(
  rawUrl: string,
  destPath: string,
  options: FetchRemoteMediaOptions,
): Promise<RemoteMediaFile> {
  const bytesWritten = await withSafeRemoteResponse(
    rawUrl,
    options,
    (res, signal) => writeCappedToFile(res, destPath, options.maxBytes, rawUrl, signal),
  )
  return {
    fileName: inferMediaFileNameFromUrl(rawUrl),
    bytesWritten,
  }
}

/** 从 URL 路径推断文件名；无法推断时回退到 `media-<时间戳>`。 */
export function inferMediaFileNameFromUrl(rawUrl: string): string {
  try {
    const name = decodeURIComponent(basename(new URL(rawUrl).pathname))
    if (name) return name
  } catch {
    // 落到兜底名
  }
  return `media-${Date.now()}`
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

async function withSafeRemoteResponse<T>(
  rawUrl: string,
  options: FetchRemoteMediaOptions,
  consume: (res: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { maxBytes, timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('安全远程媒体下载：maxBytes 必须为正数')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('安全远程媒体下载：timeoutMs 必须为正数')
  }

  const url = assertSafeRemoteUrl(rawUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)
  timer.unref?.()

  try {
    let res: Response
    try {
      res = await fetchFn(url.href, { signal: controller.signal, redirect: 'error' })
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        throw new Error(`下载远程媒体超时（超过 ${timeoutMs}ms）：${rawUrl}`)
      }
      // redirect: 'error' 命中跳转会在此抛出（TypeError）
      throw new Error(`下载远程媒体失败：${rawUrl}（${err instanceof Error ? err.message : String(err)}）`)
    }

    if (!res.ok) {
      await cancelBody(res)
      throw new Error(`下载远程媒体失败（HTTP ${res.status}）：${rawUrl}`)
    }

    const declaredHeader = res.headers.get('content-length')
    const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelBody(res)
      throw new Error(
        `远程媒体大小 ${toMB(declared)}MB 超过上限 ${toMB(maxBytes)}MB，已取消下载：${rawUrl}`,
      )
    }

    try {
      return await consume(res, controller.signal)
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        throw new Error(`下载远程媒体超时（超过 ${timeoutMs}ms）：${rawUrl}`)
      }
      throw err
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 流式读取响应体并在累计超过 maxBytes 时立即中止（防无 content-length 绕过）。 */
async function readCapped(
  res: Response,
  maxBytes: number,
  rawUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = res.body
  if (!body) {
    return Buffer.alloc(0)
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal)
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`远程媒体大小超过上限 ${toMB(maxBytes)}MB，已中止下载：${rawUrl}`)
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已释放/已取消，忽略
    }
  }

  return Buffer.concat(chunks, total)
}

async function writeCappedToFile(
  res: Response,
  destPath: string,
  maxBytes: number,
  rawUrl: string,
  signal: AbortSignal,
): Promise<number> {
  await mkdir(dirname(destPath), { recursive: true })
  const tempPath = `${destPath}.part-${process.pid}-${randomUUID()}`
  const handle = await open(tempPath, 'wx')
  const reader = res.body?.getReader() ?? null
  let total = 0
  let closed = false

  try {
    if (reader) {
      for (;;) {
        const { done, value } = await readWithAbort(reader, signal)
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`远程媒体大小超过上限 ${toMB(maxBytes)}MB，已中止下载：${rawUrl}`)
        }
        await writeAll(handle, value)
      }
    }

    await handle.close()
    closed = true
    await rename(tempPath, destPath)
    return total
  } catch (err) {
    await reader?.cancel().catch(() => {})
    throw err
  } finally {
    try {
      reader?.releaseLock()
    } catch {
      // 已释放/已取消，忽略
    }
    if (!closed) {
      await handle.close().catch(() => {})
    }
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) {
      throw new Error('写入远程媒体临时文件失败')
    }
    offset += bytesWritten
  }
}

interface RemoteMediaReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
}

function readWithAbort(
  reader: RemoteMediaReader,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolveRead(result)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        rejectRead(err)
      },
    )
  })
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // 忽略取消错误
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function toMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function isBlockedHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // 常见 mDNS/局域网/云元数据内部域名；单标签主机名同样只可能依赖本机搜索域。
  if (!host.includes('.')) return true
  return [
    '.local',
    '.localdomain',
    '.lan',
    '.home',
    '.home.arpa',
    '.internal',
  ].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

/** 解析点分十进制 IPv4；非该形态返回 null。（十进制/十六进制整数写法已被 URL 解析器归一化为点分形式） */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number]
  if (octets.some((o) => o > 255)) return null
  return octets
}

/** 私有/环回/链路本地/保留 IPv4 网段判定。 */
function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets
  if (a === 0) return true // 0.0.0.0/8 「本网络」
  if (a === 10) return true // 10.0.0.0/8 私有
  if (a === 127) return true // 127.0.0.0/8 环回
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 运营商级 NAT
  if (a === 169 && b === 254) return true // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 私有
  if (a === 192 && b === 168) return true // 192.168.0.0/16 私有
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF 协议保留
  if (a === 192 && b === 0 && c === 2) return true // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 192.88.99.0/24 已废弃 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true // 224.0.0.0/4 组播 + 240.0.0.0/4 保留 + 255.255.255.255 广播
  return false
}

/** 私有/环回/链路本地 IPv6（及 IPv4-mapped）判定。入参为已去方括号、小写的主机名。 */
function isBlockedIpv6(host: string): boolean {
  if (host === '::1') return true // 环回
  if (host === '::') return true // 未指定地址

  // IPv4-mapped（::ffff:a.b.c.d）——WHATWG URL 归一化后多呈十六进制 hextet 形式（如
  // ::ffff:7f00:1、::ffff:a9fe:a9fe）。抽出内嵌 IPv4 复用 v4 判定，挡住用 mapped 形式
  // 伪装的内网/元数据地址。
  const mapped = extractMappedIpv4(host)
  if (mapped && isBlockedIpv4(mapped)) return true

  const firstGroup = host.split(':')[0] ?? ''
  const first = firstGroup === '' ? 0 : parseInt(firstGroup, 16)
  if (Number.isNaN(first)) return false
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 组播
  if (first >= 0xfc00 && first <= 0xfdff) return true // fc00::/7 唯一本地地址（ULA）
  if (first >= 0xfe80 && first <= 0xfebf) return true // fe80::/10 链路本地
  if (host.startsWith('2001:db8:') || host === '2001:db8::') return true // 文档保留网段
  return false
}

/**
 * 从「已知会内嵌 IPv4 的 IPv6 前缀」抽出末 32 位 IPv4，供 v4 网段判定复用：
 * - `::ffff:` IPv4-mapped；
 * - `::ffff:0:` IPv4-translated（RFC 8215/SIIT）；
 * - `64:ff9b::` NAT64 well-known 前缀（RFC 6052，在启用 NAT64 的网络会真实路由到内嵌 IPv4）。
 *
 * URL 归一化后 IPv4 多呈 `hi:lo` 十六进制两段（如 `a9fe:a9fe`），点分形式也一并支持。
 * 前缀按长度从长到短匹配，避免 `::ffff:0:` 被 `::ffff:` 抢先误配。
 */
function extractMappedIpv4(host: string): [number, number, number, number] | null {
  const prefixes = ['::ffff:0:', '64:ff9b::', '::ffff:']
  const prefix = prefixes.find((p) => host.startsWith(p))
  if (!prefix) return null
  const rest = host.slice(prefix.length)

  const dotted = parseIpv4(rest)
  if (dotted) return dotted

  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
    }
  }
  return null
}
