// 定时任务结果投递的共享类型与校验（Tasks 页与工作台共用）

export type TaskDeliveryMode = 'none' | 'push'

/** 目标非空且不是只填了前缀（如 "tg:"）才算填写完整 */
export function isDeliveryTargetComplete(target: string): boolean {
  const trimmed = target.trim()
  return trimmed.length > 0 && !trimmed.endsWith(':')
}
