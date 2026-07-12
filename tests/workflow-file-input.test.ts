// [XJC] 工作流·文件型输入（read_file tool 节点）测试：
// 安全解析（越界/软链/超限/二进制/扩展名）、tool 节点工作区绑定、runner 端串联与拒绝。
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup.ts'
import { getDatabase } from './setup.ts'
import {
  getWorkflowNodeTool,
  readWorkspaceTextFile,
  READ_FILE_MAX_BYTES,
  type WorkflowNodeContext,
} from '../src/workflow/nodes.ts'
import {
  resetWorkflowRuntimeForTest,
  startWorkflowRun,
  type WorkflowRuntimeDeps,
} from '../src/workflow/runner.ts'
import { saveWorkflow } from '../src/workflow/store.ts'
import { getPaths } from '../src/config/paths.ts'

const TEST_AGENT = 'wf-file-agent'

function nodeContext(agentId: string): WorkflowNodeContext {
  return {
    agentId,
    workflowId: 'wt-file-node',
    workflowRunId: 'run-file-node',
    traceId: 'trace-file-node',
    stepId: 'read',
    stepIndex: 0,
    signal: new AbortController().signal,
  }
}

/** 只提供 llm 直调的最小运行时（tool + llm 步骤不投递 agent 回合）。 */
function installReadFileRuntime(): { llmPrompts: string[] } {
  const llmPrompts: string[] = []
  const deps: WorkflowRuntimeDeps = {
    hasEmployee: (id) => id === 'office-assistant',
    dispatchMessage: () => { throw new Error('read_file 用例不应触发 agent 回合') },
    subscribeChatEvents: () => () => {},
    runLlm: async (_agentId, prompt) => {
      llmPrompts.push(prompt)
      return `LLM:${prompt.slice(0, 60)}`
    },
  }
  resetWorkflowRuntimeForTest(deps)
  return { llmPrompts }
}

function officeWorkspaceFile(name: string): string {
  const dir = resolve(getPaths().agents, 'office-assistant')
  mkdirSync(dir, { recursive: true })
  return resolve(dir, name)
}

function dbCleanup() {
  const db = getDatabase()
  db.run("DELETE FROM agentops_spans WHERE trace_id IN (SELECT id FROM agentops_traces WHERE workflow_id LIKE 'wt-file%')")
  db.run("DELETE FROM agentops_traces WHERE workflow_id LIKE 'wt-file%'")
  db.run("DELETE FROM workflow_runs WHERE workflow_id LIKE 'wt-file%'")
  db.run("DELETE FROM workflows WHERE id LIKE 'wt-file%'")
  db.run("DELETE FROM chats WHERE chat_id LIKE 'workflow:wt-file%'")
  resetWorkflowRuntimeForTest()
}

afterEach(dbCleanup)
afterAll(() => {
  rmSync(resolve(getPaths().agents, TEST_AGENT), { recursive: true, force: true })
  rmSync(officeWorkspaceFile('wf-input.txt'), { force: true })
  rmSync(resolve(getPaths().agents, '..', 'wf-outside-secret.txt'), { force: true })
})

