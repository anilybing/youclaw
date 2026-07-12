import { describe, expect, test } from 'bun:test'
import { isChitchat, routeIntent, filterToolsByPolicy, type IntentClassifier } from './intent-router.ts'

describe('intent-router: isChitchat', () => {
  const chitchat = ['你好', '您好', '嗨', 'hi', 'hello', '谢谢', '谢谢你', '再见', '在吗', '你是谁', '你能做什么', '你能帮我做什么', '介绍一下你自己']
  for (const t of chitchat) {
    test(`chitchat: ${t}`, () => {
      expect(isChitchat(t)).toBe(true)
    })
  }

  const notChitchat = [
    '你好，帮我写个周报',
    '帮我总结这份文档',
    '画一只橘猫',
    '翻译这段话',
    'D:\\a.txt',
    '读取这个文件',
    '记住我叫小明',
    '这是一段很长很长很长很长很长很长的普通句子',
    // 裸确认词：通常是放行上一轮任务提议，必须保持全量工具
    '好的',
    '嗯',
    '继续',
    '确认',
    'ok',
    '收到',
  ]
  for (const t of notChitchat) {
    test(`not chitchat: ${t}`, () => {
      expect(isChitchat(t)).toBe(false)
    })
  }
})

describe('intent-router: routeIntent stage0', () => {
  test('image intent → media/full', async () => {
    const d = await routeIntent({ text: '给我画个海报', attachmentsKind: 'none', mediaIntent: 'generate-image' }, { lightClassifier: false })
    expect(d.category).toBe('image')
    expect(d.toolPolicy).toBe('media')
    expect(d.promptTier).toBe('full')
    expect(d.source).toBe('stage0-media')
  })

  test('video intent → media/video', async () => {
    const d = await routeIntent({ text: 'x', attachmentsKind: 'none', mediaIntent: 'generate-video' }, { lightClassifier: false })
    expect(d.category).toBe('video')
    expect(d.toolPolicy).toBe('media')
  })

  test('edit-image with images-only attachments still gets media policy', async () => {
    const d = await routeIntent({ text: '把背景换成白色', attachmentsKind: 'images-only', mediaIntent: 'edit-image' }, { lightClassifier: false })
    expect(d.toolPolicy).toBe('media')
    expect(d.source).toBe('stage0-media')
  })

  test('media intent with mixed attachments falls back to full', async () => {
    const d = await routeIntent({ text: '参考这份文档做一张海报', attachmentsKind: 'mixed', mediaIntent: 'generate-image' }, { lightClassifier: false })
    expect(d.toolPolicy).toBe('full')
    expect(d.source).toBe('attachments')
  })

  test('attachments keep full even if text looks like chitchat', async () => {
    const d = await routeIntent({ text: '你好', attachmentsKind: 'mixed', mediaIntent: null }, { lightClassifier: false })
    expect(d.toolPolicy).toBe('full')
    expect(d.source).toBe('attachments')
  })

  test('chitchat → minimal/lean', async () => {
    const d = await routeIntent({ text: '你好', attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
    expect(d.category).toBe('chitchat')
    expect(d.toolPolicy).toBe('minimal')
    expect(d.promptTier).toBe('lean')
    expect(d.source).toBe('stage0-chitchat')
  })

  test('disabled → full', async () => {
    const d = await routeIntent({ text: '你好', attachmentsKind: 'none', mediaIntent: null }, { enabled: false })
    expect(d.toolPolicy).toBe('full')
    expect(d.source).toBe('disabled')
  })
})

describe('intent-router: routeIntent stage0 narrow categories', () => {
  test('纯文本翻译 → minimal（内容在对话里，零工具）', async () => {
    const d = await routeIntent({ text: '把这段话翻译成英文：今天天气不错', attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
    expect(d.category).toBe('translate')
    expect(d.toolPolicy).toBe('minimal')
    expect(d.source).toBe('stage0-translate')
  })

  test('翻译但提到文件 → full（需要读文件）', async () => {
    const d = await routeIntent({ text: '把 D:\\resume.pdf 翻译成英文', attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
    expect(d.toolPolicy).toBe('full')
  })

  test('定时任务管理 → tasks 档', async () => {
    for (const text of ['每天早上9点提醒我写日报', '查看一下我的定时任务', '取消那个每周提醒']) {
      const d = await routeIntent({ text, attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
      expect(d.category).toBe('tasks')
      expect(d.toolPolicy).toBe('tasks')
    }
  })

  test('知识库问答 → knowledge 档', async () => {
    const d = await routeIntent({ text: '在知识库里查一下退货政策', attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
    expect(d.category).toBe('knowledge')
    expect(d.toolPolicy).toBe('knowledge')
  })

  test('普通检索请求不误入 knowledge 档', async () => {
    const d = await routeIntent({ text: '搜索一下最新的行业报告', attachmentsKind: 'none', mediaIntent: null }, { lightClassifier: false })
    expect(d.toolPolicy).toBe('full')
  })
})

describe('intent-router: routeIntent stage1', () => {
  test('short unknown → classifier chitchat → minimal', async () => {
    const classify: IntentClassifier = async () => 'chitchat'
    const d = await routeIntent({ text: '嗯我在想一些事情呢', attachmentsKind: 'none', mediaIntent: null }, { classify })
    expect(d.source).toBe('stage1')
    expect(d.toolPolicy).toBe('minimal')
    expect(d.promptTier).toBe('lean')
  })

  test('short unknown → classifier other → full', async () => {
    const classify: IntentClassifier = async () => 'other'
    const d = await routeIntent({ text: '随便说点啥呢朋友', attachmentsKind: 'none', mediaIntent: null }, { classify })
    expect(d.toolPolicy).toBe('full')
    expect(d.source).toBe('default')
  })

  test('classifier throwing falls back to full', async () => {
    const classify: IntentClassifier = async () => {
      throw new Error('boom')
    }
    const d = await routeIntent({ text: '随便说点啥呢朋友', attachmentsKind: 'none', mediaIntent: null }, { classify })
    expect(d.toolPolicy).toBe('full')
  })

  test('task-signal message does not invoke the light classifier', async () => {
    let calls = 0
    const classify: IntentClassifier = async () => {
      calls += 1
      return 'chitchat'
    }
    const taskText = '我想请你认真地帮我梳理并规划一下接下来一整个季度的工作安排和目标拆解还有排期'
    const d = await routeIntent({ text: taskText, attachmentsKind: 'none', mediaIntent: null }, { classify })
    expect(calls).toBe(0)
    expect(d.toolPolicy).toBe('full')
  })

  test('long message does not invoke the light classifier', async () => {
    let calls = 0
    const classify: IntentClassifier = async () => {
      calls += 1
      return 'chitchat'
    }
    const longText = '那天晚上我们聊到很晚天上星星特别多风也特别舒服然后我们又聊起了小时候的事情感觉时间过得真快啊转眼都这么多年过去了大家都各自忙各自的生活了偶尔想起来还是会觉得很怀念那段无忧无虑的日子'
    const d = await routeIntent({ text: longText, attachmentsKind: 'none', mediaIntent: null }, { classify })
    expect(calls).toBe(0)
    expect(d.toolPolicy).toBe('full')
  })

  test('bare affirmation does not invoke the light classifier', async () => {
    let calls = 0
    const classify: IntentClassifier = async () => {
      calls += 1
      return 'chitchat'
    }
    for (const text of ['好的', '嗯嗯', '继续', 'ok']) {
      const d = await routeIntent({ text, attachmentsKind: 'none', mediaIntent: null }, { classify })
      expect(d.toolPolicy).toBe('full')
    }
    expect(calls).toBe(0)
  })

  test('lightClassifier disabled → no call, full', async () => {
    let calls = 0
    const classify: IntentClassifier = async () => {
      calls += 1
      return 'chitchat'
    }
    const d = await routeIntent({ text: '嗯我在想一些事情呢', attachmentsKind: 'none', mediaIntent: null }, { classify, lightClassifier: false })
    expect(calls).toBe(0)
    expect(d.toolPolicy).toBe('full')
  })
})

describe('intent-router: filterToolsByPolicy', () => {
  const tools = [
    { name: 'read' },
    { name: 'bash' },
    { name: 'write' },
    { name: 'mcp__message__send_to_current_chat' },
    { name: 'mcp__memory__remember' },
    { name: 'mcp__memory__recall' },
    { name: 'mcp__media__generate_image' },
    { name: 'mcp__media__edit_image' },
    { name: 'mcp__minimax__understand_image' },
    { name: 'mcp__task__list_tasks' },
    { name: 'mcp__workflow__run_workflow' },
  ]

  test('full keeps everything', () => {
    expect(filterToolsByPolicy(tools, 'full')).toHaveLength(tools.length)
  })

  test('minimal keeps only message + memory', () => {
    const names = filterToolsByPolicy(tools, 'minimal').map((t) => t.name)
    expect(names).toEqual(['mcp__message__send_to_current_chat', 'mcp__memory__remember', 'mcp__memory__recall'])
  })

  test('media keeps media family + understand_image + message + read', () => {
    const names = filterToolsByPolicy(tools, 'media').map((t) => t.name).sort()
    expect(names).toEqual(
      ['mcp__media__edit_image', 'mcp__media__generate_image', 'mcp__message__send_to_current_chat', 'mcp__minimax__understand_image', 'read'].sort(),
    )
  })

  test('tasks keeps task management + workflow list + message', () => {
    const withTasks = [...tools, { name: 'mcp__task__update_task' }, { name: 'mcp__workflow__list_workflows' }]
    const names = filterToolsByPolicy(withTasks, 'tasks').map((t) => t.name).sort()
    expect(names).toEqual(
      ['mcp__message__send_to_current_chat', 'mcp__task__list_tasks', 'mcp__task__update_task', 'mcp__workflow__list_workflows'].sort(),
    )
    expect(names).not.toContain('bash')
    expect(names).not.toContain('mcp__workflow__run_workflow')
  })

  test('knowledge keeps knowledge search + recall + message only', () => {
    const withKnowledge = [...tools, { name: 'mcp__knowledge__search_knowledge' }]
    const names = filterToolsByPolicy(withKnowledge, 'knowledge').map((t) => t.name).sort()
    expect(names).toEqual(
      ['mcp__knowledge__search_knowledge', 'mcp__memory__recall', 'mcp__message__send_to_current_chat'].sort(),
    )
  })
})
