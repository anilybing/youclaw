// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { getLogger } from '../logger/index.ts'

interface AbortEntry {
  turnId: string
  abortController: AbortController
  query: AsyncIterable<unknown> & { close?: () => void } | null
}

const LEGACY_TURN_ID = '__legacy_chat_abort__'

/**
 * Singleton registry that maps chatId + turnId -> abort handles.
 * Allows external callers (e.g. HTTP abort endpoint) to terminate a running query.
 */
class AbortRegistry {
  private entries = new Map<string, Map<string, AbortEntry>>()

  register(chatId: string, abortController: AbortController): void
  register(chatId: string, turnId: string, abortController: AbortController): void
  register(chatId: string, turnOrController: string | AbortController, maybeController?: AbortController): void {
    const turnId = typeof turnOrController === 'string' ? turnOrController : LEGACY_TURN_ID
    const abortController = typeof turnOrController === 'string' ? maybeController : turnOrController
    if (!abortController) return
    const chatEntries = this.entries.get(chatId) ?? new Map<string, AbortEntry>()
    chatEntries.set(turnId, { turnId, abortController, query: null })
    this.entries.set(chatId, chatEntries)
  }

  setQuery(chatId: string, q: AsyncIterable<unknown> & { close?: () => void }, turnId?: string): void {
    const chatEntries = this.entries.get(chatId)
    const entry = turnId
      ? chatEntries?.get(turnId)
      : chatEntries?.get(LEGACY_TURN_ID) ?? [...(chatEntries?.values() ?? [])][0]
    if (entry) {
      entry.query = q
    }
  }

  abort(chatId: string, turnId?: string): boolean {
    const chatEntries = this.entries.get(chatId)
    if (!chatEntries) return false
    const targets = turnId
      ? [chatEntries.get(turnId)].filter((entry): entry is AbortEntry => Boolean(entry))
      : [...chatEntries.values()]
    if (targets.length === 0) return false

    const logger = getLogger()
    logger.info({ chatId, turnId, count: targets.length, category: 'agent' }, 'Query aborted by user')

    for (const entry of targets) {
      entry.abortController.abort()
      chatEntries.delete(entry.turnId)
    }
    // Do not force-close the SDK query stream here.
    // Let the AbortController propagate first so runtime can emit
    // complete/processing=false cleanly without surfacing SDK
    // "Operation aborted" noise or dropping the partial assistant reply.
    if (chatEntries.size === 0) this.entries.delete(chatId)
    return true
  }

  unregister(chatId: string, turnId?: string): void {
    const chatEntries = this.entries.get(chatId)
    chatEntries?.delete(turnId ?? LEGACY_TURN_ID)
    if (chatEntries?.size === 0) this.entries.delete(chatId)
  }

  has(chatId: string, turnId?: string): boolean {
    const chatEntries = this.entries.get(chatId)
    return turnId ? chatEntries?.has(turnId) === true : Boolean(chatEntries?.size)
  }
}

export const abortRegistry = new AbortRegistry()
