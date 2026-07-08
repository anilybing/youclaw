#!/usr/bin/env bun
/**
 * pack-skills.mjs — 技能包上架物料生成（MVP 私有技能源配套）
 *
 * 把 skills/<slug>/ 打包成 MVP 私有源可批量导入的 zip + manifest.json：
 *
 *   bun scripts/pack-skills.mjs [--skills a,b,c] [--out <目录>] [--version <x.y.z>]
 *
 * 参数：
 *   --skills a,b,c   要打包的技能 slug 列表（逗号分隔），默认打 7 个上架首发技能
 *   --out <目录>     产物输出目录，默认 release/skill-packages（被 .gitignore 忽略）
 *   --version <ver>  写入 zip 文件名与 manifest 的版本号，默认 1.0.0
 *
 * 行为：
 *   1. 递归收集 skills/<slug>/ 全部文件，zip 内路径相对 slug 目录
 *      （保证 SKILL.md 位于 zip 根——桌面端安装约定，不能套一层文件夹）
 *   2. 写 <out>/<slug>-<version>.zip；mtime 固定，保证同内容重复打包 sha256 稳定
 *      （MVP 导入按 slug+version+sha256 幂等判重，sha 漂移会被判为 conflict）
 *   3. 解析各 SKILL.md frontmatter 的 name/description，结合 slug 映射表生成
 *      nameZh/nameEn/summaryZh/category，算 sha256/sizeBytes，输出 manifest.json
 *   4. 自校验：逐个 unzipSync 抽查 zip 根含 SKILL.md、条目数一致、sha256/大小
 *      与 manifest 一致、不超 20MB 上限；任一失败退出码 1
 *
 * manifest 契约（对齐 MVP scripts/import-skill-packages.js）：
 *   { "schemaVersion": 1, "items": [{ "slug","nameZh","nameEn","summaryZh",
 *     "category","version","file","sha256","sizeBytes","minTier" }] }
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { zipSync, unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'

const REPO = resolve(import.meta.dir, '..')

// MVP 服务端 createPackage 的 zip 大小上限（超过会被拒收）
const MAX_ZIP_BYTES = 20 * 1024 * 1024
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/
// 固定 mtime 让 zip 字节可复现（fflate 默认取当前时间，会导致 sha256 每次漂移）
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z')

// 默认上架的 7 个纯 prompt 技能
const DEFAULT_SLUGS = [
  'content-article',
  'content-xiaohongshu',
  'content-video-script',
  'content-calendar',
  'daily-briefing',
  'web-monitor',
  'data-report',
]

// slug → 上架展示信息映射表（优先级最高，保证中文名/分类质量；
// 不在表内的 slug 走 SKILL.md 正文一级标题 / slug 兜底）
const SKILL_META = {
  'content-article': { nameZh: '公众号/知乎长文写作', nameEn: 'Long-form Article Writer', category: 'content' },
  'content-xiaohongshu': { nameZh: '小红书笔记创作', nameEn: 'Xiaohongshu Notes', category: 'content' },
  'content-video-script': { nameZh: '短视频口播脚本', nameEn: 'Short-video Script', category: 'content' },
  'content-calendar': { nameZh: '选题规划与内容日历', nameEn: 'Content Calendar', category: 'content' },
  'daily-briefing': { nameZh: '每日简报', nameEn: 'Daily Briefing', category: 'office' },
  'web-monitor': { nameZh: '网页/竞品监控', nameEn: 'Web Monitor', category: 'ecom' },
  'data-report': { nameZh: '数据报告', nameEn: 'Data Report', category: 'office' },
}

// ---- CLI 参数 ---------------------------------------------------------------

const args = process.argv.slice(2)

function parseArg(name, fallback) {
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return fallback
}

const SLUGS = parseArg('skills', DEFAULT_SLUGS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const OUT_DIR = resolve(REPO, parseArg('out', 'release/skill-packages'))
const VERSION = parseArg('version', '1.0.0')

if (SLUGS.length === 0) {
  console.error('[FAIL] --skills 不能为空（逗号分隔的 slug 列表）')
  process.exit(1)
}
if (!VERSION_RE.test(VERSION)) {
  console.error(`[FAIL] --version 格式必须为 x.y.z，实际: ${VERSION}`)
  process.exit(1)
}

// ---- 工具函数 ---------------------------------------------------------------

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 递归收集目录下全部文件的绝对路径（稳定排序，保证 zip 字节可复现） */
function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 提取 SKILL.md 的 frontmatter 对象与正文（解析失败返回空对象） */
function readSkillMd(skillDir) {
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  let frontmatter = {}
  if (match) {
    try {
      frontmatter = parseYaml(match[1]) ?? {}
    } catch {
      frontmatter = {}
    }
  }
  return { frontmatter, body: match ? raw.slice(match[0].length) : raw }
}

const CJK_RE = /[\u4e00-\u9fff]/

/** description 中英混排 → 取第一句中文作为 summaryZh（超长截断） */
function extractSummaryZh(description) {
  const sentences = String(description || '')
    .split(/(?<=[。！？])/)
    .map((s) => s.trim())
    .filter((s) => s && CJK_RE.test(s))
  let summary = (sentences[0] ?? '').replace(/[。！？]$/, '')
  if (summary.length > 150) summary = `${summary.slice(0, 149)}…`
  return summary
}

