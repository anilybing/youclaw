import { beforeEach, describe, expect, test } from 'bun:test'
import { useUpdateStore } from '../src/stores/update'

describe('update offer state', () => {
  beforeEach(() => {
    useUpdateStore.getState().clear()
  })

  test('retains canary and signature dimensions for update UI', () => {
    useUpdateStore.getState().setAvailable({
      version: '2.0.0',
      notes: 'canary',
      channel: 'portable',
      forceUpdate: true,
      releaseId: 'prel_test',
      releaseChannel: 'beta',
      cohort: {
        name: 'named:QA',
        bucket: 7,
        identity: 'stable',
        source: 'device_hmac',
        partial: false,
      },
      signatureVerification: 'verified',
    })

    const state = useUpdateStore.getState()
    expect(state.available).toBe(true)
    expect(state.releaseId).toBe('prel_test')
    expect(state.releaseChannel).toBe('beta')
    expect(state.cohort).toMatchObject({ name: 'named:QA', identity: 'stable' })
    expect(state.signatureVerification).toBe('verified')
  })

  test('clear removes stale release metadata', () => {
    useUpdateStore.getState().setAvailable({
      version: '2.0.0',
      notes: '',
      channel: 'installer',
      releaseId: 'rel_test',
      releaseChannel: 'stable',
    })
    useUpdateStore.getState().clear()

    expect(useUpdateStore.getState()).toMatchObject({
      available: false,
      releaseId: '',
      releaseChannel: 'stable',
      signatureVerification: 'not-checked',
    })
  })
})
