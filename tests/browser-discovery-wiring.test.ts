import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('browser discovery wiring', () => {
  test('browser routes expose a discovery endpoint', () => {
    const routes = read('src/browser/routes.ts')

    expect(routes).toContain("app.get('/browser/discovery'")
    expect(routes).toContain('detectInstalledBrowsers()')
    expect(routes).toContain("app.get('/browser/profiles/:id/main-bridge'")
    expect(routes).toContain("app.post('/browser/profiles/:id/main-bridge/select'")
  })

  test('browser client and UI expose the main browser advanced flow', () => {
    const client = read('web/src/api/client.ts')
    const page = read('web/src/pages/BrowserProfiles.tsx')
    const en = read('web/src/i18n/en.ts')

    expect(client).toContain('export async function getBrowserDiscovery()')
    expect(client).toContain('export async function getBrowserProfileMainBridge(id: string)')
    expect(client).toContain('export async function selectBrowserProfileMainBridgeBrowser')
    expect(page).toContain('getBrowserDiscovery().then(setBrowserDiscovery)')
    expect(page).toContain('getBrowserProfileMainBridge(profile.id)')
    expect(page).toContain('selectBrowserProfileMainBridgeBrowser(profile.id, browserId)')
    expect(page).toContain('MainBridgeCard')
    expect(page).toContain('title={t.browser.relayTitle}')
    expect(page).toContain('showAdvancedRelay')
    expect(page).toContain("mainBridge?.status === 'paired'")
    expect(page).toContain('{t.browser.mainBridgeCopyPairing}')
    expect(page).toContain('mainBridge.pairingCodeExpiresAt')
    expect(en).toContain("relayTitle: 'Main Browser (Advanced)'")
    expect(en).toContain("mainBridgeStatusPaired: 'Paired'")
  })
})