/** 正文一级标题提取中文名："# 每日简报（daily-briefing）" → "每日简报" */
function nameZhFromBody(body, slug) {
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''
  const cleaned = h1.replace(new RegExp(`[（(]\\s*${slug}\\s*[）)]\\s*$`), '').trim()
  return CJK_RE.test(cleaned) ? cleaned : ''
}

/** slug 兜底英文名："data-report" → "Data Report" */
function nameEnFromSlug(slug) {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// ---- 打包 -------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })

const items = []
const failures = []

console.log('================ 技能包打包 ================')
console.log(`  skills  : ${SLUGS.join(', ')}`)
console.log(`  out     : ${OUT_DIR}`)
console.log(`  version : ${VERSION}`)
console.log('--------------------------------------------')

for (const slug of SLUGS) {
  const skillDir = resolve(REPO, 'skills', slug)
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    failures.push(`${slug}: skills/${slug}/SKILL.md 不存在`)
    continue
  }

  // 1. 收集文件（zip 内路径相对 slug 目录 → SKILL.md 落在 zip 根）
  const files = walkFiles(skillDir)
  const zipInput = {}
  for (const file of files) {
    const rel = relative(skillDir, file).split('\\').join('/')
    zipInput[rel] = readFileSync(file)
  }

  // 2. 打 zip 并落盘
  const zipBuf = Buffer.from(zipSync(zipInput, { level: 9, mtime: FIXED_MTIME }))
  if (zipBuf.length > MAX_ZIP_BYTES) {
    failures.push(`${slug}: zip ${(zipBuf.length / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`)
    continue
  }
  const zipName = `${slug}-${VERSION}.zip`
  writeFileSync(join(OUT_DIR, zipName), zipBuf)

  // 3. 生成 manifest 条目（映射表 → frontmatter/正文 → slug 逐级兜底）
  const { frontmatter, body } = readSkillMd(skillDir)
  const meta = SKILL_META[slug] ?? {}
  const nameZh = meta.nameZh || nameZhFromBody(body, slug) || String(frontmatter.name || slug)
  const nameEn = meta.nameEn || nameEnFromSlug(slug)
  const summaryZh = extractSummaryZh(frontmatter.description) || nameZh
  items.push({
    slug,
    nameZh,
    nameEn,
    summaryZh,
    category: meta.category || 'office',
    version: VERSION,
    file: zipName,
    sha256: sha256Hex(zipBuf),
    sizeBytes: zipBuf.length,
    minTier: '',
  })
  console.log(`  [packed] ${zipName.padEnd(36)} ${files.length} 个文件, ${zipBuf.length} B`)
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  [FAIL] ${f}`)
  process.exit(1)
}

const manifestPath = join(OUT_DIR, 'manifest.json')
writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`)
console.log(`  [manifest] ${manifestPath}（${items.length} 条）`)

// ---- 自校验 -----------------------------------------------------------------

console.log('--------------------------------------------')
const checkFailures = []
for (const item of items) {
  const zipPath = join(OUT_DIR, item.file)
  const buf = readFileSync(zipPath)
  const problems = []

  if (sha256Hex(buf) !== item.sha256) problems.push('sha256 与 manifest 不一致')
  if (buf.length !== item.sizeBytes) problems.push('sizeBytes 与 manifest 不一致')

  try {
    const entries = unzipSync(new Uint8Array(buf))
    const names = Object.keys(entries).filter((n) => !n.endsWith('/'))
    if (!names.includes('SKILL.md')) problems.push(`zip 根缺少 SKILL.md（实际条目: ${names.slice(0, 5).join(', ')}…）`)
    const srcCount = walkFiles(resolve(REPO, 'skills', item.slug)).length
    if (names.length !== srcCount) problems.push(`zip 条目数 ${names.length} ≠ 源目录文件数 ${srcCount}`)
  } catch (err) {
    problems.push(`unzip 失败: ${err.message}`)
  }

  if (problems.length > 0) checkFailures.push(`${item.file}: ${problems.join('；')}`)
  console.log(`  [${problems.length ? 'BAD ' : 'ok  '}] ${item.file.padEnd(36)} sha256=${item.sha256.slice(0, 12)}…`)
}

if (checkFailures.length > 0) {
  console.error('自校验失败：')
  for (const f of checkFailures) console.error(`  FAIL ${f}`)
  process.exit(1)
}

// ---- 下一步提示 -------------------------------------------------------------

console.log('--------------------------------------------')
console.log(`打包完成：${items.length} 个 zip + manifest.json 自校验全部通过`)
console.log('')
console.log('下一步（在 MVP 仓库导入上架，先 dry-run 预检）：')
console.log(`  cd D:\\code\\MVPClawToC\\mvp; node scripts/import-skill-packages.js --manifest ${manifestPath} --zips ${OUT_DIR} --dry-run`)
console.log('确认无误后去掉 --dry-run 实跑（导入为 draft 草稿）；追加 --publish 则直接发布上架。')
