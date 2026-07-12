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

    expect(runtime).toContain('const cancelled = aborted || params.abortController?.signal.aborted === true')
    expect(runtime).toContain('emitCancellationCompletion(finalText, sessionId, toolUse)')
    expect(runtime).toContain('const finishEarlyCancellation = (): string => {')
    expect(runtime).toContain('if (abortController.signal.aborted) {\n            return {')
    expect(runtime).toContain('return { fullText, sessionId, aborted: true }')
  })

  test('cancellation keeps the session for continuity instead of deleting it', () => {
    const runtime = read('src/agent/runtime.ts')

    // [XJC] 上下文连续性：取消一轮不再 deleteSession——pi 回放会跳过 aborted 助手消息
    // 并为孤儿工具调用补合成结果，续用被中止会话是框架支持的安全行为。
    expect(runtime).not.toContain('deleteSession(')
    expect(runtime).toContain('if (sessionId) {\n        clearBootstrapSnapshotOnSessionRollover({')
    expect(runtime).toContain('saveSession(agentId, chatId, sessionId, sessionFile)')
  })

  test('corrupted stored sessions fall back to a fresh session instead of failing the turn', () => {
    const runtime = read('src/agent/runtime.ts')

    expect(runtime).toContain('sessionManager = SessionManager.open(existingSessionFile, sessionsDir)')
    expect(runtime).toContain('Failed to open stored session, falling back to a fresh session')
    expect(runtime).toContain('existingSessionFile = null')
  })
})
