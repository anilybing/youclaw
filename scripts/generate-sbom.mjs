#!/usr/bin/env bun
// [XJC-PATCH] Generate a deterministic CycloneDX SBOM from committed lockfiles.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDesktopVersions } from './desktop-version.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')

function nextSignificant(text, start) {
  let index = start
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1
      continue
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      index = text.indexOf('\n', index + 2)
      if (index === -1) return text.length
      continue
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      return end === -1 ? text.length : nextSignificant(text, end + 2)
    }
    return index
  }
  return text.length
}

export function stripJsonCommentsAndTrailingCommas(input) {
  const text = input.replace(/^\uFEFF/, '')
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index + 2)
      if (end === -1) break
      output += '\n'
      index = end
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Unterminated JSON block comment')
      index = end + 1
      continue
    }
    if (char === ',') {
      const next = nextSignificant(text, index + 1)
      if (text[next] === '}' || text[next] === ']') continue
    }
    output += char
  }
  if (inString) throw new Error('Unterminated JSON string')
  return output
}

function inferVersion(value) {
  if (!value) return null
  if (!value.includes('://')) return value
  const match = value.match(/(?:^|[-/])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\.tgz|\.zip)?(?:[?#].*)?$/)
  return match?.[1] ?? null
}

function splitResolvedPackage(resolved) {
  const separator = resolved.lastIndexOf('@')
  if (separator <= 0 || separator === resolved.length - 1) return null
  const name = resolved.slice(0, separator)
  const version = inferVersion(resolved.slice(separator + 1))
  if (!name || !version) return null
  return { name, version }
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash > 1) {
      return `pkg:npm/%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodeURIComponent(version)}`
    }
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function npmNameFields(name) {
  if (!name.startsWith('@')) return { name }
  const slash = name.indexOf('/')
  if (slash <= 1) return { name }
  return { group: name.slice(0, slash), name: name.slice(slash + 1) }
}

function integrityHash(integrity) {
  if (typeof integrity !== 'string') return []
  const match = integrity.match(/^sha512-(.+)$/)
  if (!match) return []
  try {
    const hex = Buffer.from(match[1], 'base64').toString('hex')
    return hex ? [{ alg: 'SHA-512', content: hex }] : []
  } catch {
    return []
  }
}

export function parseBunLock(text) {
  const lock = JSON.parse(stripJsonCommentsAndTrailingCommas(text))
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('Bun lockfile has no packages object')
  }

  const components = []
  for (const value of Object.values(lock.packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue
    const parsed = splitResolvedPackage(value[0])
    if (!parsed) continue
    const integrity = [...value].reverse().find((item) => (
      typeof item === 'string' && item.startsWith('sha512-')
    ))
    const purl = npmPurl(parsed.name, parsed.version)
    components.push({
      type: 'library',
      'bom-ref': purl,
      ...npmNameFields(parsed.name),
      version: parsed.version,
      ...(integrityHash(integrity).length > 0 ? { hashes: integrityHash(integrity) } : {}),
      purl,
    })
  }
  return components
}

function cargoPurl(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

export function parseCargoLock(text) {
  const components = []
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1]
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
    if (!name || !version || name === 'XiaoJuClaw') continue
    const checksum = block.match(/^checksum\s*=\s*"([0-9a-fA-F]{64})"/m)?.[1]
    const purl = cargoPurl(name, version)
    components.push({
      type: 'library',
      'bom-ref': purl,
      name,
      version,
      ...(checksum ? { hashes: [{ alg: 'SHA-256', content: checksum.toLowerCase() }] } : {}),
      purl,
    })
  }
  return components
}

function mergeComponents(components) {
  const byRef = new Map()
  for (const component of components) {
    const existing = byRef.get(component['bom-ref'])
    if (!existing) {
      byRef.set(component['bom-ref'], component)
      continue
    }
    if (!existing.hashes && component.hashes) existing.hashes = component.hashes
  }
  return [...byRef.values()].sort((left, right) => (
    left['bom-ref'].localeCompare(right['bom-ref'], 'en')
  ))
}

export function validateSbom(sbom) {
  if (sbom?.bomFormat !== 'CycloneDX' || sbom?.specVersion !== '1.5' || sbom?.version !== 1) {
    throw new Error('SBOM is not CycloneDX 1.5 JSON')
  }
  const application = sbom.metadata?.component
  if (application?.type !== 'application' || application?.name !== 'XiaoJuClaw' || !application?.version) {
    throw new Error('SBOM application metadata is incomplete')
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error('SBOM has no dependency components')
  }
  const refs = new Set()
  for (const component of sbom.components) {
    if (component?.type !== 'library' || !component?.name || !component?.version || !component?.['bom-ref']) {
      throw new Error('SBOM contains an incomplete component')
    }
    if (refs.has(component['bom-ref'])) throw new Error(`Duplicate SBOM component: ${component['bom-ref']}`)
    refs.add(component['bom-ref'])
  }
  return sbom
}

export function createSbom(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot)
  const version = assertDesktopVersions(root)
  const components = mergeComponents([
    ...parseBunLock(readFileSync(resolve(root, 'bun.lock'), 'utf8')),
    ...parseBunLock(readFileSync(resolve(root, 'web', 'bun.lock'), 'utf8')),
    ...parseCargoLock(readFileSync(resolve(root, 'src-tauri', 'Cargo.lock'), 'utf8')),
  ])
  return validateSbom({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/XiaoJuClaw@${encodeURIComponent(version)}`,
        name: 'XiaoJuClaw',
        version,
      },
    },
    components,
  })
}

export function serializeSbom(sbom) {
  return `${JSON.stringify(validateSbom(sbom), null, 2)}\n`
}

export function writeSbom(outputPath, repoRoot = DEFAULT_REPO_ROOT) {
  const output = resolve(outputPath)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, serializeSbom(createSbom(repoRoot)), 'utf8')
  return output
}

if (import.meta.main) {
  const [command = 'check', outputArg] = process.argv.slice(2)
  try {
    if (command === 'check') {
      const sbom = createSbom()
      console.log(`[OK] CycloneDX SBOM: ${sbom.components.length} components`)
    } else if (command === 'write') {
      const version = assertDesktopVersions()
      const output = outputArg || resolve(DEFAULT_REPO_ROOT, 'release', `XiaoJuClaw-${version}.cdx.json`)
      console.log(`[OK] CycloneDX SBOM written: ${writeSbom(output)}`)
    } else {
      console.error('Usage: bun scripts/generate-sbom.mjs check | write [output.json]')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
