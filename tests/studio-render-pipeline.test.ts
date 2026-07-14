// [XJC] 漫剧 P0.5·G0 管路单测（架构师 G0 契约对齐版）：spec 化 shot store + studio_cost_ledger +
// VideoProvider(src/media) + 共享核 renderShot + studio_render_shot 工具节点 + rerunShot 单镜重渲 +
// ¥ 预算硬闸。全 mock/dry-run，不联网不烧钱。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { existsSync } from 'node:fs'
import {
  clearRunShots,
  getShot,
  listShots,
  markShotFailed,
  markShotRendered,
  markShotRendering,
  setShotSelected,
  summarizeRunShots,
  upsertShot,
} from '../src/studio/shotStore.ts'
import {
  assertRunBudget,
  BudgetExceededError,
  DEFAULT_RUN_BUDGET_CNY,
  DEFAULT_WARN_CNY,
  estimateImageCny,
  estimateVideoCny,
  getRunBudgetStatus,
  listShotCosts,
  recordCost,
  summarizeRunCost,
} from '../src/studio/costLedger.ts'
import {
  MockVideoProvider,
  OpenAiCompatibleVideoProvider,
  resolveVideoProvider,
  studioVideoMode,
} from '../src/media/video-provider.ts'
import { renderShot } from '../src/studio/renderShot.ts'
import { getWorkflowNodeTool, hasWorkflowNodeTool } from '../src/workflow/nodes.ts'
import type { WorkflowNodeContext } from '../src/workflow/nodes.ts'
import { rerunShot } from '../src/workflow/runner.ts'

afterEach(() => {
  getDatabase().run("DELETE FROM studio_shots WHERE run_id LIKE 'run-test%'")
  getDatabase().run("DELETE FROM studio_cost_ledger WHERE run_id LIKE 'run-test%'")
  delete process.env.XJC_STUDIO_VIDEO_MODE
})

function ctx(runId: string, agentId = 'agent-test-render'): WorkflowNodeContext {
  return {
    agentId,
    workflowId: 'anime-drama-studio-v1',
    workflowRunId: runId,
    traceId: 'trace-test',
    stepId: 'render_draft',
    stepIndex: 0,
    signal: new AbortController().signal,
  }
}

describe('shot store（spec 化，契约 Q2）', () => {
  const RUN = 'run-test-shots'

  test('upsert 幂等（run+shot）：合并 spec，不碰渲染结果', () => {
    upsertShot({ runId: RUN, shotId: 'S1', shotIndex: 0, spec: { prompt: '第一镜', durationSec: 5 } })
    markShotRendering(RUN, 'S1')
    markShotRendered(RUN, 'S1', { tier: 'draft', outputPath: '/m/s1_draft.mp4', provider: 'mock' })
    upsertShot({ runId: RUN, shotId: 'S1', spec: { prompt: '第一镜·改' } })
    const after = getShot(RUN, 'S1')!
    expect(listShots(RUN).length).toBe(1)
    expect(after.spec.prompt).toBe('第一镜·改')
    expect(after.spec.durationSec).toBe(5) // 合并保留
    expect(after.status).toBe('done')
    expect(after.draftPath).toBe('/m/s1_draft.mp4')
    expect(after.attemptCount).toBe(1)
  })

  test('listShots 按 shotIndex 稳定排序', () => {
    upsertShot({ runId: RUN, shotId: 'B', shotIndex: 2, spec: { prompt: 'p' } })
    upsertShot({ runId: RUN, shotId: 'A', shotIndex: 1, spec: { prompt: 'p' } })
    upsertShot({ runId: RUN, shotId: 'C', shotIndex: 3, spec: { prompt: 'p' } })
    expect(listShots(RUN).map((s) => s.shotId)).toEqual(['A', 'B', 'C'])
  })

  test('渲染生命周期 + draft/hq 产物并存', () => {
    upsertShot({ runId: RUN, shotId: 'S1', spec: { prompt: 'p' } })
    expect(getShot(RUN, 'S1')!.status).toBe('pending')
    expect(markShotRendering(RUN, 'S1').attempt).toBe(1)
    markShotRendered(RUN, 'S1', { tier: 'draft', outputPath: '/m/d.mp4', provider: 'mock' })
    markShotRendering(RUN, 'S1')
    markShotRendered(RUN, 'S1', { tier: 'hq', outputPath: '/m/h.mp4', provider: 'kling' })
    const s = getShot(RUN, 'S1')!
    expect(s.draftPath).toBe('/m/d.mp4') // draft 保留
    expect(s.hqPath).toBe('/m/h.mp4') // hq 并存
    expect(s.lastTier).toBe('hq')
    expect(s.lastProvider).toBe('kling')
    expect(s.attemptCount).toBe(2)
  })

  test('markShotFailed + setShotSelected + summarize', () => {
    upsertShot({ runId: RUN, shotId: 'S1', spec: { prompt: 'p' } })
    upsertShot({ runId: RUN, shotId: 'S2', spec: { prompt: 'p' } })
    markShotRendering(RUN, 'S1'); markShotRendered(RUN, 'S1', { tier: 'draft', outputPath: '/m/d.mp4', provider: 'mock' })
    markShotRendering(RUN, 'S2'); markShotFailed(RUN, 'S2', '供应商超时', 'draft')
    setShotSelected(RUN, 'S1', true)
    const sum = summarizeRunShots(RUN)
    expect(sum.total).toBe(2)
    expect(sum.byStatus.done).toBe(1)
    expect(sum.byStatus.failed).toBe(1)
    expect(sum.selected).toBe(1)
    expect(sum.draftRendered).toBe(1)
    expect(getShot(RUN, 'S2')!.error).toBe('供应商超时')
  })

  test('非法 tier / 缺 runId·shotId 抛错 + clearRunShots', () => {
    upsertShot({ runId: RUN, shotId: 'S1', spec: { prompt: 'p' } })
    markShotRendering(RUN, 'S1')
    expect(() => markShotRendered(RUN, 'S1', { tier: 'weird' as 'draft', outputPath: '/m/x.mp4', provider: 'mock' })).toThrow(/tier/)
    expect(() => upsertShot({ runId: '', shotId: 'X' })).toThrow(/runId/)
    expect(() => upsertShot({ runId: RUN, shotId: '' })).toThrow(/shotId/)
    expect(clearRunShots(RUN)).toBeGreaterThan(0)
    expect(listShots(RUN).length).toBe(0)
  })
})

