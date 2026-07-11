export interface AccountPlanUser {
  activated?: boolean
  planTier?: string | null
}

export interface AccountPlanLabels {
  trial: string
  standard: string
  premium: string
  active: string
  unactivated: string
}

/**
 * Convert the server-owned entitlement into truthful UI copy.
 * Unknown future tiers stay generic instead of being mislabeled as "Pro".
 */
export function resolveAccountPlanLabel(
  user: AccountPlanUser | null | undefined,
  labels: AccountPlanLabels,
): string {
  const tier = String(user?.planTier || '').trim().toLowerCase()
  if (tier === 'trial') return labels.trial
  if (tier === 'standard') return labels.standard
  if (tier === 'premium') return labels.premium
  return user?.activated ? labels.active : labels.unactivated
}
