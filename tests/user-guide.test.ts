// [XJC] The customer guide must be illustrated, offline, and reproducible from real UI pages.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const GUIDE_DIR = resolve(ROOT, 'web', 'public', 'user-guide')
const GUIDE_HTML = resolve(GUIDE_DIR, 'index.html')
const SCREENSHOTS = [
  '01-login.png',
  '02-today.png',
  '03-models.png',
  '04-workbench.png',
  '05-chat.png',
  '06-agents.png',
  '07-knowledge.png',
  '08-workflows.png',
  '09-tasks-create.png',
  '10-channels.png',
  '11-media.png',
  '12-skills.png',
  '13-memory.png',
  '14-fulfillment.png',
  '15-logs.png',
  '16-activation.png',
]

describe('illustrated customer user guide', () => {
  test('contains searchable step-by-step chapters and interactive image viewing', () => {
    const html = readFileSync(GUIDE_HTML, 'utf8')

    expect((html.match(/class="guide-section"/g) ?? []).length).toBe(17)
    expect((html.match(/class="image-wrap" data-zoom/g) ?? []).length).toBe(16)
    expect(html).toContain('id="searchInput"')
    expect(html).toContain('id="printBtn"')
    expect(html).toContain('data-complete="safety"')
    expect(html).toContain('当前真实边界')
  })

  test('ships every referenced real UI screenshot at a useful resolution', () => {
    const html = readFileSync(GUIDE_HTML, 'utf8')

    for (const screenshot of SCREENSHOTS) {
      const path = resolve(GUIDE_DIR, 'assets', 'ui', screenshot)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).size).toBeGreaterThan(10_000)
      const png = readFileSync(path)
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(1200)
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(800)
      expect(html).toContain(`assets/ui/${screenshot}`)
    }
  })

  test('uses an offline CSP and loads no remote or active embedded resources', () => {
    const html = readFileSync(GUIDE_HTML, 'utf8')

    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toMatch(/<(?:script|img)\b[^>]+\bsrc=["']https?:/i)
    expect(html).not.toMatch(/<link\b[^>]+\bhref=["']https?:/i)
    expect(html).not.toMatch(/<(?:iframe|object|embed)\b/i)
    expect(html).not.toMatch(/@import\s+url\(\s*["']?https?:/i)
    expect(html).not.toMatch(/\bfetch\s*\(/)
  })

  test('is embedded in the app and has a reproducible screenshot script', () => {
    const pageSource = readFileSync(resolve(ROOT, 'web', 'src', 'pages', 'UserGuide.tsx'), 'utf8')
    const captureSource = readFileSync(resolve(ROOT, 'scripts', 'capture-user-guide-screenshots.mjs'), 'utf8')

    expect(pageSource).toContain('user-guide/index.html')
    expect(pageSource).toContain('XiaoJuClaw 图文操作手册')
    expect(pageSource).toContain('sandbox="allow-scripts allow-modals"')
    expect(captureSource).toContain("mkdtemp(resolve(tmpdir(), 'xjc-illustrated-guide-')")
    expect(captureSource).toContain('replaceOutputAtomically')
    expect(captureSource).toContain('validateScreenshots')
    expect(captureSource).not.toContain('GUIDE_SCREENSHOT_DIR')
    expect(captureSource).not.toContain('GUIDE_BASE_URL')
    expect(captureSource).toContain("青禾内容工作室")
    expect(captureSource).toContain("DEMO-CODE-001")
    for (const screenshot of SCREENSHOTS) {
      expect(captureSource).toContain(screenshot)
    }
    const versionSource = readFileSync(resolve(ROOT, 'scripts', 'desktop-version.mjs'), 'utf8')
    expect(versionSource).toContain('web/public/user-guide/index.html')
    expect(versionSource).toContain('docs/user-guide.zh.md')
    expect(versionSource).toContain('docs/user-guide.en.md')
  })
})