describe('readWorkspaceTextFile 安全校验', () => {
  test('工作区内正常读取（相对路径）+ maxChars 截断', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-ok-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(resolve(workspace, 'notes.md'), '工作流文件输入·真实内容\n第二行')
    try {
      expect(readWorkspaceTextFile('notes.md', workspace)).toBe('工作流文件输入·真实内容\n第二行')
      expect(readWorkspaceTextFile('notes.md', workspace, { maxChars: 5 })).toBe('工作流文件')
      // maxChars 非法（0/NaN）→ 不截断
      expect(readWorkspaceTextFile('notes.md', workspace, { maxChars: 0 })).toContain('第二行')
      expect(readWorkspaceTextFile('notes.md', workspace, { maxChars: Number.NaN })).toContain('第二行')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('工作区内绝对路径也放行', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-abs-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const file = resolve(workspace, 'data.csv')
    writeFileSync(file, 'a,b\n1,2')
    try {
      expect(readWorkspaceTextFile(file, workspace)).toBe('a,b\n1,2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('空路径 / 未知扩展名 / 不存在 → 明确报错', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-reject-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    try {
      expect(() => readWorkspaceTextFile('', workspace)).toThrow(/需要 args\.path/)
      expect(() => readWorkspaceTextFile('   ', workspace)).toThrow(/需要 args\.path/)
      // 扩展名先于存在性检查：文件不存在也应先报"仅支持文本类"
      expect(() => readWorkspaceTextFile('logo.png', workspace)).toThrow(/仅支持文本类文件/)
      expect(() => readWorkspaceTextFile('app.exe', workspace)).toThrow(/仅支持文本类文件/)
      expect(() => readWorkspaceTextFile('missing.txt', workspace)).toThrow(/不存在或不可读/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('路径穿越（../ 越界到工作区外）→ 拒绝', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-esc-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    // 越界目标真实存在且扩展名合法：确保被拦下的是"容器归属"而非"不存在/扩展名"。
    writeFileSync(resolve(outside, 'secret.txt'), 'top-secret')
    try {
      expect(() => readWorkspaceTextFile('../outside/secret.txt', workspace)).toThrow(/工作区内的文件/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('软链/junction 逃逸（工作区内链接指向工作区外）→ 拒绝', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-link-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside')
    const linkedDir = resolve(workspace, 'linked')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(resolve(outside, 'secret.txt'), 'top-secret')
    try {
      symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => readWorkspaceTextFile('linked/secret.txt', workspace)).toThrow(/工作区内的文件/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('超过 256KB 上限 → 拒绝', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-big-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(resolve(workspace, 'big.txt'), 'a'.repeat(READ_FILE_MAX_BYTES + 1))
    try {
      expect(() => readWorkspaceTextFile('big.txt', workspace)).toThrow(/文件过大/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('文本扩展名但内容含 NUL 字节（伪装二进制）→ 拒绝', () => {
    const root = resolve(tmpdir(), `xjc-wf-file-bin-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(resolve(workspace, 'fake.txt'), Buffer.from([0x41, 0x00, 0x42]))
    try {
      expect(() => readWorkspaceTextFile('fake.txt', workspace)).toThrow(/二进制/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('read_file 工作流节点', () => {
  test('绑定 context.agentId 对应的工作区读取；空 agentId 拒绝', async () => {
    const tool = getWorkflowNodeTool('read_file')!
    expect(tool).toBeTruthy()
    expect(tool.effect).toBe('read')

    const dir = resolve(getPaths().agents, TEST_AGENT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'brief.md'), '# 节点级读取内容')
    try {
      expect(await tool.execute({ path: 'brief.md' }, nodeContext(TEST_AGENT))).toBe('# 节点级读取内容')
      // maxChars 参数经字符串透传后仍生效
      expect(await tool.execute({ path: 'brief.md', maxChars: '3' }, nodeContext(TEST_AGENT))).toBe('# 节')
      await expect(tool.execute({ path: 'brief.md' }, nodeContext('')))
        .rejects.toThrow(/无法确定当前员工工作区/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('read_file 工作流串联', () => {
  test('文件内容作为 tool 步产出，供后续 {{steps.x.output}} 引用', async () => {
    const runtime = installReadFileRuntime()
    const fileContent = '一季度营收数据：华东 120 万，华南 80 万。'
    writeFileSync(officeWorkspaceFile('wf-input.txt'), fileContent)

    saveWorkflow({
      id: 'wt-file-chain',
      name: '文件输入串联流',
      agentId: 'office-assistant',
      steps: [
        { id: 'read', title: '读取资料', kind: 'tool', tool: 'read_file', prompt: '', args: { path: 'wf-input.txt' } },
        { id: 'use', title: '分析', kind: 'llm', prompt: '根据资料分析：{{steps.read.output}}' },
      ],
    })

    const finished = await startWorkflowRun('wt-file-chain', {}).done
    expect(finished.status).toBe('success')
    expect(finished.outputs[0]).toBe(fileContent)
    expect(finished.outputs[1]).toStartWith('LLM:')
    expect(runtime.llmPrompts[0]).toContain(fileContent)
  })

  test('read_file 越界经 runner 触发 → run 失败并带明确错误', async () => {
    installReadFileRuntime()
    // 在工作区外（agents 上一级）放一个真实存在、扩展名合法的文件，确保拦截原因是容器归属。
    writeFileSync(resolve(getPaths().agents, '..', 'wf-outside-secret.txt'), 'secret')

    saveWorkflow({
      id: 'wt-file-escape',
      name: '文件越界流',
      agentId: 'office-assistant',
      steps: [
        { id: 'read', title: '越界读取', kind: 'tool', tool: 'read_file', prompt: '', args: { path: '../../wf-outside-secret.txt' } },
      ],
    })

    const finished = await startWorkflowRun('wt-file-escape', {}).done
    expect(finished.status).toBe('failed')
    expect(finished.error).toContain('工作区内的文件')
  })
})
