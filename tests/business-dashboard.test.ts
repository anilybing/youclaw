// [XJC] 一人公司试用版：经营画像、今日快照、确定性简报与 API。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import {
  createEmptyBusinessProfile,
  getBusinessProfile,
  getBusinessProfileCompletion,
  updateBusinessProfile,
} from '../src/business/profile.ts'
import {
  getTodayBusinessSnapshot,
  renderTodayBusinessBrief,
  resolveBusinessDayRange,
} from '../src/business/dashboard.ts'
import { createBusinessRoutes } from '../src/routes/business.ts'
import {
  BUILTIN_WORKFLOWS,
  saveWorkflow,
  TODAY_BUSINESS_BRIEF_WORKFLOW_ID,
} from '../src/workflow/store.ts'
import {
  resetWorkflowRuntimeForTest,
  startWorkflowRun,
} from '../src/workflow/runner.ts'

function cleanup() {
  const db = getDatabase()
  db.run("DELETE FROM kv_state WHERE key = 'business_profile_v1'")
  db.run("DELETE FROM agentops_spans WHERE trace_id IN (SELECT id FROM agentops_traces WHERE workflow_id LIKE 'opc-%')")
  db.run("DELETE FROM agentops_traces WHERE id LIKE 'opc-%' OR workflow_id LIKE 'opc-%'")
  db.run("DELETE FROM workflow_runs WHERE id LIKE 'opc-%'")
  db.run("DELETE FROM workflows WHERE id LIKE 'opc-%'")
  db.run("DELETE FROM task_run_logs WHERE task_id LIKE 'opc-%'")
  db.run("DELETE FROM scheduled_tasks WHERE id LIKE 'opc-%'")
  db.run("DELETE FROM chat_plans WHERE chat_id LIKE 'opc-%'")
  resetWorkflowRuntimeForTest()
}

afterEach(cleanup)

function saveCompleteProfile() {
  return updateBusinessProfile({
    businessName: '星河工作室',
    businessType: '独立咨询',
    offer: '为小微团队提供 AI 流程咨询',
    targetCustomer: '需要降本增效的小微企业主',
    channels: ['微信', '小红书', '微信'],
    currentGoals: ['完成首个付费交付', '发布三个案例'],
    constraints: '每天最多投入 6 小时',
    timeZone: 'Asia/Shanghai',
  })
}

describe('business profile', () => {
  test('缺失或损坏数据回退默认值；更新时归一化列表并计算完成度', () => {
    expect(getBusinessProfile()).toEqual(createEmptyBusinessProfile())
    getDatabase().run(
      "INSERT OR REPLACE INTO kv_state (key, value) VALUES ('business_profile_v1', 'not-json')",
    )
    expect(getBusinessProfile().businessName).toBe('')

    const saved = saveCompleteProfile()
    expect(saved.channels).toEqual(['微信', '小红书'])
    expect(saved.currentGoals).toHaveLength(2)
    expect(getBusinessProfileCompletion(saved)).toEqual({
      completeness: 100,
      missingFields: [],
    })

    const renamed = updateBusinessProfile({ businessName: '星河咨询' })
    expect(renamed.businessName).toBe('星河咨询')
    expect(renamed.offer).toBe(saved.offer)
    expect(renamed.channels).toEqual(saved.channels)
    expect(renamed.currentGoals).toEqual(saved.currentGoals)
    expect(() => updateBusinessProfile({})).toThrow(/At least one profile field/)
  })

  test('API 返回画像完成度并拒绝无效时区', async () => {
    const app = createBusinessRoutes()
    const initial = await app.request('/business/profile')
    expect(initial.status).toBe(200)
    expect((await initial.json() as { completeness: number }).completeness).toBe(0)

    const invalid = await app.request('/business/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeZone: 'Mars/Olympus' }),
    })
    expect(invalid.status).toBe(400)

    const updated = await app.request('/business/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessName: 'API 测试工作室',
        businessType: '内容服务',
        offer: '内容策划',
        targetCustomer: '独立品牌',
        channels: ['微信'],
        currentGoals: ['完成试运营'],
      }),
    })
    expect(updated.status).toBe(200)
    expect((await updated.json() as { completeness: number }).completeness).toBe(100)
  })
})

