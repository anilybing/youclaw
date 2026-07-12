// [XJC] 工作流人工审批节点：跑到 approval 步暂停（awaiting_approval），批准从下一步续跑、拒绝置 failed。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables } from './setup.ts'
import { saveWorkflow } from '../src/workflow/store.ts'
import {
  approveWorkflowRun,
  rejectWorkflowRun,
  resetWorkflowRuntimeForTest,
  startWorkflowRun,
  type WorkflowRuntimeDeps,
} from '../src/workflow/runner.ts'

function installRuntime(): void {
  const deps: WorkflowRuntimeDeps = {
    hasEmployee: (id) => id === 'office-assistant',
    dispatchMessage: () => {},
    subscribeChatEvents: () => () => {},
    runLlm: async (_agentId, prompt) => `LLM[${prompt.slice(0, 20)}]`,
  }
  resetWorkflowRuntimeForTest(deps)
}

afterEach(() => {
  resetWorkflowRuntimeForTest()
  cleanTables('agentops_spans', 'agentops_traces', 'workflow_runs', 'workflows', 'chats')
})

describe('workflow human-approval gate', () => {
  test('run pauses at an approval step and resumes on approve', async () => {
    installRuntime()
    saveWorkflow({
      id: 'wf-approval',
      name: '审批测试',
      description: '',
      agentId: 'office-assistant',
      inputs: [],
      steps: [
        { id: 'draft', title: '起草', kind: 'llm', prompt: '起草内容' },
        { id: 'gate', title: '发布前审批', kind: 'approval', prompt: '确认发布？' },
        { id: 'publish', title: '发布', kind: 'llm', prompt: '发布：{{steps.draft.output}}' },
      ],
      budgets: null,
    })
    const { run, done } = startWorkflowRun('wf-approval', {})
    const paused = await done
    expect(paused.status).toBe('awaiting_approval')
    expect(paused.currentStep).toBe(1)
    expect(paused.outputs.length).toBe(1)

    const { done: done2 } = approveWorkflowRun(run.id)
    const completed = await done2
    expect(completed.status).toBe('success')
    expect(completed.outputs.length).toBe(3)
    expect(completed.outputs[1]).toContain('已批准')
  })

  test('rejecting an approval marks the run failed', async () => {
    installRuntime()
    saveWorkflow({
      id: 'wf-approval-reject',
      name: '审批拒绝',
      description: '',
      agentId: 'office-assistant',
      inputs: [],
      steps: [
        { id: 'gate', title: '审批', kind: 'approval', prompt: '确认？' },
        { id: 'after', title: '后续', kind: 'llm', prompt: '继续' },
      ],
      budgets: null,
    })
    const { run, done } = startWorkflowRun('wf-approval-reject', {})
    await done
    const rejected = rejectWorkflowRun(run.id, '不批准')
    expect(rejected.status).toBe('failed')
    expect(rejected.errorCode).toBe('WORKFLOW_REJECTED')
    expect(rejected.error).toContain('不批准')
  })

  test('a run awaiting approval blocks a second run of the same workflow', async () => {
    installRuntime()
    saveWorkflow({
      id: 'wf-approval-lock',
      name: '审批锁',
      description: '',
      agentId: 'office-assistant',
      inputs: [],
      steps: [{ id: 'gate', title: '审批', kind: 'approval', prompt: '确认？' }],
      budgets: null,
    })
    const { done } = startWorkflowRun('wf-approval-lock', {})
    await done
    expect(() => startWorkflowRun('wf-approval-lock', {})).toThrow()
  })
})
