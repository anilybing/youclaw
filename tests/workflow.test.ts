// [XJC] 工作流引擎测试：存储校验/内置种子/执行器串联/串行守卫/MCP 工具/REST 路由。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import {
  saveWorkflow,
  getWorkflow,
  listWorkflows,
  deleteWorkflow,
  createRun,
  hasRunningRun,
  reconcileInterruptedRuns,
  seedBuiltinWorkflows,
  BUILTIN_WORKFLOWS,
  getRun,
  WorkflowError,
} from '../src/workflow/store.ts'
import {
  configureWorkflowRuntime,
  resetWorkflowRuntimeForTest,
  startWorkflowRun,
  resumeWorkflowRun,
  parseForEachList,
  isWorkflowRunning,
  SKIP_MARKER,
  type WorkflowRuntimeDeps,
} from '../src/workflow/runner.ts'
import { abortRegistry } from '../src/agent/abort-registry.ts'
import { createWorkflowTools } from '../src/agent/workflow-mcp.ts'
import { createWorkflowsRoutes } from '../src/routes/workflows.ts'

function cleanup() {
  const db = getDatabase()
  db.run("DELETE FROM agentops_spans WHERE trace_id IN (SELECT id FROM agentops_traces WHERE workflow_id LIKE 'wt-%' OR workflow_id LIKE 'wf-%')")
  db.run("DELETE FROM agentops_traces WHERE workflow_id LIKE 'wt-%' OR workflow_id LIKE 'wf-%'")
  db.run("DELETE FROM workflow_runs WHERE workflow_id LIKE 'wt-%' OR workflow_id LIKE 'wf-%'")
  db.run("DELETE FROM workflows WHERE id LIKE 'wt-%' OR id LIKE 'wf-%'")
  db.run("DELETE FROM chats WHERE chat_id LIKE 'workflow:wt-%' OR chat_id LIKE 'workflow:wf-%'")
  resetWorkflowRuntimeForTest()
}

afterEach(cleanup)

type TestWorkflowEvent =
  | { type: 'complete'; fullText: string; turnId: string }
  | { type: 'error'; error: string; turnId: string }

/** echo 型 fake 运行时：agent 步回 "S{n}产出"、llm 步回 "LLM[前缀]"，记录投递内容用于断言 */
function installEchoRuntime(): { dispatched: string[]; llmPrompts: string[]; llmAgentIds: string[] } {
  const dispatched: string[] = []
  const llmPrompts: string[] = []
  const llmAgentIds: string[] = []
  const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
  const deps: WorkflowRuntimeDeps = {
    hasEmployee: (id) => id === 'office-assistant',
    dispatchMessage: ({ chatId, messageId, content }) => {
      dispatched.push(content)
      setTimeout(() => handlers.get(chatId)?.({
        type: 'complete',
        fullText: `S${dispatched.length}产出`,
        turnId: messageId,
      }), 5)
    },
    subscribeChatEvents: (chatId, handler) => {
      handlers.set(chatId, handler)
      return () => handlers.delete(chatId)
    },
    runLlm: async (agentId, prompt) => {
      llmAgentIds.push(agentId)
      llmPrompts.push(prompt)
      return `LLM[${prompt.slice(0, 20)}]`
    },
  }
  resetWorkflowRuntimeForTest(deps)
  return { dispatched, llmPrompts, llmAgentIds }
}

