import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

describe('build provenance', () => {
  test('records source and runtime metadata without secrets', () => {
    const output = resolve(process.cwd(), 'data', `provenance-test-${process.pid}.json`)
    const version = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version
    rmSync(output, { force: true })
    try {
      const result = Bun.spawnSync([
        process.execPath,
        'scripts/write-build-provenance.mjs',
        output,
        version,
        'test-variant',
      ], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(output)).toBe(true)

      const payload = JSON.parse(readFileSync(output, 'utf8')) as Record<string, any>
      expect(payload).toMatchObject({
        schemaVersion: 1,
        product: 'XiaoJuClaw',
        version,
        variant: 'test-variant',
        source: {
          dirty: expect.any(Boolean),
          inputs: expect.any(Object),
        },
        runtime: {
          platform: process.platform,
          arch: process.arch,
        },
      })
      expect(payload.source.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/)
      expect(JSON.stringify(payload)).not.toMatch(/apiKey|token|password/i)
    } finally {
      rmSync(output, { force: true })
    }
  }, 15_000)
})
