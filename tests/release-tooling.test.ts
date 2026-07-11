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
import {
  assertSourceSnapshot,
  captureCleanSourceSnapshot,
} from '../scripts/assert-source-snapshot.mjs'

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

function runGit(root: string, args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function makeRepo(version = '1.0.0') {
  const root = mkdtempSync(resolve(tmpdir(), 'xjc-release-tools-'))
  roots.push(root)
  write(resolve(root, 'package.json'), `${JSON.stringify({ name: 'XiaoJuClaw', version }, null, 2)}\n`)
  write(resolve(root, 'bun.lock'), bunLock)
  write(resolve(root, 'web', 'bun.lock'), bunLock)
  write(resolve(root, 'web', 'package.json'), '{"name":"web","version":"0.0.0"}\n')
  write(resolve(root, 'web', 'public', 'user-guide', 'index.html'), `<div>图文操作手册 · ${version}</div><footer>适用版本 ${version}</footer>\n`)
  write(resolve(root, 'docs', 'user-guide.zh.md'), `> 适用版本：XiaoJuClaw ${version}\n`)
  write(resolve(root, 'docs', 'user-guide.en.md'), `> Applies to XiaoJuClaw ${version}\n`)
  write(resolve(root, 'mvp', 'package.json'), '{"name":"mvp","version":"0.1.0"}\n')
  write(resolve(root, 'src', 'config', 'build-constants.ts'), 'export const BUILD_CONSTANTS = {}\n')
  write(resolve(root, 'src-tauri', 'tauri.conf.json'), `${JSON.stringify({ productName: 'XiaoJuClaw', version }, null, 2)}\n`)
  write(resolve(root, 'src-tauri', 'tauri.no-updater.conf.json'), '{"bundle":{"createUpdaterArtifacts":false}}\n')
  write(resolve(root, 'src-tauri', 'tauri.windows-updater.conf.json'), '{"bundle":{"createUpdaterArtifacts":true}}\n')
  write(resolve(root, 'src-tauri', 'tauri.windows.conf.json'), '{"app":{"windows":[]}}\n')
  write(resolve(root, 'src-tauri', 'portable-update-key.json'), '{"keyId":"test","publicKey":"test"}\n')
  write(resolve(root, 'src-tauri', 'package.json'), `{"name":"XiaoJuClaw","version":"${version}","private":true}\n`)
  write(resolve(root, 'src-tauri', 'Cargo.toml'), `[package]\nname = "XiaoJuClaw"\nversion = "${version}"\n\n[lib]\nname = "XiaoJuClaw_lib"\n`)
  write(resolve(root, 'src-tauri', 'Cargo.lock'), cargoLock.replace('version = "1.0.0"', `version = "${version}"`))
  return root
}

function writeArtifactMetadata(repoRoot: string, artifactRoot: string, variant = 'test-portable') {
  const version = assertDesktopVersions(repoRoot)
  const provenance = {
    schemaVersion: 1,
    product: 'XiaoJuClaw',
    version,
    variant,
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
    expect(readFileSync(resolve(root, 'web', 'public', 'user-guide', 'index.html'), 'utf8')).toContain('图文操作手册 · 1.1.0')
  })

  test('release gate skips auto-discovered historical artifacts after a version bump', () => {
    const gate = readFileSync(resolve(import.meta.dir, '..', 'scripts', 'release-gate.ps1'), 'utf8')
    expect(gate).toContain('[pscustomobject]@{ Path = $candidate; Explicit = $true }')
    expect(gate).toContain('if (-not $candidate.Explicit)')
    expect(gate).toContain('if ($manifestVersion -ne $currentVersion)')
    expect(gate).toContain('[skip] Historical artifact')
  })

  test('pre-build gate defers stale artifacts until the newly staged package is verified', () => {
    const root = resolve(import.meta.dir, '..')
    const gate = readFileSync(resolve(root, 'scripts', 'release-gate.ps1'), 'utf8')
    const buildRelease = readFileSync(resolve(root, 'build-release.bat'), 'utf8')
    const makeUsb = readFileSync(resolve(root, 'scripts', 'make-usb.ps1'), 'utf8')

    expect(gate).toContain('[switch]$PreBuild')
    expect(gate).toContain('if ($PreBuild)')
    expect(gate).toContain('[defer] Pre-build source gate')
    expect(gate).toContain('Strict post-build release mode requires at least one explicit -ArtifactRoot')
    expect(buildRelease).toContain('release-gate.ps1 -Release -PreBuild')
    expect(buildRelease).not.toContain('XJC_RELEASE_GATE_ALREADY_RUN')
    expect(buildRelease).toContain('assert-source-snapshot.mjs capture')
    expect(buildRelease).toContain('--expected-commit')
    expect(buildRelease).toContain('--output-file')
    expect(buildRelease).toContain('build-lock.ps1')
    expect(buildRelease).toContain('release-artifacts.mjs verify')
    expect(makeUsb).toContain('OutputPathFile')
    expect(makeUsb).toContain('verify-portable-layout.mjs')
  })

  test('source snapshot rejects dirty trees and commit changes after the gate', () => {
    const root = makeRepo('1.2.1')
    runGit(root, ['init'])
    runGit(root, ['add', '.'])
    runGit(root, ['-c', 'user.name=XJC Test', '-c', 'user.email=xjc@example.test', 'commit', '-m', 'baseline'])
    const expected = captureCleanSourceSnapshot(root)
    expect(expected).toMatch(/^[0-9a-f]{40}$/)
    expect(assertSourceSnapshot(expected, root)).toBe(expected)

    write(resolve(root, 'dirty.txt'), 'dirty')
    expect(() => captureCleanSourceSnapshot(root)).toThrow('must be clean')
    expect(() => assertSourceSnapshot(expected, root)).toThrow('working tree changed')

    rmSync(resolve(root, 'dirty.txt'))
    write(resolve(root, 'package.json'), `${JSON.stringify({ name: 'XiaoJuClaw', version: '1.2.1', next: true })}\n`)
    runGit(root, ['add', 'package.json'])
    runGit(root, ['-c', 'user.name=XJC Test', '-c', 'user.email=xjc@example.test', 'commit', '-m', 'next'])
    expect(() => assertSourceSnapshot(expected, root)).toThrow('Source commit changed')
  })

  test('Windows updater builds require signed NSIS artifacts and a bundled portable key', () => {
    const buildRelease = readFileSync(resolve(import.meta.dir, '..', 'build-release.bat'), 'utf8')
    const updaterConfig = JSON.parse(readFileSync(
      resolve(import.meta.dir, '..', 'src-tauri', 'tauri.windows-updater.conf.json'),
      'utf8',
    ))
    const portableKey = JSON.parse(readFileSync(
      resolve(import.meta.dir, '..', 'src-tauri', 'portable-update-key.json'),
      'utf8',
    ))
    expect(buildRelease).toContain('TAURI_SIGNING_PRIVATE_KEY_PATH')
    expect(buildRelease).toContain('set /p TAURI_SIGNING_PRIVATE_KEY=<"%TAURI_SIGNING_PRIVATE_KEY_PATH%"')
    expect(buildRelease).toContain('bun run build:tauri:updater')
    expect(updaterConfig.bundle).toMatchObject({
      createUpdaterArtifacts: true,
      targets: ['nsis'],
    })
    expect(portableKey.keyId).toMatch(/^xjc-portable-[a-f0-9]{12}$/)
    expect(Buffer.from(portableKey.publicKey, 'base64')).toHaveLength(32)
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

  test('signed Windows installer artifacts require the updater signature sidecar', async () => {
    const repoRoot = makeRepo('1.2.1')
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-installer-artifact-'))
    roots.push(artifactRoot)
    write(resolve(artifactRoot, 'XiaoJuClaw_1.2.1_x64-setup.exe'), 'installer')
    writeArtifactMetadata(repoRoot, artifactRoot, 'windows-installer')
    await expect(createArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow('missing its Tauri updater .sig')
    write(resolve(artifactRoot, 'XiaoJuClaw_1.2.1_x64-setup.exe.sig'), 'signature')
    await expect(createArtifactManifest(artifactRoot, repoRoot)).resolves.toBeDefined()
  })

  test('offline installer artifacts require NSIS setup and reject updater signatures', async () => {
    const repoRoot = makeRepo('1.2.1')
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-offline-installer-artifact-'))
    roots.push(artifactRoot)
    writeArtifactMetadata(repoRoot, artifactRoot, 'offline-installer')

    await expect(createArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow(
      'missing its NSIS setup executable',
    )
    write(resolve(artifactRoot, 'XiaoJuClaw_1.2.1_x64-setup.exe'), 'offline installer')
    await expect(createArtifactManifest(artifactRoot, repoRoot)).resolves.toBeDefined()

    write(resolve(artifactRoot, 'XiaoJuClaw_1.2.1_x64-setup.exe.sig'), 'must not ship')
    await expect(createArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow(
      'must not contain updater signature sidecars',
    )
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

  test('rejects artifacts produced from a dirty working tree', async () => {
    const repoRoot = makeRepo('1.1.0')
    const artifactRoot = mkdtempSync(resolve(tmpdir(), 'xjc-artifact-'))
    roots.push(artifactRoot)
    write(resolve(artifactRoot, 'payload.bin'), 'release payload')
    writeArtifactMetadata(repoRoot, artifactRoot)

    const provenancePath = resolve(artifactRoot, 'build-provenance.json')
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
    provenance.source.dirty = true
    write(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)

    await expect(createArtifactManifest(artifactRoot, repoRoot)).rejects.toThrow(
      'not built from a clean working tree',
    )
  })
})
