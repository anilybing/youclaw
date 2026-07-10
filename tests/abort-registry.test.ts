import { describe, expect, test } from 'bun:test'
import './setup.ts'
import { abortRegistry } from '../src/agent/abort-registry.ts'

describe('abort registry', () => {
  test('abort only signals the controller and does not force-close the query', () => {
    const controller = new AbortController()
    let closeCalled = false

    abortRegistry.register('chat-abort', controller)
    abortRegistry.setQuery('chat-abort', {
      [Symbol.asyncIterator]() {
        return this
      },
      next: async () => ({ done: true, value: undefined }),
      close: () => {
        closeCalled = true
      },
    })

    const aborted = abortRegistry.abort('chat-abort')

    expect(aborted).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(closeCalled).toBe(false)
    expect(abortRegistry.has('chat-abort')).toBe(false)
  })

  test('legacy overload coexists with exact turns without unregistering siblings', () => {
    const legacy = new AbortController()
    const first = new AbortController()
    const sibling = new AbortController()
    abortRegistry.register('chat-mixed', legacy)
    abortRegistry.register('chat-mixed', 'turn-first', first)
    abortRegistry.register('chat-mixed', 'turn-sibling', sibling)

    abortRegistry.unregister('chat-mixed')
    expect(abortRegistry.has('chat-mixed', 'turn-first')).toBe(true)
    expect(abortRegistry.has('chat-mixed', 'turn-sibling')).toBe(true)
    expect(abortRegistry.abort('chat-mixed', 'turn-first')).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(sibling.signal.aborted).toBe(false)

    expect(abortRegistry.abort('chat-mixed')).toBe(true)
    expect(sibling.signal.aborted).toBe(true)
  })
})