describe('workflow store', () => {
  test('save/get/list/delete + 校验', () => {
    const wf = saveWorkflow({
      id: 'wt-a', name: '测试流', agentId: 'office-assistant',
      steps: [{ title: '一', prompt: '做 {{thing}}' }],
      inputs: [{ key: 'thing', label: '事项' }],
    })
    expect(wf.id).toBe('wt-a')
    expect(getWorkflow('wt-a')?.steps).toHaveLength(1)
    expect(listWorkflows().some((w) => w.id === 'wt-a')).toBe(true)

    expect(() => saveWorkflow({ id: 'wt-b', name: '', agentId: 'x', steps: [{ title: 't', prompt: 'p' }] })).toThrow(/名称/)
    expect(() => saveWorkflow({ id: 'wt-b', name: 'x', agentId: 'x', steps: [] })).toThrow(/步骤数/)
    expect(() => saveWorkflow({ id: 'wt-b', name: 'x', agentId: 'x', steps: [{ title: 't', prompt: 'p' }], inputs: [{ key: 'Bad-Key', label: 'x' }] })).toThrow(/不合法/)

    expect(deleteWorkflow('wt-a')).toBe(true)
    expect(deleteWorkflow('wt-a')).toBe(false)
  })

  test('内置种子：只种一次、删除不复活', () => {
    const db = getDatabase()
    db.run("DELETE FROM kv_state WHERE key = 'workflow_builtin_seeded_v1'")
    db.run("DELETE FROM workflows WHERE source = 'builtin'")

    expect(seedBuiltinWorkflows()).toBe(BUILTIN_WORKFLOWS.length)
    expect(getWorkflow('xianyu-new-listing')?.agentId).toBe('xianyu-cs')

    deleteWorkflow('content-pipeline')
    expect(seedBuiltinWorkflows()).toBe(0) // flag 已置，不复活
    expect(getWorkflow('content-pipeline')).toBeNull()
  })
})

