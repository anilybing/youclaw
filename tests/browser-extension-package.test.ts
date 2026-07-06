import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getBrowserExtensionPackageInfo } from '../src/browser/extension-package.ts'

describe('browser extension package', () => {
  test('reads extension metadata from the bundled chromium extension directory', () => {
    const info = getBrowserExtensionPackageInfo()

    expect(info.name).toBe('XiaoJuClaw Main Browser Bridge')
    expect(info.version).toBe('0.2.0')
    expect(info.installMode).toBe('unpacked')
    expect(info.files).toContain('manifest.json')
    expect(info.files).toContain('popup.js')
    expect(info.files).toContain('service-worker.js')
  })

  test('manifest uses debugger transport instead of scripting host injection', () => {
    const manifest = readFileSync(path.join(process.cwd(), 'extensions/main-browser-chromium/manifest.json'), 'utf8')

    expect(manifest).toContain('"permissions": ["tabs", "storage", "debugger"]')
    expect(manifest).not.toContain('"scripting"')
  })
})
