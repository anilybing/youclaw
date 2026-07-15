// [XJC] 漫剧工作室·VLM 质检打分（画风/角色/场景一致性；不过阈值→标记重渲）。
//
// settings.studio.qc.{enabled,baseUrl,apiKey,model,minScore}。默认 qwen3-vl-plus（OpenAI 兼容 vision，中文强、
// QC 成本相对渲染可忽略）。enabled=false 时直接放行(score=100)。HTTP 层全 mock 可单测（不联网不烧钱）。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { getStoredSettings } from '../settings/manager.ts'

const IMG_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const IMG_MAX_BYTES = 10 * 1024 * 1024
const QC_TIMEOUT_MS = 60_000

const QC_SYSTEM = [
  '你是漫剧质检员。针对给定关键帧/镜头首帧，评估三项：',
  '1) 画风是否统一（如日系 cel 动画风；出现 3D 化/写实化/风格突变视为不合格）；',
  '2) 角色是否与参考图一致（脸型/发色/服饰/比例）；',
  '3) 场景是否连贯（承接镜与前镜场景不应突变）。',
  '只输出 JSON：{"score":0-100,"issues":["简述问题"]}；score 越高越好，无问题则 issues 为空数组。',
].join('')

export interface QcScoreParams {
  /** 待质检图（镜头首帧/关键帧）本机路径。 */
  imagePaths: string[]
  /** 分镜提示词（供 VLM 对照）。 */
  prompt?: string
  /** 角色/画风参考图（对照一致性）。 */
  referenceImagePaths?: string[]
}

export interface QcScore {
  enabled: boolean
  score: number
  pass: boolean
  minScore: number
  issues: string[]
  model: string
  raw?: string
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

function toDataUri(path: string): string {
  const ext = extname(path).toLowerCase()
  if (!IMG_EXTS.has(ext)) throw new Error('质检图仅支持 png/jpg/jpeg/webp')
  if (!existsSync(path) || statSync(path).size > IMG_MAX_BYTES) throw new Error('质检图缺失或过大（>10MB）')
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

function parseScore(raw: string): { score: number; issues: string[] } {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0]) as { score?: unknown; issues?: unknown }
      const s = Number(j.score)
      return {
        score: Number.isFinite(s) ? Math.max(0, Math.min(100, s)) : 0,
        issues: Array.isArray(j.issues) ? j.issues.map((x) => String(x)) : [],
      }
    }
  } catch { /* 解析失败退化 */ }
  return { score: 0, issues: ['VLM 返回无法解析为 JSON'] }
}

/**
 * 对一组图做画风/角色/场景一致性打分。qc.enabled=false → 放行(score=100)。
 * 返回 pass=score>=minScore；调用方对 !pass 的镜标记重渲（选中→HQ 或换 provider）。
 */
export async function scoreShotConsistency(params: QcScoreParams): Promise<QcScore> {
  const qc = getStoredSettings().studio.qc
  const model = qc.model?.trim() || 'qwen3-vl-plus'
  const minScore = Number.isFinite(qc.minScore) ? qc.minScore : 70
  if (!qc.enabled) return { enabled: false, score: 100, pass: true, minScore, issues: [], model }

  const baseUrl = qc.baseUrl?.trim() || process.env.SILICONFLOW_BASE_URL?.trim() || ''
  const apiKey = qc.apiKey?.trim() || process.env.SILICONFLOW_API_KEY?.trim() || ''
  if (!baseUrl || !apiKey) throw new Error('VLM 质检未配置：需 settings.studio.qc.{baseUrl,apiKey}')

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: `分镜提示：${params.prompt || '(无)'}。请按系统要求质检下列图（前为参考图、后为待检图）。` },
  ]
  for (const p of [...(params.referenceImagePaths ?? []), ...params.imagePaths].filter((x) => x && x.trim())) {
    content.push({ type: 'image_url', image_url: { url: toDataUri(p) } })
  }

  let res: Response
  try {
    res = await fetch(endpointUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: QC_SYSTEM }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(QC_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`VLM 质检失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`VLM 质检失败（HTTP ${res.status}）`)
  const body = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null
  const raw = body?.choices?.[0]?.message?.content ?? ''
  const parsed = parseScore(raw)
  return { enabled: true, score: parsed.score, pass: parsed.score >= minScore, minScore, issues: parsed.issues, model, raw }
}
