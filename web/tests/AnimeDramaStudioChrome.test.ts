import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractJson,
  extractMediaPaths,
  parseScriptDoc,
  parseShotList,
  parseVideoPrompts,
} from '../src/pages/studio/anime-drama/parse'

const root = join(import.meta.dir, '../..')

describe('anime drama studio chrome', () => {
  test('registers route, sidebar nav, and polished stage workspaces', () => {
    const app = readFileSync(join(root, 'web/src/App.tsx'), 'utf8')
    const sidebar = readFileSync(join(root, 'web/src/components/layout/AppSidebar.tsx'), 'utf8')
    const en = readFileSync(join(root, 'web/src/i18n/en.ts'), 'utf8')
    const zh = readFileSync(join(root, 'web/src/i18n/zh.ts'), 'utf8')
    const studio = readFileSync(join(root, 'web/src/pages/studio/AnimeDramaStudio.tsx'), 'utf8')

    expect(app).toContain('/studio/anime-drama')
    expect(sidebar).toContain('/studio/anime-drama')
    expect(en).toContain('metricProgress:')
    expect(zh).toContain('metricProgress:')
    expect(studio).toContain('IdeaBench')
    expect(studio).toContain('ScriptBench')
    expect(studio).toContain('AssetsBench')
    expect(studio).toContain('StoryboardBench')
    expect(studio).toContain('ClipsBench')
  })
})

describe('anime drama output parsers', () => {
  test('parses fenced script JSON and shot arrays', () => {
    const script = parseScriptDoc(`说明如下\n\`\`\`json\n{"title":"囤货少女","hook":"开场钩子","characters":[{"id":"c1","name":"小橘","role":"lead","appearance":"橘发Q版"}],"locations":[{"id":"l1","name":"便利店","visualNotes":"冷白灯"}],"beats":[{"summary":"囤货","dialogue":"先拿泡面"}]}\n\`\`\``)
    expect(script?.title).toBe('囤货少女')
    expect(script?.characters[0]?.name).toBe('小橘')
    expect(script?.beats[0]?.dialogue).toBe('先拿泡面')

    const shots = parseShotList('[{"shotId":"S1","index":1,"durationSec":4,"visualPrompt":"少女冲进便利店","shotSize":"medium","cameraMove":"push"}]')
    expect(shots).toHaveLength(1)
    expect(shots[0].shotId).toBe('S1')

    const prompts = parseVideoPrompts('[{"shotId":"S1","i2vPrompt":"slow push in","durationSec":4}]')
    expect(prompts[0].i2vPrompt).toContain('slow push')
  })

  test('extracts media paths and tolerates invalid json', () => {
    expect(extractJson('not json')).toBeNull()
    expect(extractMediaPaths('保存到 D:\\\\media\\\\output\\\\hero.png 和 /tmp/a.jpg')).toEqual(
      expect.arrayContaining([expect.stringMatching(/hero\.png$/), expect.stringMatching(/a\.jpg$/)]),
    )
  })
})
