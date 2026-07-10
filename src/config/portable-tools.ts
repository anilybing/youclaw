// [XJC-PATCH] new file — T-E2 便携工具平台子目录 + manifest 校验（实现自 src/routes/health.ts 迁出）
/**
 * Portable Tools Directory — 新版工具安装到 XiaoJuClawRuntime/tools/ 下，
 * 与 XiaoJuClawData（数据库、密钥、聊天、工作区）物理分离。
 * 旧 U 盘的 XiaoJuClawData/tools/ 仅作为只读兼容回退。
 *
 * 目录布局（v2 平台子目录，兼容 v1 扁平结构）：
 *   tools/<platformKey>/<tool>/   ← 优先：多平台共用一个 U 盘数据目录
 *   tools/<tool>/                 ← 回退：旧扁平布局（兼容存量 U 盘）
 *   tools/manifest.json           ← 工具清单与版本记录
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import appConfig from '../../app.config.ts'
import { getPaths, isPortableMode } from './paths.ts'
import { getLogger } from '../logger/index.ts'

// ---------------------------------------------------------------------------
// 平台标识
// ---------------------------------------------------------------------------

/**
 * 平台键：'win-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64'
 * 其他组合回退为 `${platform}-${arch}`（如 linux-arm64、win32-arm64）
 */
export function getPlatformKey(): string {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  return `${platform}-${arch}`
}

// ---------------------------------------------------------------------------
// 目录解析
// ---------------------------------------------------------------------------

/** 支持的便携工具 bin 子路径（git 有 cmd/、bin/ 两种布局，平台子目录与扁平均扫描） */
const PORTABLE_TOOL_BIN_SUBPATHS: ReadonlyArray<readonly string[]> = [
  ['bun'],
  ['git', 'cmd'],
  ['git', 'bin'],
  ['node'],
  ['uv'],
  ['python'],
]

/**
 * 获取首选工具根目录（新版便携为 XiaoJuClawRuntime/tools/）。
 * @param toolsDirOverride 测试注入用，生产代码不传
 */
export function getPortableToolsDir(toolsDirOverride?: string): string {
  const toolsDir = toolsDirOverride ?? getPaths().tools
  mkdirSync(toolsDir, { recursive: true })
  return toolsDir
}

function getReadableToolsDirs(
  toolsDirOverride?: string,
  legacyToolsDirOverride?: string,
): string[] {
  const primary = getPortableToolsDir(toolsDirOverride)
  const legacy = legacyToolsDirOverride
    ?? (toolsDirOverride ? null : getPaths().legacyTools)
  if (!legacy) return [primary]
  const primaryPath = resolve(primary)
  const legacyPath = resolve(legacy)
  const samePath = process.platform === 'win32'
    ? primaryPath.toLowerCase() === legacyPath.toLowerCase()
    : primaryPath === legacyPath
  if (samePath) return [primary]
  return [primary, legacy]
}

/**
 * 获取特定工具的旧扁平布局目录 tools/<tool>（非便携模式的安装目标，维持既有行为）。
 * 便携模式的安装目标请用 getPortableToolInstallDir（T-E3 起切换到平台子目录）。
 */