describe('studio_cost_ledger（契约 Q4）', () => {
  const RUN = 'run-test-cost'

  test('recordCost + 归集（provider/tier/shot；real 排除 dry-run；durationMs）', () => {
    recordCost({ runId: RUN, shotId: 'S1', provider: 'mock', tier: 'draft', costCny: 2, durationMs: 0, dryRun: true })
    recordCost({ runId: RUN, shotId: 'S2', provider: 'wan', tier: 'draft', costUsd: 0.29, costCny: 2, durationMs: 4200, dryRun: false })
    const sum = summarizeRunCost(RUN)
    expect(sum.entries).toBe(2)
    expect(sum.totalCostCny).toBe(4)
    expect(sum.realCostCny).toBe(2)
    expect(sum.byProvider.wan.count).toBe(1)
    expect(listShotCosts(RUN, 'S2')[0].durationMs).toBe(4200)
  })

  test('缺 runId / provider 抛错', () => {
    expect(() => recordCost({ runId: '', provider: 'mock' })).toThrow(/runId/)
    expect(() => recordCost({ runId: RUN, provider: '' })).toThrow(/provider/)
  })
})

describe('VideoProvider（src/media，契约 Q1）', () => {
  const RUN = 'run-test-provider'

  test('MockVideoProvider.generate 写占位产物 + 名义成本（dry-run）', async () => {
    const provider = new MockVideoProvider()
    expect(provider.isConfigured()).toBe(true)
    const outputDir = `${process.env.DATA_DIR}/prov-test`
    const res = await provider.generate(
      { prompt: 'p' },
      { runId: RUN, agentId: 'agent-test-render', shotId: 'S1', tier: 'draft', outputDir },
    )
    expect(res.dryRun).toBe(true)
    expect(res.providerId).toBe('mock')
    expect(res.costCny).toBe(2)
    expect(res.costUsd).toBeCloseTo(0.29, 5)
    expect(existsSync(res.filePath)).toBe(true)
  })

  test('resolveVideoProvider：mock 模式=Mock；live 模式=OpenAiCompatible', () => {
    expect(studioVideoMode()).toBe('mock')
    expect(resolveVideoProvider('draft')).toBeInstanceOf(MockVideoProvider)
    process.env.XJC_STUDIO_VIDEO_MODE = 'live'
    expect(studioVideoMode()).toBe('live')
    expect(resolveVideoProvider('hq')).toBeInstanceOf(OpenAiCompatibleVideoProvider)
  })

  test('OpenAiCompatibleVideoProvider.isConfigured：缺 baseUrl/apiKey/model = false', () => {
    const savedKey = process.env.SILICONFLOW_API_KEY
    const savedBase = process.env.SILICONFLOW_BASE_URL
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.SILICONFLOW_BASE_URL
    try {
      expect(new OpenAiCompatibleVideoProvider('wan', 'draft').isConfigured()).toBe(false)
    } finally {
      if (savedKey !== undefined) process.env.SILICONFLOW_API_KEY = savedKey
      if (savedBase !== undefined) process.env.SILICONFLOW_BASE_URL = savedBase
    }
  })
})

