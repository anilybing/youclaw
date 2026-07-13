// [XJC] 工作流 MCP 工具（对话式沉淀 + 复跑）
// 核心场景：agent 察觉用户需求是可复用的固定流水线（收集数据→分析→产出内容），
// 征得同意后 save_workflow 沉淀；以后用户一句话 run_workflow 复跑。
// 运行是异步的：run 默认等待完成（有上限），超时不丢——get_run 可随时补看。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  getRun,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  WorkflowError,
  type WorkflowStep,
  type WorkflowInput,
  type WorkflowBudgets,
} from '../workflow/store.ts'
import { startWorkflowRun, resumeWorkflowRun, SKIP_MARKER } from '../workflow/runner.ts'
import { getLogger } from '../logger/index.ts'

const RUN_WAIT_DEFAULT_S = 600
const RUN_WAIT_MAX_S = 900

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, never> }
function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}
function fail(err: unknown, fallback: string): never {
  if (err instanceof WorkflowError) throw new Error(err.message)
  getLogger().error({ error: String(err), category: 'workflow' }, fallback)
  throw new Error(fallback)
}

function summarizeRun(runId: string): string {
  const run = getRun(runId)
  if (!run) return JSON.stringify({ error: 'run not found' })
  const wf = getWorkflow(run.workflowId)
  return JSON.stringify({
    runId: run.id,
    workflow: wf?.name ?? run.workflowId,
    status: run.status,
    progress: `${Math.min(run.currentStep, wf?.steps.length ?? run.currentStep)}/${wf?.steps.length ?? '?'}`,
    chatId: run.chatId,
    error: run.error,
    errorCode: run.errorCode,
    stopReason: run.stopReason,
    budgets: run.budgets,
    usage: run.usage,
    traceId: run.traceId,
    final_output: run.status === 'success' ? run.outputs.filter((o) => o !== SKIP_MARKER).at(-1) : undefined,
    note: run.status === 'running' ? '仍在运行；稍后用 mcp__workflow__get_run 查看，或让用户打开该 chatId 会话围观过程。' : undefined,
  }, null, 2)
}

const BudgetParams = Type.Object({
  maxSteps: Type.Optional(Type.Number({ description: 'Maximum executed node invocations; each forEach item counts once.' })),
  maxTotalTokens: Type.Optional(Type.Number({ description: 'Cumulative input+output+cache token limit. Provider usage may overshoot by one call.' })),
  maxCostUsd: Type.Optional(Type.Number({ description: 'Cumulative provider-reported USD limit. May overshoot by one call; unknown prices remain partial.' })),
  maxActiveDurationMs: Type.Optional(Type.Number({ description: 'Cumulative active execution time across resume attempts.' })),
  maxToolCalls: Type.Optional(Type.Number({ description: 'Maximum tool executions, including tools invoked inside agent nodes.' })),
  deniedToolEffects: Type.Optional(Type.Array(Type.Union([
    Type.Literal('read'),
    Type.Literal('network'),
    Type.Literal('write'),
    Type.Literal('execute'),
    Type.Literal('message'),
    Type.Literal('inventory'),
    Type.Literal('unknown'),
  ]), { description: 'Tool effect classes denied before execution.' })),
  unknownCostPolicy: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('deny')], {
    description: 'allow (default) records partial cost coverage; deny blocks unknown-price models before a call.',
  })),
})

