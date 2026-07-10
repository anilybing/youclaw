import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

describe('abort session wiring', () => {
  test('runtime handles cancellation before and during an active session', () => {
    const runtime = read('src/agent/runtime.ts')

    expect(runtime).toContain("params.executionState.status = 'cancelled'\n        deleteSession(agentId, chatId)")
    expect(runtime).toContain('const cancelled = aborted || params.abortController?.signal.aborted === true')
    expect(runtime).toContain('emitCancellationCompletion(finalText, sessionId, toolUse)')
    expect(runtime).toContain('const finishEarlyCancellation = (): string => {')
    expect(runtime).toContain('if (abortController.signal.aborted) {\n            return {')
    expect(runtime).toContain('return { fullText, sessionId, aborted: true }')
  })
})
