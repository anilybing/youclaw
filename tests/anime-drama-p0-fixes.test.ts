import { describe, expect, test, beforeEach } from 'bun:test'
import { cleanTables } from './setup'
import { getWorkflowNodeTool } from '../src/workflow/nodes'
import { listAssets, patchAsset, seedAssetsFromScript } from '../src/studio/assetStore'
import {
  ANIME_DRAMA_STAGES,
  ANIME_DRAMA_WORKFLOW_ID,
  buildAnimeDramaWorkflowDefinition,
  getAnimeDramaStageByWorkflowStep,
} from '../src/workflow/anime-drama'
import { hasWorkflowNodeTool } from '../src/workflow/nodes'
import {
  parseStillFrames,
  resolveShotMediaPath,
  parseShotList,
} from '../web/src/pages/studio/anime-drama/parse'

function toolContext(runId: string) {
  return {
    agentId: 'content-creator',
    workflowId: 'anime-drama-studio-v1',
    workflowRunId: runId,
    traceId: 'tr-test',
    stepId: 'assert_locked',
    stepIndex: 4,
    signal: new AbortController().signal,
  }
}

describe('anime drama P0 fixes', () => {
  beforeEach(() => {
    cleanTables('studio_assets')
  })

  test('workflow includes assert_locked after gate_assets', () => {
    const wf = buildAnimeDramaWorkflowDefinition()
    expect(wf.id).toBe(ANIME_DRAMA_WORKFLOW_ID)
    expect(wf.steps.map((s) => s.id)).toEqual([
      'script',
      'seed_assets',
      'char_sheet',
      'gate_assets',
      'assert_locked',
      'storyboard',
      'stills',
      'animatic',
      'gate_board',
      'video_prompts',
      'gate_video',
      'video_notes',
      'assemble',
    ])
    expect(wf.budgets?.maxTotalTokens).toBe(36_000)
    expect(hasWorkflowNodeTool('studio_assert_locked')).toBe(true)
    expect(getAnimeDramaStageByWorkflowStep('assert_locked')).toBe('assets')
    expect(ANIME_DRAMA_STAGES.find((s) => s.id === 'script')?.requiresGate).toBe(false)
  })

  test('studio_assert_locked blocks unlocked or imageless characters', async () => {
    const tool = getWorkflowNodeTool('studio_assert_locked')!
    const runId = `run-assert-${Date.now().toString(36)}`
    await expect(tool.execute({}, toolContext(runId))).rejects.toThrow(/无角色资产/)

    const [char] = seedAssetsFromScript({
      runId,
      characters: [{ refKey: 'c1', name: '林野', description: '黑发' }],
    })
    await expect(tool.execute({}, toolContext(runId))).rejects.toThrow(/未锁定/)

    patchAsset(char!.id, { locked: true })
    await expect(tool.execute({}, toolContext(runId))).rejects.toThrow(/缺少参考图/)

    patchAsset(char!.id, { imagePath: 'D:/media/linye.png' })
    const out = JSON.parse(await tool.execute({}, toolContext(runId))) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(listAssets(runId, 'character')[0]?.locked).toBe(true)
  })

  test('parseStillFrames + resolveShotMediaPath bind by shotId not index', () => {
    const frames = parseStillFrames(`
\`\`\`json
[
  {"shotId":"S02","startPath":"D:/a/s2.png"},
  {"shotId":"S01","startPath":"D:/a/s1.png","endPath":"D:/a/s1e.png"}
]
\`\`\`
`)
    expect(frames.map((f) => f.shotId)).toEqual(['S02', 'S01'])
    expect(resolveShotMediaPath('S01', 0, frames, ['D:/wrong.png'])).toBe('D:/a/s1.png')
    expect(resolveShotMediaPath('S02', 1, frames, [])).toBe('D:/a/s2.png')
    expect(resolveShotMediaPath('S99', 0, frames, ['D:/fallback.png'])).toBe('D:/fallback.png')

    const shots = parseShotList('[{"shotId":"S01","durationSec":4,"visualPrompt":"x","continuityTo":"S02","costTier":"hq"}]')
    expect(shots[0]?.continuityTo).toBe('S02')
    expect(shots[0]?.costTier).toBe('hq')
  })
})
