// [XJC] 计划 MCP 工具（自主能力强化 · 显式 planning）：让 agent 对多步任务先建
// 可持久化的计划，逐步推进并更新状态。计划每轮注入 <current_plan>（见 plans/store.ts），
// 会话压缩/应用重启后依然在场——解决"跑一半忘了走到哪"。结构对齐 memory-mcp/media-mcp。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { getPlan, renderPlan, setPlan, updateStep, PLAN_MAX_STEPS, type PlanStepStatus } from '../plans/store.ts'
import { getLogger } from '../logger/index.ts'

const SetPlanParams = Type.Object({
  goal: Type.String({ description: 'One-sentence goal of the overall task (what "done" looks like).' }),
  steps: Type.Array(Type.String(), { description: `Ordered list of concrete steps (1-${PLAN_MAX_STEPS}). Each step should be a verifiable action, not a vague phase.` }),
})

const UpdateStepParams = Type.Object({
  step: Type.Number({ description: 'Step number to update (1-based, as shown in the plan).' }),
  status: Type.String({ description: 'New status: in_progress | done | skipped | pending.' }),
})

type PlanToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
}

function ok(text: string): PlanToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}

export function createPlanTools(params: { chatId: string; agentId: string }): ToolDefinition[] {
  const { chatId, agentId } = params

  return [
    {
      name: 'mcp__plan__set_plan',
      label: 'mcp__plan__set_plan',
      description:
        'Create (or replace) the persistent step plan for THIS conversation. '
        + 'Use at the START of any task that needs 3+ distinct steps (research → produce → verify, multi-file processing, long documents). '
        + 'The plan survives session compaction and app restarts, and is re-injected every turn so you never lose track. '
        + 'Keep steps concrete and verifiable. After creating, immediately start step 1 and mark it in_progress via mcp__plan__update_step. '
        + 'Do NOT use for trivial single-step requests.',
      parameters: SetPlanParams,
      async execute(_id, args: { goal: string; steps: string[] }) {
        try {
          const plan = setPlan(chatId, agentId || null, args.goal ?? '', Array.isArray(args.steps) ? args.steps : [])
          getLogger().info({ chatId, agentId, steps: plan.steps.length, category: 'plan' }, 'Chat plan created')
          return ok(`计划已创建（会持久化并每轮注入，压缩/重启不丢失）：\n\n${renderPlan(plan)}`)
        } catch (err) {
          throw new Error(`创建计划失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
    {
      name: 'mcp__plan__update_step',
      label: 'mcp__plan__update_step',
      description:
        'Update one step\'s status in this conversation\'s plan: in_progress when you start it, done when verified complete, skipped (with a note to the user) when no longer needed. '
        + 'Update promptly — the injected plan is how you (and the user) track progress.',
      parameters: UpdateStepParams,
      async execute(_id, args: { step: number; status: string }) {
        try {
          const plan = updateStep(chatId, Number(args.step), String(args.status ?? '') as PlanStepStatus)
          const remaining = plan.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').length
          return ok(`已更新：\n\n${renderPlan(plan)}\n\n${remaining === 0 ? '计划全部完成，向用户交付结果并做简短总结。' : `剩余 ${remaining} 步未完成。`}`)
        } catch (err) {
          throw new Error(`更新计划失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
    {
      name: 'mcp__plan__get_plan',
      label: 'mcp__plan__get_plan',
      description: 'Read this conversation\'s current plan (goal + steps + statuses). Use after interruptions/compaction if you need to re-orient; the plan is also auto-injected each turn.',
      parameters: Type.Object({}),
      async execute() {
        const plan = getPlan(chatId)
        if (!plan) return ok('当前会话没有计划。多步任务请先用 mcp__plan__set_plan 创建。')
        return ok(renderPlan(plan))
      },
    },
  ]
}
