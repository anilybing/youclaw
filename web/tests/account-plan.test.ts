import { describe, expect, test } from 'bun:test'
import { resolveAccountPlanLabel } from '../src/lib/account-plan'

const labels = {
  trial: 'Trial',
  standard: 'Standard',
  premium: 'Premium',
  active: 'Active',
  unactivated: 'Not activated',
}

describe('resolveAccountPlanLabel', () => {
  test('uses the server-owned tier instead of a fixed Pro label', () => {
    expect(resolveAccountPlanLabel({ activated: true, planTier: 'trial' }, labels)).toBe('Trial')
    expect(resolveAccountPlanLabel({ activated: true, planTier: 'standard' }, labels)).toBe('Standard')
    expect(resolveAccountPlanLabel({ activated: true, planTier: 'premium' }, labels)).toBe('Premium')
  })

  test('falls back truthfully for unknown, active, and unactivated accounts', () => {
    expect(resolveAccountPlanLabel({ activated: true, planTier: 'future-tier' }, labels)).toBe('Active')
    expect(resolveAccountPlanLabel({ activated: false, planTier: null }, labels)).toBe('Not activated')
    expect(resolveAccountPlanLabel(null, labels)).toBe('Not activated')
  })
})
