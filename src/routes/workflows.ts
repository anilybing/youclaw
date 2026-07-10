// [XJC] 工作流路由（供 web UI/自动化调用；对话式入口见 agent/workflow-mcp.ts）
//   GET    /workflows              — 列表（含步骤标题/输入参数/运行统计）
//   POST   /workflows              — 建/更新（source=user）
//   DELETE /workflows/:id          — 删除
//   POST   /workflows/:id/run      — 启动一次运行（立即返回 runId，不阻塞）
//   GET    /workflows/:id/runs     — 运行历史
//   GET    /workflow-runs/:runId   — 单次运行详情（进度/产出/错误）

import { Hono } from 'hono'
import {
  deleteWorkflow,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  saveWorkflow,
  WorkflowError,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowBudgets,
} from '../workflow/store.ts'
import { startWorkflowRun, resumeWorkflowRun } from '../workflow/runner.ts'
import { getLogger } from '../logger/index.ts'

function handleError(err: unknown, fallback: string): { status: 400 | 404 | 500; body: { error: string; errorCode?: string } } {
  if (err instanceof WorkflowError) {
    return { status: err.code === 'WORKFLOW_NOT_FOUND' ? 404 : 400, body: { error: err.message, errorCode: err.code } }
  }
  getLogger().error({ error: String(err), category: 'workflow' }, fallback)
  return { status: 500, body: { error: fallback } }
}

export function createWorkflowsRoutes() {
  const app = new Hono()

  app.get('/workflows', (c) => {
    return c.json({ workflows: listWorkflows() })
  })

  app.post('/workflows', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        id?: string; name?: string; description?: string; agentId?: string
        steps?: WorkflowStep[]; inputs?: WorkflowInput[]; budgets?: WorkflowBudgets | null
      }
      const wf = saveWorkflow({
        id: body.id,
        name: String(body.name ?? ''),
        description: body.description,
        agentId: String(body.agentId ?? ''),
        steps: Array.isArray(body.steps) ? body.steps : [],
        inputs: Array.isArray(body.inputs) ? body.inputs : [],
        budgets: body.budgets,
        source: 'user',
      })
      return c.json({ workflow: wf })
    } catch (err) {
      const { status, body } = handleError(err, '保存工作流失败')
      return c.json(body, status)
    }
  })

  app.delete('/workflows/:id', (c) => {
    const ok = deleteWorkflow(c.req.param('id'))
    if (!ok) return c.json({ error: '工作流不存在' }, 404)
    return c.json({ ok: true })
  })

  app.post('/workflows/:id/run', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        inputs?: Record<string, string>
        budgets?: WorkflowBudgets | null
      }
      const { run } = startWorkflowRun(c.req.param('id'), body.inputs ?? {}, { budgets: body.budgets })
      return c.json({ run })
    } catch (err) {
      const { status, body } = handleError(err, '启动工作流失败')
      return c.json(body, status)
    }
  })

  app.get('/workflows/:id/runs', (c) => {
    const wf = getWorkflow(c.req.param('id'))
    if (!wf) return c.json({ error: '工作流不存在' }, 404)
    return c.json({ runs: listRuns(wf.id) })
  })

  app.get('/workflow-runs/:runId', (c) => {
    const run = getRun(c.req.param('runId'))
    if (!run) return c.json({ error: '运行不存在' }, 404)
    return c.json({ run })
  })

  // 断点续跑：failed → 从失败步继续（已完成步骤产出复用，不重扣 token）
  app.post('/workflow-runs/:runId/resume', (c) => {
    try {
      const { run } = resumeWorkflowRun(c.req.param('runId'))
      return c.json({ run })
    } catch (err) {
      const { status, body } = handleError(err, '续跑失败')
      return c.json(body, status)
    }
  })

  return app
}