describe('renderShot 共享核（契约 Q3）', () => {
  const RUN = 'run-test-core'

  test('mock：upsert + renderShot(draft) → done + draft_path + 成本入账', async () => {
    upsertShot({ runId: RUN, shotId: 'S1', spec: { prompt: '推镜' } })
    const outcome = await renderShot({ runId: RUN, agentId: 'agent-test-render', shotId: 'S1', tier: 'draft' })
    expect(outcome.dryRun).toBe(true)
    expect(existsSync(outcome.outputPath)).toBe(true)
    const shot = getShot(RUN, 'S1')!
    expect(shot.status).toBe('done')
    expect(shot.draftPath).toBe(outcome.outputPath)
    expect(summarizeRunCost(RUN).entries).toBe(1)
  })

  test('镜头不存在 → 抛错', async () => {
    await expect(renderShot({ runId: RUN, shotId: 'nope', tier: 'draft' })).rejects.toThrow(/不存在/)
  })

  test('live 未配置：置 failed + 记 failed 行 + 抛错（不联网，防误烧钱）', async () => {
    process.env.XJC_STUDIO_VIDEO_MODE = 'live'
    const savedKey = process.env.SILICONFLOW_API_KEY
    const savedBase = process.env.SILICONFLOW_BASE_URL
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.SILICONFLOW_BASE_URL
    try {
      upsertShot({ runId: RUN, shotId: 'S9', spec: { prompt: 'p' } })
      await expect(renderShot({ runId: RUN, agentId: 'a', shotId: 'S9', tier: 'draft' })).rejects.toThrow(/渲染失败|未配置/)
      expect(getShot(RUN, 'S9')!.status).toBe('failed')
      expect(listShotCosts(RUN, 'S9')[0].status).toBe('failed')
    } finally {
      if (savedKey !== undefined) process.env.SILICONFLOW_API_KEY = savedKey
      if (savedBase !== undefined) process.env.SILICONFLOW_BASE_URL = savedBase
    }
  })
})

describe('studio_render_shot 工具节点（全链路管路）', () => {
  test('已注册进白名单', () => {
    expect(hasWorkflowNodeTool('studio_render_shot')).toBe(true)
  })

  test('批量渲染 10 镜（draft）→ 全 done + 10 成本行 + mock 不烧钱', async () => {
    const RUN = 'run-test-batch'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    for (let i = 1; i <= 10; i++) {
      const out = await tool.execute(
        { shotId: `S${i}`, tier: 'draft', prompt: `第 ${i} 镜`, durationSec: '5', aspect: '9:16', shotIndex: String(i) },
        ctx(RUN),
      )
      const parsed = JSON.parse(out) as { ok: boolean; dryRun: boolean; outputPath: string }
      expect(parsed.ok).toBe(true)
      expect(existsSync(parsed.outputPath)).toBe(true)
    }
    expect(listShots(RUN).every((s) => s.status === 'done')).toBe(true)
    const sum = summarizeRunCost(RUN)
    expect(sum.entries).toBe(10)
    expect(sum.totalCostCny).toBe(20) // 10 × ¥2 名义
    expect(sum.realCostCny).toBe(0) // 全 dry-run，不烧钱
    clearRunShots(RUN)
  })

  test('forEach 单镜 JSON（{{item}}）解析：costTier/i2vPrompt/首尾帧', async () => {
    const RUN = 'run-test-foreach'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    const shot = JSON.stringify({ shotId: 'S7', i2vPrompt: '特写', costTier: 'draft', durationSec: 5, endPath: '/m/s7_end.png' })
    const out = await tool.execute({ shot }, ctx(RUN))
    expect((JSON.parse(out) as { shotId: string }).shotId).toBe('S7')
    const stored = getShot(RUN, 'S7')!
    expect(stored.spec.prompt).toBe('特写')
    expect(stored.endPath).toBe('/m/s7_end.png')
    clearRunShots(RUN)
  })

  test('HQ 重渲：仅 shotId（无 prompt）从台账取规格', async () => {
    const RUN = 'run-test-hqtool'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    await tool.execute({ shotId: 'S1', tier: 'draft', prompt: '初渲' }, ctx(RUN))
    const out = await tool.execute({ shotId: 'S1', tier: 'hq' }, ctx(RUN)) // 无 prompt → 从 store 取
    expect((JSON.parse(out) as { tier: string }).tier).toBe('hq')
    const s = getShot(RUN, 'S1')!
    expect(s.draftPath).toBeTruthy()
    expect(s.hqPath).toBeTruthy()
    clearRunShots(RUN)
  })

  test('前向 I2V 兼底：新镜无首帧时用前一镜尾帧作起始图', async () => {
    const RUN = 'run-test-fwd'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    await tool.execute({ shotId: 'S1', prompt: 'p1', shotIndex: '1', lastFramePath: '/m/s1_end.png' }, ctx(RUN))
    await tool.execute({ shotId: 'S2', prompt: 'p2', shotIndex: '2' }, ctx(RUN)) // 无首帧 → 继承 S1 尾帧
    expect(getShot(RUN, 'S2')!.startPath).toBe('/m/s1_end.png')
    clearRunShots(RUN)
  })

  test('缺 shotId / (无 prompt 且不在台账) 抛错', async () => {
    const RUN = 'run-test-validate'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    await expect(tool.execute({ prompt: 'p' }, ctx(RUN))).rejects.toThrow(/shotId/)
    await expect(tool.execute({ shotId: 'S1' }, ctx(RUN))).rejects.toThrow(/prompt|台账/)
  })
})

