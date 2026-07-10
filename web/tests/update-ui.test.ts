import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function readSource(pathname: string) {
  return readFileSync(new URL(`../src/${pathname}`, import.meta.url), 'utf8')
}

describe('canary update UI', () => {
  test('About exposes channel, failure, provenance, and signature status', () => {
    const source = readSource('components/settings/AboutPanel.tsx')

    expect(source).toContain('id="update-release-channel"')
    expect(source).toContain('startupStatus?.previousFailure')
    expect(source).toContain('diagnostics.provenanceStatus')
    expect(source).toContain('diagnostics.signatureVerification')
    expect(source).toContain('applyInstallerUpdate')
    expect(source).not.toContain('@tauri-apps/plugin-updater')
  })

  test('English and Chinese update diagnostics keys remain aligned', () => {
    const english = readSource('i18n/en.ts')
    const chinese = readSource('i18n/zh.ts')
    const keys = [
      'previousUpdateFailed',
      'updateChannel',
      'updateChannelStable',
      'updateChannelBeta',
      'updateDiagnostics',
      'updateDiagnosticProvenance',
      'updateDiagnosticSignature',
    ]

    for (const key of keys) {
      expect(english).toContain(`${key}:`)
      expect(chinese).toContain(`${key}:`)
    }
  })
})