const SaveParams = Type.Object({
  id: Type.Optional(Type.String({ description: 'Stable id (lowercase-hyphen). Omit to auto-generate. Pass an existing id to update it.' })),
  name: Type.String({ description: 'Human name, e.g. "周报数据流水线".' }),
  description: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String({ description: 'Executor employee id. Default: current agent.' })),
  inputs: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ description: 'lowercase_snake key used as {{inputs.key}} in step prompts.' }),
    label: Type.String({ description: 'Human label asked when running.' }),
  }), { description: 'Run-time parameters (max 8).' })),
  steps: Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: 'Step ref id (lowercase_snake, default step1..stepN) for {{steps.<id>.output}} references.' })),
    title: Type.String(),
    prompt: Type.String({ description: 'Instruction template. Variables: {{inputs.key}} and {{steps.<id>.output}} (any earlier step, not just the previous one). If no steps.* ref is used, the previous output is auto-injected.' }),
    kind: Type.Optional(Type.Union([Type.Literal('agent'), Type.Literal('llm'), Type.Literal('tool'), Type.Literal('approval')], {
      description: 'agent(default)=full employee turn with tools (expensive, autonomous); llm=single model call, no tools (cheap/fast — use for rewrite/outline/summarize); tool=deterministic builtin, zero model cost; approval=human gate: the run pauses (awaiting_approval) until the user approves in the UI (put the approval question in prompt).',
    })),
    tool: Type.Optional(Type.String({ description: 'kind=tool only: one of knowledge_search / http_get / read_file / fulfillment_list_stock.' })),
    args: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'kind=tool only: tool args; values support {{variable}} templates. read_file uses { path (workspace-relative or in-workspace absolute), maxChars? }.' })),
    when: Type.Optional(Type.Object({
      var: Type.String({ description: 'Variable ref, e.g. "steps.check.output" or "inputs.topic".' }),
      op: Type.Union([Type.Literal('contains'), Type.Literal('not_contains'), Type.Literal('is_empty'), Type.Literal('not_empty')]),
      value: Type.Optional(Type.String()),
    }, { description: 'Skip this step when the condition is false (deterministic string check).' })),
    forEach: Type.Optional(Type.Object({
      var: Type.String({ description: 'List source ref, e.g. "steps.topic_pick.output". Parsed as JSON string-array, else split by lines.' }),
      maxItems: Type.Optional(Type.Number({ description: 'Iteration cap, default 5, hard max 20 (each item is one execution — cost!).' })),
    }, { description: 'Run this step once per list item. Use {{item}} and {{item_index}} in the prompt/args. Output = concatenated per-item results.' })),
  }), { description: '1-12 sequential steps. Keep steps single-purpose; prefer llm/tool kinds over agent when tools/autonomy are not needed (cheaper, more deterministic).' }),
  budgets: Type.Optional(BudgetParams),
})

const RunParams = Type.Object({
  workflowId: Type.String(),
  inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Values for the workflow inputs, e.g. {"topic": "AI 眼镜"}.' })),
  wait: Type.Optional(Type.Boolean({ description: `Wait for completion (default true, cap ${RUN_WAIT_DEFAULT_S}s). Pass false to fire-and-return runId immediately.` })),
  budgets: Type.Optional(BudgetParams),
})

const GetRunParams = Type.Object({
  runId: Type.String(),
})

const DeleteParams = Type.Object({
  workflowId: Type.String(),
})

/** 可信会话前缀：应用内 web、定时任务、Cursor 桥。渠道会话（微信/TG…）面向陌生人，禁写禁跑 */
const TRUSTED_CHAT_PREFIXES = ['web:', 'task:', 'mcp:', 'workflow:']

