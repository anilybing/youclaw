/**
 * 模型路由 hint 分类与路由表解析（T-G3）
 *
 * 远程配置 `ai.model_routing` 的消费端纯函数层，双通道共用：
 *   - platform 通道：commercial.ts 把 hint 透传给 MVP，由 MVP 侧按路由表选 provider/model
 *   - user_key 通道：user-ai.ts 按路由表选 model id 匹配的本地自定义模型
 *
 * 路由表 schema（远程配置 value）：
 *   {
 *     "default":  { "provider": "", "model": "" },
 *     "byHint":   { "reasoning": { "provider": "", "model": "" }, ... },
 *     "fallback": [ { "provider": "", "model": "" } ]
 *   }
 * 空字符串 / 缺键 = 沿用现状（env / 用户三件套），保证零配置行为不变。
 * 兼容旧种子结构 { primary: "", fallback: [] }（primary 非空视为 default.model）。
 */

export type ModelHint = 'chat' | 'reasoning' | 'memory' | 'fast' | 'vision'

export const MODEL_HINTS: readonly ModelHint[] = ['chat', 'reasoning', 'memory', 'fast', 'vision']

export function isModelHint(value: unknown): value is ModelHint {
  return typeof value === 'string' && (MODEL_HINTS as readonly string[]).includes(value)
}

export interface RoutedModelTarget {
  /**
   * 目标 provider 名。platform 通道对齐 MVP aiProvider 注册名（openai/windsurfapi/mock）；
   * user_key 通道用于 customModels.provider 过滤。空串 = 未指定。
   */
  provider: string
  /** 目标模型 id。空串 = 未指定 */
  model: string
}

function normalizeTarget(value: unknown): RoutedModelTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  // 字段全空视为缺（该层未配置，继续降级）
  if (!provider && !model) return null
  return { provider, model }
}

/**
 * 解析 hint 对应的目标模型：byHint[hint] → default → null。
 * 返回 null 表示路由表未指定该 hint 的映射，调用方沿用现状配置。
 */
export function resolveRoutedModel(routing: unknown, hint: ModelHint): RoutedModelTarget | null {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return null
  const record = routing as Record<string, unknown>

  // 旧种子结构 { primary, fallback }：primary 非空视为 default.model
  if (!('default' in record) && !('byHint' in record) && typeof record.primary === 'string') {
    const model = record.primary.trim()
    return model ? { provider: '', model } : null
  }

  const byHint = record.byHint
  if (byHint && typeof byHint === 'object' && !Array.isArray(byHint)) {
    const target = normalizeTarget((byHint as Record<string, unknown>)[hint])
    if (target) return target
  }

  return normalizeTarget(record.default)
}
