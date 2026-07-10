#!/usr/bin/env bun
// [XJC] Write reproducible source metadata beside release artifacts.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertDesktopVersions,
  assertReleaseVersion,
} from './desktop-version.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const PROVENANCE_INPUTS = Object.freeze([
  'package.json',
  'bun.lock',
  'web/bun.lock',
  'src/config/build-constants.ts',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.no-updater.conf.json',
  'src-tauri/tauri.windows.conf.json',
])

function git(repoRoot, args) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim()
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function hashProvenanceInputs(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot)
  return Object.fromEntries(PROVENANCE_INPUTS.map((relative) => [
    relative,
    sha256File(resolve(root, relative)),
  ]))
}

export function createProvenance({
  repoRoot = DEFAULT_REPO_ROOT,
  version,
  variant,
  builtAt = new Date().toISOString(),
}) {
  const root = resolve(repoRoot)
  assertReleaseVersion(version)
  if (!variant || variant === 'unknown') throw new Error('A release variant is required')
  const desktopVersion = assertDesktopVersions(root)
  if (version !== desktopVersion) {
    throw new Error(`Provenance version ${version} does not match desktop version ${desktopVersion}`)
  }
  const status = git(root, ['status', '--porcelain'])
  return {
    schemaVersion: 1,
    product: 'XiaoJuClaw',
    version,
    variant,
    builtAt,
    source: {
      commit: git(root, ['rev-parse', 'HEAD']) ?? 'unknown',
      branch: git(root, ['branch', '--show-current']) || 'detached',
      dirty: status === null ? null : status.length > 0,
      inputs: hashProvenanceInputs(root),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
    },
  }
}

export function writeProvenance(outputArg, options) {
  const output = resolve(outputArg)
  const payload = createProvenance(options)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { output, payload }
}

if (import.meta.main) {
  const [outputArg, version, variant] = process.argv.slice(2)
  if (!outputArg || !version || !variant) {
    console.error('Usage: bun scripts/write-build-provenance.mjs <output.json> <version> <variant>')
    process.exit(2)
  }
  try {
    const { output, payload } = writeProvenance(outputArg, {
      repoRoot: DEFAULT_REPO_ROOT,
      version,
      variant,
    })
    console.log(`[OK] Build provenance: ${output}`)
    if (payload.source.dirty) {
      console.warn('[WARN] Build provenance records a dirty working tree.')
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
