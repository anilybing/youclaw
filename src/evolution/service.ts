// [XJC] 进化引擎桥（内置技能 evolution-engine 的系统托管层）
//
// 设计目标：把技能宣传的「无感自动进化」真正实现，且学习环路零 token——
//   1) 事件驱动：订阅 EventBus 的 complete/error 事件，直接调用本地 Python 引擎
//      记录成功/失败（不经过 LLM，不产生任何 token 消耗）；
//   2) 行为闭环：引擎产出的「行为提示」缓存在内存，由 runtime 注入 agent 上下文
//      （<evolution_hint>，每轮仅几十 token，且仅在开关开启时）；
//   3) 用户开关：settings.evolution.enabled（默认关闭），设置页可随时开关。
//
// 引擎代码物料化：内置技能目录（安装版为只读 resources）在启用时复制到
// `<数据目录>/evolution-engine/`，数据（data/、AGENTS.md）都落在该可写目录内。
// 引擎为纯 stdlib Python，零联网零子进程（已安全审查）；python 缺失时功能静默降级。

import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/paths.ts'
import { resolvePortableToolDir } from '../config/portable-tools.ts'
import { getLogger } from '../logger/index.ts'
import { getStoredSettings } from '../settings/manager.ts'
import type { EventBus } from '../events/index.ts'

const CLI_TIMEOUT_MS = 15_000
const HINT_TTL_MS = 30 * 60 * 1000
/** 引擎返回的「无数据」占位提示，不值得注入上下文 */
const EMPTY_HINT_MARKERS = ['数据不足', '暂无']
/** 每记录 N 条结果自动触发一次 evolve（策略提案→covenant→规则落 AGENTS.md）。
 *  此前 evolve() 从不被调用，策略池长期为空、规则闭环 dormant——这是"自动进化"的缺失一环。 */
const EVOLVE_EVERY_RECORDS = 10
/** 注入 prompt 的规则块长度上限（规则文件整份重写、活跃规则在前，截头即可） */
const RULES_MAX_CHARS = 1200

export interface EvolutionStatus {
  enabled: boolean
  pythonOk: boolean
  materialized: boolean
  /** summary --json 的关键字段（拿不到时为 null） */
  stage: string | null
  records: number
  successes: number
  failures: number
  activeStrategies: number
  activeRules: number
  /** 引擎已学会的活跃规则文本（截断后），null=尚无规则/开关关闭——设置页可见"它学到了什么" */
  rulesText: string | null
}

function engineHome(): string {
  return resolve(getPaths().data, 'evolution-engine')
}

function builtinSkillDir(): string {
  return resolve(getPaths().skills, 'evolution-engine')
}

class EvolutionService {
  private pythonCmd: string | null | undefined // undefined=未探测 null=不可用
  private queue: Promise<unknown> = Promise.resolve()
  private hintCache = new Map<string, { hint: string; at: number }>()
  private warnedDisabled = false
  private materializedOk = false // 进程级缓存：成功物料化一次后不再重复整目录复制
  private recordsSinceEvolve = 0 // 自动 evolve 计数（进程级；重启归零只是推迟一轮，无害）
  private rulesCache: { text: string; mtimeMs: number } | null = null // AGENTS.md 规则 mtime 缓存

  isEnabled(): boolean {
    try {
      return getStoredSettings().evolution.enabled === true
    } catch {
      return false
    }
  }

  /** 把内置技能里的引擎代码复制到可写运行目录（幂等；不触碰 data/）。每进程只做一次。 */
  ensureMaterialized(): boolean {
    if (this.materializedOk) return true
    try {
      const src = builtinSkillDir()
      if (!existsSync(resolve(src, 'evolve.py'))) {
        this.materializedOk = existsSync(resolve(engineHome(), 'evolve.py'))
        return this.materializedOk
      }
      const dest = engineHome()
      mkdirSync(resolve(dest, 'engine'), { recursive: true })
      // 代码文件覆盖复制（跟随应用升级），data/ 由引擎自管不动
      cpSync(resolve(src, 'evolve.py'), resolve(dest, 'evolve.py'))
      cpSync(resolve(src, 'engine'), resolve(dest, 'engine'), { recursive: true })
      this.materializedOk = true
      return true
    } catch (err) {
      getLogger().warn({ error: String(err), category: 'evolution' }, 'Evolution engine materialize failed')
      return false
    }
  }

