// [XJC-PATCH] new file — T-E2 便携工具平台子目录 + manifest 校验（实现自 src/routes/health.ts 迁出）
/**
 * Portable Tools Directory — 所有工具安装到 XiaoJuClawData/tools/ 下
 * 这样 U 盘拔走换电脑不需要重新安装（"U 盘即环境"）
 *
 * 目录布局（v2 平台子目录，兼容 v1 扁平结构）：
 *   tools/<platformKey>/<tool>/   ← 优先：多平台共用一个 U 盘数据目录
 *   tools/<tool>/                 ← 回退：旧扁平布局（兼容存量 U 盘）
 *   tools/manifest.json           ← 工具清单与版本记录
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import appConfig from '../../app.config.ts'
import { getPaths } from './paths.ts'
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
 * 获取便携工具根目录（XiaoJuClawData/tools/）
 * @param toolsDirOverride 测试注入用，生产代码不传
 */
export function getPortableToolsDir(toolsDirOverride?: string): string {
  const toolsDir = toolsDirOverride ?? resolve(getPaths().data, 'tools')
  mkdirSync(toolsDir, { recursive: true })
  return toolsDir
}

/**
 * 获取特定工具的便携【安装目标】目录。
 * 注意：当前仍指向旧扁平布局 tools/<tool>（与既有 install-tool 行为一致），
 * 安装目标切换到平台子目录属后续 T-E3 范围。
 */
export function getPortableToolDir(toolName: string, toolsDirOverride?: string): string {
  const dir = resolve(getPortableToolsDir(toolsDirOverride), toolName)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 解析特定工具的【读取】目录：优先平台子目录 tools/<platformKey>/<tool>，
 * 不存在则回退旧扁平 tools/<tool>；都不存在返回 null
 */
export function resolvePortableToolDir(toolName: string, toolsDirOverride?: string): string | null {
  const toolsDir = getPortableToolsDir(toolsDirOverride)
  const platformDir = resolve(toolsDir, getPlatformKey(), toolName)
  if (existsSync(platformDir)) return platformDir
  const flatDir = resolve(toolsDir, toolName)
  if (existsSync(flatDir)) return flatDir
  return null
}

// ---------------------------------------------------------------------------
// PATH 注入
// ---------------------------------------------------------------------------

export interface EnsurePortableToolsInPathOptions {
  /** 测试注入用：覆盖 tools 根目录（默认 XiaoJuClawData/tools/） */
  toolsDirOverride?: string
  /** 测试注入用：覆盖环境变量对象（默认 process.env），避免测试污染真实 PATH */
  env?: Record<string, string | undefined>
}

/** PATH 条目归一化：去尾部斜杠；Windows 下大小写不敏感 */
function normalizePathEntry(entry: string): string {
  const trimmed = entry.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
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
  const { toolsDirOverride, env = process.env } = options
  const toolsDir = getPortableToolsDir(toolsDirOverride)
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

  // 1) 平台子目录优先：tools/<platformKey>/{bun, git/cmd, git/bin, node, uv, python}
  for (const subpath of PORTABLE_TOOL_BIN_SUBPATHS) {
    collect(resolve(toolsDir, platformKey, ...subpath))
  }
  // 2) 旧扁平布局次之（兼容存量 U 盘）：tools/{bun, git/cmd, git/bin, node, uv, python}
  for (const subpath of PORTABLE_TOOL_BIN_SUBPATHS) {
    collect(resolve(toolsDir, ...subpath))
  }

  if (injected.length > 0) {
    env.PATH = currentPath ? injected.join(sep) + sep + currentPath : injected.join(sep)
  }

  // manifest 版本校验：低于期望版本的工具逐条告警（manifest 缺失/损坏时静默跳过）
  const manifest = readToolsManifest(toolsDirOverride)
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
export function readToolsManifest(toolsDirOverride?: string): ToolsManifest | null {
  try {
    const manifestPath = resolve(getPortableToolsDir(toolsDirOverride), 'manifest.json')
    if (!existsSync(manifestPath)) return null
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    return isToolsManifest(parsed) ? parsed : null
  } catch {
    return null
  }
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
