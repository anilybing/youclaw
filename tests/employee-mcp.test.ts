// [XJC] 对话式建员工测试（自主强化）：参数守卫/保留 id/落盘/热重载调用。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getPaths } from '../src/config/paths.ts'
import { configureEmployeeMcpRuntime, createEmployeeTools, resetEmployeeMcpRuntime } from '../src/agent/employee-mcp.ts'

const created: string[] = []

function makeManager(existing: string[] = []) {
  const reloads: string[][] = []
  return {
    manager: {
      getAgent: (id: string) => (existing.includes(id) ? { config: { id } } : undefined),
      reloadAgents: async () => { reloads.push(existing) },
    },
    reloads,
  }
}

function tool() {
  return createEmployeeTools()[0]!
}

afterEach(() => {
  resetEmployeeMcpRuntime()
  for (const id of created.splice(0)) {
    rmSync(resolve(getPaths().agents, id), { recursive: true, force: true })
  }
})

describe('mcp__agent__create_employee', () => {
  test('创建：写 agent.yaml + SOUL.md + 工作区骨架并 reload', async () => {
    const { manager, reloads } = makeManager()
    configureEmployeeMcpRuntime({ agentManager: manager as never })
    const id = `emp-test-${Date.now().toString(36)}`
    created.push(id)

    const res = await tool().execute('t', { id, name: '发票助理', persona: '# 职责\n专管发票整理与报销核对', skills: ['finance-invoice', 'BAD SLUG'] })
    expect(res.content[0]!.text).toContain('发票助理')

    const dir = resolve(getPaths().agents, id)
    const yaml = parseYaml(readFileSync(resolve(dir, 'agent.yaml'), 'utf8')) as { id: string; name: string; skills: string[] }
    expect(yaml.id).toBe(id)
    expect(yaml.name).toBe('发票助理')
    expect(yaml.skills).toEqual(['finance-invoice']) // 非法 slug 被过滤
    expect(readFileSync(resolve(dir, 'SOUL.md'), 'utf8')).toContain('专管发票')
    expect(existsSync(dir)).toBe(true)
    expect(reloads.length).toBe(1)
  })

  test('保留 id / 非法 id / 已存在 / 缺参数 全部拒绝', async () => {
    const { manager } = makeManager(['already-there'])
    configureEmployeeMcpRuntime({ agentManager: manager as never })

    await expect(tool().execute('t', { id: 'office-assistant', name: 'x', persona: 'p' })).rejects.toThrow(/保留/)
    await expect(tool().execute('t', { id: 'Bad_ID', name: 'x', persona: 'p' })).rejects.toThrow(/不合法/)
    await expect(tool().execute('t', { id: 'already-there', name: 'x', persona: 'p' })).rejects.toThrow(/已存在/)
    await expect(tool().execute('t', { id: 'ok-id-1', name: '  ', persona: 'p' })).rejects.toThrow(/name/)
    await expect(tool().execute('t', { id: 'ok-id-2', name: 'x', persona: '  ' })).rejects.toThrow(/persona/)
  })

  test('运行时未装配时给出友好错误', async () => {
    resetEmployeeMcpRuntime()
    await expect(tool().execute('t', { id: 'ok-id-3', name: 'x', persona: 'p' })).rejects.toThrow(/尚未初始化/)
  })
})
