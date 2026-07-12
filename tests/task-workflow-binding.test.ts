// [XJC] 工作流原生定时绑定：workflow_id 持久化与克隆保留（service + DB round-trip，确定性）。
import { beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables } from './setup.ts'
import {
  cloneScheduledTaskById,
  createScheduledTask,
  getScheduledTask,
} from '../src/task/index.ts'

beforeEach(() => cleanTables('scheduled_tasks', 'task_run_logs'))

describe('workflow-bound scheduled tasks (persistence)', () => {
  test('persists workflow_id and reads it back', () => {
    createScheduledTask({
      id: 'wf-task-1',
      agentId: 'agent-1',
      chatId: 'chat-1',
      prompt: '运行工作流：竞品分析',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      name: 'Daily competitor scan',
      workflowId: 'wf-abc',
    })
    expect(getScheduledTask('wf-task-1')?.workflow_id).toBe('wf-abc')
  })

  test('agent-turn tasks keep workflow_id null', () => {
    createScheduledTask({
      id: 'agent-task-1',
      agentId: 'agent-1',
      chatId: 'chat-1',
      prompt: 'summarize today',
      scheduleType: 'interval',
      scheduleValue: '60000',
    })
    expect(getScheduledTask('agent-task-1')?.workflow_id).toBeNull()
  })

  test('clone preserves the workflow binding', () => {
    createScheduledTask({
      id: 'wf-task-2',
      agentId: 'agent-1',
      chatId: 'chat-1',
      prompt: '运行工作流：周报',
      scheduleType: 'cron',
      scheduleValue: '0 8 * * 1',
      name: 'Weekly report',
      workflowId: 'wf-weekly',
    })
    const clone = cloneScheduledTaskById('wf-task-2')
    expect(clone.workflow_id).toBe('wf-weekly')
    expect(getScheduledTask(clone.id)?.workflow_id).toBe('wf-weekly')
  })
})