describe('workflow runner', () => {
  test('逐步执行：产出串联注入下一步、inputs 渲染、run 记录成功', async () => {
    installEchoRuntime()
    const echo = installEchoRuntime()
    saveWorkflow({
      id: 'wt-run', name: '两步流', agentId: 'office-assistant',
      steps: [
        { title: '收集', prompt: '收集 {{topic}} 的数据' },
        { title: '分析', prompt: '分析并出报告' },
      ],
      inputs: [{ key: 'topic', label: '主题' }],
    })

    const { run, done } = startWorkflowRun('wt-run', { topic: 'AI眼镜' })
    expect(run.status).toBe('running')
    const finished = await done
    expect(finished.status).toBe('success')
    expect(finished.outputs).toEqual(['S1产出', 'S2产出'])

    expect(echo.dispatched[0]).toContain('收集 AI眼镜 的数据')
    expect(echo.dispatched[0]).toContain('第 1/2 步')
    expect(echo.dispatched[1]).toContain('上一步产出')
    expect(echo.dispatched[1]).toContain('S1产出')

    const persisted = getRun(finished.id)!
    expect(persisted.status).toBe('success')
    expect(persisted.chatId).toStartWith('workflow:wt-run:')
  })

  test('缺输入渲染占位；步骤 error 事件 → run failed 即停', async () => {
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    let calls = 0
    resetWorkflowRuntimeForTest({
      hasEmployee: () => true,
      dispatchMessage: ({ chatId, messageId, content }) => {
        calls++
        expect(content).toContain('（未提供 topic）')
        setTimeout(() => handlers.get(chatId)?.({
          type: 'error',
          error: '模型未配置',
          turnId: messageId,
        }), 5)
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler)
        return () => handlers.delete(chatId)
      },
    })
    saveWorkflow({
      id: 'wt-fail', name: '会失败', agentId: 'office-assistant',
      steps: [{ title: '一', prompt: '关于 {{topic}}' }, { title: '二', prompt: '不该执行' }],
      inputs: [{ key: 'topic', label: '主题' }],
    })
    const { done } = startWorkflowRun('wt-fail', {})
    const finished = await done
    expect(finished.status).toBe('failed')
    expect(finished.error).toContain('模型未配置')
    expect(calls).toBe(1) // 第二步没跑
  })

  test('ignores complete events from another turn in the same chat', async () => {
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    resetWorkflowRuntimeForTest({
      hasEmployee: () => true,
      dispatchMessage: ({ chatId, messageId }) => {
        setTimeout(() => handlers.get(chatId)?.({
          type: 'complete',
          fullText: 'WRONG TURN',
          turnId: 'another-turn',
        }), 5)
        setTimeout(() => handlers.get(chatId)?.({
          type: 'complete',
          fullText: 'RIGHT TURN',
          turnId: messageId,
        }), 10)
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler)
        return () => handlers.delete(chatId)
      },
    })
    saveWorkflow({
      id: 'wt-turn-id',
      name: '事件关联流',
      agentId: 'office-assistant',
      steps: [{ title: '一', prompt: 'x' }],
    })

    const finished = await startWorkflowRun('wt-turn-id', {}).done
    expect(finished.status).toBe('success')
    expect(finished.outputs).toEqual(['RIGHT TURN'])
  })

  test('aborts the active agent query when a workflow step times out', async () => {
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    let aborted = false
    let dispatchedTurnId = ''
    const cancelledTurns: Array<{ chatId: string; turnId: string }> = []
    resetWorkflowRuntimeForTest({
      hasEmployee: () => true,
      dispatchMessage: ({ chatId, messageId }) => {
        dispatchedTurnId = messageId
        const controller = new AbortController()
        controller.signal.addEventListener('abort', () => { aborted = true }, { once: true })
        abortRegistry.register(chatId, messageId, controller)
        // Deliberately never emit complete/error.
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler)
        return () => handlers.delete(chatId)
      },
      cancelTurn: (chatId, turnId) => {
        cancelledTurns.push({ chatId, turnId })
        return { queued: 0, running: 1 }
      },
      stepTimeoutMs: 20,
    })
    saveWorkflow({
      id: 'wt-timeout-abort',
      name: '超时中止流',
      agentId: 'office-assistant',
      steps: [{ title: '一', prompt: 'x' }],
    })

    const finished = await startWorkflowRun('wt-timeout-abort', {}).done
    expect(finished.status).toBe('failed')
    expect(finished.error).toContain('步骤超时')
    expect(finished.errorCode).toBe('WORKFLOW_STEP_TIMEOUT')
    expect(finished.stopReason).toBe('step_timeout')
    expect(cancelledTurns).toEqual([{
      chatId: finished.chatId,
      turnId: dispatchedTurnId,
    }])
    expect(aborted).toBe(true)
    expect(abortRegistry.has(finished.chatId)).toBe(false)
  })

  test('异构节点：llm 直调 + tool 确定性执行 + {{steps.x.output}} 显式引用', async () => {
    const echo = installEchoRuntime()
    saveWorkflow({
      id: 'wt-mixed', name: '混合流', agentId: 'office-assistant',
      inputs: [{ key: 'q', label: '关键词' }],
      steps: [
        { id: 'gather', title: '收集', prompt: '收集 {{inputs.q}}' },                                   // agent
        { id: 'stock', title: '查库存', kind: 'tool', tool: 'fulfillment_list_stock', prompt: '' },      // tool（零模型）
        { id: 'summary', title: '总结', kind: 'llm', prompt: '总结 {{steps.gather.output}} 与库存 {{steps.stock.output}}' }, // llm 显式引用
      ],
    })
    const { done } = startWorkflowRun('wt-mixed', { q: '数据' })
    const finished = await done
    expect(finished.status).toBe('success')
    expect(finished.outputs[0]).toBe('S1产出')
    expect(finished.outputs[1]).toStartWith('[') // tool 节点返回 JSON 数组
    expect(finished.outputs[2]).toStartWith('LLM[')
    // llm 步显式引用了 steps.*：变量已渲染、且不再自动注入"上一步产出"块
    expect(echo.llmPrompts[0]).toContain('总结 S1产出')
    expect(echo.llmPrompts[0]).not.toContain('上一步产出')
  })

  test('llm 节点把各 workflow.agentId 传给员工模型解析器', async () => {
    const calls: Array<{ agentId: string; prompt: string }> = []
    resetWorkflowRuntimeForTest({
      hasEmployee: () => true,
      dispatchMessage: () => { throw new Error('纯 llm 工作流不应投递 agent 回合') },
      subscribeChatEvents: () => () => {},
      runLlm: async (agentId, prompt) => {
        calls.push({ agentId, prompt })
        return `${agentId}:ok`
      },
    })
    saveWorkflow({
      id: 'wt-model-office', name: '办公模型流', agentId: 'office-assistant',
      steps: [{ title: '总结', kind: 'llm', prompt: '办公任务' }],
    })
    saveWorkflow({
      id: 'wt-model-content', name: '创作模型流', agentId: 'content-creator',
      steps: [{ title: '改写', kind: 'llm', prompt: '创作任务' }],
    })

    const office = await startWorkflowRun('wt-model-office', {}).done
    const content = await startWorkflowRun('wt-model-content', {}).done

    expect(calls.map((call) => call.agentId)).toEqual(['office-assistant', 'content-creator'])
    expect(office.outputs).toEqual(['office-assistant:ok'])
    expect(content.outputs).toEqual(['content-creator:ok'])
  })

  test('tool 节点 args 模板渲染（knowledge_search 空库返回 []）', async () => {
    installEchoRuntime()
    saveWorkflow({
      id: 'wt-tool-args', name: '工具参数流', agentId: 'office-assistant',
      inputs: [{ key: 'kw', label: '关键词' }],
      steps: [{ id: 'kb', title: '查知识库', kind: 'tool', tool: 'knowledge_search', prompt: '', args: { query: '找 {{inputs.kw}}' } }],
    })
    const { done } = startWorkflowRun('wt-tool-args', { kw: '售后政策' })
    const finished = await done
    expect(finished.status).toBe('success')
    expect(JSON.parse(finished.outputs[0])).toEqual([])
  })

  test('when 条件：满足执行、不满足跳过（outputs 占位对齐）', async () => {
    installEchoRuntime()
    saveWorkflow({
      id: 'wt-cond', name: '条件流', agentId: 'office-assistant',
      steps: [
        { id: 'check', title: '检查', prompt: '检查' },                                                              // → S1产出
        { id: 'hit', title: '命中才跑', prompt: '深入', when: { var: 'steps.check.output', op: 'contains', value: 'S1' } },
        { id: 'miss', title: '不命中跳过', prompt: '不该跑', when: { var: 'steps.check.output', op: 'contains', value: '不存在的词' } },
      ],
    })
    const { done } = startWorkflowRun('wt-cond', {})
    const finished = await done
    expect(finished.status).toBe('success')
    expect(finished.outputs).toEqual(['S1产出', 'S2产出', '（条件不满足，已跳过）'])
  })

  test('校验：tool 缺名/步骤 id 重复/when 非法 op 拒绝；http_get 拒内网 URL（SSRF 守卫生效）', async () => {
    expect(() => saveWorkflow({ id: 'wt-v1', name: 'x', agentId: 'a', steps: [{ title: 't', prompt: '', kind: 'tool' }] })).toThrow(/缺 tool/)
    expect(() => saveWorkflow({ id: 'wt-v2', name: 'x', agentId: 'a', steps: [{ id: 'a', title: '1', prompt: 'p' }, { id: 'a', title: '2', prompt: 'p' }] })).toThrow(/重复/)
    expect(() => saveWorkflow({ id: 'wt-v3', name: 'x', agentId: 'a', steps: [{ title: 't', prompt: 'p', when: { var: 'x', op: 'gt' as never } }] })).toThrow(/不合法/)

    installEchoRuntime()
    saveWorkflow({
      id: 'wt-ssrf', name: 'ssrf', agentId: 'office-assistant',
      steps: [{ id: 'fetch', title: '抓取', kind: 'tool', tool: 'http_get', prompt: '', args: { url: 'http://127.0.0.1:8080/secret' } }],
    })
    const finished = await startWorkflowRun('wt-ssrf', {}).done
    expect(finished.status).toBe('failed')
    expect(finished.error).toContain('内网')
  })

  test('forEach：JSON 数组/按行解析 + 条数上限 + {{item}} 渲染 + 产出拼接', async () => {
    // 解析器单测
    expect(parseForEachList('["a","b","c"]', 5)).toEqual(['a', 'b', 'c'])
    expect(parseForEachList('一\n\n二\n三', 5)).toEqual(['一', '二', '三'])
    expect(parseForEachList('["a","b","c"]', 2)).toEqual(['a', 'b'])
    expect(parseForEachList('', 5)).toEqual([])

    const echo = installEchoRuntime()
    saveWorkflow({
      id: 'wt-loop', name: '循环流', agentId: 'office-assistant',
      steps: [
        { id: 'pick', title: '出清单', prompt: '列清单' },                       // agent → "S1产出"
        { id: 'each', title: '逐项处理', kind: 'llm', prompt: '处理第{{item_index}}项：{{item}}', forEach: { var: 'steps.pick.output', maxItems: 3 } },
      ],
    })
    const { done } = startWorkflowRun('wt-loop', {})
    const finished = await done
    expect(finished.status).toBe('success')
    // pick 产出单行 "S1产出" → 列表 1 项
    expect(echo.llmPrompts).toHaveLength(1)
    expect(echo.llmPrompts[0]).toContain('处理第1项：S1产出')
    expect(finished.outputs[1]).toContain('【第 1/1 项】')
  })

  test('forEach 逐项检查点：第 3 项失败后续跑只执行第 3 项及之后', async () => {
    const attempts: number[] = []
    let failThird = true
    resetWorkflowRuntimeForTest({
      hasEmployee: (id) => id === 'content-creator',
      dispatchMessage: () => { throw new Error('纯 llm 工作流不应投递 agent 回合') },
      subscribeChatEvents: () => () => {},
      runLlm: async (agentId, prompt) => {
        expect(agentId).toBe('content-creator')
        const item = Number(prompt.match(/处理 (\d+)/)?.[1])
        attempts.push(item)
        if (failThird && item === 3) throw new Error('第 3 项临时失败')
        return `结果-${item}`
      },
    })
    saveWorkflow({
      id: 'wt-loop-resume', name: '循环逐项续跑', agentId: 'content-creator',
      inputs: [{ key: 'items', label: '项目列表' }],
      steps: [{
        id: 'each',
        title: '逐项处理',
        kind: 'llm',
        prompt: '处理 {{item}}',
        forEach: { var: 'inputs.items', maxItems: 20 },
      }],
    })

    const first = await startWorkflowRun('wt-loop-resume', { items: '["1","2","3","4"]' }).done
    expect(first.status).toBe('failed')
    expect(first.currentStep).toBe(0)
    expect(first.outputs).toEqual([])
    expect(attempts).toEqual([1, 2, 3])
    const checkpointRow = getDatabase()
      .query('SELECT foreach_checkpoint_json FROM workflow_runs WHERE id = ?')
      .get(first.id) as { foreach_checkpoint_json: string }
    expect(JSON.parse(checkpointRow.foreach_checkpoint_json).outputs).toEqual(['结果-1', '结果-2'])

    failThird = false
    const beforeResume = attempts.length
    const resumed = await resumeWorkflowRun(first.id).done
    expect(resumed.status).toBe('success')
    expect(attempts.slice(beforeResume)).toEqual([3, 4])
    expect(attempts.filter((item) => item === 1)).toHaveLength(1)
    expect(attempts.filter((item) => item === 2)).toHaveLength(1)
    expect(resumed.outputs).toHaveLength(1)
    expect(resumed.outputs[0]).toContain('【第 1/4 项】1\n结果-1')
    expect(resumed.outputs[0]).toContain('【第 4/4 项】4\n结果-4')
    const completedRow = getDatabase()
      .query('SELECT foreach_checkpoint_json FROM workflow_runs WHERE id = ?')
      .get(first.id) as { foreach_checkpoint_json: string | null }
    expect(completedRow.foreach_checkpoint_json).toBeNull()
  })

  test('断点续跑：失败步起继（已完成产出复用不重跑）+ 成功 run 拒续 + 定义变更拒续', async () => {
    // 按会话计数：每次运行第 2 步失败（可开关）；产出含会话内序号与渲染后的内容
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    const callsPerChat = new Map<string, number>()
    let totalDispatches = 0
    let failSecondOfRun = true
    const deps: WorkflowRuntimeDeps = {
      hasEmployee: () => true,
      dispatchMessage: ({ chatId, messageId, content }) => {
        totalDispatches++
        const n = (callsPerChat.get(chatId) ?? 0) + 1
        callsPerChat.set(chatId, n)
        const marker = content.includes('用 A1') ? 'ref-ok' : 'no-ref'
        setTimeout(() => {
          if (failSecondOfRun && n === 2) {
            handlers.get(chatId)?.({ type: 'error', error: '临时故障', turnId: messageId })
          } else {
            handlers.get(chatId)?.({
              type: 'complete',
              fullText: n === 1 ? 'A1' : `C${n}:${marker}`,
              turnId: messageId,
            })
          }
        }, 5)
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler)
        return () => handlers.delete(chatId)
      },
    }
    resetWorkflowRuntimeForTest(deps)
    saveWorkflow({
      id: 'wt-resume', name: '续跑流', agentId: 'office-assistant',
      steps: [
        { id: 'one', title: '一', prompt: 'x' },
        { id: 'two', title: '二', prompt: '用 {{steps.one.output}}' },
        { id: 'three', title: '三', prompt: '收尾 {{steps.two.output}}' },
      ],
    })

    const first = await startWorkflowRun('wt-resume', {}).done
    expect(first.status).toBe('failed')
    expect(first.currentStep).toBe(1)
    expect(first.outputs).toEqual(['A1'])

    // 续跑：同会话继续（callsPerChat 保留），step1 不再投递
    failSecondOfRun = false
    const before = totalDispatches
    const resumed = await resumeWorkflowRun(first.id).done
    expect(resumed.status).toBe('success')
    expect(totalDispatches).toBe(before + 2) // 只跑了 step2 + step3
    expect(resumed.outputs[0]).toBe('A1') // 复用
    expect(resumed.outputs[1]).toContain('ref-ok') // step2 拿到了复用的 step1 产出渲染
    expect(resumed.outputs).toHaveLength(3)

    // 成功 run 拒续
    expect(() => resumeWorkflowRun(resumed.id)).toThrow(/只有失败/)

    // 定义变更拒续：再造一个失败 run → 改定义 → 拒绝
    failSecondOfRun = true
    const second = await startWorkflowRun('wt-resume', {}).done
    expect(second.status).toBe('failed')
    await new Promise((r) => setTimeout(r, 10)) // 保证 updatedAt > startedAt
    saveWorkflow({ id: 'wt-resume', name: '续跑流·改', agentId: 'office-assistant', steps: [{ id: 'one', title: '一', prompt: 'x' }] })
    expect(() => resumeWorkflowRun(second.id)).toThrow(/修改过/)
  })

  test('when 跳过步后的续跑变量重建（SKIP_MARKER 不进变量表）', async () => {
    expect(SKIP_MARKER).toContain('跳过')
    // 场景：step1 成功 → step2 被 when 跳过 → step3 失败 → 续跑 step3 能拿到 step1 变量
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    const callsPerChat = new Map<string, number>()
    let failThird = true
    resetWorkflowRuntimeForTest({
      hasEmployee: () => true,
      dispatchMessage: ({ chatId, messageId, content }) => {
        const n = (callsPerChat.get(chatId) ?? 0) + 1
        callsPerChat.set(chatId, n)
        const ok = content.includes('基于 BASE') ? 'got-base' : 'missing'
        setTimeout(() => {
          if (failThird && n === 2) {
            handlers.get(chatId)?.({ type: 'error', error: '故障', turnId: messageId })
          } else {
            handlers.get(chatId)?.({
              type: 'complete',
              fullText: n === 1 ? 'BASE' : `R:${ok}`,
              turnId: messageId,
            })
          }
        }, 5)
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler)
        return () => handlers.delete(chatId)
      },
    })
    saveWorkflow({
      id: 'wt-skipresume', name: '跳过续跑流', agentId: 'office-assistant',
      steps: [
        { id: 'base', title: '基础', prompt: 'x' },
        { id: 'opt', title: '可选', prompt: '不跑', when: { var: 'steps.base.output', op: 'contains', value: '不存在' } },
        { id: 'final', title: '收尾', prompt: '基于 {{steps.base.output}}' },
      ],
    })
    const first = await startWorkflowRun('wt-skipresume', {}).done
    expect(first.status).toBe('failed')
    expect(first.outputs).toEqual(['BASE', SKIP_MARKER])

    failThird = false
    const resumed = await resumeWorkflowRun(first.id).done
    expect(resumed.status).toBe('success')
    expect(resumed.outputs[2]).toContain('got-base') // 跳过占位没污染变量，base 正常复用
  })

  test('渠道会话守卫：run/save/delete 被拒，list 仍可用', async () => {
    installEchoRuntime()
    saveWorkflow({ id: 'wt-chan', name: '渠道流', agentId: 'office-assistant', steps: [{ title: '一', prompt: 'x' }] })
    const channelTools = createWorkflowTools({ agentId: 'office-assistant', chatId: 'telegram:12345' })
    const by = (n: string) => channelTools.find((t) => t.name === n)!

    await expect(by('mcp__workflow__run_workflow').execute('t', { workflowId: 'wt-chan' })).rejects.toThrow(/渠道会话/)
    await expect(by('mcp__workflow__save_workflow').execute('t', { name: 'x', steps: [{ title: 't', prompt: 'p' }] })).rejects.toThrow(/渠道会话/)
    await expect(by('mcp__workflow__delete_workflow').execute('t', { workflowId: 'wt-chan' })).rejects.toThrow(/渠道会话/)

    const listRes = await by('mcp__workflow__list_workflows').execute('t', {})
    expect(listRes.content[0].text).toContain('wt-chan')

    // 可信前缀不受影响
    const taskTools = createWorkflowTools({ agentId: 'office-assistant', chatId: 'task:abc123' })
    const runRes = await taskTools.find((t) => t.name === 'mcp__workflow__run_workflow')!.execute('t', { workflowId: 'wt-chan' })
    expect(JSON.parse(runRes.content[0].text).status).toBe('success')
  })

  test('串行守卫：同工作流在途时拒绝二次启动；未知工作流/员工报错', async () => {
    const handlers = new Map<string, (e: TestWorkflowEvent) => void>()
    let release: (() => void) | null = null
    resetWorkflowRuntimeForTest({
      hasEmployee: (id) => id === 'office-assistant',
      dispatchMessage: ({ chatId, messageId }) => {
        release = () => handlers.get(chatId)?.({ type: 'complete', fullText: 'ok', turnId: messageId })
      },
      subscribeChatEvents: (chatId, handler) => {
        handlers.set(chatId, handler as never)
        return () => handlers.delete(chatId)
      },
    })
    saveWorkflow({ id: 'wt-serial', name: '慢流', agentId: 'office-assistant', steps: [{ title: '一', prompt: 'x' }] })

    const { done } = startWorkflowRun('wt-serial', {})
    expect(isWorkflowRunning('wt-serial')).toBe(true)
    expect(() => startWorkflowRun('wt-serial', {})).toThrow(/正在运行/)
    release!()
    await done
    expect(isWorkflowRunning('wt-serial')).toBe(false)

    expect(() => startWorkflowRun('wt-ghost', {})).toThrow(WorkflowError)
    saveWorkflow({ id: 'wt-noagent', name: 'x', agentId: 'ghost-agent', steps: [{ title: '一', prompt: 'x' }] })
    expect(() => startWorkflowRun('wt-noagent', {})).toThrow(/不存在/)
  })

  test('reconciles process-interrupted running rows before allowing a new run', async () => {
    installEchoRuntime()
    saveWorkflow({
      id: 'wt-reconcile',
      name: '崩溃恢复流',
      agentId: 'office-assistant',
      steps: [{ title: '一', prompt: 'x' }],
    })
    const orphan = createRun('wt-reconcile', {}, 'workflow:wt-reconcile:orphan')
    expect(hasRunningRun('wt-reconcile')).toBe(true)
    expect(() => startWorkflowRun('wt-reconcile', {})).toThrow(/正在运行/)

    expect(reconcileInterruptedRuns()).toBeGreaterThanOrEqual(1)
    const recovered = getRun(orphan.id)!
    expect(recovered.status).toBe('failed')
    expect(recovered.error).toContain('Sidecar restarted')
    expect(hasRunningRun('wt-reconcile')).toBe(false)

    const fresh = await startWorkflowRun('wt-reconcile', {}).done
    expect(fresh.status).toBe('success')
  })
})

