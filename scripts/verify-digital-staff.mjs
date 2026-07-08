/**
 * verify-digital-staff.mjs — 数字员工聚合验收（T-D9）
 *
 * 用法：bun scripts/verify-digital-staff.mjs
 *
 * 检查项（全部通过退出码 0，任一失败退出码 1 并列出明细）：
 *   1. 19 个内置技能目录齐全：SKILL.md 存在且 frontmatter 含 name/description
 *   2. 6 个脚本技能的构建产物 .mjs 存在且非空
 *   3. skills-dev golden 测试全绿（bun test）
 *   4. 预置数字员工模板：office-assistant（10 办公/简报技能）、ecommerce-assistant（7 电商技能）、
 *      content-creator（4 创作技能 + web-search）agent.yaml 可解析、白名单齐全
 *   5. 工作台任务卡配置：22 张卡、promptTemplate 双语、办公卡绑定 office-assistant、
 *      电商卡绑定 ecommerce-assistant、创作卡绑定 content-creator
 *
 * 不覆盖（需人工/真机，见 doc/数字员工验收清单.md）：
 *   真实模型端到端产出、打包后资源加载、U 盘断网场景。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = resolve(import.meta.dir, '..')
const failures = []
const passes = []

function check(name, ok, detail = '') {
  if (ok) passes.push(name)
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// ── 1/2. 技能目录与构建产物 ─────────────────────────────────────────
const SKILLS = [
  { slug: 'office-ppt', script: 'scripts/render.mjs' },
  { slug: 'office-doc', script: 'scripts/render.mjs' },
  { slug: 'office-excel', script: 'scripts/excel.mjs' },
  { slug: 'office-pdf', script: 'scripts/pdf.mjs' },
  { slug: 'file-organizer', script: 'scripts/organize.mjs' },
  { slug: 'meeting-notes', script: null },
  { slug: 'weekly-report', script: null },
  { slug: 'email-draft', script: null },
  // 电商能力包（client-side 零配置）
  { slug: 'ecom-copywriter', script: null },
  { slug: 'ecom-compliance', script: null },
  { slug: 'ecom-analytics', script: null },
  { slug: 'ecom-image', script: 'scripts/image.mjs' },
  // 内容创作能力包（纯 prompt 技能）
  { slug: 'content-article', script: null },
  { slug: 'content-xiaohongshu', script: null },
  { slug: 'content-video-script', script: null },
  { slug: 'content-calendar', script: null },
  // 情报简报能力包（纯 prompt 技能）
  { slug: 'daily-briefing', script: null },
  { slug: 'web-monitor', script: null },
  // 数据分析可视化（纯 prompt 技能）
  { slug: 'data-report', script: null },
  // 财务记账能力包（纯 prompt 技能）
  { slug: 'finance-bookkeeping', script: null },
  { slug: 'finance-invoice', script: null },
  { slug: 'finance-report', script: null },
  { slug: 'finance-budget', script: null },
  // 人事 HR 能力包（纯 prompt 技能）
  { slug: 'hr-jd', script: null },
  { slug: 'hr-resume-screen', script: null },
  { slug: 'hr-interview', script: null },
  { slug: 'hr-docs', script: null },
  // 客服能力包（纯 prompt 技能）
  { slug: 'support-reply', script: null },
  { slug: 'support-faq', script: null },
  { slug: 'support-ticket', script: null },
  { slug: 'support-review', script: null },
  // 研究/知识工作能力包（纯 prompt 技能）
  { slug: 'doc-summarize', script: null },
  { slug: 'research-report', script: null },
  { slug: 'translate', script: null },
  { slug: 'web-extract', script: null },
  { slug: 'mind-map', script: null },
]

// 各预置数字员工的技能白名单（与 templates.ts 的 agent.yaml 对齐）
const OFFICE_ASSISTANT_SKILLS = [
  'office-ppt', 'office-doc', 'office-excel', 'office-pdf',
  'meeting-notes', 'weekly-report', 'email-draft', 'file-organizer',
  'daily-briefing', 'web-monitor',
]
const ECOMMERCE_ASSISTANT_SKILLS = [
  'ecom-copywriter', 'ecom-compliance', 'ecom-image', 'ecom-analytics', 'office-excel', 'office-doc',
  'web-monitor',
]
const CONTENT_CREATOR_SKILLS = [
  'content-article', 'content-xiaohongshu', 'content-video-script', 'content-calendar', 'web-search',
]
const FINANCE_ASSISTANT_SKILLS = [
  'finance-bookkeeping', 'finance-invoice', 'finance-report', 'finance-budget', 'office-excel',
]
const HR_ASSISTANT_SKILLS = [
  'hr-jd', 'hr-resume-screen', 'hr-interview', 'hr-docs',
]
const SUPPORT_ASSISTANT_SKILLS = [
  'support-reply', 'support-faq', 'support-ticket', 'support-review',
]
const RESEARCH_ASSISTANT_SKILLS = [
  'doc-summarize', 'research-report', 'translate', 'web-extract', 'mind-map', 'web-search', 'agent-browser',
]

for (const skill of SKILLS) {
  const dir = resolve(REPO, 'skills', skill.slug)
  const skillMd = resolve(dir, 'SKILL.md')
  if (!existsSync(skillMd)) {
    check(`skill:${skill.slug}`, false, 'SKILL.md 缺失')
    continue
  }
  const head = readFileSync(skillMd, 'utf8').slice(0, 600)
  const hasName = new RegExp(`name:\\s*${skill.slug}`).test(head)
  const hasDesc = /description:\s*.+/.test(head)
  check(`skill:${skill.slug} frontmatter`, hasName && hasDesc, !hasName ? 'name 不匹配' : (!hasDesc ? 'description 缺失' : ''))

  if (skill.script) {
    const scriptPath = resolve(dir, skill.script)
    const ok = existsSync(scriptPath) && statSync(scriptPath).size > 1024
    check(`skill:${skill.slug} 构建产物`, ok, ok ? '' : `${skill.script} 缺失或过小（先跑 skills-dev bun run build:all)`)
  }
}

// ── 3. golden 测试 ──────────────────────────────────────────────────
const testRun = spawnSync('bun', ['test'], { cwd: resolve(REPO, 'skills-dev'), encoding: 'utf8', shell: process.platform === 'win32' })
const testOut = `${testRun.stdout ?? ''}${testRun.stderr ?? ''}`
const failMatch = testOut.match(/(\d+)\s+fail/)
check('skills-dev golden 测试', testRun.status === 0 && failMatch && failMatch[1] === '0',
  testRun.status !== 0 ? `退出码 ${testRun.status}` : '存在失败用例')

// ── 4. 预置数字员工 ─────────────────────────────────────────────────
try {
  const { parse } = await import('yaml')
  const templates = readFileSync(resolve(REPO, 'src/agent/templates.ts'), 'utf8')
  const yamlMatch = templates.match(/OFFICE_ASSISTANT_AGENT_YAML = `\\?\n?([\s\S]*?)`/)
  if (!yamlMatch) {
    check('office-assistant 模板', false, '未找到 OFFICE_ASSISTANT_AGENT_YAML')
  } else {
    const parsed = parse(yamlMatch[1].replace(/\\`/g, '`'))
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
    const missing = OFFICE_ASSISTANT_SKILLS.filter((s) => !skills.includes(s))
    check('office-assistant 模板', parsed?.id === 'office-assistant' && missing.length === 0,
      missing.length ? `缺技能: ${missing.join(',')}` : 'id 不匹配')
  }

  // 电商助理模板：id + 7 技能白名单齐全
  const ecomMatch = templates.match(/ECOMMERCE_ASSISTANT_AGENT_YAML = `\\?\n?([\s\S]*?)`/)
  if (!ecomMatch) {
    check('ecommerce-assistant 模板', false, '未找到 ECOMMERCE_ASSISTANT_AGENT_YAML')
  } else {
    const parsed = parse(ecomMatch[1].replace(/\\`/g, '`'))
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
    const missing = ECOMMERCE_ASSISTANT_SKILLS.filter((s) => !skills.includes(s))
    check('ecommerce-assistant 模板', parsed?.id === 'ecommerce-assistant' && missing.length === 0,
      missing.length ? `缺技能: ${missing.join(',')}` : 'id 不匹配')
  }

  // 创作助理模板：id + 4 创作技能 + web-search 白名单齐全
  const contentMatch = templates.match(/CONTENT_CREATOR_AGENT_YAML = `\\?\n?([\s\S]*?)`/)
  if (!contentMatch) {
    check('content-creator 模板', false, '未找到 CONTENT_CREATOR_AGENT_YAML')
  } else {
    const parsed = parse(contentMatch[1].replace(/\\`/g, '`'))
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
    const missing = CONTENT_CREATOR_SKILLS.filter((s) => !skills.includes(s))
    check('content-creator 模板', parsed?.id === 'content-creator' && missing.length === 0,
      missing.length ? `缺技能: ${missing.join(',')}` : 'id 不匹配')
  }

  // 后台职能能力包：财务/人事/客服助理模板 id + 技能白名单齐全
  const backOffice = [
    { name: 'FINANCE_ASSISTANT', id: 'finance-assistant', skills: FINANCE_ASSISTANT_SKILLS },
    { name: 'HR_ASSISTANT', id: 'hr-assistant', skills: HR_ASSISTANT_SKILLS },
    { name: 'SUPPORT_ASSISTANT', id: 'support-assistant', skills: SUPPORT_ASSISTANT_SKILLS },
    { name: 'RESEARCH_ASSISTANT', id: 'research-assistant', skills: RESEARCH_ASSISTANT_SKILLS },
  ]
  for (const staff of backOffice) {
    const m = templates.match(new RegExp(`${staff.name}_AGENT_YAML = \`\\\\?\\n?([\\s\\S]*?)\``))
    if (!m) {
      check(`${staff.id} 模板`, false, `未找到 ${staff.name}_AGENT_YAML`)
      continue
    }
    const parsed = parse(m[1].replace(/\\`/g, '`'))
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
    const missing = staff.skills.filter((s) => !skills.includes(s))
    check(`${staff.id} 模板`, parsed?.id === staff.id && missing.length === 0,
      missing.length ? `缺技能: ${missing.join(',')}` : 'id 不匹配')
  }
} catch (err) {
  check('数字员工模板', false, String(err))
}

// ── 5. 工作台任务卡 ────────────────────────────────────────────────
try {
  const cardsSrc = readFileSync(resolve(REPO, 'web/src/config/workbench-tasks.ts'), 'utf8')
  const cardIds = [...cardsSrc.matchAll(/^\s{4}id:\s*'([a-z-]+)'/gm)].map((m) => m[1])
  check('工作台任务卡数量(38)', cardIds.length === 38, `实际 ${cardIds.length}: ${cardIds.join(',')}`)
  check('工作台绑定 office-assistant', /WORKBENCH_AGENT_ID = 'office-assistant'/.test(cardsSrc))
  check('电商卡绑定 ecommerce-assistant', /ECOMMERCE_AGENT_ID = 'ecommerce-assistant'/.test(cardsSrc))
  check('创作卡绑定 content-creator', /CONTENT_AGENT_ID = 'content-creator'/.test(cardsSrc))
  // 每张 ecom-* 卡都必须显式绑定 agentId: ECOMMERCE_AGENT_ID（漏绑会误派给办公助理）
  const ecomCardIds = cardIds.filter((id) => id.startsWith('ecom-'))
  const agentBindCount = (cardsSrc.match(/agentId:\s*ECOMMERCE_AGENT_ID/g) ?? []).length
  check('电商卡均显式绑定 ecommerce-assistant', ecomCardIds.length > 0 && agentBindCount === ecomCardIds.length,
    `电商卡 ${ecomCardIds.length} 张 / agentId 绑定 ${agentBindCount} 处`)
  // 每张 content-* 卡都必须显式绑定 agentId: CONTENT_AGENT_ID（漏绑会误派给办公助理）
  const contentCardIds = cardIds.filter((id) => id.startsWith('content-'))
  const contentBindCount = (cardsSrc.match(/agentId:\s*CONTENT_AGENT_ID/g) ?? []).length
  check('创作卡均显式绑定 content-creator', contentCardIds.length > 0 && contentBindCount === contentCardIds.length,
    `创作卡 ${contentCardIds.length} 张 / agentId 绑定 ${contentBindCount} 处`)
  const zhCount = (cardsSrc.match(/zh:/g) ?? []).length
  const enCount = (cardsSrc.match(/en:/g) ?? []).length
  check('任务卡双语文案', zhCount > 20 && enCount > 20 && zhCount === enCount, `zh=${zhCount} en=${enCount}`)
} catch (err) {
  check('工作台任务卡', false, String(err))
}

// ── 输出 ───────────────────────────────────────────────────────────
console.log(`verify-digital-staff: ${passes.length} pass / ${failures.length} fail`)
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`)
  process.exit(1)
}
console.log('  数字员工静态验收全部通过（端到端场景见 doc/数字员工验收清单.md）')
