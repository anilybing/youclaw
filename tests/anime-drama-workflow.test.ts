import { describe, expect, test } from 'bun:test'
import {
  ANIME_DRAMA_CAPABILITY_GAPS,
  ANIME_DRAMA_STAGES,
  ANIME_DRAMA_WORKFLOW_ID,
  buildAnimeDramaWorkflowDefinition,
  getAnimeDramaStageByWorkflowStep,
} from '../src/workflow/anime-drama'
import { hasWorkflowNodeTool } from '../src/workflow/nodes'

describe('anime drama pipeline blueprint', () => {
  test('stages cover the mature production chain with gates on key phases', () => {
    expect(ANIME_DRAMA_STAGES.map((stage) => stage.id)).toEqual([
      'idea',
      'script',
      'assets',
      'storyboard',
      'clips',
      'audio',
      'final',
    ])
    expect(ANIME_DRAMA_STAGES.filter((stage) => stage.requiresGate).map((stage) => stage.id)).toEqual([
      'assets',
      'storyboard',
      'clips',
    ])
  })

  test('builtin workflow embeds approval gates, asset seed/assert tools, and animatic step', () => {
    const wf = buildAnimeDramaWorkflowDefinition()
    expect(wf.id).toBe(ANIME_DRAMA_WORKFLOW_ID)
    expect(wf.agentId).toBe('content-creator')
    expect(wf.steps.map((step) => step.id)).toEqual([
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
      'render_draft',
      'render_hq',
      'video_notes',
      'assemble',
    ])
    expect(wf.steps.filter((step) => step.kind === 'approval').map((step) => step.id)).toEqual([
      'gate_assets',
      'gate_board',
      'gate_video',
    ])
    expect(wf.steps.find((step) => step.id === 'seed_assets')).toMatchObject({
      kind: 'tool',
      tool: 'studio_seed_assets',
    })
    expect(wf.steps.find((step) => step.id === 'assert_locked')).toMatchObject({
      kind: 'tool',
      tool: 'studio_assert_locked',
    })
    expect(hasWorkflowNodeTool('studio_seed_assets')).toBe(true)
    expect(hasWorkflowNodeTool('studio_assert_locked')).toBe(true)
    expect(wf.steps.find((step) => step.id === 'char_sheet')?.kind).toBe('agent')
    expect(wf.steps.find((step) => step.id === 'stills')?.prompt).toContain('startPath')
    expect(wf.steps.find((step) => step.id === 'script')?.prompt).toContain('60-90')
    expect(wf.steps.find((step) => step.id === 'video_prompts')?.prompt).toContain('costTier')
    expect(wf.budgets?.maxTotalTokens).toBe(36_000)
  })

  test('step ids map back to studio stages', () => {
    expect(getAnimeDramaStageByWorkflowStep('gate_assets')).toBe('assets')
    expect(getAnimeDramaStageByWorkflowStep('seed_assets')).toBe('assets')
    expect(getAnimeDramaStageByWorkflowStep('assert_locked')).toBe('assets')
    expect(getAnimeDramaStageByWorkflowStep('stills')).toBe('storyboard')
    expect(getAnimeDramaStageByWorkflowStep('animatic')).toBe('storyboard')
    expect(getAnimeDramaStageByWorkflowStep('assemble')).toBe('final')
    expect(getAnimeDramaStageByWorkflowStep('missing')).toBeNull()
  })

  test('capability gap list documents covered vs missing media assemble path', () => {
    const byId = Object.fromEntries(ANIME_DRAMA_CAPABILITY_GAPS.map((item) => [item.id, item]))
    expect(byId['stage-studio-ui']?.status).toBe('covered')
    expect(byId['asset-lock']?.status).toBe('covered')
    expect(byId['ffmpeg-assemble']?.status).toBe('covered')
    expect(byId['animatic-gate']?.status).toBe('partial')
    expect(byId['token-budget']?.status).toBe('covered')
    expect(byId['tts-subtitle']?.status).toBe('gap')
    expect(byId['media-as-tool-node']?.status).toBe('covered')
  })
})
