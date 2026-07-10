#!/usr/bin/env bun
// [XJC-PATCH] Create and verify deterministic release artifact hashes.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDesktopVersions, assertReleaseVersion } from './desktop-version.mjs'
import { validateSbom } from './generate-sbom.mjs'
import { hashProvenanceInputs } from './write-build-provenance.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const ARTIFACT_MANIFEST = 'artifact-manifest.json'
export const PROVENANCE_FILE = 'build-provenance.json'
export const SBOM_FILE = 'sbom.cdx.json'

function relativePath(root, path) {
  return relative(root, path).replaceAll('\\', '/')
}

function listArtifactFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) {
        throw new Error(`Release artifacts must not contain symlinks: ${relativePath(root, path)}`)
      }
      if (stats.isDirectory()) pending.push(path)
      else if (stats.isFile() && relativePath(root, path) !== ARTIFACT_MANIFEST) files.push(path)
    }
  }
  return files.sort((left, right) => relativePath(root, left).localeCompare(relativePath(root, right), 'en'))
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function describeFiles(root) {
  return Promise.all(listArtifactFiles(root).map(async (path) => ({
    path: relativePath(root, path),
    size: statSync(path).size,
    sha256: await sha256File(path),
  })))
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function validateArtifactMetadata(artifactRoot, repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(artifactRoot)
  const sourceRoot = resolve(repoRoot)
  const provenancePath = resolve(root, PROVENANCE_FILE)
  const sbomPath = resolve(root, SBOM_FILE)
  if (!existsSync(provenancePath)) throw new Error(`Missing ${PROVENANCE_FILE}`)
  if (!existsSync(sbomPath)) throw new Error(`Missing ${SBOM_FILE}`)

  const expectedVersion = assertDesktopVersions(sourceRoot)
  const provenance = readJson(provenancePath, PROVENANCE_FILE)
  if (
    provenance?.schemaVersion !== 1
    || provenance?.product !== 'XiaoJuClaw'
    || provenance?.version !== expectedVersion
  ) {
    throw new Error(`${PROVENANCE_FILE} does not describe XiaoJuClaw ${expectedVersion}`)
  }
  assertReleaseVersion(provenance.version)
  if (!provenance.variant || provenance.variant === 'unknown') {
    throw new Error(`${PROVENANCE_FILE} has no release variant`)
  }
  if (!provenance.builtAt || Number.isNaN(Date.parse(provenance.builtAt))) {
    throw new Error(`${PROVENANCE_FILE} has no valid build timestamp`)
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.source?.commit || '')) {
    throw new Error(`${PROVENANCE_FILE} has no source commit`)
  }
  if (!provenance.source?.branch || typeof provenance.source.branch !== 'string') {
    throw new Error(`${PROVENANCE_FILE} has no source branch`)
  }
  if (typeof provenance.source?.dirty !== 'boolean') {
    throw new Error(`${PROVENANCE_FILE} has no source dirty-state`)
  }
  const expectedInputs = hashProvenanceInputs(sourceRoot)
  if (JSON.stringify(provenance.source?.inputs) !== JSON.stringify(expectedInputs)) {
    throw new Error(`${PROVENANCE_FILE} source input hashes do not match this checkout`)
  }

  const sbom = validateSbom(readJson(sbomPath, SBOM_FILE))
  if (sbom.metadata.component.version !== provenance.version) {
    throw new Error(`${SBOM_FILE} version does not match ${PROVENANCE_FILE}`)
  }
  return { root, provenance, sbom }
}

export async function createArtifactManifest(artifactRoot, repoRoot = DEFAULT_REPO_ROOT) {
  const { root, provenance } = validateArtifactMetadata(artifactRoot, repoRoot)
  const manifest = {
    schemaVersion: 1,
    product: 'XiaoJuClaw',
    version: provenance.version,
    variant: provenance.variant,
    algorithm: 'sha256',
    files: await describeFiles(root),
  }
  const output = resolve(root, ARTIFACT_MANIFEST)
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { output, manifest }
}

export async function verifyArtifactManifest(artifactRoot, repoRoot = DEFAULT_REPO_ROOT) {
  const { root, provenance } = validateArtifactMetadata(artifactRoot, repoRoot)
  const manifestPath = resolve(root, ARTIFACT_MANIFEST)
  if (!existsSync(manifestPath)) throw new Error(`Missing ${ARTIFACT_MANIFEST}`)
  const manifest = readJson(manifestPath, ARTIFACT_MANIFEST)
  if (
    manifest?.schemaVersion !== 1
    || manifest?.product !== 'XiaoJuClaw'
    || manifest?.version !== provenance.version
    || manifest?.variant !== provenance.variant
    || manifest?.algorithm !== 'sha256'
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`${ARTIFACT_MANIFEST} metadata is invalid`)
  }

  const actual = await describeFiles(root)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    const expectedPaths = new Set(manifest.files.map((file) => file.path))
    const actualPaths = new Set(actual.map((file) => file.path))
    const missing = [...expectedPaths].filter((path) => !actualPaths.has(path))
    const extra = [...actualPaths].filter((path) => !expectedPaths.has(path))
    const changed = actual
      .filter((file) => {
        const expected = manifest.files.find((candidate) => candidate.path === file.path)
        return expected && (expected.size !== file.size || expected.sha256 !== file.sha256)
      })
      .map((file) => file.path)
    const detail = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `extra: ${extra.join(', ')}` : '',
      changed.length ? `changed: ${changed.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`Artifact hash verification failed${detail ? ` (${detail})` : ''}`)
  }
  return { root, manifest }
}

if (import.meta.main) {
  const [command, artifactRoot] = process.argv.slice(2)
  if (!artifactRoot || !['write', 'verify'].includes(command)) {
    console.error('Usage: bun scripts/release-artifacts.mjs write|verify <artifact-root>')
    process.exit(2)
  }
  try {
    if (command === 'write') {
      const { output, manifest } = await createArtifactManifest(artifactRoot)
      console.log(`[OK] Artifact hashes written (${manifest.files.length} files): ${output}`)
    } else {
      const { root, manifest } = await verifyArtifactManifest(artifactRoot)
      console.log(`[OK] Artifact hashes and provenance verified (${manifest.files.length} files): ${root}`)
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
