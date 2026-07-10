import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const realTransport = await import('../src/api/transport')
mock.module('@/api/transport', () => ({ ...realTransport, isTauri: true }))

const realApi = await import('../src/api/client')
let releaseChannel: 'stable' | 'beta' = 'stable'
const getSettingsMock = mock(async () => ({
  update: { channel: releaseChannel },
}) as Awaited<ReturnType<typeof realApi.getSettings>>)
mock.module('@/api/client', () => ({ ...realApi, getSettings: getSettingsMock }))

let updateType: unknown = 'installer'
let portableCheckResult: unknown = null
let installerCheckResult: unknown = null
const invokeMock = mock(async (command: string) => {
  if (command === 'get_update_channel') return updateType
  if (command === 'portable_update_check') return portableCheckResult
  if (command === 'installer_update_check') return installerCheckResult
  if (command === 'portable_update_apply' || command === 'installer_update_apply') return undefined
  throw new Error(`unexpected invoke: ${command}`)
})
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const unlistenMock = mock(() => {})
const listenMock = mock(async () => unlistenMock)
mock.module('@tauri-apps/api/event', () => ({ listen: listenMock }))

const {
  applyInstallerUpdate,
  detectUpdate,
  getUpdateChannel,
} = await import('../src/lib/update-check')

afterAll(() => {
  mock.module('@/api/transport', () => ({ ...realTransport }))
  mock.module('@/api/client', () => ({ ...realApi }))
})

function invokedCommands(): string[] {
  return invokeMock.mock.calls.map(([command]) => command)
}

describe('canary update request routing', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    getSettingsMock.mockClear()
    listenMock.mockClear()
    unlistenMock.mockClear()
    updateType = 'installer'
    releaseChannel = 'stable'
    portableCheckResult = null
    installerCheckResult = {
      available: false,
      version: '',
      notes: '',
      force_update: false,
      release_id: '',
      release_channel: 'stable',
      cohort: { name: '', bucket: 0, identity: '', source: '', partial: false },
      signature_verification: 'not-checked',
    }
  })

  test('normalizes unknown update types to installer', async () => {
    updateType = 'disabled'
    expect(await getUpdateChannel()).toBe('disabled')
    updateType = 'whatever'
    expect(await getUpdateChannel()).toBe('installer')
  })

  test('offline build returns without reading settings or checking endpoints', async () => {
    updateType = 'disabled'
    const result = await detectUpdate()
    expect(result.available).toBe(false)
    expect(result.channel).toBe('disabled')
    expect(invokedCommands()).toEqual(['get_update_channel'])
    expect(getSettingsMock).toHaveBeenCalledTimes(0)
  })

  test('cloud-disabled mode performs no Tauri or sidecar update calls', async () => {
    const result = await detectUpdate(false)
    expect(result.channel).toBe('disabled')
    expect(invokeMock).toHaveBeenCalledTimes(0)
    expect(getSettingsMock).toHaveBeenCalledTimes(0)
  })

  test('portable check sends beta channel and preserves release dimensions', async () => {
    updateType = 'portable'
    releaseChannel = 'beta'
    portableCheckResult = {
      available: true,
      version: '9.9.9',
      notes: 'notes',
      force_update: true,
      release_id: 'prel_1',
      release_channel: 'beta',
      cohort: { name: 'percent:10', bucket: 4, identity: 'stable', source: 'device_hmac', partial: false },
      signature_verification: 'verified',
    }

    const result = await detectUpdate()

    expect(result.releaseId).toBe('prel_1')
    expect(result.releaseChannel).toBe('beta')
    expect(result.cohort.name).toBe('percent:10')
    expect(result.signatureVerification).toBe('verified')
    expect(invokeMock.mock.calls[1]).toEqual(['portable_update_check', { channel: 'beta' }])
  })

  test('installer check uses the Rust command so identity headers stay scoped', async () => {
    installerCheckResult = {
      available: true,
      version: '2.0.0',
      notes: 'release',
      force_update: false,
      release_id: 'rel_1',
      release_channel: 'stable',
      cohort: { name: 'percent:25', bucket: 12, identity: 'stable', source: 'device_hmac', partial: false },
      signature_verification: 'pending-artifact-verification',
    }

    const result = await detectUpdate()

    expect(result.channel).toBe('installer')
    expect(result.releaseId).toBe('rel_1')
    expect(invokedCommands()).toEqual(['get_update_channel', 'installer_update_check'])
    expect(invokeMock.mock.calls[1]).toEqual(['installer_update_check', { channel: 'stable' }])
  })

  test('installer apply consumes the checked Rust offer and always removes listener', async () => {
    await applyInstallerUpdate()
    expect(invokeMock).toHaveBeenCalledWith('installer_update_apply')
    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })
})
