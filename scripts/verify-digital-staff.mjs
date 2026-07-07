/**
 * verify-digital-staff.mjs — 数字员工聚合验收（T-D9）
 *
 * 用法：bun scripts/verify-digital-staff.mjs
 *
 * 检查项（全部通过退出码 0，任一失败退出码 1 并列出明细）：
 *   1. 9 个内置技能目录齐全：SKILL.md 存在且 frontmatter 含 name/description
 *   2. 5 个脚本技能的构建产物 .mjs 存在且非空
 *   3. skills-dev golden 测试全绿（bun test）
 *   4. 预置数字员工模板：office-assistant agent.yaml 可解析、8 技能白名单齐全
 *   5. 工作台任务卡配置：9 张卡、promptTemplate 双语、绑定 office-assistant
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
    const expected = SKILLS.map((s) => s.slug)
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
    const missing = expected.filter((s) => !skills.includes(s))
    check('office-assistant 模板', parsed?.id === 'office-assistant' && missing.length === 0,
      missing.length ? `缺技能: ${missing.join(',')}` : 'id 不匹配')
  }
} catch (err) {
  check('office-assistant 模板', false, String(err))
}

// ── 5. 工作台任务卡 ────────────────────────────────────────────────
try {
  const cardsSrc = readFileSync(resolve(REPO, 'web/src/config/workbench-tasks.ts'), 'utf8')
  const cardIds = [...cardsSrc.matchAll(/^\s{4}id:\s*'([a-z-]+)'/gm)].map((m) => m[1])
  check('工作台任务卡数量(9)', cardIds.length === 9, `实际 ${cardIds.length}: ${cardIds.join(',')}`)
  check('工作台绑定 office-assistant', /WORKBENCH_AGENT_ID = 'office-assistant'/.test(cardsSrc))
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
