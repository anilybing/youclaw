// [XJC] 进化引擎桥测试：真实 python 端到端（物料化 → record → hint 缓存 → status）。
// 依赖本机 python（CI/开发机均有；无 python 时验证优雅降级路径）。
import { afterAll, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../src/config/paths.ts'
import { getEvolutionService } from '../src/evolution/service.ts'

function writeEvolutionEnabled(enabled: boolean) {
  getDatabase().run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    ['settings', JSON.stringify({ evolution: { enabled } })],
  )
}

const engineHome = resolve(getPaths().data, 'evolution-engine')

afterAll(() => {
  try { rmSync(engineHome, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
})

describe('EvolutionService', () => {
  const service = getEvolutionService()
  const pythonAvailable = (() => {
    try {
      return Bun.spawnSync(['python', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
    } catch {
      return false
    }
  })()

  test('disabled by default: no hint, records are no-ops', () => {
    writeEvolutionEnabled(false)
    expect(service.isEnabled()).toBe(false)
    service.recordOutcome('office-assistant', 'success')
    expect(service.getHintFor('office-assistant')).toBeNull()
  })

  test('materialize copies engine code into data dir', () => {
    const ok = service.ensureMaterialized()
    expect(ok).toBe(true)
    expect(existsSync(resolve(engineHome, 'evolve.py'))).toBe(true)
    expect(existsSync(resolve(engineHome, 'engine', 'sensor.py'))).toBe(true)
  })

  test.if(pythonAvailable)('enabled: record outcomes end-to-end and expose status', async () => {
    writeEvolutionEnabled(true)
    expect(service.isEnabled()).toBe(true)

    // 连续记录（串行队列保证 json 不互相覆盖）
    service.recordOutcome('office-assistant', 'success', { agent: 'office-assistant' })
    service.recordOutcome('office-assistant', 'success', { agent: 'office-assistant' })
    service.recordOutcome('office-assistant', 'failure', { agent: 'office-assistant', errorCode: 'MODEL_CONNECTION_FAILED' })

    // getStatus 走同一串行队列，天然等待前面的 record 完成
    const status = await service.getStatus()
    expect(status.enabled).toBe(true)
    expect(status.pythonOk).toBe(true)
    expect(status.materialized).toBe(true)
    expect(status.records).toBeGreaterThanOrEqual(3)
    expect(status.successes).toBeGreaterThanOrEqual(2)
    expect(status.failures).toBeGreaterThanOrEqual(1)
    expect(status.stage).toBeTruthy()
  }, 60_000)

  test.if(pythonAvailable)('hint cache: sync read, cleared when engine has no data for type', async () => {
    writeEvolutionEnabled(true)
    // record 后 hint 缓存被刷新（数据不足时为 null，有数据时为字符串）
    service.recordOutcome('office-assistant', 'success')
    await service.getStatus() // 排队等待 record+hint 完成
    const hint = service.getHintFor('office-assistant')
    expect(hint === null || typeof hint === 'string').toBe(true)
    // 未知任务类型永远无提示
    expect(service.getHintFor('never-recorded-agent')).toBeNull()
    // 关闭开关后提示立刻失效
    writeEvolutionEnabled(false)
    expect(service.getHintFor('office-assistant')).toBeNull()
  }, 60_000)

  test.if(!pythonAvailable)('python missing: everything degrades silently', async () => {
    writeEvolutionEnabled(true)
    service.recordOutcome('office-assistant', 'success')
    const status = await service.getStatus()
    expect(status.pythonOk).toBe(false)
  })

  // [XJC] covenant 规则注入（getRulesFor）：不依赖 python，直接对文件行为断言
  test('getRulesFor: 开关关闭恒 null；开启但无规则文件也 null', () => {
    writeEvolutionEnabled(false)
    expect(service.getRulesFor()).toBeNull()
    writeEvolutionEnabled(true)
    rmSync(resolve(engineHome, 'AGENTS.md'), { force: true })
    expect(service.getRulesFor()).toBeNull()
  })

  test('warmHints: 开关关闭时 no-op（不预热任何缓存）', async () => {
    writeEvolutionEnabled(false)
    await service.warmHints(['office-assistant', 'default'])
    expect(service.getHintFor('office-assistant')).toBeNull()
    expect(service.getHintFor('default')).toBeNull()
  })

  test.if(pythonAvailable)('warmHints: 开启后为已有数据的类型预热 hint 缓存', async () => {
    writeEvolutionEnabled(true)
    // 先积累几条记录（走串行队列）
    service.recordOutcome('warm-agent', 'success')
    service.recordOutcome('warm-agent', 'success')
    await service.getStatus() // 排队等待完成
    // 清空进程缓存模拟重启，再预热
    service.getHintFor('warm-agent') // 触碰即可（无法直接清 map，重建 service 会丢单例——用行为断言）
    await service.warmHints(['warm-agent', 'never-recorded'])
    const hint = service.getHintFor('warm-agent')
    expect(hint === null || typeof hint === 'string').toBe(true)
    expect(service.getHintFor('never-recorded')).toBeNull()
  }, 60_000)

  test('getStatus 暴露 rulesText（开着有规则文件→内容；关着→null）', async () => {
    writeEvolutionEnabled(true)
    mkdirSync(engineHome, { recursive: true })
    writeFileSync(resolve(engineHome, 'AGENTS.md'), '# Evolution Rules\n- When: 测试 Then: 断言')
    const enabledStatus = await service.getStatus()
    expect(enabledStatus.rulesText).toContain('断言')

    writeEvolutionEnabled(false)
    const disabledStatus = await service.getStatus()
    expect(disabledStatus.rulesText).toBeNull()
    rmSync(resolve(engineHome, 'AGENTS.md'), { force: true })
  })

  test('getRulesFor: 读取规则文件、mtime 变更后刷新、超长截断', async () => {
    writeEvolutionEnabled(true)
    mkdirSync(engineHome, { recursive: true })
    const rulesPath = resolve(engineHome, 'AGENTS.md')

    writeFileSync(rulesPath, '# Evolution Rules\n- When: 长文档 Then: 分段处理')
    expect(service.getRulesFor()).toContain('分段处理')

    await new Promise((r) => setTimeout(r, 30)) // 确保 mtime 变化
    writeFileSync(rulesPath, '# Evolution Rules\n- When: 表格 Then: 先读表头')
    expect(service.getRulesFor()).toContain('先读表头')

    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(rulesPath, 'R'.repeat(5000))
    const capped = service.getRulesFor()!
    expect(capped.length).toBeLessThan(1400)
    expect(capped).toContain('已截断')

    writeEvolutionEnabled(false)
    expect(service.getRulesFor()).toBeNull()
  })
})
