import type { ToolEffectClass } from './types.ts'

const EXACT_EFFECTS: Record<string, ToolEffectClass> = {
  read: 'read',
  grep: 'read',
  find: 'read',
  ls: 'read',
  bash: 'execute',
  edit: 'write',
  write: 'write',
}

const INVENTORY_MARKERS = ['fulfillment__deliver', 'fulfillment__add_cards', 'fulfillment__upsert_sku']
const MESSAGE_MARKERS = ['message__send', 'send_to_current_chat', 'send_channel', 'outbound']
const NETWORK_MARKERS = ['browser', 'http_get', 'web_search', 'web-search', 'generate_image', 'generate_video', 'edit_image']
const READ_MARKERS = [
  '__list_',
  '__get_',
  '__search_',
  '__recall',
  '__read_',
  '__discover_',
  '__understand_image',
  'knowledge_search',
  'fulfillment__list_stock',
]
const WRITE_MARKERS = [
  '__save_',
  '__set_',
  '__update_',
  '__delete_',
  '__create_',
  '__install_',
  '__remember',
  '__parse_',
  '__transcribe_',
  '__run_',
  '__resume_',
]

/**
 * Conservative effect classification used for workflow policy checks and
 * trace summaries. Unknown tools remain "unknown" instead of being guessed as
 * read-only.
 */
export function classifyToolEffect(toolName: string): ToolEffectClass {
  const normalized = toolName.trim().toLowerCase()
  const exact = EXACT_EFFECTS[normalized]
  if (exact) return exact
  if (INVENTORY_MARKERS.some((marker) => normalized.includes(marker))) return 'inventory'
  if (MESSAGE_MARKERS.some((marker) => normalized.includes(marker))) return 'message'
  if (NETWORK_MARKERS.some((marker) => normalized.includes(marker))) return 'network'
  if (READ_MARKERS.some((marker) => normalized.includes(marker))) return 'read'
  if (WRITE_MARKERS.some((marker) => normalized.includes(marker))) return 'write'
  return 'unknown'
}

export function isModelPriceKnown(model: {
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}): boolean {
  const cost = model.cost
  if (!cost) return false
  // Input and output prices are both required for exact call cost. Cache
  // prices may legitimately be absent when the provider does not expose them.
  return [cost.input, cost.output]
    .every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
}
