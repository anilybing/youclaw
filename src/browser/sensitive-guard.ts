// [XJC] 浏览器敏感写操作的确定性人工确认（对标 media-intent.ts 的 pending 授权范式）。
// 现状：敏感浏览器操作（购买/支付/发布/删除/提交表单/账号安全）只靠 system prompt 软约束。
// 本模块提供“确定性界定 + 回合级授权”，由 browser/mcp.ts 在工具执行时强制门禁：
// 敏感且未授权 → 挂起 pending 并抛错让回用户；下一轮用户确认后放行一次（可绑定动作签名）。
// 安全非目标：这是“AI 代操作时的人工确认边界”，非 OS 沙箱、不防恶意站点/XSS。
import { createHash } from 'node:crypto'

/** 浏览器 snapshot 返回的可交互元素元数据（结构兼容 pw-session 内部 SnapshotRef，独立定义以解耦） */
export interface SnapshotRefMeta {
  ref: string
  tag?: string
  role?: string
  type?: string
  label?: string
  text?: string
  placeholder?: string
  value?: string
}

export const BROWSER_CONFIRMATION_REQUIRED = 'BROWSER_CONFIRMATION_REQUIRED'
const CONFIRM_TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 1024
const MAX_SNAPSHOTS = 1024
const SNAPSHOT_TTL_MS = 30 * 60 * 1000

/** 敏感元素关键词（匹配元素文字/label/aria 或 raw CSS selector；大小写不敏感） */
const SENSITIVE_KEYWORDS =
  /支付|付款|立即购买|立即下单|提交订单|确认下单|确认订单|去结算|结算|确认支付|确认收货|充值|提现|转账|下单|立即支付|去支付|确认并支付|发布|发表|发送|群发|投稿|上架|一键发布|删除|移除|清空|注销|解绑|停用|永久删除|修改密码|重置密码|更改绑定|两步验证|授权登录|允许访问|同意授权|确认授权|\b(?:pay|pay now|checkout|place order|buy now|submit order|confirm payment|complete purchase|withdraw|transfer|post|publish|send|share|submit|delete|remove|deactivate|close account|unlink|change password|reset password|authorize|allow access|grant|consent)\b/i

/** 敏感页面 URL 模式（命中即“敏感区”，区内任何提交型动作都需确认——兜住无文字图标按钮） */
const SENSITIVE_URL =
  /\/checkout|\/cashier|\/pay(?:ment)?(?:\/|\?|$)|\/settlement|\/trade|\/createorder|\/confirmorder|\/order\/submit|alipay\.com|tenpay\.com|pay\.weixin|unionpay|paypal\.com\/checkout|checkout\.stripe\.com|\/oauth|\/authorize|\/consent|open\.weixin\.qq\.com\/connect|accounts\.google\.com\/o\/oauth2|\/settings\/security|\/account\/(?:password|security)|\/deactivate|\/close-account/i

/** 机密输入字段（匹配元素 type/name/id/autocomplete 或 selector） */
const SECRET_FIELD =
  /password|current-password|new-password|\botp\b|one-time-code|\bsms\b|\bcvv\b|\bcvc\b|card-?number|verification-?code/i

/** 提交等价按键 */
const SUBMIT_KEY = /^(?:Enter|Return|NumpadEnter|(?:Meta|Control|Ctrl)\+Enter)$/i

/** 用户在下一轮对挂起操作的肯定/授权（对话式确认，复用媒体口径） */
const CONFIRM =
  /^(?:确认|确定|同意|授权|继续|好的?|可以了?|没问题|执行吧?|点吧|就这样|ok|okay|yes|sure|confirm|proceed|go\s?ahead|do it)[。.!！~\s]*$/i
const CANCEL = /^(?:取消|算了|不用了?|别|停止|停|不要|cancel|stop|abort)[。.!！\s]*$/i

export type BrowserGatedAction =
  | { kind: 'act'; action: 'click' | 'type' | 'select' | 'check' | 'uncheck'; ref: string; text?: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text?: string }
  | { kind: 'press_key'; key: string }
  | { kind: 'navigate'; url: string }