export function getPortableToolDir(toolName: string, toolsDirOverride?: string): string {
  const dir = resolve(getPortableToolsDir(toolsDirOverride), toolName)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 获取特定工具的【安装目标】目录（T-E3）：
 * - 便携模式（isPortableMode()）→ tools/<platformKey>/<tool>（U 盘平台子目录，多平台共用一个 U 盘）
 * - 非便携模式 → 维持既有扁平 tools/<tool>（主机数据目录安装）
 * 目录不存在时自动创建。
 */
export function getPortableToolInstallDir(toolName: string, toolsDirOverride?: string): string {
  if (!isPortableMode()) return getPortableToolDir(toolName, toolsDirOverride)
  const dir = resolve(getPortableToolsDir(toolsDirOverride), getPlatformKey(), toolName)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 判断某个可执行文件路径是否位于便携 tools 目录内（env-check 的 source 标注用）。
 * Windows 下 path.relative 已做大小写不敏感比较；跨盘符时 relative 返回绝对路径，判为 false。
 */
export function isPathInPortableTools(
  filePath: string | null | undefined,
  toolsDirOverride?: string,
  legacyToolsDirOverride?: string,
): boolean {
  if (!filePath) return false
  try {
    return getReadableToolsDirs(toolsDirOverride, legacyToolsDirOverride).some((toolsDir) => {
      const rel = relative(toolsDir, resolve(filePath))
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  } catch {
    return false
  }
}

/**
 * 解析特定工具的【读取】目录：优先平台子目录 tools/<platformKey>/<tool>，
 * 不存在则回退旧扁平 tools/<tool>；都不存在返回 null
 */
export function resolvePortableToolDir(
  toolName: string,
  toolsDirOverride?: string,
  legacyToolsDirOverride?: string,
): string | null {
  for (const toolsDir of getReadableToolsDirs(toolsDirOverride, legacyToolsDirOverride)) {
    const platformDir = resolve(toolsDir, getPlatformKey(), toolName)
    if (existsSync(platformDir)) return platformDir
    const flatDir = resolve(toolsDir, toolName)
    if (existsSync(flatDir)) return flatDir
  }
  return null
}

// ---------------------------------------------------------------------------
// PATH 注入
// ---------------------------------------------------------------------------

export interface EnsurePortableToolsInPathOptions {
  /** 测试注入用：覆盖首选 tools 根目录（默认 getPaths().tools） */
  toolsDirOverride?: string
  /** 测试注入用：覆盖旧 XiaoJuClawData/tools 回退目录 */
  legacyToolsDirOverride?: string
  /** 测试注入用：覆盖环境变量对象（默认 process.env），避免测试污染真实 PATH */
  env?: Record<string, string | undefined>
}

/** PATH 条目归一化：去尾部斜杠；Windows 下大小写不敏感 */
function normalizePathEntry(entry: string): string {
  const trimmed = entry.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** 进程内累计注入到真实 process.env.PATH 的便携路径（测试用 env 覆盖不计入），供启动日志汇报 */
const injectedIntoProcessEnv: string[] = []

/** 返回本进程迄今为止注入到 process.env.PATH 的便携工具路径（按注入顺序） */
export function getInjectedPortablePaths(): string[] {
  return [...injectedIntoProcessEnv]
}

/**
 * 把便携工具目录加到 PATH 环境变量前面，
 * 这样 which() 和 execSync 都能优先找到 U 盘上的工具。
 *
 * 注入顺序：平台子目录路径在前、扁平路径次之、原 PATH 最后；
 * 已在 PATH 中的目录不重复注入。
 * 执行时会读取 tools/manifest.json 做版本校验，低于期望版本逐条 logger.warn。
 *
 * @returns 本次实际注入的路径数组（便于日志与测试）
 */
export function ensurePortableToolsInPath(options: EnsurePortableToolsInPathOptions = {}): string[] {
  const { toolsDirOverride, legacyToolsDirOverride, env = process.env } = options
  const toolsDirs = getReadableToolsDirs(toolsDirOverride, legacyToolsDirOverride)
  const sep = process.platform === 'win32' ? ';' : ':'
  const currentPath = env.PATH || ''
  const seen = new Set(currentPath.split(sep).filter(Boolean).map(normalizePathEntry))

  const platformKey = getPlatformKey()
  const injected: string[] = []
  const collect = (dir: string): void => {
    if (!existsSync(dir)) return
    const key = normalizePathEntry(dir)
    if (seen.has(key)) return
    seen.add(key)
    injected.push(dir)
  }

  // 新 Runtime 根优先，旧 Data/tools 根回退；每个根内仍保持平台子目录优先于扁平布局。
  for (const toolsDir of toolsDirs) {
    for (const subpath of PORTABLE_TOOL_BIN_SUBPATHS) {
      collect(resolve(toolsDir, platformKey, ...subpath))
    }
    for (const subpath of PORTABLE_TOOL_BIN_SUBPATHS) {
      collect(resolve(toolsDir, ...subpath))
    }
  }

  if (injected.length > 0) {
    env.PATH = currentPath ? injected.join(sep) + sep + currentPath : injected.join(sep)
    if (env === (process.env as Record<string, string | undefined>)) {
      injectedIntoProcessEnv.push(...injected)
    }
  }

  // manifest 版本校验：低于期望版本的工具逐条告警（manifest 缺失/损坏时静默跳过）
  const manifest = readToolsManifest(toolsDirOverride, legacyToolsDirOverride)
  if (manifest) {
    for (const warning of checkManifestVersions(manifest)) {
      safeWarn(warning.message)
    }
  }

  return injected
}

// ---------------------------------------------------------------------------
// Manifest（tools/manifest.json）
// ---------------------------------------------------------------------------

export interface ToolsManifestEntry {
  name: string
  version: string
  dir: string
  sha256?: string
}

export interface ToolsManifest {
  schemaVersion: 1
  platform: string
  tools: ToolsManifestEntry[]
  createdAt: string
}

export interface ManifestVersionWarning {
  name: string
  current: string
  expected: string
  message: string
}

/**
 * 读取 tools/manifest.json；文件不存在或解析/结构校验失败时返回 null（不抛错）
 */
export function readToolsManifest(
  toolsDirOverride?: string,
  legacyToolsDirOverride?: string,
): ToolsManifest | null {
  for (const toolsDir of getReadableToolsDirs(toolsDirOverride, legacyToolsDirOverride)) {
    try {
      const manifestPath = resolve(toolsDir, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      if (isToolsManifest(parsed)) return parsed
    } catch {
      // A damaged primary manifest must not block the legacy fallback.
    }
  }
  return null
}

/** 写入 tools/manifest.json（覆盖写，pretty JSON，与 make-usb-payload.ps1 产物格式一致） */
export function writeToolsManifest(manifest: ToolsManifest, toolsDirOverride?: string): void {
  const manifestPath = resolve(getPortableToolsDir(toolsDirOverride), 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

/**
 * 合并写入单个工具条目（T-E3 安装成功后调用）：
 * 读旧 manifest（缺失/损坏时新建骨架），按 name 覆盖或追加该条目后写回。
 * entry.dir 可传绝对安装路径，会归一化为相对 tools/ 的正斜杠路径（与 U 盘 payload 脚本一致）。
 */
export function upsertToolsManifestEntry(entry: ToolsManifestEntry, toolsDirOverride?: string): ToolsManifest {
  const toolsDir = getPortableToolsDir(toolsDirOverride)
  const normalized: ToolsManifestEntry = { ...entry, dir: normalizeManifestDir(entry.dir, toolsDir) }
  const manifest: ToolsManifest = readToolsManifest(toolsDirOverride) ?? {
    schemaVersion: 1,
    platform: getPlatformKey(),
    tools: [],
    createdAt: new Date().toISOString(),
  }
  const index = manifest.tools.findIndex((tool) => tool.name === normalized.name)
  if (index >= 0) manifest.tools[index] = normalized
  else manifest.tools.push(normalized)
  writeToolsManifest(manifest, toolsDirOverride)
  return manifest
}

/** manifest 的 dir 统一为相对 tools/ 的正斜杠路径；tools/ 之外的绝对路径原样保留（仅换正斜杠） */
function normalizeManifestDir(dir: string, toolsDir: string): string {
  if (!isAbsolute(dir)) return dir.replaceAll('\\', '/')
  const rel = relative(toolsDir, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return dir.replaceAll('\\', '/')
  return rel.replaceAll('\\', '/')
}

function isToolsManifest(value: unknown): value is ToolsManifest {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== 1) return false
  if (typeof obj.platform !== 'string') return false
  if (typeof obj.createdAt !== 'string') return false
  if (!Array.isArray(obj.tools)) return false
  return obj.tools.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false
    const tool = entry as Record<string, unknown>
    return (
      typeof tool.name === 'string' &&
      typeof tool.version === 'string' &&
      typeof tool.dir === 'string' &&
      (tool.sha256 === undefined || typeof tool.sha256 === 'string')
    )
  })
}

/** 期望版本表：读取 app.config.ts 的 appConfig.tools（只读，不修改该文件） */
export function getExpectedToolVersions(): Record<string, string> {
  return {
    bun: appConfig.tools.bun.version,
    git: appConfig.tools.git.version,
    uv: appConfig.tools.uv.version,
  }
}

/** 版本比较（忽略前导 v，按数字段逐段比较，缺段补 0）：a<b → -1，a==b → 0，a>b → 1 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.trim().replace(/^v/i, '').split('.').map((seg) => {
      const n = parseInt(seg, 10)
      return Number.isNaN(n) ? 0 : n
    })
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/**
 * 将 manifest 中记录的工具版本与期望版本表比较，低于期望的返回警告列表。
 * @param manifest readToolsManifest() 的结果（null 时返回空列表）
 * @param expected 期望版本表（工具名 → 版本），默认取 app.config.ts 的 appConfig.tools
 */
export function checkManifestVersions(
  manifest: ToolsManifest | null,
  expected: Record<string, string> = getExpectedToolVersions(),
): ManifestVersionWarning[] {
  if (!manifest) return []
  const warnings: ManifestVersionWarning[] = []
  for (const tool of manifest.tools) {
    const expectedVersion = expected[tool.name]
    if (!expectedVersion) continue
    if (compareVersions(tool.version, expectedVersion) < 0) {
      warnings.push({
        name: tool.name,
        current: tool.version,
        expected: expectedVersion,
        message: `[portable-tools] ${tool.name} 版本过低：manifest=${tool.version} < 期望=${expectedVersion}（建议更新 U 盘工具）`,
      })
    }
  }
  return warnings
}

/** logger 可能尚未初始化（如 health.ts 模块加载早期），失败时静默降级 */
function safeWarn(message: string): void {
  try {
    getLogger().warn({ category: 'portable-tools' }, message)
  } catch {
    /* logger not initialized yet */
  }
}
