// [XJC] 交付物登记：service CRUD/统计 + 工作流成功自动登记接线。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables } from './setup.ts'
import {
  countDeliverablesInRange,
  createDeliverable,
  deleteDeliverable,
  getDeliverable,
  listDeliverables,
  updateDeliverableStatus,
} from '../src/business/deliverables.ts'
import { saveWorkflow } from '../src/workflow/store.ts'
import { resetWorkflowRuntimeForTest, startWorkflowRun, type WorkflowRuntimeDeps } from '../src/workflow/runner.ts'

describe('deliverable registry service', () => {
  beforeEach(() => cleanTables('deliverables'))

  test('create/get/list round-trip defaults to draft', () => {
    const d = createDeliverable({ title: '周报', type: 'report', sourceKind: 'workflow', sourceId: 'run-1', summary: '正文' })
    expect(d.status).toBe('draft')
    expect(d.type).toBe('report')
    expect(d.source_kind).toBe('workflow')
    expect(getDeliverable(d.id)?.title).toBe('周报')
    expect(listDeliverables().length).toBe(1)
  })

  test('unknown type falls back to other and empty title gets a placeholder', () => {
    const d = createDeliverable({ title: '   ', type: 'weird' as never })
    expect(d.type).toBe('other')
    expect(d.title).toBe('未命名交付物')
  })

  test('status update, filtering, invalid status and missing id', () => {
    const d = createDeliverable({ title: 'x' })
    updateDeliverableStatus(d.id, 'adopted')
    expect(getDeliverable(d.id)?.status).toBe('adopted')
    expect(listDeliverables({ status: 'adopted' }).length).toBe(1)
    expect(listDeliverables({ status: 'draft' }).length).toBe(0)
    expect(() => updateDeliverableStatus(d.id, 'bogus' as never)).toThrow()
    expect(updateDeliverableStatus('nope', 'adopted')).toBeNull()
  })

  test('delete removes the row', () => {
    const d = createDeliverable({ title: 'x' })
    expect(deleteDeliverable(d.id)).toBe(true)
    expect(getDeliverable(d.id)).toBeNull()
    expect(deleteDeliverable('nope')).toBe(false)
  })

  test('countDeliverablesInRange counts by status within the window', () => {
    const a = createDeliverable({ title: 'a' })
    const b = createDeliverable({ title: 'b' })
    updateDeliverableStatus(a.id, 'adopted')
    updateDeliverableStatus(b.id, 'discarded')
    const wide = countDeliverablesInRange('2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
    expect(wide.total).toBe(2)
    expect(wide.adopted).toBe(1)
    expect(wide.discarded).toBe(1)
    expect(countDeliverablesInRange('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z').total).toBe(0)
  })
})

describe('workflow success auto-registers a deliverable', () => {
  beforeEach(() => cleanTables('deliverables', 'workflow_runs', 'workflows', 'chats', 'agentops_traces', 'agentops_spans'))
  afterEach(() => resetWorkflowRuntimeForTest())

  test('a successful workflow run registers one report deliverable', async () => {
    const deps: WorkflowRuntimeDeps = {
      hasEmployee: (id) => id === 'office-assistant',
      dispatchMessage: () => {},
      subscribeChatEvents: () => () => {},
      runLlm: async (_agentId, prompt) => `LLM[${prompt.slice(0, 10)}]`,
    }
    resetWorkflowRuntimeForTest(deps)
    saveWorkflow({
      id: 'wf-deliv',
      name: '周报生成',
      description: '',
      agentId: 'office-assistant',
      inputs: [],
      steps: [{ id: 's1', title: '写周报', kind: 'llm', prompt: '写一份周报' }],
      budgets: null,
    })
    const { done } = startWorkflowRun('wf-deliv', {})
    await done
    const list = listDeliverables()
    expect(list.length).toBe(1)
    expect(list[0]?.type).toBe('report')
    expect(list[0]?.source_kind).toBe('workflow')
    expect(list[0]?.title).toContain('周报生成')
  })
})
