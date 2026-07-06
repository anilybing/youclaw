/**
 * 统一 API 错误处理：
 * - `ApiError`：携带 errorCode、status、原始 message
 * - `ERROR_CODE_MESSAGES`：errorCode -> { title, suggestion } 中文映射
 * - `formatApiError`：把任意错误转成 { title, suggestion, code } 三段式提示
 *
 * 商业化 Sidecar 在代理 MVP 接口时会把 errorCode 透传到响应体，
 * 前端调用 apiFetch 时由 ApiError 携带，业务层只需 formatApiError 展示。
 */

export class ApiError extends Error {
  errorCode: string
  status: number
  raw: unknown

  constructor(params: { message: string; errorCode?: string; status?: number; raw?: unknown }) {
    super(params.message)
    this.name = 'ApiError'
    this.errorCode = params.errorCode ?? ''
    this.status = params.status ?? 0
    this.raw = params.raw
  }
}

export interface FormattedApiError {
  /** 简短标题，适合作为 toast 的主要文案 */
  title: string
  /** 操作建议，适合作为 toast 的副文案或 inline 提示 */
  suggestion: string
  /** 原始错误码，用于上报或调试 */
  code: string
  /** HTTP 状态码 */
  status: number
}

interface ErrorCopy {
  title: string
  suggestion: string
}

/**
 * 业务 errorCode -> 中文标题 + 操作建议。
 * 与 mvp/src/services/* 中 throw businessError(code, ...) 的码保持一致。
 */
export const ERROR_CODE_MESSAGES: Record<string, ErrorCopy> = {
  // 认证 / 会话
  AUTH_REQUIRED: {
    title: '请先登录',
    suggestion: '当前会话已失效，请重新登录后再试。',
  },
  USER_DISABLED: {
    title: '账号已被禁用',
    suggestion: '请联系客服处理或更换账号登录。',
  },
  LOGIN_INPUT_INVALID: {
    title: '登录信息不完整',
    suggestion: '请输入手机号或邮箱后再登录。',
  },

  // 激活 / 设备
  ACTIVATION_CODE_REQUIRED: {
    title: '请输入激活码',
    suggestion: '激活码格式形如 MVP-2026-XXXX，请联系销售获取。',
  },
  ACTIVATION_CODE_INVALID: {
    title: '激活码不存在或已锁定',
    suggestion: '请检查激活码是否输入正确，或联系销售确认状态。',
  },
  ACTIVATION_CODE_EXPIRED: {
    title: '激活码已过期',
    suggestion: '请联系销售获取新的激活码。',
  },
  ACTIVATION_CODE_USED: {
    title: '激活码已被使用',
    suggestion: '该激活码已绑定其他账号，请使用尚未使用的激活码。',
  },
  DEVICE_REQUIRED: {
    title: '缺少设备信息',
    suggestion: '请重启客户端再试，若仍提示请导出诊断包反馈。',
  },
  DEVICE_LIMIT_REACHED: {
    title: '设备绑定数已达上限',
    suggestion: '请到「激活与设备」页面解绑闲置设备后再激活。',
  },
  DEVICE_NOT_FOUND: {
    title: '当前设备未绑定',
    suggestion: '请先在「激活与设备」中兑换激活码并绑定本设备。',
  },
  PLAN_NOT_FOUND: {
    title: '套餐已下架',
    suggestion: '请联系销售确认当前可用的激活码套餐。',
  },

  // 模板 / AI
  TEMPLATE_NOT_FOUND: {
    title: '模板不存在或已下架',
    suggestion: '请刷新模板中心，或选择其他模板尝试。',
  },
  TEMPLATE_INPUT_INVALID: {
    title: '模板输入不合法',
    suggestion: '请按照模板表单要求填写所有必填字段。',
  },
  CREDIT_INSUFFICIENT: {
    title: '积分不足',
    suggestion: '请使用激活码补充积分，或联系销售购买更多积分。',
  },
  AI_BUSY: {
    title: 'AI 当前比较忙',
    suggestion: '稍后重试即可，平台会自动恢复积分，不会重复扣费。',
  },
  AI_QUEUE_FULL: {
    title: '排队人数过多',
    suggestion: '请稍后再试，已进入队列的请求会按顺序处理。',
  },
  AI_QUEUE_TIMEOUT: {
    title: 'AI 排队超时',
    suggestion: '排队等待时间已超过上限，建议稍后再试。',
  },
  AI_PROVIDER_UNAVAILABLE: {
    title: 'AI 服务暂不可用',
    suggestion: '请稍后重试，或在后台切换至备用 Provider。',
  },
  AI_TIMEOUT: {
    title: 'AI 响应超时',
    suggestion: '请稍后重试；本次扣费已自动退回。',
  },
  AI_GENERATION_FAILED: {
    title: 'AI 生成失败',
    suggestion: '请稍后再试或调整输入内容；本次扣费已自动退回。',
  },

  // 用户自带 Key 通道
  AI_MODE_INVALID: {
    title: 'AI 模式不正确',
    suggestion: '请在「个人中心 - AI 模式」中重新选择「平台积分」或「自带 Key」。',
  },
  USER_AI_NOT_CONFIGURED: {
    title: '本地 AI Key 尚未配置',
    suggestion: '请在「个人中心 - 用户自带 Key」中填写 BaseURL、Model 和 API Key 后再切换。',
  },
  USER_AI_GENERATION_FAILED: {
    title: '本地 AI 调用失败',
    suggestion: '请检查 BaseURL / Model / Key 是否正确，或确认账户额度后重试。',
  },
  CHAT_INPUT_INVALID: {
    title: '请先输入聊天内容',
    suggestion: '在输入框中填写问题后再发送。',
  },

  // 通用
  PARAM_INVALID: {
    title: '参数不正确',
    suggestion: '请检查输入信息后再试。',
  },
  RATE_LIMITED: {
    title: '请求过于频繁',
    suggestion: '请稍等几秒后再操作。',
  },
  INTERNAL_ERROR: {
    title: '服务器内部错误',
    suggestion: '请稍后重试，若多次出现请导出诊断包联系客服。',
  },
}

