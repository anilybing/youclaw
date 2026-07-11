import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Regression guard for the IPv6 loopback startup bug.
//
// The sidecar binds IPv4 loopback only (`127.0.0.1`, src/index.ts) to avoid
// Windows firewall prompts. On default Windows, `localhost` resolves to IPv6
// `::1` first, so a frontend that targets `http://localhost:<port>` never
// reaches the IPv4-only sidecar: health probing and every API/WS call fail and
// the app dead-ends on the "启动失败 / 后端服务无法启动" screen even though the
// backend is running. The frontend must build sidecar URLs from 127.0.0.1.
const WEB_ROOT = resolve(import.meta.dir, '..', 'web')

const SIDECAR_URL_FILES = [
  'src/api/transport.ts',
  'src/App.tsx',
  'src/components/settings/GeneralPanel.tsx',
  'src/components/PortConflictDialog.tsx',
]

describe('sidecar loopback host', () => {
  test('transport exposes a 127.0.0.1 sidecar origin helper', () => {
    const src = readFileSync(resolve(WEB_ROOT, 'src/api/transport.ts'), 'utf8')
    expect(src).toContain("SIDECAR_LOOPBACK_HOST = '127.0.0.1'")
    expect(src).toMatch(/export function sidecarOrigin\(/)
  })

  test('frontend never builds an http://localhost sidecar URL', () => {
    const offenders = SIDECAR_URL_FILES.filter((rel) =>
      readFileSync(resolve(WEB_ROOT, rel), 'utf8').includes('http://localhost:'),
    )
    expect(offenders).toEqual([])
  })
})
