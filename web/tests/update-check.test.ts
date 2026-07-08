import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// update-check 在模块顶层读取 isTauri 常量：mock 成 Tauri 环境。
// 保留真实模块的其余导出并在本文件跑完后还原，避免污染同进程的其他测试文件。
const realTransport = await import('../src/api/transport')
mock.module('@/api/transport', () => ({ ...realTransport, isTauri: true }))

let channelValue: unknown = 'installer'
let portableCheckResult: unknown = null
const invokeMock = mock(async (cmd: string) => {
  if (cmd === 'get_update_channel') return channelValue
  if (cmd === 'portable_update_check') return portableCheckResult
  throw new Error(`unexpected invoke: ${cmd}`)
})
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const updaterCheckMock = mock(async (): Promise<unknown> => null)
mock.module('@tauri-apps/plugin-updater', () => ({ check: updaterCheckMock }))

const { detectUpdate, getUpdateChannel } = await import('../src/lib/update-check')

afterAll(() => {
  mock.module('@/api/transport', () => ({ ...realTransport }))
})

function invokedCommands(): string[] {
  return invokeMock.mock.calls.map(([cmd]) => cmd)
}

describe('getUpdateChannel', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    updaterCheckMock.mockClear()
  })

  test('maps rust "disabled" to disabled channel', async () => {
    channelValue = 'disabled'
    expect(await getUpdateChannel()).toBe('disabled')
  })

  test('maps unknown values to installer', async () => {
    channelValue = 'whatever'
    expect(await getUpdateChannel()).toBe('installer')
    channelValue = 'portable'
    expect(await getUpdateChannel()).toBe('portable')
  })
})

describe('detectUpdate offline (disabled) channel', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    updaterCheckMock.mockClear()
  })

  test('disabled channel returns NONE without any update query', async () => {
    channelValue = 'disabled'
    const res = await detectUpdate()

    expect(res.available).toBe(false)
    expect(res.version).toBe('')
    expect(res.forceUpdate).toBe(false)
    // 只允许查询通道本身，绝不 invoke portable_update_check
    expect(invokedCommands()).toEqual(['get_update_channel'])
    // 也不走 Tauri updater plugin 的 check()
    expect(updaterCheckMock).toHaveBeenCalledTimes(0)
  })

  test('portable channel still goes through portable_update_check', async () => {
    channelValue = 'portable'
    portableCheckResult = { available: true, version: '9.9.9', notes: 'notes', force_update: true }
    const res = await detectUpdate()

    expect(res).toEqual({ available: true, version: '9.9.9', notes: 'notes', channel: 'portable', forceUpdate: true })
    expect(invokedCommands()).toEqual(['get_update_channel', 'portable_update_check'])
    expect(updaterCheckMock).toHaveBeenCalledTimes(0)
  })

  test('installer channel still goes through updater plugin check()', async () => {
    channelValue = 'installer'
    const res = await detectUpdate()

    expect(res).toEqual({ available: false, version: '', notes: '', channel: 'installer', forceUpdate: false })
    expect(invokedCommands()).toEqual(['get_update_channel'])
    expect(updaterCheckMock).toHaveBeenCalledTimes(1)
  })
})
