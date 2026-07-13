import { describe, expect, test, beforeEach } from 'bun:test'
import { cleanTables } from './setup'
import { getWorkflowNodeTool } from '../src/workflow/nodes'
import { listAssets } from '../src/studio/assetStore'

function toolContext(runId: string) {
  return {
    agentId: 'content-creator',
    workflowId: 'anime-drama-studio-v1',
    workflowRunId: runId,
    traceId: 'tr-test',
    stepId: 'seed_assets',
    stepIndex: 2,
    signal: new AbortController().signal,
  }
}

describe('studio_seed_assets workflow tool', () => {
  beforeEach(() => {
    cleanTables('studio_assets')
  })

  test('seeds characters/locations/props from bible JSON object', async () => {
    const tool = getWorkflowNodeTool('studio_seed_assets')
    expect(tool).not.toBeNull()
    const runId = `run-seed-${Date.now().toString(36)}`
    const out = await tool!.execute(
      {
        bibleJson: JSON.stringify({
          characters: [{ id: 'c1', name: '林野', appearance: '黑发校服', role: 'lead' }],
          locations: [{ id: 'l1', name: '教室_白天', visualNotes: '空教室阳光', mood: '平静' }],
          props: [{ id: 'p1', name: '日记本', description: '褐色封面' }],
        }),
      },
      toolContext(runId),
    )
    const parsed = JSON.parse(out) as { seeded: number; assets: Array<{ kind: string; refKey: string }> }
    expect(parsed.seeded).toBe(3)
    expect(parsed.assets.map((a) => a.kind).sort()).toEqual(['character', 'location', 'prop'])
    expect(listAssets(runId)).toHaveLength(3)
  })

  test('rejects array root and empty payload', async () => {
    const tool = getWorkflowNodeTool('studio_seed_assets')!
    const runId = `run-seed-bad-${Date.now().toString(36)}`
    await expect(tool.execute({ bibleJson: '[]' }, toolContext(runId))).rejects.toThrow(/对象形/)
    await expect(tool.execute({ bibleJson: '' }, toolContext(runId))).rejects.toThrow(/bibleJson/)
  })

  test('is idempotent on same refKey', async () => {
    const tool = getWorkflowNodeTool('studio_seed_assets')!
    const runId = `run-seed-idemp-${Date.now().toString(36)}`
    const bible = JSON.stringify({
      characters: [{ id: 'c1', name: '林野', appearance: '黑发' }],
    })
    await tool.execute({ bibleJson: bible }, toolContext(runId))
    await tool.execute({ bibleJson: bible }, toolContext(runId))
    expect(listAssets(runId)).toHaveLength(1)
  })
})
