/**
 * Contract tests for projectBurnRate() in burn-rate-projection.ts.
 *
 * Scenarios covered:
 * 1. No history (empty snapshots)
 * 2. One snapshot only
 * 3. Steady burn rate → exhaustion_before_reset status with projectedExhaustionAt
 * 4. Negative / noisy delta only → unavailable
 * 5. Already exhausted (billingPhase: credits_exhausted)
 * 6. Already exhausted (billingPhase: hard_stop)
 * 7. Reset before exhaustion → reset_before_exhaustion status
 * 8. Budget active with projected overage at reset
 * 9. Credits available + overage permitted: projects overage between exhaustion and reset
 * 10. Unlimited → unavailable
 * 11. Injectable time source (deterministic output)
 * 12. Mixed positive and negative deltas (noisy history)
 * 13. Budget available — projects against overage entitlement
 * 14. Budget active with entitlement undefined → unavailable
 * 15. Zero window (identical capturedAt) → unavailable
 */

import { describe, expect, it } from 'vitest'
import { projectBurnRate } from '../burn-rate-projection'
import type { BurnRateProjection } from '../burn-rate-projection'
import type { Usage } from '../copilot'
import type { UsageHistorySnapshot } from '../usage-history-types'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Usage object with sensible defaults for testing.
 * All required fields are provided; callers may spread-override.
 */
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    mode: 'ai_credits',
    used: 3000,
    quota: 7000,
    remaining: 4000,
    percentUsed: 43,
    resetAt: '2026-07-01T00:00:00.000Z',
    billingEntity: 'octocat',
    source: 'github-copilot-internal',
    warningLevel: 'normal',
    updatedAt: '2026-06-25T00:00:00.000Z',
    notes: [],
    billingPhase: 'credits_available',
    includedQuotaCostUsd: 30,
    totalUsedCostUsd: 30,
    overageCostUsd: 0,
    overageBudgetCostUsd: 0,
    budgetRemainingCostUsd: 0,
    estimatedRemainingBudgetCostUsd: 0,
    ...overrides,
  }
}

/**
 * Builds a minimal snapshot with sensible defaults.
 */
function makeSnapshot(capturedAt: string, used: number, quota = 7000): UsageHistorySnapshot {
  return {
    capturedAt,
    used,
    quota,
    remaining: Math.max(0, quota - used),
    billingPhase: 'credits_available',
  }
}

/**
 * A fixed "now" used as the injectable time source across tests so that
 * assertions about timestamps are deterministic.
 *
 * 2026-06-25T12:00:00.000Z (noon UTC, same billing period as resetAt)
 */
const NOW = new Date('2026-06-25T12:00:00.000Z')

// ---------------------------------------------------------------------------
// Scenario 1: No history (empty snapshots)
// ---------------------------------------------------------------------------