export function createWorkflowTools(params: { agentId: string; chatId?: string }): ToolDefinition[] {
  // 工作流步骤本身是 agent 回合，若步骤里再启动工作流会无限套娃——workflow: 会话内禁止 run
  const insideWorkflowChat = params.chatId?.startsWith('workflow:') === true
  // 渠道会话守卫：群里陌生人一句话就能触发运行烧 token / 篡改流程，运行与增删只留给应用内/定时任务
  const inChannelChat = params.chatId !== undefined && !TRUSTED_CHAT_PREFIXES.some((p) => params.chatId!.startsWith(p))
  const assertMutationAllowed = () => {
    if (inChannelChat) {
      throw new WorkflowError('WORKFLOW_INVALID', '渠道会话内不允许运行或修改工作流（防陌生人触发消耗）。请在 XiaoJuClaw 应用内操作，或建定时任务自动跑。')
    }
  }
  return [
    {
      name: 'mcp__workflow__list_workflows',
      label: 'mcp__workflow__list_workflows',
      description: 'List saved workflows (reusable multi-step pipelines) with their input parameters. Check here before building a repetitive pipeline by hand.',
      parameters: Type.Object({}),
      async execute() {
        try {
          const list = listWorkflows().map((w) => ({
            id: w.id, name: w.name, description: w.description, agentId: w.agentId,
            steps: w.steps.map((s) => s.title), inputs: w.inputs, budgets: w.budgets,
            runCount: w.runCount, lastRunAt: w.lastRunAt,
          }))
          if (list.length === 0) return ok('还没有保存任何工作流。发现用户需求是固定流水线时，用 mcp__workflow__save_workflow 沉淀一个。')
          return ok(JSON.stringify(list, null, 2))
        } catch (err) { fail(err, '查询工作流失败') }
      },
    },
    {
      name: 'mcp__workflow__save_workflow',
      label: 'mcp__workflow__save_workflow',
      description:
        'Save (or update) a reusable multi-step workflow. Use when the user\'s need is a repeatable pipeline (e.g. collect data → analyze → produce content) — propose the steps, get user consent, then save. '
        + 'Steps run sequentially as full agent turns; the previous step\'s output is injected into the next. Steps that need external info should say "联网搜索并给出来源".',
      parameters: SaveParams,
      async execute(_id, args: {
        id?: string
        name: string
        description?: string
        agentId?: string
        inputs?: WorkflowInput[]
        steps: WorkflowStep[]
        budgets?: WorkflowBudgets
      }) {
        try {
          assertMutationAllowed()
          const wf = saveWorkflow({
            id: args.id,
            name: args.name,
            description: args.description,
            agentId: args.agentId?.trim() || params.agentId,
            steps: args.steps,
            inputs: args.inputs,
            budgets: args.budgets,
            source: 'agent',
          })
          return ok(`工作流已保存：${wf.name}（id: ${wf.id}，${wf.steps.length} 步，执行员工 ${wf.agentId}）。以后可用 mcp__workflow__run_workflow 一句话复跑。`)
        } catch (err) { fail(err, '保存工作流失败') }
      },
    },
    {
      name: 'mcp__workflow__run_workflow',
      label: 'mcp__workflow__run_workflow',
      description:
        'Run a saved workflow. Steps execute sequentially with outputs chained; the whole run happens in a dedicated auditable chat. '
        + 'Default waits for completion and returns the final output; on wait-timeout the run keeps going (fetch later via get_run).',
      parameters: RunParams,
      async execute(_id, args: {
        workflowId: string
        inputs?: Record<string, string>
        wait?: boolean
        budgets?: WorkflowBudgets
      }) {
        try {
          if (insideWorkflowChat) throw new WorkflowError('WORKFLOW_INVALID', '工作流步骤内不允许再启动工作流（防套娃）')
          assertMutationAllowed()
          const { run, done } = startWorkflowRun(args.workflowId, args.inputs ?? {}, { budgets: args.budgets })
          if (args.wait === false) {
            return ok(JSON.stringify({ runId: run.id, status: 'running', chatId: run.chatId, note: '已启动；用 mcp__workflow__get_run 查询进度与结果。' }, null, 2))
          }
          const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), RUN_WAIT_MAX_S * 1000))
          const settled = await Promise.race([done, timeout])
          if (settled === 'timeout') {
            return ok(JSON.stringify({ runId: run.id, status: 'running', chatId: run.chatId, note: `等待超过 ${RUN_WAIT_MAX_S}s，运行仍在继续；稍后用 mcp__workflow__get_run 取结果。` }, null, 2))
          }
          return ok(summarizeRun(run.id))
        } catch (err) { fail(err, '运行工作流失败') }
      },
    },
    {
      name: 'mcp__workflow__get_run',
      label: 'mcp__workflow__get_run',
      description: 'Check a workflow run: status, progress, final output (when finished).',
      parameters: GetRunParams,
      async execute(_id, args: { runId: string }) {
        try {
          return ok(summarizeRun(args.runId.trim()))
        } catch (err) { fail(err, '查询运行失败') }
      },
    },
    {
      name: 'mcp__workflow__resume_run',
      label: 'mcp__workflow__resume_run',
      description: 'Resume a FAILED workflow run from the step that failed — completed steps are reused (no re-run, no extra token cost). Rejected if the workflow definition changed since that run started.',
      parameters: GetRunParams,
      async execute(_id, args: { runId: string }) {
        try {
          if (insideWorkflowChat) throw new WorkflowError('WORKFLOW_INVALID', '工作流步骤内不允许续跑工作流（防套娃）')
          assertMutationAllowed()
          const { run, done } = resumeWorkflowRun(args.runId.trim())
          const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), RUN_WAIT_MAX_S * 1000))
          const settled = await Promise.race([done, timeout])
          if (settled === 'timeout') {
            return ok(JSON.stringify({ runId: run.id, status: 'running', note: `续跑中，等待超过 ${RUN_WAIT_MAX_S}s；稍后用 mcp__workflow__get_run 取结果。` }, null, 2))
          }
          return ok(summarizeRun(run.id))
        } catch (err) { fail(err, '续跑失败') }
      },
    },
    {
      name: 'mcp__workflow__delete_workflow',
      label: 'mcp__workflow__delete_workflow',
      description: 'Delete a saved workflow (needs explicit user confirmation in conversation first). Run history is kept.',
      parameters: DeleteParams,
      async execute(_id, args: { workflowId: string }) {
        try {
          assertMutationAllowed()
          const ok_ = deleteWorkflow(args.workflowId)
          if (!ok_) throw new WorkflowError('WORKFLOW_NOT_FOUND', `工作流「${args.workflowId}」不存在`)
          return ok(`工作流「${args.workflowId}」已删除（运行历史保留）。`)
        } catch (err) { fail(err, '删除工作流失败') }
      },
    },
  ]
}
