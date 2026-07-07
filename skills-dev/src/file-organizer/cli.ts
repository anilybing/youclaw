/**
 * file-organizer — 文件整理脚本（T-D6）
 *
 * 用法：
 *   bun organize.mjs --dir <目录> --rule bytype|bydate [--apply]
 *
 * 安全设计（对应技能红线）：
 *   - 默认 dry-run：只输出移动计划 JSON，不动任何文件
 *   - --apply 才执行；只做"移动到子目录"，永不删除、永不覆盖（重名自动加序号）
 *   - 只处理目标目录第一层的文件（不递归、不碰子目录）
 *   - 拒绝整理危险目录：盘符根目录、用户主目录本身、系统目录
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

interface MovePlan { from: string; to: string; category: string }

const CATEGORY_BY_EXT: Record<string, string> = {
  '.doc': '文档', '.docx': '文档', '.pdf': '文档', '.txt': '文档', '.md': '文档', '.rtf': '文档', '.wps': '文档',
  '.xls': '表格', '.xlsx': '表格', '.csv': '表格', '.et': '表格',
  '.ppt': '演示', '.pptx': '演示', '.dps': '演示',
  '.jpg': '图片', '.jpeg': '图片', '.png': '图片', '.gif': '图片', '.webp': '图片', '.bmp': '图片', '.svg': '图片',
  '.mp3': '音视频', '.wav': '音视频', '.mp4': '音视频', '.mov': '音视频', '.avi': '音视频', '.mkv': '音视频',
  '.zip': '压缩包', '.rar': '压缩包', '.7z': '压缩包', '.tar': '压缩包', '.gz': '压缩包',
  '.exe': '程序', '.msi': '程序', '.bat': '程序', '.ps1': '程序',
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv: string[]): { dir: string; rule: string; apply: boolean } {
  let dir = ''
  let rule = ''
  let apply = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') dir = argv[++i] ?? ''
    else if (arg === '--rule') rule = argv[++i] ?? ''
    else if (arg === '--apply') apply = true
  }
  if (!dir) fail('缺少 --dir 参数（要整理的目录）')
  if (rule !== 'bytype' && rule !== 'bydate') fail('--rule 必须为 bytype 或 bydate')
  return { dir: resolve(dir), rule, apply }
}

function assertSafeDir(dir: string): void {
  if (!existsSync(dir)) fail(`目录不存在: ${dir}`)
  if (!statSync(dir).isDirectory()) fail(`不是目录: ${dir}`)
  // 盘符根（C:\、D:\）与 POSIX 根
  if (/^[a-zA-Z]:[\\/]?$/.test(dir) || dir === '/') fail('安全保护：不允许整理磁盘根目录')
  const home = resolve(homedir())
  if (resolve(dir) === home) fail('安全保护：不允许整理用户主目录本身，请指定其中的子目录')
  const lower = dir.toLowerCase()
  if (lower.includes('\\windows') || lower.includes('\\program files') || lower.includes('xiaojuclawdata\\tools')) {
    fail('安全保护：系统目录或工具目录不允许整理')
  }
}

function categorize(file: string, rule: string, dir: string): string {
  if (rule === 'bytype') {
    return CATEGORY_BY_EXT[extname(file).toLowerCase()] ?? '其他'
  }
  const mtime = statSync(join(dir, file)).mtime
  return `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}`
}

function buildPlan(dir: string, rule: string): MovePlan[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const plan: MovePlan[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'desktop.ini' || entry.name === '整理报告.md') continue
    const category = categorize(entry.name, rule, dir)
    plan.push({ from: join(dir, entry.name), to: join(dir, category, entry.name), category })
  }
  return plan
}

/** 目标已存在时自动加序号后缀：a.txt → a (1).txt，永不覆盖 */
function resolveConflict(target: string): string {
  if (!existsSync(target)) return target
  const ext = extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`
    if (!existsSync(candidate)) return candidate
  }
  fail(`同名文件过多，无法安置: ${basename(target)}`)
}

function applyPlan(dir: string, plan: MovePlan[]): { moved: number; report: string } {
  let moved = 0
  const lines: string[] = ['# 整理报告', '', `- 目录：${dir}`, `- 时间：${new Date().toLocaleString('zh-CN')}`, '']
  const byCategory = new Map<string, string[]>()
  for (const item of plan) {
    mkdirSync(join(dir, item.category), { recursive: true })
    const target = resolveConflict(item.to)
    renameSync(item.from, target)
    moved += 1
    const list = byCategory.get(item.category) ?? []
    list.push(`${basename(item.from)}${target !== item.to ? `（重名，存为 ${basename(target)}）` : ''}`)
    byCategory.set(item.category, list)
  }
  for (const [category, files] of byCategory) {
    lines.push(`## ${category}（${files.length}）`, ...files.map((f) => `- ${f}`), '')
  }
  lines.push('> 本次整理只做移动，未删除任何文件；如需撤销，把文件从分类子目录移回即可。')
  const reportPath = join(dir, '整理报告.md')
  writeFileSync(reportPath, lines.join('\n'), 'utf8')
  return { moved, report: reportPath }
}

function main(): void {
  const { dir, rule, apply } = parseArgs(process.argv.slice(2))
  assertSafeDir(dir)
  const plan = buildPlan(dir, rule)

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      dir,
      rule,
      count: plan.length,
      moves: plan.map((p) => ({ from: basename(p.from), to: join(p.category, basename(p.from)) }))
    }))
    return
  }

  const { moved, report } = applyPlan(dir, plan)
  console.log(JSON.stringify({ ok: true, dryRun: false, dir, rule, moved, report }))
}

main()
