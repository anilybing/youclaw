import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { minimatch } from 'minimatch'
import type { Skill } from './types.ts'

// Directories and files excluded during scanning
const EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store', 'data'])

/**
 * Scan workspace directory and return relative paths of all files.
 * Excludes .git, node_modules, .DS_Store, data/.
 */
export function scanWorkspaceFiles(workspaceDir: string): string[] {
  const files: string[] = []

  const walk = (directory: string, relativeParts: string[]): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue

      const absolutePath = join(directory, entry.name)
      const nextParts = [...relativeParts, entry.name]
      if (entry.isDirectory()) {
        walk(absolutePath, nextParts)
      } else if (entry.isFile()) {
        files.push(nextParts.join('/'))
      }
    }
  }

  try {
    walk(workspaceDir, [])
    return files
  } catch {
    return []
  }
}

/**
 * Check if a skill's globs match any files in the workspace.
 * - No globs or empty array -> unconditionally included (returns true)
 * - Otherwise checks if any file matches at least one glob pattern
 */
export function matchSkillGlobs(skill: Skill, filePaths: string[]): boolean {
  const globs = skill.frontmatter.globs
  if (!globs || globs.length === 0) return true

  for (const pattern of globs) {
    for (const filePath of filePaths) {
      if (minimatch(filePath, pattern)) return true
    }
  }

  return false
}