export interface SensitiveClassification {
  sensitive: boolean
  reasons: string[]
  /** 面向用户的动作摘要，如 “点击『立即支付』（checkout.jd.com）” */
  summary: string
  /** 绑定签名：URL + 动作 + 元素标识，用于防“确认 A 却做 B” */
  signature: string
}

export interface BrowserActionAuthorization {
  allowSensitiveOnce: boolean
  /** 执行时须与当前动作签名一致才放行（P1 硬化；为空表示不校验签名） */
  boundSignature?: string
  reason: string
}

export interface BrowserTurnContext {
  authorization: BrowserActionAuthorization
  systemInstruction: string | null
}

interface PendingConfirm { signature: string; url: string; summary: string; expiresAt: number }
interface CachedSnapshot { url: string; capturedAt: number; refs: Map<string, SnapshotRefMeta> }

const pendingConfirmations = new Map<string, PendingConfirm>()
const snapshotCache = new Map<string, CachedSnapshot>()

function pruneExpired(now: number): void {
  for (const [id, entry] of pendingConfirmations) {
    if (entry.expiresAt <= now) pendingConfirmations.delete(id)
  }
  for (const [id, snap] of snapshotCache) {
    if (snap.capturedAt + SNAPSHOT_TTL_MS <= now) snapshotCache.delete(id)
  }
  while (pendingConfirmations.size > MAX_PENDING) {
    const oldest = pendingConfirmations.keys().next().value
    if (typeof oldest !== 'string') break
    pendingConfirmations.delete(oldest)
  }
  while (snapshotCache.size > MAX_SNAPSHOTS) {
    const oldest = snapshotCache.keys().next().value
    if (typeof oldest !== 'string') break
    snapshotCache.delete(oldest)
  }
}

/** snapshot 工具成功后调用：缓存本次 refs 供后续 act 反查元素语义 */
export function rememberSnapshot(chatId: string, url: string, refs: SnapshotRefMeta[], now = Date.now()): void {
  pruneExpired(now)
  const map = new Map<string, SnapshotRefMeta>()
  for (const ref of refs) {
    if (ref && typeof ref.ref === 'string') map.set(ref.ref, ref)
  }
  snapshotCache.set(chatId, { url, capturedAt: now, refs: map })
}

export function lookupRef(chatId: string, ref: string): SnapshotRefMeta | undefined {
  return snapshotCache.get(chatId)?.refs.get(ref)
}

function refText(meta: SnapshotRefMeta | undefined): string {
  if (!meta) return ''
  return [meta.label, meta.text, meta.placeholder, meta.value, meta.role, meta.type]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(' ')
}

function signatureOf(activeUrl: string | null, action: BrowserGatedAction, elementId: string): string {
  const actKey = action.kind === 'act' ? `${action.action}:${action.ref}` : action.kind === 'press_key' ? action.key : ''
  return createHash('sha256')
    .update(`${activeUrl ?? ''}|${action.kind}|${actKey}|${elementId}`)
    .digest('hex')
    .slice(0, 16)
}

function classification(sensitive: boolean, reasons: string[], summary: string, signature: string): SensitiveClassification {
  return { sensitive, reasons, summary, signature }
}

/**
 * 确定性界定一个浏览器动作是否敏感、需人工确认。
 * 只读工具（status/list_tabs/snapshot/screenshot）不会走到这里。
 */