/**
 * 根据 HTTP 状态码兜底匹配错误提示。
 */
function fallbackByStatus(status: number, fallbackMessage: string): ErrorCopy {
  if (status === 401) {
    return ERROR_CODE_MESSAGES.AUTH_REQUIRED
  }
  if (status === 403) {
    return { title: '没有权限', suggestion: '当前账号无权访问该功能，请联系管理员。' }
  }
  if (status === 404) {
    return { title: '资源不存在', suggestion: '请刷新后重试，或确认资源是否仍可用。' }
  }
  if (status === 429) {
    return ERROR_CODE_MESSAGES.RATE_LIMITED
  }
  if (status === 501) {
    return { title: '云端服务未配置', suggestion: '请稍后再试或联系管理员配置 XiaoJuClaw_API_URL。' }
  }
  if (status >= 500) {
    return ERROR_CODE_MESSAGES.INTERNAL_ERROR
  }
  if (status === 0) {
    return {
      title: '网络异常',
      suggestion: '请检查本机网络或 Sidecar 是否在运行，再试一次。',
    }
  }
  return {
    title: '操作失败',
    suggestion: fallbackMessage || '请稍后重试，若问题持续请导出诊断包反馈。',
  }
}

/**
 * 把任意错误（ApiError / Error / 字符串）格式化为统一的中文提示结构。
 */
export function formatApiError(error: unknown, fallbackMessage = ''): FormattedApiError {
  if (error instanceof ApiError) {
    const copy = (error.errorCode && ERROR_CODE_MESSAGES[error.errorCode])
      || fallbackByStatus(error.status, error.message || fallbackMessage)
    return {
      title: copy.title,
      suggestion: copy.suggestion,
      code: error.errorCode,
      status: error.status,
    }
  }

  if (error instanceof Error) {
    return {
      title: '操作失败',
      suggestion: error.message || fallbackMessage || '请稍后重试。',
      code: '',
      status: 0,
    }
  }

  return {
    title: '操作失败',
    suggestion: fallbackMessage || (typeof error === 'string' ? error : '请稍后重试。'),
    code: '',
    status: 0,
  }
}

/**
 * 简化版：只返回单行提示，方便已有 toast 调用直接替换。
 */
export function formatApiErrorMessage(error: unknown, fallbackMessage = ''): string {
  const formatted = formatApiError(error, fallbackMessage)
  if (!formatted.suggestion) return formatted.title
  return `${formatted.title}：${formatted.suggestion}`
}
