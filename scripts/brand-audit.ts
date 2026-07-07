/**
 * brand-audit.ts — 品牌与外链审计门禁（T-B7）
 *
 * 扫描 git 跟踪文件中的上游品牌残留与危险外跳，作为发布门禁：
 *   bun run brand-audit          # 有违规 exit 1 并列出 文件:行号:关键字
 *
 * 规则：
 *   1) 关键字黑名单（大小写不敏感）：上游品牌/云端点/公共 token/占位符/上游反馈表单
 *   2) clawhub 仅允许出现在技能市场源实现文件（第三方源开关由远程配置控制）
 *   3) web/src 中 openExternal(...) 的实参：
 *        字符串字面量必须命中允许前缀；变量必须在允许标识符清单内
 *
 * 白名单维护在本文件顶部常量；新增豁免必须写 reason。
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')

// ---- 关键字黑名单 -----------------------------------------------------------

const BANNED_KEYWORDS = [
  'CodePhiliaX',
  'readmex',
  'chat2db',
  'XiaoJuClaw.dev',
  'UPDATER_ENDPOINT_PLACEHOLDER',
  'youclaw-builtin-cloud-model',
  'feishu.cn/share', // 上游反馈表单
]

// clawhub：仅技能市场源实现与其 UI 表面允许出现
// （clawhub 是可选第三方源，默认关闭由远程配置控制，见 T-C6；非品牌违规）
const CLAWHUB_ALLOWED_FILES = [
  /^src\/skills\//,
  /^src\/routes\/registry\.ts$/,
  /^src\/routes\/settings\.ts$/,
  /^src\/settings\//,
  /^web\/src\/lib\/registry-source\.ts$/,
  /^web\/src\/stores\/app-runtime\.ts$/,
  /^web\/src\/api\/client\.ts$/,
  /^web\/src\/components\/SkillImportPanel\.tsx$/,
  /^web\/src\/components\/settings\/MarketplacePanel\.tsx$/,
  /^web\/src\/components\/skills\//,
  /^web\/src\/pages\/Skills\.tsx$/,
  /^web\/src\/i18n\//,
  /^tests\//,
  /^web\/tests\//,
]

// "youclaw"（含大小写变体）豁免：功能性 legacy 常量 / 自有仓库地址 / 文档致谢
const YOUCLAW_ALLOW: Array<{ file: RegExp; pattern?: RegExp; reason: string }> = [
  { file: /^package\.json$/, pattern: /anilybing\/youclaw|CodePhiliaX/i, reason: '自有 fork 仓库地址（repository 字段）' },
  { file: /^app\.config\.ts$/, pattern: /anilybing\/youclaw/i, reason: '自有 fork 仓库地址' },
  { file: /^(README|AGENTS|CLAUDE)/, reason: '上游致谢与来源说明' },
  { file: /^\.claude\//, reason: '内部开发命令文档（引用自有 fork 仓库名）' },
  { file: /^docs\//, reason: '上游文档留档' },
  { file: /^LICENSE$/, reason: '许可证' },
  { file: /^scripts\/brand-audit\.ts$/, reason: '审计脚本自身' },
  { file: /^scripts\/build-sidecar\.mjs$/, pattern: /YOUCLAW_/, reason: 'legacy 环境变量别名兼容（仅 .env.production 解析）' },
  { file: /^src\/config\/env\.ts$/, pattern: /YOUCLAW_/, reason: 'legacy 环境变量别名映射' },
  { file: /^src\/config\/paths\.ts$/, pattern: /youclaw/i, reason: 'legacy 数据目录迁移常量' },
  { file: /^\.github\//, reason: 'CI 工作流（仓库名引用）' },
  { file: /^e2e\//, reason: '端到端测试夹具' },
  { file: /^tests\//, pattern: /youclaw/i, reason: '测试夹具中的 legacy 路径断言' },
  { file: /^src\/openclaw/, reason: 'OpenClaw 兼容层目录名（非品牌）' },
  { file: /^skills(-dev)?\//, reason: '技能文档提及生态名称' },
  { file: /^prompts\//, reason: '提示词中的生态说明' },
]

// ---- openExternal 白名单 ----------------------------------------------------

const EXTERNAL_URL_PREFIXES = [
  'https://www.xiaojuclaw.top',
  'https://cdn.xiaojuclaw.top',
  'https://github.com/anilybing',
  'mailto:',
]

const EXTERNAL_IDENT_ALLOW = [
  'appConfig.github',
  'appConfig.siteBase',
  'appConfig.websiteUrl',
  'appConfig.docsBase',
  'feedbackUrl',
  'guidance.url',
  'externalUrl',
  'channel.docsUrl',
  'typeInfo.docsUrl',
  'CUSTOM_MODEL_DOCS_URL',
  'url', // link-safety-modal 的通用参数（经 LinkSafetyModal 用户确认层）
  'href',
  'GITHUB_URL',
]

// ---- 扫描实现 ---------------------------------------------------------------

const SCAN_EXT = /\.(ts|tsx|rs|json|html|md|bat|mjs|ps1|ya?ml)$/
const SKIP_FILES = /^(bun\.lock|web\/bun\.lock|skills-dev\/bun\.lock|src-tauri\/Cargo\.lock|src-tauri\/gen\/)/

interface Violation { file: string; line: number; detail: string }

function listFiles(): string[] {
  const out = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' })
  return out.split(/\r?\n/).filter((f) => f && SCAN_EXT.test(f) && !SKIP_FILES.test(f))
}

function isYouclawAllowed(file: string, lineText: string): boolean {
  return YOUCLAW_ALLOW.some((rule) => {
    if (!rule.file.test(file)) return false
    return rule.pattern ? rule.pattern.test(lineText) : true
  })
}

function checkKeywords(file: string, lines: string[], violations: Violation[]): void {
  lines.forEach((text, idx) => {
    const lower = text.toLowerCase()
    for (const kw of BANNED_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        violations.push({ file, line: idx + 1, detail: `banned keyword: ${kw}` })
      }
    }
    if (lower.includes('clawhub') && !CLAWHUB_ALLOWED_FILES.some((re) => re.test(file))) {
      violations.push({ file, line: idx + 1, detail: 'clawhub outside registry whitelist' })
    }
    // "youclaw" 大小写变体（排除 XiaoJuClaw 自身品牌词后再查）
    const scrubbed = text.replace(/XiaoJuClaw/gi, '')
    if (/youclaw/i.test(scrubbed) && !isYouclawAllowed(file, text)) {
      violations.push({ file, line: idx + 1, detail: 'upstream brand: youclaw' })
    }
  })
}

function checkOpenExternal(file: string, lines: string[], violations: Violation[]): void {
  if (!file.startsWith('web/src/')) return
  if (file === 'web/src/api/transport.ts') return // openExternal 定义处
  lines.forEach((text, idx) => {
    const regex = /openExternal\(\s*([^)]*)\)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const arg = (match[1] || '').trim()
      if (!arg) continue
      const literal = arg.match(/^["'`](.+?)["'`]$/)
      if (literal) {
        const target = literal[1] ?? ''
        if (target && !EXTERNAL_URL_PREFIXES.some((p) => target.startsWith(p))) {
          violations.push({ file, line: idx + 1, detail: `openExternal literal not whitelisted: ${target}` })
        }
        continue
      }
      const ident = arg.replace(/\s+/g, '')
      if (!EXTERNAL_IDENT_ALLOW.some((ok) => ident === ok || ident.startsWith(`${ok},`))) {
        violations.push({ file, line: idx + 1, detail: `openExternal variable not whitelisted: ${arg}` })
      }
    }
  })
}

function main(): void {
  const files = listFiles()
  const violations: Violation[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(resolve(REPO, file), 'utf8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    checkKeywords(file, lines, violations)
    checkOpenExternal(file, lines, violations)
  }

  if (violations.length > 0) {
    console.error(`brand-audit FAILED: ${violations.length} violation(s)`) // eslint-disable-line no-console
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.detail}`) // eslint-disable-line no-console
    }
    process.exit(1)
  }
  console.log(`brand-audit OK (${files.length} files scanned)`) // eslint-disable-line no-console
}

main()