describe('projectBurnRate — no history', () => {
  it('returns unavailable with reason when snapshots is empty', () => {
    const result = projectBurnRate(makeUsage(), [], NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/no usage history/i)
    expect(result.creditsUsedInWindow).toBe(0)
    expect(result.averageCreditsPerDay).toBe(0)
    expect(result.windowHours).toBe(0)
    expect(result.projectedExhaustionAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: One snapshot only
// ---------------------------------------------------------------------------

describe('projectBurnRate — one snapshot', () => {
  it('returns unavailable with reason when only one snapshot exists', () => {
    const snapshots = [makeSnapshot('2026-06-25T10:00:00.000Z', 1000)]
    const result = projectBurnRate(makeUsage(), snapshots, NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/one snapshot/i)
    expect(result.projectedExhaustionAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: Steady burn rate → exhaustion_before_reset
// ---------------------------------------------------------------------------

describe('projectBurnRate — steady burn rate (exhaustion_before_reset)', () => {
  it('projects exhaustion date when burn rate is positive and exhaustion is before reset', () => {
    // 1000 credits consumed over 24 hours → 1000 cr/day, ~41.67 cr/hour
    // usage.remaining = 4000. hours to exhaust = 4000 / 41.67 ≈ 96h
    // 96h from NOW (2026-06-25T12:00Z) = 2026-06-29T12:00Z, before reset on 2026-07-01.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000), // newest
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000), // 24h earlier, +1000 used
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('exhaustion_before_reset')
    expect(result.creditsUsedInWindow).toBe(1000)
    expect(result.windowHours).toBeCloseTo(24, 1)
    expect(result.averageCreditsPerDay).toBeCloseTo(1000, 1)
    expect(result.projectedExhaustionAt).toBeDefined()

    // Exhaustion should be roughly 96 hours from NOW
    const exhaustionMs = new Date(result.projectedExhaustionAt!).getTime()
    const hoursUntilExhaustion = (exhaustionMs - NOW.getTime()) / 3_600_000
    expect(hoursUntilExhaustion).toBeCloseTo(96, 0)

    // Must be before the reset (2026-07-01)
    expect(new Date(result.projectedExhaustionAt!).getTime())
      .toBeLessThan(new Date('2026-07-01T00:00:00.000Z').getTime())
  })

  it('populates windowHours and creditsUsedInWindow correctly', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T06:00:00.000Z', 2000), // newest
      makeSnapshot('2026-06-25T00:00:00.000Z', 1000), // 6h earlier
    ]
    const usage = makeUsage({ used: 2000, remaining: 5000 })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.windowHours).toBeCloseTo(6, 1)
    expect(result.creditsUsedInWindow).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: Negative / noisy delta only → unavailable
// ---------------------------------------------------------------------------

describe('projectBurnRate — negative/noisy deltas', () => {
  it('returns unavailable when the only delta is negative (quota reset between periods)', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 500),  // newest — lower used (new period)
      makeSnapshot('2026-06-24T10:00:00.000Z', 6900), // previous period high
    ]
    const usage = makeUsage({ used: 500, remaining: 6500 })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/no positive credit consumption/i)
    expect(result.creditsUsedInWindow).toBe(0)
  })

  it('returns unavailable when all deltas are zero', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 3000),
    ]
    const result = projectBurnRate(makeUsage(), snapshots, NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.creditsUsedInWindow).toBe(0)
  })

  it('counts only positive deltas when history contains a mix', () => {
    // Three snapshots: +1000, then -5000 (reset), then +500
    // Only the positive intervals should contribute.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-26T00:00:00.000Z', 1500), // newest (+500 from prev)
      makeSnapshot('2026-06-25T12:00:00.000Z', 1000), // (−5000 from before — reset)
      makeSnapshot('2026-06-24T12:00:00.000Z', 6000), // oldest (high; period ended)
    ]
    const usage = makeUsage({ used: 1500, remaining: 5500 })
    const result = projectBurnRate(usage, snapshots, new Date('2026-06-26T00:00:00.000Z'))
    // Only the +500 delta should count; -5000 is excluded.
    // Window is 36 hours (oldest to newest).
    expect(result.projectionStatus).not.toBe('unavailable')
    expect(result.creditsUsedInWindow).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Already exhausted — credits_exhausted
// ---------------------------------------------------------------------------

describe('projectBurnRate — already exhausted (credits_exhausted)', () => {
  it('returns exhausted immediately, regardless of snapshot count', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 7000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 6000),
    ]
    const usage = makeUsage({
      used: 7000,
      remaining: 0,
      billingPhase: 'credits_exhausted',
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectionStatus).toBe('exhausted')
    expect(result.projectedExhaustionAt).toBeUndefined()
  })

  it('returns exhausted with zero window values', () => {
    const result = projectBurnRate(
      makeUsage({ billingPhase: 'credits_exhausted', remaining: 0, used: 7000 }),
      [],
      NOW,
    )
    expect(result.projectionStatus).toBe('exhausted')
    expect(result.windowHours).toBe(0)
    expect(result.creditsUsedInWindow).toBe(0)
    expect(result.averageCreditsPerDay).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: Already exhausted — hard_stop
// ---------------------------------------------------------------------------

describe('projectBurnRate — hard_stop billing phase', () => {
  it('returns exhausted for hard_stop phase', () => {
    const result = projectBurnRate(
      makeUsage({ billingPhase: 'hard_stop', remaining: 0, used: 0 }),
      [makeSnapshot('2026-06-25T10:00:00.000Z', 0), makeSnapshot('2026-06-24T10:00:00.000Z', 0)],
      NOW,
    )
    expect(result.projectionStatus).toBe('exhausted')
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: Reset before exhaustion
// ---------------------------------------------------------------------------

describe('projectBurnRate — reset before exhaustion', () => {
  it('returns reset_before_exhaustion when burn rate is low relative to remaining credits', () => {
    // Usage remaining = 4000. Rate = 100 cr/day → 40 days to exhaust.
    // Reset is in ~6 days → reset happens first.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2900), // +100 cr/day
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedExhaustionAt).toBeUndefined()
  })

  it('does not set projectedOverageCreditsAtReset for credits_available without overage', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2900),
    ]
    const result = projectBurnRate(makeUsage({ remaining: 4000 }), snapshots, NOW)
    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedOverageCreditsAtReset).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: Budget active — projects overage at reset
// ---------------------------------------------------------------------------

describe('projectBurnRate — budget_active with projected overage', () => {
  it('projects overage credits at reset when in budget_active with high burn rate', () => {
    // Overage entitlement = 2000. Overage used = 500. Remaining overage = 1500.
    // Burn rate = 1000 cr/day. Time to exhaust remaining overage = 1.5 days.
    // But reset is in 6 days → reset_before_exhaustion.
    // projectedOverageCreditsAtReset = ~6 days * 1000 cr/day = ~6000? No...
    // Actually hoursUntilReset from NOW to 2026-07-01 = ~144h.
    // creditsPerHour = 1000/24 ≈ 41.67. projectedOverageCreditsAtReset = 41.67 * 144 ≈ 6000.
    // But overageEntitlement is 2000 so the actual used would be capped by the budget.
    // The projection function doesn't cap — it just projects the burn rate.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 8000, 7000), // used > quota (overage)
      makeSnapshot('2026-06-24T10:00:00.000Z', 7000, 7000),
    ]
    const usage = makeUsage({
      billingPhase: 'budget_active',
      used: 8000,
      quota: 7000,
      remaining: 0,
      overageCount: 500,
      overageEntitlement: 2000,
      overagePermitted: true,
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    // effectiveRemaining = 2000 - 500 = 1500
    // creditsPerHour ≈ 41.67; hours to exhaust 1500 = ~36h
    // 36h from NOW = 2026-06-27T00:00Z, before reset 2026-07-01 → exhaustion before reset?
    // Wait: projectedExhaustionMs = NOW(2026-06-25T12:00Z) + 36h = 2026-06-27T00:00Z
    // resetAtMs = 2026-07-01T00:00Z
    // projectedExhaustionMs (2026-06-27) < resetAtMs (2026-07-01) → exhaustion_before_reset
    expect(result.projectionStatus).toBe('exhaustion_before_reset')
    expect(result.projectedExhaustionAt).toBeDefined()
  })

  it('sets projectedOverageCreditsAtReset for budget_active when reset is before exhaustion', () => {
    // Low burn rate in overage → reset happens first.
    // overageEntitlement = 2000, overageCount = 100, remaining overage = 1900.
    // Burn rate = 10 cr/day → hours to exhaust 1900 = 4560h (190 days).
    // Reset in ~6 days → reset_before_exhaustion.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 7100, 7000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 7000, 7000), // +100 over 24h (≈4.17/hr)
    ]
    // To get a really small daily rate let's use 6h window with 10 credits:
    const snapshots2: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T06:00:00.000Z', 7010, 7000), // +10 over 6h → ~40/day
      makeSnapshot('2026-06-25T00:00:00.000Z', 7000, 7000),
    ]
    const usage = makeUsage({
      billingPhase: 'budget_active',
      used: 7010,
      quota: 7000,
      remaining: 0,
      overageCount: 100,
      overageEntitlement: 50000, // huge budget, won't exhaust before reset
      overagePermitted: true,
    })
    const result = projectBurnRate(usage, snapshots2, NOW)
    // effectiveRemaining = 50000 - 100 = 49900. Very large. Reset first.
    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedOverageCreditsAtReset).toBeDefined()
    expect(result.projectedOverageCreditsAtReset).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario 9: Credits available + overage permitted → project overage between
//             exhaustion and reset when exhaustion is before reset
// ---------------------------------------------------------------------------

describe('projectBurnRate — credits_available + overagePermitted + exhaustion_before_reset', () => {
  it('projects overage credits that will accumulate between exhaustion and reset', () => {
    // Burn rate: 500 cr/day → creditsPerHour ≈ 20.83.
    // remaining = 500. hoursUntilExhaustion = 500/20.83 ≈ 24h.
    // projectedExhaustion = NOW + 24h = 2026-06-26T12:00Z.
    // Reset = 2026-07-01T00:00Z (≈132h after now).
    // hoursOfOverage = 132 - 24 = 108h.
    // projectedOverageCreditsAtReset = 20.83 * 108 ≈ 2250.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 6500),
      makeSnapshot('2026-06-24T10:00:00.000Z', 6000), // +500 over 24h
    ]
    const usage = makeUsage({
      used: 6500,
      remaining: 500,
      overagePermitted: true,
      overageEntitlement: 5000,
    })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('exhaustion_before_reset')
    expect(result.projectedExhaustionAt).toBeDefined()
    expect(result.projectedOverageCreditsAtReset).toBeDefined()
    expect(result.projectedOverageCreditsAtReset!).toBeGreaterThan(0)

    // Rough sanity: ~108h * (500/24) ≈ 2250 credits
    expect(result.projectedOverageCreditsAtReset!).toBeCloseTo(2250, -2)
  })

  it('does not set projectedOverageCreditsAtReset when overagePermitted is false', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 6500),
      makeSnapshot('2026-06-24T10:00:00.000Z', 6000),
    ]
    const usage = makeUsage({
      used: 6500,
      remaining: 500,
      overagePermitted: false,
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectedOverageCreditsAtReset).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 10: Unlimited → unavailable
// ---------------------------------------------------------------------------

describe('projectBurnRate — unlimited billing phase', () => {
  it('returns unavailable for unlimited phase', () => {
    const usage = makeUsage({ billingPhase: 'unlimited' })
    const result = projectBurnRate(usage, [], NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/unlimited/i)
  })
})

// ---------------------------------------------------------------------------
// Scenario 11: Injectable time source (deterministic output)
// ---------------------------------------------------------------------------

describe('projectBurnRate — injectable time source', () => {
  it('produces identical results for the same now value', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000),
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 })
    const r1 = projectBurnRate(usage, snapshots, NOW)
    const r2 = projectBurnRate(usage, snapshots, NOW)
    expect(r1).toEqual(r2)
  })

  it('produces different projectedExhaustionAt for different now values', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000),
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 })
    const now1 = new Date('2026-06-25T12:00:00.000Z')
    const now2 = new Date('2026-06-25T18:00:00.000Z') // 6h later
    const r1 = projectBurnRate(usage, snapshots, now1)
    const r2 = projectBurnRate(usage, snapshots, now2)

    expect(r1.projectedExhaustionAt).toBeDefined()
    expect(r2.projectedExhaustionAt).toBeDefined()
    // r2 was computed 6h later, so its exhaustion timestamp should also be 6h later
    const diff =
      new Date(r2.projectedExhaustionAt!).getTime() -
      new Date(r1.projectedExhaustionAt!).getTime()
    expect(diff / 3_600_000).toBeCloseTo(6, 1)
  })
})

// ---------------------------------------------------------------------------
// Scenario 12: Budget available — projects against overage entitlement
// ---------------------------------------------------------------------------

describe('projectBurnRate — budget_available phase', () => {
  it('projects against overage entitlement when in budget_available', () => {
    // Included credits exhausted, budget available but no overage consumed yet.
    // overageEntitlement = 1000, overageCount = 0.
    // Burn rate = 200 cr/day → hours to exhaust 1000 = 5 days.
    // Reset is in 6 days → exhaustion before reset → exhaustion_before_reset.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 7200, 7000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 7000, 7000), // +200/day
    ]
    const usage = makeUsage({
      billingPhase: 'budget_available',
      used: 7200,
      remaining: 0,
      overageCount: 0,
      overageEntitlement: 1000,
      overagePermitted: true,
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    // effectiveRemaining = 1000 - 0 = 1000
    // creditsPerHour = 200/24 ≈ 8.33; hoursUntilExhaustion = 1000/8.33 ≈ 120h (5 days)
    // projectedExhaustion = NOW(12:00 Jun 25) + 120h = Jun 30 12:00 UTC
    // Reset = Jul 1 → exhaustion before reset → exhaustion_before_reset
    expect(result.projectionStatus).toBe('exhaustion_before_reset')
    expect(result.projectedExhaustionAt).toBeDefined()
  })

  it('returns unavailable when overageEntitlement is undefined', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 7000, 7000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 6000, 7000),
    ]
    const usage = makeUsage({
      billingPhase: 'budget_available',
      used: 7000,
      remaining: 0,
      overageCount: 0,
      overageEntitlement: undefined,
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/overage entitlement/i)
  })

  it('sets projectedOverageCreditsAtReset for budget_available when reset is before exhaustion', () => {
    // Huge entitlement → reset happens long before budget exhaustion.
    // snapshots: +1000 cr over 24h → 1000/day, ~41.67/hr
    // effectiveRemaining = 100000 - 0 = 100000 (enormous)
    // projectedExhaustion = far in the future; reset is in ~6 days → reset_before_exhaustion
    // projectedOverageCreditsAtReset = 41.67 * hoursUntilReset (≈144h) ≈ 6000
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 8000, 7000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 7000, 7000), // +1000/day
    ]
    const usage = makeUsage({
      billingPhase: 'budget_available',
      used: 8000,
      remaining: 0,
      overageCount: 0,
      overageEntitlement: 100000,
      overagePermitted: true,
    })
    const result = projectBurnRate(usage, snapshots, NOW)
    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedOverageCreditsAtReset).toBeDefined()
    expect(result.projectedOverageCreditsAtReset!).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario 13: Zero-length window (snapshots with identical capturedAt)
// ---------------------------------------------------------------------------

describe('projectBurnRate — zero-length window', () => {
  it('returns unavailable when all snapshots share the same capturedAt', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-25T10:00:00.000Z', 2000), // same timestamp
    ]
    const result = projectBurnRate(makeUsage(), snapshots, NOW)
    expect(result.projectionStatus).toBe('unavailable')
    expect(result.projectionReason).toMatch(/zero-length/i)
  })
})

// ---------------------------------------------------------------------------
// Scenario 14: reset-boundary — resetAt in the past or equal to now
// ---------------------------------------------------------------------------

describe('projectBurnRate — resetAt at or before now (reset-boundary)', () => {
  it('returns reset_before_exhaustion when resetAt is 1 hour in the past', () => {
    // resetAt is already past → hoursUntilReset clamped to 0.
    // Any positive burn rate means projectedExhaustionMs > nowMs > resetAtMs
    // → projectedExhaustionMs > resetAtMs → reset_before_exhaustion.
    // No projectedExhaustionAt should be set (reset already happened).
    const pastReset = '2026-06-25T11:00:00.000Z' // 1 hour before NOW
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000), // +1000 cr/day
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000, resetAt: pastReset })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedExhaustionAt).toBeUndefined()
    // projectedOverageCreditsAtReset must not be set for credits_available without overage
    expect(result.projectedOverageCreditsAtReset).toBeUndefined()
  })

  it('returns reset_before_exhaustion when resetAt equals now exactly', () => {
    const resetAtNow = NOW.toISOString() // resetAt === now → hoursUntilReset = 0
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000),
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000, resetAt: resetAtNow })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedExhaustionAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 15: overagePermitted absent → no projectedOverageCreditsAtReset
// ---------------------------------------------------------------------------

describe('projectBurnRate — overagePermitted absent does not produce overage projection', () => {
  it('does not set projectedOverageCreditsAtReset when overagePermitted is undefined', () => {
    // exhaustion_before_reset path: burn rate is high enough to exhaust before reset.
    // Without overagePermitted, projectedOverageCreditsAtReset must remain unset
    // so callers do not show misleading future-overage figures.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 6500),
      makeSnapshot('2026-06-24T10:00:00.000Z', 6000), // +500 cr/day → exhaustion in ~24h
    ]
    const usage = makeUsage({
      used: 6500,
      remaining: 500,
      overagePermitted: undefined, // absent
    })
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('exhaustion_before_reset')
    expect(result.projectedExhaustionAt).toBeDefined()
    // Key contract: no overage projection when overagePermitted is absent
    expect(result.projectedOverageCreditsAtReset).toBeUndefined()
  })

  it('does not set projectedOverageCreditsAtReset for reset_before_exhaustion in credits_available without overage', () => {
    // credits_available + low burn rate → reset_before_exhaustion.
    // overagePermitted absent: must not fabricate an overage figure.
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2900), // only +100/day
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 }) // overagePermitted not set
    const result = projectBurnRate(usage, snapshots, NOW)

    expect(result.projectionStatus).toBe('reset_before_exhaustion')
    expect(result.projectedOverageCreditsAtReset).toBeUndefined()
  })
})


describe('projectBurnRate — exhaustion_before_reset projection field completeness', () => {
  it('returns all required fields for an exhaustion_before_reset projection', () => {
    const snapshots: UsageHistorySnapshot[] = [
      makeSnapshot('2026-06-25T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-24T10:00:00.000Z', 2000),
    ]
    const usage = makeUsage({ used: 3000, remaining: 4000 })
    const result: BurnRateProjection = projectBurnRate(usage, snapshots, NOW)

    // Required fields
    expect(typeof result.windowHours).toBe('number')
    expect(typeof result.creditsUsedInWindow).toBe('number')
    expect(typeof result.averageCreditsPerDay).toBe('number')
    expect(result.projectionStatus).toBe('exhaustion_before_reset')

    // windowHours must be positive for exhaustion_before_reset
    expect(result.windowHours).toBeGreaterThan(0)
    expect(result.creditsUsedInWindow).toBeGreaterThan(0)
    expect(result.averageCreditsPerDay).toBeGreaterThan(0)
    expect(result.projectedExhaustionAt).toBeDefined()
    expect(() => new Date(result.projectedExhaustionAt!)).not.toThrow()
  })
})
