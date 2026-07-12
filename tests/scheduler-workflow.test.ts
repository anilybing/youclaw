// [XJC] 工作流原生定时绑定：scheduler 执行分支——workflow_id 非空则触发工作流并取最终产出。
// 通过构造函数注入 fake startWorkflow 隔离真实 workflow runtime（生产用默认真实实现）。
import { beforeEach, describe, expect, test, mock } from 'bun:test'
import './setup.ts'
import { cleanTables } from './setup.ts'
import { createScheduledTask, getScheduledTask } from '../src/task/index.ts'
import { getMessages } from '../src/db/index.ts'
import { Scheduler } from '../src/scheduler/scheduler.ts'

const mockEventBus = { emit: mock(() => {}) } as unknown as ConstructorParameters<typeof Scheduler>[2]

beforeEach(() => cleanTables('messages', 'chats', 'scheduled_tasks', 'task_run_logs'))

function makeScheduler(startWorkflow: unknown): Scheduler {
  return new Scheduler(
    {} as unknown as ConstructorParameters<typeof Scheduler>[0],
    {} as unknown as ConstructorParameters<typeof Scheduler>[1],
    mockEventBus,
    startWorkflow as ConstructorParameters<typeof Scheduler>[3],
  )
}

function messageHasText(chatId: string, text: string): boolean {
  return getMessages(chatId, 10).some((m) => typeof m.content === 'string' && m.content.includes(text))
}

describe('workflow-bound task execution', () => {
  test('runManually triggers the bound workflow and returns its final output', async () => {
    createScheduledTask({
      id: 'wf-run-1',
      agentId: 'agent-1',
      chatId: 'chat-wf-1',
      prompt: '运行工作流：竞品分析',
      scheduleType: 'interval',
      scheduleValue: '60000',
      name: 'Comp scan',
      workflowId: 'wf-1',
    })
    const task = getScheduledTask('wf-run-1')!
    let calledWith = ''
    const scheduler = makeScheduler((id: string) => {
      calledWith = id
      return { run: {}, done: Promise.resolve({ status: 'success', outputs: ['第一步产出', '最终竞品报告'], error: null }) }
    })
    const res = await scheduler.runManually(task)
    expect(calledWith).toBe('wf-1')
    expect(res.status).toBe('success')
    expect(res.result).toBe('最终竞品报告')
    expect(messageHasText('chat-wf-1', '最终竞品报告')).toBe(true)
  })

  test('an unsuccessful workflow surfaces as a task error', async () => {
    createScheduledTask({
      id: 'wf-run-2',
      agentId: 'agent-1',
      chatId: 'chat-wf-2',
      prompt: '运行工作流：X',
      scheduleType: 'interval',
      scheduleValue: '60000',
      workflowId: 'wf-2',
    })
    const task = getScheduledTask('wf-run-2')!
    const scheduler = makeScheduler(() => ({ run: {}, done: Promise.resolve({ status: 'failed', outputs: [], error: '预算超限' }) }))
    const res = await scheduler.runManually(task)
    expect(res.status).toBe('error')
    expect(res.error).toContain('预算超限')
  })

  test('empty workflow output falls back to a placeholder', async () => {
    createScheduledTask({
      id: 'wf-run-3',
      agentId: 'agent-1',
      chatId: 'chat-wf-3',
      prompt: '运行工作流：Y',
      scheduleType: 'interval',
      scheduleValue: '60000',
      workflowId: 'wf-3',
    })
    const task = getScheduledTask('wf-run-3')!
    const scheduler = makeScheduler(() => ({ run: {}, done: Promise.resolve({ status: 'success', outputs: [], error: null }) }))
    const res = await scheduler.runManually(task)
    expect(res.status).toBe('success')
    expect(res.result).toBe('(工作流无输出)')
  })
})