describe('today business dashboard', () => {
  test('按经营时区生成半开区间日期边界', () => {
    expect(resolveBusinessDayRange(new Date('2026-07-11T01:30:00.000Z'), 'Asia/Shanghai')).toEqual({
      localDate: '2026-07-11',
      startIso: '2026-07-10T16:00:00.000Z',
      endIso: '2026-07-11T16:00:00.000Z',
    })
  })

  test('聚合结构化执行状态、排除当前简报运行且不泄漏正文与密钥', () => {
    saveCompleteProfile()
    const db = getDatabase()
    db.run(
      `INSERT INTO scheduled_tasks (
        id, agent_id, chat_id, prompt, schedule_type, schedule_value, next_run, status, created_at,
        name, consecutive_failures, delivery_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-task-active', 'office-assistant', 'opc-chat', 'API_KEY=top-secret', 'once', '2026-07-11T03:00:00.000Z', '2026-07-11T03:00:00.000Z', 'active', '2026-07-10T10:00:00.000Z', '发送晨报', 0, 'none'],
    )
    db.run(
      `INSERT INTO scheduled_tasks (
        id, agent_id, chat_id, prompt, schedule_type, schedule_value, next_run, status, created_at,
        name, consecutive_failures, delivery_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-task-paused', 'office-assistant', 'opc-chat', 'private prompt', 'interval', '1h', null, 'paused', '2026-07-10T10:00:00.000Z', '失败任务', 3, 'none'],
    )
    db.run(
      `INSERT INTO scheduled_tasks (
        id, agent_id, chat_id, prompt, schedule_type, schedule_value, next_run, status, created_at,
        name, consecutive_failures, running_since, delivery_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-task-running', 'office-assistant', 'opc-chat', 'already running', 'once', '2026-07-11T02:00:00.000Z', '2026-07-11T02:00:00.000Z', 'active', '2026-07-10T10:00:00.000Z', '执行中任务', 0, '2026-07-11T01:00:00.000Z', 'none'],
    )
    db.run(
      `INSERT INTO workflow_runs (
        id, workflow_id, status, inputs_json, outputs_json, chat_id, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-run-success', 'opc-flow', 'success', '{"secret":"input"}', '["secret output"]', 'workflow:opc', '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
    )
    db.run(
      `INSERT INTO workflow_runs (
        id, workflow_id, status, inputs_json, outputs_json, chat_id, started_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-run-failed', 'opc-flow', 'failed', '{}', '[]', 'workflow:opc', '2026-07-11T00:10:00.000Z', 'password=leak'],
    )
    db.run(
      `INSERT INTO workflow_runs (
        id, workflow_id, status, inputs_json, outputs_json, chat_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['opc-current-run', TODAY_BUSINESS_BRIEF_WORKFLOW_ID, 'running', '{}', '[]', 'workflow:opc', '2026-07-11T00:20:00.000Z'],
    )
    db.run(
      `INSERT INTO workflow_runs (
        id, workflow_id, status, inputs_json, outputs_json, chat_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['opc-outside-run', 'opc-flow', 'failed', '{}', '[]', 'workflow:opc', '2026-07-10T15:59:59.000Z'],
    )
    db.run(
      `INSERT INTO workflow_runs (
        id, workflow_id, status, inputs_json, outputs_json, chat_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['opc-overnight-run', 'opc-flow', 'running', '{}', '[]', 'workflow:opc', '2026-07-10T15:00:00.000Z'],
    )
    db.run(
      `INSERT INTO agentops_traces (
        id, kind, status, workflow_run_id, model_calls, total_tokens, cost_usd, tool_calls,
        started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-trace', 'turn', 'success', null, 2, 1234, 0.0123, 4, '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
    )
    db.run(
      `INSERT INTO agentops_traces (
        id, kind, status, workflow_run_id, model_calls, total_tokens, cost_usd, tool_calls,
        started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opc-current-trace', 'workflow', 'running', 'opc-current-run', 9, 9999, 9.9, 9, '2026-07-11T00:20:00.000Z', '2026-07-11T00:20:00.000Z'],
    )
    db.run(
      'INSERT INTO chat_plans (chat_id, agent_id, goal, steps_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['opc-plan', 'office-assistant', 'private customer contract', '[{"title":"x","status":"in_progress"}]', '2026-07-11T00:00:00.000Z'],
    )

    const snapshot = getTodayBusinessSnapshot({
      now: new Date('2026-07-11T01:30:00.000Z'),
      excludeWorkflowRunId: 'opc-current-run',
    })
    expect(snapshot.localDate).toBe('2026-07-11')
    expect(snapshot.automation.scheduledTasks).toMatchObject({
      total: 3,
      active: 2,
      paused: 1,
      running: 1,
      failing: 1,
      nextName: '发送晨报',
    })
    expect(snapshot.automation.workflowRunsToday).toEqual({
      total: 2,
      running: 0,
      runningNow: 1,
      success: 1,
      failed: 1,
    })
    expect(snapshot.automation.activePlans).toBe(1)
    expect(snapshot.automation.aiUsageToday).toMatchObject({
      modelCalls: 2,
      totalTokens: 1234,
      costUsd: 0.0123,
      toolCalls: 4,
    })
    expect(snapshot.candidateActions.slice(0, 3).map((action) => action.id)).toEqual([
      'review_failed_workflows',
      'review_failed_automations',
      'check_running_workflows',
    ])

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('private prompt')
    expect(serialized).not.toContain('secret output')
    expect(serialized).not.toContain('password=leak')
    expect(serialized).not.toContain('private customer contract')
  })

  test('简报只接受快照中的行动 ID，非法模型输出确定性回退', () => {
    saveCompleteProfile()
    const snapshot = getTodayBusinessSnapshot({ now: new Date('2026-07-11T01:30:00.000Z') })
    const validId = snapshot.candidateActions[1]!.id
    const brief = renderTodayBusinessBrief(snapshot, `["invented_revenue_action","${validId}"]`)

    expect(brief).toContain('# 今日经营行动简报')
    expect(brief).toContain(snapshot.candidateActions[1]!.title)
    expect(brief).not.toContain('invented_revenue_action')
    expect(brief).toContain('不会推测未接入的营收、订单、毛利或转化数据')
  })

  test('经营简报真实执行 tool → llm → tool，模型只能影响候选排序', async () => {
    saveCompleteProfile()
    const definition = BUILTIN_WORKFLOWS.find((workflow) => workflow.id === TODAY_BUSINESS_BRIEF_WORKFLOW_ID)!
    saveWorkflow({
      ...definition,
      id: 'opc-business-brief',
      source: 'user',
    })
    const prompts: string[] = []
    resetWorkflowRuntimeForTest({
      hasEmployee: (agentId) => agentId === 'office-assistant',
      dispatchMessage: () => { throw new Error('纯 tool/llm 工作流不应投递 agent 回合') },
      subscribeChatEvents: () => () => {},
      runLlm: async (_agentId, prompt) => {
        prompts.push(prompt)
        return '["invented_action","advance_goal_2","advance_goal_1"]'
      },
    })

    const finished = await startWorkflowRun('opc-business-brief', {}).done
    expect(finished.status).toBe('success')
    expect(finished.outputs).toHaveLength(3)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('"candidateActions"')
    expect(finished.outputs[2]).toContain('# 今日经营行动简报')
    expect(finished.outputs[2]).toContain('推进目标：发布三个案例')
    expect(finished.outputs[2]).not.toContain('invented_action')
  })
})