export function classifyBrowserAction(
  chatId: string,
  action: BrowserGatedAction,
  activeUrl: string | null,
): SensitiveClassification {
  const inZone = activeUrl ? SENSITIVE_URL.test(activeUrl) : false
  const reasons: string[] = []
  let sensitive = false
  let elementId = ''
  let label = ''

  if (action.kind === 'act') {
    const meta = lookupRef(chatId, action.ref)
    const elText = refText(meta)
    elementId = elText || `ref:${action.ref}`
    label = (meta?.label || meta?.text || '').trim() || `元素#${action.ref}`
    const role = (meta?.role ?? '').toLowerCase()
    // 勾选/单选/选择/开关：不视为“落地提交”，只拦最终提交，减少确认疲劳
    if (action.action === 'check' || action.action === 'uncheck' || action.action === 'select'
      || /^(checkbox|radio|switch)$/.test(role)) {
      return classification(false, [], '', signatureOf(activeUrl, action, elementId))
    }
    if (action.action === 'type') {
      const fieldId = [meta?.type, meta?.label, meta?.placeholder, meta?.value].filter(Boolean).join(' ')
      if ((meta?.type ?? '').toLowerCase() === 'password' || SECRET_FIELD.test(fieldId)) {
        sensitive = true; reasons.push('secret-field')
      } else if (inZone) { sensitive = true; reasons.push('page-zone') }
    } else { // click
      if (elText && SENSITIVE_KEYWORDS.test(elText)) { sensitive = true; reasons.push('keyword') }
      if (inZone) { sensitive = true; reasons.push('page-zone') }
    }
  } else if (action.kind === 'click') {
    elementId = action.selector; label = action.selector
    if (SENSITIVE_KEYWORDS.test(action.selector)) { sensitive = true; reasons.push('keyword') }
    if (inZone) { sensitive = true; reasons.push('page-zone') }
  } else if (action.kind === 'type') {
    elementId = action.selector; label = action.selector
    if (SECRET_FIELD.test(action.selector)) { sensitive = true; reasons.push('secret-field') }
    else if (inZone) { sensitive = true; reasons.push('page-zone') }
  } else if (action.kind === 'press_key') {
    elementId = action.key; label = action.key
    if (SUBMIT_KEY.test(action.key) && inZone) { sensitive = true; reasons.push('submit-key') }
  } else {
    // navigate：P0 不拦（导航一般无副作用；GET 型副作用属残余风险）
    elementId = action.url
  }

  const zone = activeUrl ? (() => { try { return new URL(activeUrl).host } catch { return activeUrl } })() : ''
  const verb = action.kind === 'act' ? action.action : action.kind
  const summary = zone ? `${verb} “${label}”（${zone}）` : `${verb} “${label}”`
  return classification(sensitive, reasons, summary, signatureOf(activeUrl, action, elementId))
}

/** 挂起一个待确认的敏感动作（工具门禁在拦截时调用） */
export function armPendingConfirmation(chatId: string, c: SensitiveClassification, url: string, now = Date.now()): void {
  pruneExpired(now)
  pendingConfirmations.set(chatId, { signature: c.signature, url, summary: c.summary, expiresAt: now + CONFIRM_TTL_MS })
}

/**
 * 每回合开始按 chatId 计算浏览器敏感操作授权（由 runtime 装配调用）。
 * 用户上一轮触发的挂起 + 本轮明确确认 → 放行一次（绑定签名）；取消/超时 → 清除。
 */
export function resolveBrowserTurnContext(
  chatId: string,
  text: string,
  activeUrl: string | null,
  now = Date.now(),
): BrowserTurnContext {
  pruneExpired(now)
  const trimmed = text.trim()
  const pending = pendingConfirmations.get(chatId)

  if (CANCEL.test(trimmed)) {
    pendingConfirmations.delete(chatId)
    return { authorization: { allowSensitiveOnce: false, reason: 'cancelled' }, systemInstruction: null }
  }
  if (pending && CONFIRM.test(trimmed)) {
    pendingConfirmations.delete(chatId)
    return {
      authorization: { allowSensitiveOnce: true, boundSignature: pending.signature, reason: 'confirmed' },
      systemInstruction:
        '<runtime_browser_instruction>The user confirmed the previously requested sensitive browser action. '
        + 'You may perform exactly one sensitive browser action this turn (re-take a fresh snapshot first if needed). '
        + 'Do not perform any other sensitive action without a new confirmation.</runtime_browser_instruction>',
    }
  }
  return { authorization: { allowSensitiveOnce: false, reason: 'no confirmation' }, systemInstruction: null }
}

export function clearBrowserConfirmationState(): void {
  pendingConfirmations.clear()
  snapshotCache.clear()
}
