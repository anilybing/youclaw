import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPaths } from '../config/paths.ts'
import { getEnv } from '../config/env.ts'
import { getLogDates, readLogEntries } from '../logger/reader.ts'

/**
 * 售后诊断接口（P1-3）：
 *
 * GET /api/commercial/diagnostic
 *
 * 返回：版本号、API 地址、运行时信息、便携路径、最近错误日志摘要等。
 * 不返回：用户 Key、激活码明文、JWT、Authorization 头。
 *
 * 该路由属于商业化隔离层，与上游 YouClaw 无关。
 */

const startedAt = new Date().toISOString()
const __dirname = dirname(fileURLToPath(import.meta.url))

interface PackageJson {
  name?: string
  version?: string
}

let cachedVersion: string | null = null
function readSidecarVersion(): string {
  if (cachedVersion) return cachedVersion
  const candidates = [
    resolve(__dirname, '../..', 'package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as PackageJson
      if (pkg.version) {
        cachedVersion = pkg.version
        return pkg.version
      }
    } catch {
      // ignore
    }
  }
  cachedVersion = 'unknown'
  return 'unknown'
}

/**
 * 把 URL 转成只保留 protocol://host:port 的安全形式，去掉 query / 路径里可能出现的 token。
 */
function sanitizeUrl(input: string | undefined | null): string {
  if (!input) return ''
  try {
    const u = new URL(input)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

const SECRET_PATTERNS: Array<RegExp> = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /rdxtoken[":\s=]+["']?[A-Za-z0-9._\-]+["']?/gi,
  /authorization[":\s=]+["']?[A-Za-z0-9._\-\s]+["']?/gi,
  /api[_-]?key[":\s=]+["']?[A-Za-z0-9._\-]+["']?/gi,
  /token[":\s=]+["']?[A-Za-z0-9._\-]{8,}["']?/gi,
  /sk-[A-Za-z0-9]{16,}/g,
]

function maskSecrets(input: string): string {
  let output = input
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]')
  }
  return output
}

interface RecentLogEntry {
  time: number
  level: number
  msg: string
  category: string
}

async function readRecentErrors(limit: number): Promise<RecentLogEntry[]> {
  const dates = getLogDates()
  const collected: RecentLogEntry[] = []
  for (const date of dates) {
    if (collected.length >= limit) break
    const remaining = limit - collected.length
    try {
      const result = await readLogEntries(date, {
        level: 'warn',
        order: 'desc',
        limit: remaining,
      })
      for (const entry of result.entries) {
        collected.push({
          time: entry.time,
          level: entry.level,
          msg: maskSecrets(typeof entry.msg === 'string' ? entry.msg : String(entry.msg ?? '')),
          category: typeof entry.category === 'string' ? entry.category : '',
        })
        if (collected.length >= limit) break
      }
    } catch {
      // ignore one-day failure
    }
  }
  return collected
}

export function createDiagnosticRoutes() {
  const app = new Hono()

  app.get('/commercial/diagnostic', async (c) => {
    const env = getEnv()
    const paths = getPaths()
    const recentErrors = await readRecentErrors(50)

    return c.json({
      generatedAt: new Date().toISOString(),
      sidecar: {
        name: 'XiaoJuClaw-sidecar',
        version: readSidecarVersion(),
        startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : process.version,
      },
      cloud: {
        apiUrl: sanitizeUrl(env.XiaoJuClaw_API_URL),
        websiteUrl: sanitizeUrl(env.XiaoJuClaw_WEBSITE_URL),
        apiUrlConfigured: Boolean(env.XiaoJuClaw_API_URL),
      },
      paths: {
        dataDir: paths.data,
        workspaceRoot: paths.workspace,
        dbPath: paths.db,
        logsDir: paths.logs,
        skillsDir: paths.skills,
        userSkillsDir: paths.userSkills,
      },
      recentErrors,
      notes: [
        '诊断包不包含用户 AI Key、激活码明文、登录 token。',
        '日志摘要中匹配到的密钥/token 已替换为 [REDACTED]。',
        '若需要进一步排查请把诊断包发送给客服。',
      ],
    })
  })

  return app
}
