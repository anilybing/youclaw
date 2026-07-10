import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('browser extension package wiring', () => {
  test('browser routes expose extension package info and download endpoints', () => {
    const routes = read('src/browser/routes.ts')

    expect(routes).toContain("app.get('/browser/main-bridge/extension-package'")
    expect(routes).toContain("app.get('/browser/main-bridge/extension-download'")
    expect(routes).toContain('buildBrowserExtensionZip()')
    expect(routes).toContain('getBrowserExtensionPackageInfo()')
  })

  test('browser UI surfaces extension package install actions', () => {
    const client = read('web/src/api/client.ts')
    const page = read('web/src/pages/BrowserProfiles.tsx')
    const en = read('web/src/i18n/en.ts')

    expect(client).toContain('export async function getBrowserMainBridgeExtensionPackage()')
    expect(client).toContain('export async function downloadBrowserMainBridgeExtensionBundle()')
    expect(page).toContain('getBrowserMainBridgeExtensionPackage().then(setExtensionPackage)')
    expect(page).toContain('{t.browser.downloadExtensionBundle}')
    expect(page).toContain('{t.browser.copyExtensionPath}')
    expect(page).toContain('{t.browser.extensionInstallHint}')
    expect(en).toContain("downloadExtensionBundle: 'Download Extension Bundle'")
    expect(en).toContain("copyExtensionPath: 'Copy Extension Path'")
    expect(en).toContain("extensionInstallHint: 'Open `chrome://extensions`")
  })
})
