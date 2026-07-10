import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  assertDesktopVersions,
  readDesktopVersions,
  setDesktopVersion,
} from '../scripts/desktop-version.mjs'
import {
  createSbom,
  parseBunLock,
  parseCargoLock,
  serializeSbom,
  stripJsonCommentsAndTrailingCommas,
} from '../scripts/generate-sbom.mjs'
import {
  createArtifactManifest,
  describeFiles,
  verifyArtifactManifest,
} from '../scripts/release-artifacts.mjs'
import {
  hashProvenanceInputs,
} from '../scripts/write-build-provenance.mjs'

const roots: string[] = []

const bunLock = `{
  // The parser must retain comment-like text inside strings.
  "note": "https://example.test/a,}",
  "packages": {
    "@scope/example": ["@scope/example@2.3.4", "https://registry.test/example.tgz", {}, "sha512-YWJj"],
    "plain": ["plain@1.2.3", "https://registry.test/plain.tgz", {}, "sha512-ZGVm"],
  },
}`

const cargoLock = `# generated
version = 4

[[package]]
name = "XiaoJuClaw"
version = "1.0.0"

[[package]]
name = "serde"
version = "1.0.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function makeRepo(version = '1.0.0') {
  const root = mkdtempSync(resolve(tmpdir(), 'xjc-release-tools-'))
  roots.push(root)
  write(resolve(root, 'package.json'), `${JSON.stringify({ name: 'XiaoJuClaw', version }, null, 2)}\n`)
  write(resolve(root, 'bun.lock'), bunLock)
  write(resolve(root, 'web', 'bun.lock'), bunLock)
  write(resolve(root, 'web', 'package.json'), '{"name":"web","version":"0.0.0"}\n')
  write(resolve(root, 'mvp', 'package.json'), '{"name":"mvp","version":"0.1.0"}\n')
  write(resolve(root, 'src', 'config', 'build-constants.ts'), 'export const BUILD_CONSTANTS = {}\n')
  write(resolve(root, 'src-tauri', 'tauri.conf.json'), `${JSON.stringify({ productName: 'XiaoJuClaw', version }, null, 2)}\n`)
  write(resolve(root, 'src-tauri', 'tauri.no-updater.conf.json'), '{"bundle":{"createUpdaterArtifacts":false}}\n')
  write(resolve(root, 'src-tauri', 'tauri.windows.conf.json'), '{"app":{"windows":[]}}\n')
  write(resolve(root, 'src-tauri', 'package.json'), `{"name":"XiaoJuClaw","version":"${version}","private":true}\n`)
  write(resolve(root, 'src-tauri', 'Cargo.toml'), `[package]\nname = "XiaoJuClaw"\nversion = "${version}"\n\n[lib]\nname = "XiaoJuClaw_lib"\n`)
  write(resolve(root, 'src-tauri', 'Cargo.lock'), cargoLock.replace('version = "1.0.0"', `version = "${version}"`))
  return root
}

function writeArtifactMetadata(repoRoot: string, artifactRoot: string) {
  const version = assertDesktopVersions(repoRoot)
  const provenance = {
    schemaVersion: 1,
    product: 'XiaoJuClaw',
    version,
    variant: 'test-portable',
    builtAt: '2026-07-10T00:00:00.000Z',
    source: {
      commit: 'a'.repeat(40),
      branch: 'test',
      dirty: false,
      inputs: hashProvenanceInputs(repoRoot),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
    },
  }
  write(resolve(artifactRoot, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  write(resolve(artifactRoot, 'sbom.cdx.json'), serializeSbom(createSbom(repoRoot)))
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('release metadata parsers', () => {
  test('parses Bun JSONC without corrupting strings or trailing commas', () => {
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(bunLock))
    expect(parsed.note).toBe('https://example.test/a,}')
    const components = parseBunLock(bunLock)
    expect(components.map((component) => component['bom-ref'])).toEqual([
      'pkg:npm/%40scope/example@2.3.4',
      'pkg:npm/plain@1.2.3',
    ])
  })

  test('parses Cargo packages and checksums', () => {
    expect(parseCargoLock(cargoLock)).toEqual([
      expect.objectContaining({
        name: 'serde',
        version: '1.0.9',
        hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }],
      }),
    ])
  })
})

describe('desktop version tooling', () => {
  test('reports mismatches and updates only desktop version sources', () => {
    const root = makeRepo()
    const tauriPath = resolve(root, 'src-tauri', 'tauri.conf.json')
    writeFileSync(tauriPath, readFileSync(tauriPath, 'utf8').replace('1.0.0', '1.0.1'))
    expect(() => assertDesktopVersions(root)).toThrow('inconsistent')

    expect(setDesktopVersion('1.1.0', root)).toBe('1.1.0')
    expect(new Set(Object.values(readDesktopVersions(root)))).toEqual(new Set(['1.1.0']))
    expect(JSON.parse(readFileSync(resolve(root, 'web', 'package.json'), 'utf8')).version).toBe('0.0.0')
    expect(JSON.parse(readFileSync(resolve(root, 'mvp', 'package.json'), 'utf8')).version).toBe('0.1.0')
  })
})

describe('SBOM and artifact verification', () => {
  test('hashes large directory trees with bounded concurrency and stable ordering', async () => {
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-artifact-tree-'))
    roots.push(artifactRoot)
    for (let index = 127; index >= 0; index -= 1) {
      write(resolve(artifactRoot, `nested-${index % 7}`, `${String(index).padStart(3, '0')}.bin`), `payload-${index}`)
    }

    const files = await describeFiles(artifactRoot, 2)
    expect(files).toHaveLength(128)
    expect(files.map((file) => file.path)).toEqual(
      [...files.map((file) => file.path)].sort((left, right) => left.localeCompare(right, 'en')),
    )
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)
  })

  test('generates deterministic CycloneDX JSON', () => {
    const root = makeRepo('1.1.0')
    const first = serializeSbom(createSbom(root))
    const second = serializeSbom(createSbom(root))
    expect(second).toBe(first)
    const sbom = JSON.parse(first)
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: { component: { name: 'XiaoJuClaw', version: '1.1.0' } },
    })
    expect(sbom.components.length).toBe(3)
  })

  test('detects artifact changes after hashing', async () => {
    const repoRoot = makeRepo('1.1.0')
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-artifact-'))
    roots.push(artifactRoot)
    write(resolve(artifactRoot, 'payload.bin'), 'release payload')
    writeArtifactMetadata(repoRoot, artifactRoot)

    await createArtifactManifest(artifactRoot, repoRoot)
    await expect(verifyArtifactManifest(artifactRoot, repoRoot)).resolves.toBeDefined()

    write(resolve(artifactRoot, 'payload.bin'), 'tampered payload')
    await expect(verifyArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow('changed: payload.bin')
  })

  test('rejects provenance that is not bound to the current source inputs', async () => {
    const repoRoot = makeRepo('1.1.0')
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-artifact-'))
    roots.push(artifactRoot)
    write(resolve(artifactRoot, 'payload.bin'), 'release payload')
    writeArtifactMetadata(repoRoot, artifactRoot)

    const provenancePath = resolve(artifactRoot, 'build-provenance.json')
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
    provenance.source.inputs['package.json'] = '0'.repeat(64)
    write(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)

    await expect(createArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow(
      'source input hashes do not match',
    )
  })
})