describe('rerunShot 单镜重渲 API（契约 Q3）', () => {
  test('draft 后 rerunShot(hq) → hq_path + attempt 累加 + 成本 append', async () => {
    const RUN = 'run-test-rerun'
    const tool = getWorkflowNodeTool('studio_render_shot')!
    await tool.execute({ shotId: 'S1', tier: 'draft', prompt: '初渲' }, ctx(RUN))
    const outcome = await rerunShot(RUN, 'S1', 'hq', { agentId: 'agent-test-render' })
    expect(outcome.tier).toBe('hq')
    const s = getShot(RUN, 'S1')!
    expect(s.hqPath).toBeTruthy()
    expect(s.attemptCount).toBe(2)
    expect(listShotCosts(RUN, 'S1').length).toBe(2)
    clearRunShots(RUN)
  })

  test('rerunShot 缺镜头 → 抛错', async () => {
    await expect(rerunShot('run-test-rerun', 'nope', 'hq')).rejects.toThrow(/不存在/)
  })
})

describe('¥ 预算硬闸（契约 Q4）', () => {
  const RUN = 'run-test-budget'

  test('estimateVideoCny + DEFAULT 常量', () => {
    expect(estimateVideoCny('draft')).toBe(2)
    expect(estimateVideoCny('hq')).toBe(6)
    expect(estimateVideoCny('draft', 12)).toBe(24)
    expect(estimateImageCny(4)).toBeCloseTo(1.2, 5)
    expect(DEFAULT_RUN_BUDGET_CNY).toBe(32)
    expect(DEFAULT_WARN_CNY).toBe(30)
  })

  test('getRunBudgetStatus：只计真实花费，near/exceeded 正确', () => {
    for (let i = 0; i < 14; i++) recordCost({ runId: RUN, provider: 'wan', tier: 'draft', costCny: 2, dryRun: false }) // ¥28
    recordCost({ runId: RUN, provider: 'mock', tier: 'draft', costCny: 100, dryRun: true }) // 不计
    const st = getRunBudgetStatus(RUN, 2)
    expect(st.spentCny).toBe(28)
    expect(st.projectedCny).toBe(30)
    expect(st.nearLimit).toBe(true)
    expect(st.exceeded).toBe(false)
  })

  test('assertRunBudget：警戒阻断 / 确认放行 / 硬顶拒', () => {
    for (let i = 0; i < 14; i++) recordCost({ runId: RUN, provider: 'wan', tier: 'draft', costCny: 2, dryRun: false }) // ¥28
    expect(() => assertRunBudget(RUN, 2)).toThrow(BudgetExceededError) // ¥30 警戒
    expect(() => assertRunBudget(RUN, 2, { allowNearLimit: true })).not.toThrow() // 确认放行至硬顶
    expect(() => assertRunBudget(RUN, 6, { allowNearLimit: true })).toThrow(BudgetExceededError) // ¥34 > 硬顶
  })
})