describe('workflow MCP 工具', () => {
  const tools = createWorkflowTools({ agentId: 'office-assistant' })
  const byName = (n: string) => tools.find((t) => t.name === n)!

  test('save → list → run(wait) → get_run → delete 全链路', async () => {
    installEchoRuntime()
    await byName('mcp__workflow__save_workflow').execute('t', {
      name: '沉淀流', steps: [{ title: '一', prompt: '做事' }],
    })
    const listText = (await byName('mcp__workflow__list_workflows').execute('t', {})).content[0].text
    const saved = (JSON.parse(listText) as Array<{ id: string; name: string; agentId: string }>).find((w) => w.name === '沉淀流')!
    expect(saved.agentId).toBe('office-assistant') // 默认执行员工=当前 agent

    const runText = (await byName('mcp__workflow__run_workflow').execute('t', { workflowId: saved.id })).content[0].text
    const runResult = JSON.parse(runText) as { runId: string; status: string; final_output?: string }
    expect(runResult.status).toBe('success')
    expect(runResult.final_output).toBe('S1产出')

    const getText = (await byName('mcp__workflow__get_run').execute('t', { runId: runResult.runId })).content[0].text
    expect(JSON.parse(getText).status).toBe('success')

    const delText = (await byName('mcp__workflow__delete_workflow').execute('t', { workflowId: saved.id })).content[0].text
    expect(delText).toContain('已删除')
  })

  test('run wait=false 立即返回 runId', async () => {
    installEchoRuntime()
    saveWorkflow({ id: 'wt-async', name: '异步流', agentId: 'office-assistant', steps: [{ title: '一', prompt: 'x' }] })
    const text = (await byName('mcp__workflow__run_workflow').execute('t', { workflowId: 'wt-async', wait: false })).content[0].text
    const parsed = JSON.parse(text) as { runId: string; status: string }
    expect(parsed.status).toBe('running')
    await new Promise((r) => setTimeout(r, 50)) // 让后台跑完，避免脏在途标记
  })

  test('防套娃：workflow: 会话内的 run_workflow 被拒绝', async () => {
    installEchoRuntime()
    saveWorkflow({ id: 'wt-nest', name: '嵌套流', agentId: 'office-assistant', steps: [{ title: '一', prompt: 'x' }] })
    const nested = createWorkflowTools({ agentId: 'office-assistant', chatId: 'workflow:wt-nest:abc' })
    const runTool = nested.find((t) => t.name === 'mcp__workflow__run_workflow')!
    await expect(runTool.execute('t', { workflowId: 'wt-nest' })).rejects.toThrow(/套娃/)
  })
})

describe('workflow 路由', () => {
  const app = createWorkflowsRoutes()

  test('POST 校验 400 / run 立即返回 / 历史与详情 / DELETE 404', async () => {
    installEchoRuntime()
    const bad = await app.request('/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', steps: [] }) })
    expect(bad.status).toBe(400)

    const created = await app.request('/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'wt-rest', name: 'REST流', agentId: 'office-assistant', steps: [{ title: '一', prompt: 'x' }] }),
    })
    expect(created.status).toBe(200)

    const runRes = await app.request('/workflows/wt-rest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const { run } = await runRes.json() as { run: { id: string; status: string } }
    expect(run.status).toBe('running')
    await new Promise((r) => setTimeout(r, 60))

    const runs = await app.request('/workflows/wt-rest/runs')
    expect(((await runs.json()) as { runs: unknown[] }).runs).toHaveLength(1)

    const detail = await app.request(`/workflow-runs/${run.id}`)
    expect(((await detail.json()) as { run: { status: string } }).run.status).toBe('success')

    expect((await app.request('/workflows/wt-ghost', { method: 'DELETE' })).status).toBe(404)
  })
})
