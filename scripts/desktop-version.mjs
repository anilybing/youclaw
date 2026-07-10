#!/usr/bin/env bun
// [XJC-PATCH] Keep every desktop release-version source in sync.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')

export const VERSION_FILES = Object.freeze({
  packageJson: 'package.json',
  tauriConfig: 'src-tauri/tauri.conf.json',
  cargoManifest: 'src-tauri/Cargo.toml',
  cargoLock: 'src-tauri/Cargo.lock',
  tauriPackageJson: 'src-tauri/package.json',
})

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function assertReleaseVersion(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`Invalid desktop release version: ${String(version)}`)
  }
  return version
}

function readJsonVersion(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return assertReleaseVersion(parsed.version)
}

function readCargoPackageVersion(path, packageName) {
  const text = readFileSync(path, 'utf8')
  const packageBlocks = text.split(/(?=^\[\[?package\]?\][ \t]*\r?$)/m)
  const block = packageBlocks.find((candidate) => {
    if (!candidate.startsWith('[package]') && !candidate.startsWith('[[package]]')) return false
    const name = candidate.match(/^name\s*=\s*"([^"]+)"/m)
    return name?.[1] === packageName
  })
  if (!block) throw new Error(`Package ${packageName} not found in ${path}`)
  const match = block.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error(`Package ${packageName} has no version in ${path}`)
  return assertReleaseVersion(match[1])
}

export function readDesktopVersions(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot)
  return {
    [VERSION_FILES.packageJson]: readJsonVersion(resolve(root, VERSION_FILES.packageJson)),
    [VERSION_FILES.tauriConfig]: readJsonVersion(resolve(root, VERSION_FILES.tauriConfig)),
    [VERSION_FILES.cargoManifest]: readCargoPackageVersion(
      resolve(root, VERSION_FILES.cargoManifest),
      'XiaoJuClaw',
    ),
    [VERSION_FILES.cargoLock]: readCargoPackageVersion(
      resolve(root, VERSION_FILES.cargoLock),
      'XiaoJuClaw',
    ),
    [VERSION_FILES.tauriPackageJson]: readJsonVersion(
      resolve(root, VERSION_FILES.tauriPackageJson),
    ),
  }
}

export function assertDesktopVersions(repoRoot = DEFAULT_REPO_ROOT) {
  const versions = readDesktopVersions(repoRoot)
  const unique = [...new Set(Object.values(versions))]
  if (unique.length !== 1) {
    const detail = Object.entries(versions)
      .map(([file, version]) => `  ${file}: ${version}`)
      .join('\n')
    throw new Error(`Desktop release versions are inconsistent:\n${detail}`)
  }
  return unique[0]
}

function replaceFirstJsonVersion(text, version, path) {
  let replaced = false
  const output = text.replace(/("version"\s*:\s*")([^"]+)(")/, (_match, before, _old, after) => {
    replaced = true
    return `${before}${version}${after}`
  })
  if (!replaced) throw new Error(`No JSON version field found in ${path}`)
  return output
}

function replacePackageVersion(text, packageName, version, path) {
  const headers = [...text.matchAll(/^\[{1,2}[^\]\r\n]+\]{1,2}[ \t]*\r?$/gm)]
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    const headerText = header[0].trim()
    if (headerText !== '[package]' && headerText !== '[[package]]') continue
    const start = header.index
    const end = headers[index + 1]?.index ?? text.length
    const block = text.slice(start, end)
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)
    if (name?.[1] !== packageName) continue
    const next = block.replace(
      /(^version\s*=\s*")[^"]+(")/m,
      (_match, before, after) => `${before}${version}${after}`,
    )
    if (next === block) throw new Error(`Package ${packageName} has no version in ${path}`)
    return `${text.slice(0, start)}${next}${text.slice(end)}`
  }
  throw new Error(`Package ${packageName} not found in ${path}`)
}

export function setDesktopVersion(version, repoRoot = DEFAULT_REPO_ROOT) {
  assertReleaseVersion(version)
  const root = resolve(repoRoot)
  const edits = []

  for (const relative of [
    VERSION_FILES.packageJson,
    VERSION_FILES.tauriConfig,
    VERSION_FILES.tauriPackageJson,
  ]) {
    const path = resolve(root, relative)
    const current = readFileSync(path, 'utf8')
    edits.push([path, replaceFirstJsonVersion(current, version, path)])
  }

  for (const relative of [VERSION_FILES.cargoManifest, VERSION_FILES.cargoLock]) {
    const path = resolve(root, relative)
    const current = readFileSync(path, 'utf8')
    edits.push([path, replacePackageVersion(current, 'XiaoJuClaw', version, path)])
  }

  for (const [path, content] of edits) writeFileSync(path, content, 'utf8')
  return assertDesktopVersions(root)
}

function usage() {
  console.error('Usage: bun scripts/desktop-version.mjs check | set <semver>')
}

if (import.meta.main) {
  const [command = 'check', version] = process.argv.slice(2)
  try {
    if (command === 'check') {
      console.log(`[OK] Desktop release version: ${assertDesktopVersions()}`)
    } else if (command === 'set' && version) {
      console.log(`[OK] Desktop release version set to ${setDesktopVersion(version)}`)
    } else {
      usage()
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
