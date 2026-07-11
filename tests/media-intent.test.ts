// [XJC] Plain-chat media routing separates intent, configuration, and billed-call authorization.
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  clearMediaConfirmationState,
  detectMediaIntent,
  resolveMediaTurnContext,
} from '../src/agent/media-intent.ts'

const CONFIGURED = {
  imageConfigured: true,
  imageEditConfigured: true,
  videoConfigured: true,
}

beforeEach(() => clearMediaConfirmationState())

describe('plain-chat media intent routing', () => {
  test('recognizes explicit image/edit/video actions and prioritizes the final media target', () => {
    expect(detectMediaIntent('调用硅基流动的 API 生成图片')).toBe('generate-image')
    expect(detectMediaIntent('帮我生成一张戴宇航头盔的橘猫海报')).toBe('generate-image')
    expect(detectMediaIntent('画一只橘猫')).toBe('generate-image')
    expect(detectMediaIntent('请把我上传的图片背景换成雪山')).toBe('edit-image')
    expect(detectMediaIntent('remove the background')).toBe('edit-image')
    expect(detectMediaIntent('把图片改成 5 秒视频')).toBe('generate-video')
  })

  test('recognizes common image nouns that used to be missed (宣传图 / logo / 插画 / 壁纸 / banner)', () => {
    expect(detectMediaIntent('帮我生成 XiaoJuClaw 宣传图')).toBe('generate-image')
    expect(detectMediaIntent('我授权你生成这张宣传图')).toBe('generate-image')
    expect(detectMediaIntent('做一个logo')).toBe('generate-image')
    expect(detectMediaIntent('设计一张banner')).toBe('generate-image')
    expect(detectMediaIntent('生成一张插画')).toBe('generate-image')
    expect(detectMediaIntent('生成一张壁纸')).toBe('generate-image')
    expect(detectMediaIntent('生成一个表情包')).toBe('generate-image')
    expect(detectMediaIntent('生成一张场景图')).toBe('generate-image')
  })

  test('does not route data charts or cost questions to image generation', () => {
    expect(detectMediaIntent('把这张数据做成图表')).toBeNull()
    expect(detectMediaIntent('生成图表')).toBeNull()
    expect(detectMediaIntent('生成一张图要花多少钱？')).toBeNull()
    // A poster that mentions price is still a real image request.
    expect(detectMediaIntent('做一张价格表海报')).toBe('generate-image')
  })

  test('excludes capability questions, tutorials, prompt writing, troubleshooting, and indirect plans', () => {
    for (const text of [
      '你能生成图片吗？',
      '帮我写一篇如何生成图片的教程',
      '生成营销方案，里面列出需要的配图',
      '给我一个海报生图提示词，不要真的生成',
      '为什么图片生成失败？',
      '排查硅基流动生图 API',
    ]) {
      expect(detectMediaIntent(text)).toBeNull()
    }
  })

  test('handles mixed negation by clause instead of cancelling the whole request', () => {
    expect(detectMediaIntent('不要生成视频，只生成一张商品图')).toBe('generate-image')
    expect(detectMediaIntent('不要帮我生成图片，只写提示词')).toBeNull()
    expect(detectMediaIntent("don't generate an image, only describe it")).toBeNull()
  })

  test('configured image action grants exactly the matching tool authorization', () => {
    const context = resolveMediaTurnContext(
      'web:chat-image',
      '生成一张戴宇航头盔的橘猫海报',
      CONFIGURED,
      1_000,
    )

    expect(context.intent).toBe('generate-image')
    expect(context.authorization.allowGenerateImage).toBe(true)
    expect(context.authorization.allowEditImage).toBe(false)
    expect(context.authorization.allowGenerateVideo).toBe(false)
    expect(context.systemInstruction).toContain('mcp__media__generate_image')
    expect(context.systemInstruction).toContain('at most once')
  })

  test('generic provider request asks only for missing visual content without authorizing a call', () => {
    const context = resolveMediaTurnContext(
      'web:chat-generic-image',
      '调用硅基流动的 API 生成图片',
      CONFIGURED,
    )

    expect(context.intent).toBe('generate-image')
    expect(context.authorization.allowGenerateImage).toBe(false)
    expect(context.systemInstruction).toContain('not provided enough subject/content details')
    expect(context.systemInstruction).toContain('do not ask for an API Key')
  })

  test('unconfigured image action is denied and points to settings', () => {
    const context = resolveMediaTurnContext('web:chat-off', '生成一张商品图', {
      imageConfigured: false,
      imageEditConfigured: false,
      videoConfigured: false,
    })

    expect(context.authorization.allowGenerateImage).toBe(false)
    expect(context.systemInstruction).toContain('设置 → 语音与媒体')
    expect(context.systemInstruction).toContain('Do not call skills')
  })

  test('video requires a pending confirmation and consumes it once', () => {
    const requested = resolveMediaTurnContext(
      'web:chat-video',
      '生成一个 5 秒产品视频',
      CONFIGURED,
      1_000,
    )
    expect(requested.authorization.allowGenerateVideo).toBe(false)
    expect(requested.systemInstruction).toContain('Ask for confirmation')

    const confirmed = resolveMediaTurnContext('web:chat-video', '确认', CONFIGURED, 2_000)
    expect(confirmed.authorization.allowGenerateVideo).toBe(true)
    expect(confirmed.systemInstruction).toContain('explicitly confirmed')

    const replayed = resolveMediaTurnContext('web:chat-video', '确认', CONFIGURED, 3_000)
    expect(replayed.authorization.allowGenerateVideo).toBe(false)
  })

  test('pending video is not authorized by unrelated payment confirmations', () => {
    resolveMediaTurnContext('web:video-payment-collision', '生成一个产品视频', CONFIGURED, 1_000)
    const unrelated = resolveMediaTurnContext(
      'web:video-payment-collision',
      '确认付费写邮件给张三',
      CONFIGURED,
      2_000,
    )
    expect(unrelated.authorization.allowGenerateVideo).toBe(false)

    const anchored = resolveMediaTurnContext(
      'web:video-payment-collision',
      '确认本次视频生成',
      CONFIGURED,
      3_000,
    )
    expect(anchored.authorization.allowGenerateVideo).toBe(true)
  })

  test('inline billed video confirmation authorizes one turn, cancellation clears pending state', () => {
    const inline = resolveMediaTurnContext(
      'web:inline-video',
      '确认付费生成一个 5 秒产品视频',
      CONFIGURED,
      1_000,
    )
    expect(inline.authorization.allowGenerateVideo).toBe(true)

    resolveMediaTurnContext('web:cancel-video', '生成一个产品视频', CONFIGURED, 1_000)
    const cancelled = resolveMediaTurnContext('web:cancel-video', '取消', CONFIGURED, 2_000)
    expect(cancelled.authorization.allowGenerateVideo).toBe(false)
    expect(resolveMediaTurnContext('web:cancel-video', '确认', CONFIGURED, 3_000).authorization.allowGenerateVideo).toBe(false)
  })

  test('image request without details closes the loop when the user authorizes on the next turn', () => {
    const asked = resolveMediaTurnContext('web:img-loop', '帮我生成一张宣传图', CONFIGURED, 1_000)
    expect(asked.intent).toBe('generate-image')
    expect(asked.authorization.allowGenerateImage).toBe(false)
    expect(asked.systemInstruction).toContain('not provided enough subject/content details')

    const authorized = resolveMediaTurnContext('web:img-loop', '我授权你生成', CONFIGURED, 2_000)
    expect(authorized.authorization.allowGenerateImage).toBe(true)
    expect(authorized.systemInstruction).toContain('mcp__media__generate_image')

    // One-shot: the same pending request is not silently re-authorized afterwards.
    const replayed = resolveMediaTurnContext('web:img-loop', '再说吧', CONFIGURED, 3_000)
    expect(replayed.authorization.allowGenerateImage).toBe(false)
  })

  test('pending image is authorized when the user supplies the requested content', () => {
    resolveMediaTurnContext('web:img-content', '生成一张插画', CONFIGURED, 1_000)
    const withContent = resolveMediaTurnContext('web:img-content', '橘色的爪子，简约扁平风', CONFIGURED, 2_000)
    expect(withContent.authorization.allowGenerateImage).toBe(true)
  })

  test('pending image is NOT authorized by a cost question, but a later affirmation still works', () => {
    resolveMediaTurnContext('web:img-cost', '生成一张宣传图', CONFIGURED, 1_000)
    const question = resolveMediaTurnContext('web:img-cost', '这个要花钱吗？', CONFIGURED, 2_000)
    expect(question.authorization.allowGenerateImage).toBe(false)

    const affirm = resolveMediaTurnContext('web:img-cost', '好的，生成吧', CONFIGURED, 3_000)
    expect(affirm.authorization.allowGenerateImage).toBe(true)
  })

  test('cancelling a pending image clears it so a later confirmation does not fire', () => {
    resolveMediaTurnContext('web:img-cancel', '生成一张宣传图', CONFIGURED, 1_000)
    const cancelled = resolveMediaTurnContext('web:img-cancel', '算了', CONFIGURED, 2_000)
    expect(cancelled.authorization.allowGenerateImage).toBe(false)
    expect(resolveMediaTurnContext('web:img-cancel', '确认', CONFIGURED, 3_000).authorization.allowGenerateImage).toBe(false)
  })

  test('unconfigured image never sets a pending confirmation', () => {
    const off = { imageConfigured: false, imageEditConfigured: false, videoConfigured: false }
    resolveMediaTurnContext('web:img-off', '生成一张宣传图', off, 1_000)
    const confirmed = resolveMediaTurnContext('web:img-off', '确认', off, 2_000)
    expect(confirmed.authorization.allowGenerateImage).toBe(false)
  })

  test('runtime puts trusted media routing in the system prompt and passes authorization to tools', () => {
    const runtimeSource = readFileSync(resolve(import.meta.dir, '../src/agent/runtime.ts'), 'utf8')
    expect(runtimeSource).toContain('resolveMediaTurnContext(chatId, prompt, mediaStatus)')
    expect(runtimeSource).toContain('mediaTurnInstruction,')
    expect(runtimeSource).toContain('mediaAuthorization: mediaTurnContext.authorization')
    expect(runtimeSource).toContain('availableToolNames')
    expect(runtimeSource).not.toContain('promptWithMediaIntent')
  })
})