  private detectPython(): string | null {
    if (this.pythonCmd !== undefined) return this.pythonCmd
    // 候选顺序：便携工具目录的绝对路径优先（U 盘版自带嵌入式 Python 3.12，
    // 即使 PATH 注入时序不齐/被外部覆盖也能命中——引擎为纯 stdlib，嵌入式发行版够用），
    // 其次 PATH 上的 python/python3。
    const candidates: string[] = []
    try {
      const portableDir = resolvePortableToolDir('python')
      if (portableDir) {
        candidates.push(resolve(portableDir, process.platform === 'win32' ? 'python.exe' : 'bin/python3'))
      }
    } catch { /* 便携目录解析失败走 PATH */ }
    candidates.push('python', 'python3')

    for (const cmd of candidates) {
      try {
        const probe = Bun.spawnSync([cmd, '--version'], { stdout: 'pipe', stderr: 'pipe' })
        if (probe.exitCode === 0) {
          this.pythonCmd = cmd
          return cmd
        }
      } catch { /* try next */ }
    }
    this.pythonCmd = null
    return null
  }

  /** 串行执行引擎 CLI（引擎按进程读改写 JSON，并发会互相覆盖） */
  private runCli(args: string[]): Promise<{ ok: boolean; stdout: string }> {
    const task = this.queue.then(async () => {
      const python = this.detectPython()
      if (!python) return { ok: false, stdout: '' }
      if (!this.ensureMaterialized()) return { ok: false, stdout: '' }
      try {
        const proc = Bun.spawn([python, 'evolve.py', ...args], {
          cwd: engineHome(),
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeout = setTimeout(() => { try { proc.kill() } catch { /* 已退出 */ } }, CLI_TIMEOUT_MS)
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        clearTimeout(timeout)
        return { ok: exitCode === 0, stdout }
      } catch (err) {
        getLogger().warn({ error: String(err), args: args[0], category: 'evolution' }, 'Evolution CLI failed')
        return { ok: false, stdout: '' }
      }
    })
    // 队列吞错前进，单次失败不阻塞后续
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * 记录一次任务结果（事件驱动入口，零 token）。
   * taskType 用 agentId（如 office-assistant），引擎按类型积累策略。
   */
  /** 拉取并缓存某类型的行为提示（零 token 本地 CLI，走串行队列） */
  private async refreshHint(taskType: string): Promise<void> {
    const hint = await this.runCli(['hint', taskType])
    if (!hint.ok) return
    const text = hint.stdout.trim()
    const useless = !text || EMPTY_HINT_MARKERS.some((m) => text.includes(m))
    if (useless) this.hintCache.delete(taskType)
    else this.hintCache.set(taskType, { hint: text, at: Date.now() })
  }

  /**
   * [XJC] 启动预热：hint 缓存是进程内存（30min TTL），此前应用重启后全部丢失——
   * 引擎已积累的经验在重启后的首轮对话缺席，直到该员工下一次任务完成才恢复。
   * 桥接初始化时对全部员工串行预热（零 token；引擎无该类型数据时自然为空，无副作用）。
   */
  async warmHints(taskTypes: string[]): Promise<void> {
    if (!this.isEnabled()) return
    if (this.detectPython() === null) return
    for (const taskType of taskTypes) {
      if (!taskType) continue
      try {
        await this.refreshHint(taskType)
      } catch { /* 单个失败不阻塞其余 */ }
    }
    getLogger().info({ agents: taskTypes.length, warmed: this.hintCache.size, category: 'evolution' }, 'Evolution hints warmed at startup')
  }

  recordOutcome(taskType: string, result: 'success' | 'failure' | 'partial', context: Record<string, string> = {}): void {
    if (!this.isEnabled()) return
    if (!taskType) return
    void this.runCli(['record', taskType, result, JSON.stringify(context)])
      .then(async (res) => {
        if (!res.ok) {
          this.warnPythonOnce()
          return
        }
        // 记录后刷新该类型的行为提示缓存（同样零 token，本地 CLI）
        await this.refreshHint(taskType)
        // 自动进化：每 N 条记录跑一次 evolve（策略提案→covenant 审批→活跃规则写 AGENTS.md）。
        // 零 token 本地 CLI，走同一串行队列不与 record 并发；失败静默（下轮再试）。
        this.recordsSinceEvolve += 1
        if (this.recordsSinceEvolve >= EVOLVE_EVERY_RECORDS) {
          this.recordsSinceEvolve = 0
          const evolved = await this.runCli(['evolve'])
          if (evolved.ok) {
            this.rulesCache = null // 规则文件可能已更新，失效缓存
            getLogger().info({ category: 'evolution' }, 'Auto-evolve cycle completed')
          }
        }
      })
  }

  /** 供 runtime 注入上下文：同步读缓存，绝不 spawn（不增加对话时延） */
  getHintFor(taskType: string): string | null {
    if (!this.isEnabled()) return null
    const entry = this.hintCache.get(taskType)
    if (!entry) return null
    if (Date.now() - entry.at > HINT_TTL_MS) {
      this.hintCache.delete(taskType)
      return null
    }
    return entry.hint
  }

  async getStatus(): Promise<EvolutionStatus> {
    const enabled = this.isEnabled()
    const status: EvolutionStatus = {
      enabled,
      pythonOk: this.detectPython() !== null,
      materialized: existsSync(resolve(engineHome(), 'evolve.py')),
      stage: null,
      records: 0,
      successes: 0,
      failures: 0,
      activeStrategies: 0,
      activeRules: 0,
      rulesText: this.getRulesFor(),
    }
    if (!status.pythonOk) return status
    // 开着才物料化；关着但已物料化也允许查询（展示历史积累）
    if (!status.materialized && !enabled) return status
    const res = await this.runCli(['summary', '--json'])
    status.materialized = existsSync(resolve(engineHome(), 'evolve.py'))
    if (res.ok) {
      try {
        const summary = JSON.parse(res.stdout) as {
          sensor?: { records_count?: number; total_success?: number; total_failure?: number }
          evo_devo?: { stage?: string; active_strategies?: number }
          covenant?: { active_rules?: number }
        }
        status.records = Number(summary.sensor?.records_count ?? 0)
        status.successes = Number(summary.sensor?.total_success ?? 0)
        status.failures = Number(summary.sensor?.total_failure ?? 0)
        status.stage = summary.evo_devo?.stage ?? null
        status.activeStrategies = Number(summary.evo_devo?.active_strategies ?? 0)
        status.activeRules = Number(summary.covenant?.active_rules ?? 0)
      } catch { /* 输出异常按空处理 */ }
    }
    return status
  }

  private warnPythonOnce(): void {
    if (this.warnedDisabled) return
    this.warnedDisabled = true
    getLogger().warn({ category: 'evolution' }, 'Evolution engine unavailable (python missing or CLI failing); auto-learning is inactive')
  }

  /** 读取物料化目录里引擎生成的活跃规则（供状态页展示用，可选） */
  readGeneratedRules(): string {
    try {
      return readFileSync(resolve(engineHome(), 'AGENTS.md'), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * 供 runtime 注入 prompt 的活跃规则块（同步、mtime 缓存、长度封顶）。
   * 这是 covenant 闭环的"最后一公里"——引擎最硬的产出（审批通过的行为规则）
   * 此前从不进 prompt。开关关闭恒 null；文件缺失/为空 null。
   */
  getRulesFor(): string | null {
    if (!this.isEnabled()) return null
    const rulesPath = resolve(engineHome(), 'AGENTS.md')
    try {
      const mtimeMs = statSync(rulesPath).mtimeMs
      if (this.rulesCache && this.rulesCache.mtimeMs === mtimeMs) {
        return this.rulesCache.text || null
      }
      const raw = readFileSync(rulesPath, 'utf8').trim()
      const text = raw.length > RULES_MAX_CHARS ? `${raw.slice(0, RULES_MAX_CHARS)}\n…（规则过长已截断）` : raw
      this.rulesCache = { text, mtimeMs }
      return text || null
    } catch {
      // 文件不存在（引擎尚未产出规则）或读失败：缓存空结果避免每轮 stat 抛错开销
      this.rulesCache = { text: '', mtimeMs: -1 }
      return null
    }
  }
}

let singleton: EvolutionService | null = null

export function getEvolutionService(): EvolutionService {
  if (!singleton) singleton = new EvolutionService()
  return singleton
}

/**
 * 启动时接线：订阅 agent 完成/失败事件 → 零 token 记录。
 * complete.suppressOutbound（定时任务）同样计入——定时任务成败正是高价值学习信号。
 * 传入 listAgentIds 时启动预热各员工 hint 缓存（重启后首轮对话即有经验提示）。
 */
export function initEvolutionBridge(eventBus: EventBus, listAgentIds?: () => string[]): void {
  const service = getEvolutionService()
  if (listAgentIds) {
    // fire-and-forget：预热走串行队列，不阻塞启动
    void service.warmHints(listAgentIds()).catch(() => { /* 预热失败静默 */ })
  }
  eventBus.subscribe({ types: ['complete'] }, (event) => {
    if (event.type !== 'complete') return
    try {
      service.recordOutcome(event.agentId, 'success', { agent: event.agentId })
    } catch { /* 学习环路绝不影响主流程 */ }
  })
  eventBus.subscribe({ types: ['error'] }, (event) => {
    if (event.type !== 'error') return
    try {
      service.recordOutcome(event.agentId, 'failure', {
        agent: event.agentId,
        ...(event.errorCode ? { errorCode: String(event.errorCode) } : {}),
      })
    } catch { /* 同上 */ }
  })
  getLogger().info({ category: 'evolution' }, 'Evolution bridge wired (event-driven, zero-token learning loop)')
}
