import { describe, expect, test } from 'bun:test'
import {
  ANIME_DRAMA_CAPABILITY_GAPS,
  ANIME_DRAMA_STAGES,
  ANIME_DRAMA_WORKFLOW_ID,
  buildAnimeDramaWorkflowDefinition,
  getAnimeDramaStageByWorkflowStep,
} from '../src/workflow/anime-drama'

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
      'script',
      'assets',
      'storyboard',
      'clips',
    ])
  })

  test('builtin workflow embeds approval gates and media-capable agent steps', () => {
    const wf = buildAnimeDramaWorkflowDefinition()
    expect(wf.id).toBe(ANIME_DRAMA_WORKFLOW_ID)
    expect(wf.agentId).toBe('content-creator')
    expect(wf.steps.map((step) => step.id)).toEqual([
      'script',
      'bible',
      'char_sheet',
      'gate_assets',
      'storyboard',
      'stills',
      'gate_board',
      'video_prompts',
      'gate_video',
      'video_notes',
      'assemble',
    ])
    expect(wf.steps.filter((step) => step.kind === 'approval').map((step) => step.id)).toEqual([
      'gate_assets',
      'gate_board',
      'gate_video',
    ])
    expect(wf.steps.find((step) => step.id === 'char_sheet')?.kind).toBe('agent')
    expect(wf.steps.find((step) => step.id === 'stills')?.prompt).toContain('mcp__media__generate_image')
  })

  test('step ids map back to studio stages', () => {
    expect(getAnimeDramaStageByWorkflowStep('gate_assets')).toBe('assets')
    expect(getAnimeDramaStageByWorkflowStep('stills')).toBe('storyboard')
    expect(getAnimeDramaStageByWorkflowStep('assemble')).toBe('final')
    expect(getAnimeDramaStageByWorkflowStep('missing')).toBeNull()
  })

  test('capability gap list documents covered vs missing media assemble path', () => {
    const byId = Object.fromEntries(ANIME_DRAMA_CAPABILITY_GAPS.map((item) => [item.id, item]))
    expect(byId['stage-studio-ui']?.status).toBe('covered')
    expect(byId['ffmpeg-assemble']?.status).toBe('gap')
    expect(byId['tts-subtitle']?.status).toBe('gap')
    expect(byId['asset-lock']?.status).toBe('partial')
  })
})
