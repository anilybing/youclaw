import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { zipSync } from 'fflate'
import { ROOT_DIR } from '../config/paths.ts'
import type { BrowserDiscoveryKind } from './types.ts'

const EXTENSION_DIR_NAME = 'main-browser-chromium'
const EXTENSION_RELATIVE_DIR = resolve('extensions', EXTENSION_DIR_NAME)

export interface BrowserExtensionPackageInfo {
  name: string
  version: string
  directoryPath: string
  installMode: 'unpacked'
  supportedBrowsers: BrowserDiscoveryKind[]
  files: string[]
}

function resolveExtensionDirectoryCandidate(baseDir: string): string {
  return resolve(baseDir, EXTENSION_RELATIVE_DIR)
}

export function resolveBrowserExtensionDirectory(): string {
  const candidates = [
    resolveExtensionDirectoryCandidate(ROOT_DIR),
  ]

  const resourcesDir = process.env.RESOURCES_DIR?.trim()
  if (resourcesDir) {
    candidates.push(resolve(resourcesDir, '_up_', EXTENSION_RELATIVE_DIR))
    candidates.push(resolve(resourcesDir, EXTENSION_RELATIVE_DIR))
  }

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'manifest.json'))) {
      return candidate
    }
  }

  throw new Error('Main browser extension bundle not found')
}

function listFilesRecursive(rootDir: string, currentDir = rootDir): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = resolve(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(rootDir, absolutePath))
      continue
    }
    files.push(relative(rootDir, absolutePath))
  }

  return files.sort()
}

export function getBrowserExtensionPackageInfo(): BrowserExtensionPackageInfo {
  const directoryPath = resolveBrowserExtensionDirectory()
  const manifestPath = resolve(directoryPath, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    name?: string
    version?: string
  }

  return {
    name: manifest.name ?? 'XiaoJuClaw Main Browser Bridge',
    version: manifest.version ?? '0.0.0',
    directoryPath,
    installMode: 'unpacked',
    supportedBrowsers: ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'arc'],
    files: listFilesRecursive(directoryPath),
  }
}

export function buildBrowserExtensionZip(): Uint8Array {
  const info = getBrowserExtensionPackageInfo()
  const zipEntries: Record<string, Uint8Array> = {}

  for (const file of info.files) {
    const absolutePath = resolve(info.directoryPath, file)
    const stats = statSync(absolutePath)
    if (!stats.isFile()) continue
    zipEntries[file] = new Uint8Array(readFileSync(absolutePath))
  }

  return zipSync(zipEntries, { level: 6 })
}
