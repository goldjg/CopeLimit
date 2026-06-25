/**
 * Contract tests for computeComfortStatus() in comfort-status.ts.
 *
 * Scenarios covered:
 *  1.  Normal low usage (no projection)
 *  2.  High percent used but reset before exhaustion
 *  3.  Exhaustion before reset (not imminent)
 *  4.  Exhaustion before reset within 24 hours
 *  5.  Credits exhausted
 *  6.  Hard stop
 *  7.  Budget active
 *  8.  Budget available (no projection)
 *  9.  Unavailable projection with low current usage
 * 10.  Unavailable projection with high current usage
 * 11.  Unlimited
 * 12.  Missing projection entirely
 */

import { describe, expect, it } from 'vitest'
import { computeComfortStatus } from '../comfort-status'
import type { ComfortStatus } from '../comfort-status'
import type { Usage } from '../copilot'
import type { BurnRateProjection } from '../burn-rate-projection'

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
    used: 1500,
    quota: 7000,
    remaining: 5500,
    percentUsed: 21,
    resetAt: '2026-07-01T00:00:00.000Z',
    billingEntity: 'octocat',
    source: 'github-copilot-internal',
    warningLevel: 'normal',
    updatedAt: '2026-06-25T12:00:00.000Z',
    notes: [],
    billingPhase: 'credits_available',
    includedQuotaCostUsd: 15,
    totalUsedCostUsd: 15,
    overageCostUsd: 0,
    overageBudgetCostUsd: 0,
    budgetRemainingCostUsd: 0,
    estimatedRemainingBudgetCostUsd: 0,
    ...overrides,
  }
}

/**
 * Builds a minimal BurnRateProjection with sensible defaults.
 * Callers may spread-override individual fields.
 */
function makeProjection(overrides: Partial<BurnRateProjection> = {}): BurnRateProjection {
  return {
    windowHours: 24,
    creditsUsedInWindow: 1000,
    averageCreditsPerDay: 1000,
    projectionStatus: 'reset_before_exhaustion',
    ...overrides,
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
// Scenario 1: Normal low usage (no projection)
// ---------------------------------------------------------------------------

describe('computeComfortStatus — normal low usage, no projection', () => {
  it('returns safe level with remaining signal', () => {
    const usage = makeUsage({ used: 1500, remaining: 5500, percentUsed: 21, warningLevel: 'normal' })
    const result: ComfortStatus = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('remaining')
    expect(result.summary).toMatch(/21%/)
  })

  it('does not include a recommendedAction for safe usage', () => {
    const usage = makeUsage()
    const result = computeComfortStatus(usage, undefined, NOW)
    expect(result.recommendedAction).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: High percent used but reset before exhaustion
// ---------------------------------------------------------------------------

describe('computeComfortStatus — high percent used, reset before exhaustion', () => {
  it('returns watch level driven by burn_rate signal', () => {
    const usage = makeUsage({
      used: 6000,
      remaining: 1000,
      percentUsed: 86,
      warningLevel: 'hot',
    })
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('watch')
    expect(result.primarySignal).toBe('burn_rate')
  })

  it('returns safe level when percent used is low and reset is before exhaustion', () => {
    const usage = makeUsage({ percentUsed: 30, warningLevel: 'normal' })
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('burn_rate')
  })

  it('summary confirms credits will survive to reset', () => {
    const usage = makeUsage({ percentUsed: 80, warningLevel: 'hot' })
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.summary).toMatch(/billing reset/i)
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: Exhaustion before reset (not within 24 h)
// ---------------------------------------------------------------------------

describe('computeComfortStatus — exhaustion before reset (not imminent)', () => {
  it('returns warm level with burn_rate signal', () => {
    // Projected exhaustion is 4 days away (well beyond 24 h)
    const exhaustionAt = '2026-06-29T12:00:00.000Z'
    const usage = makeUsage({ percentUsed: 60, warningLevel: 'normal' })
    const projection = makeProjection({
      projectionStatus: 'exhaustion_before_reset',
      projectedExhaustionAt: exhaustionAt,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('warm')
    expect(result.primarySignal).toBe('burn_rate')
    expect(result.detail).toContain(exhaustionAt)
  })

  it('includes a recommendedAction', () => {
    const usage = makeUsage()
    const projection = makeProjection({
      projectionStatus: 'exhaustion_before_reset',
      projectedExhaustionAt: '2026-06-29T00:00:00.000Z',
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.recommendedAction).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: Exhaustion before reset within 24 hours
// ---------------------------------------------------------------------------

describe('computeComfortStatus — exhaustion before reset within 24 hours', () => {
  it('returns hot level when projected exhaustion is within 24 h', () => {
    // Projected exhaustion is 8 hours from NOW
    const exhaustionAt = '2026-06-25T20:00:00.000Z'
    const usage = makeUsage({ percentUsed: 90, warningLevel: 'hot' })
    const projection = makeProjection({
      projectionStatus: 'exhaustion_before_reset',
      projectedExhaustionAt: exhaustionAt,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('hot')
    expect(result.primarySignal).toBe('burn_rate')
    expect(result.summary).toMatch(/24 hours/i)
    expect(result.detail).toContain(exhaustionAt)
  })

  it('returns hot when projectedExhaustionAt is exactly at the 24 h boundary', () => {
    // Exactly 24 h from NOW (boundary is inclusive ≤ 24)
    const exhaustionAt = '2026-06-26T12:00:00.000Z'
    const usage = makeUsage()
    const projection = makeProjection({
      projectionStatus: 'exhaustion_before_reset',
      projectedExhaustionAt: exhaustionAt,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('hot')
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Credits exhausted
// ---------------------------------------------------------------------------

describe('computeComfortStatus — credits exhausted', () => {
  it('returns blocked level with remaining signal', () => {
    const usage = makeUsage({
      used: 7000,
      remaining: 0,
      percentUsed: 100,
      warningLevel: 'over',
      billingPhase: 'credits_exhausted',
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('blocked')
    expect(result.primarySignal).toBe('remaining')
    expect(result.recommendedAction).toBeDefined()
  })

  it('ignores any projection when billing phase is credits_exhausted', () => {
    const usage = makeUsage({ billingPhase: 'credits_exhausted', remaining: 0, percentUsed: 100 })
    // Even a healthy-looking projection should not override the terminal phase.
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: Hard stop
// ---------------------------------------------------------------------------

describe('computeComfortStatus — hard stop', () => {
  it('returns blocked level with hard_stop signal', () => {
    const usage = makeUsage({
      billingPhase: 'hard_stop',
      remaining: 0,
      percentUsed: 0,
      warningLevel: 'normal',
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('blocked')
    expect(result.primarySignal).toBe('hard_stop')
    expect(result.recommendedAction).toBeDefined()
  })

  it('ignores projection when billing phase is hard_stop', () => {
    const usage = makeUsage({ billingPhase: 'hard_stop' })
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('blocked')
    expect(result.primarySignal).toBe('hard_stop')
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: Budget active
// ---------------------------------------------------------------------------

describe('computeComfortStatus — budget active', () => {
  it('returns overage level with overage signal', () => {
    const usage = makeUsage({
      billingPhase: 'budget_active',
      overageCount: 250,
      overageEntitlement: 1000,
      remaining: 0,
      percentUsed: 100,
      warningLevel: 'over',
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('overage')
    expect(result.primarySignal).toBe('overage')
  })

  it('includes overageCount in detail when available', () => {
    const usage = makeUsage({
      billingPhase: 'budget_active',
      overageCount: 250,
      remaining: 0,
      percentUsed: 100,
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.detail).toContain('250')
  })

  it('falls back to derivedOverageCredits in detail when overageCount is absent', () => {
    const usage = makeUsage({
      billingPhase: 'budget_active',
      derivedOverageCredits: 80,
      remaining: 0,
      percentUsed: 100,
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.detail).toContain('80')
    expect(result.detail).toMatch(/estimated/i)
  })

  it('ignores projection when billing phase is budget_active', () => {
    const usage = makeUsage({ billingPhase: 'budget_active', remaining: 0, percentUsed: 100 })
    const projection = makeProjection({ projectionStatus: 'reset_before_exhaustion' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('overage')
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: Budget available (no overage spending yet)
// ---------------------------------------------------------------------------

describe('computeComfortStatus — budget available', () => {
  it('returns hot level when no projection is supplied', () => {
    const usage = makeUsage({
      billingPhase: 'budget_available',
      remaining: 0,
      percentUsed: 100,
      warningLevel: 'over',
      overageEntitlement: 1000,
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('hot')
  })

  it('returns hot level when projection is unavailable', () => {
    const usage = makeUsage({
      billingPhase: 'budget_available',
      remaining: 0,
      percentUsed: 100,
      warningLevel: 'over',
    })
    const projection = makeProjection({
      projectionStatus: 'unavailable',
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('hot')
    expect(result.primarySignal).toBe('insufficient_history')
  })

  it('summary mentions budget state', () => {
    const usage = makeUsage({
      billingPhase: 'budget_available',
      remaining: 0,
      percentUsed: 100,
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.summary).toMatch(/budget/i)
  })
})

// ---------------------------------------------------------------------------
// Scenario 9: Unavailable projection with low current usage
// ---------------------------------------------------------------------------

describe('computeComfortStatus — unavailable projection, low usage', () => {
  it('returns safe level with insufficient_history signal', () => {
    const usage = makeUsage({ percentUsed: 20, warningLevel: 'normal' })
    const projection = makeProjection({
      projectionStatus: 'unavailable',
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
      projectionReason: 'No usage history available.',
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('insufficient_history')
  })
})

// ---------------------------------------------------------------------------
// Scenario 10: Unavailable projection with high current usage
// ---------------------------------------------------------------------------

describe('computeComfortStatus — unavailable projection, high usage', () => {
  it('returns warm level for hot warningLevel with insufficient_history signal', () => {
    const usage = makeUsage({
      used: 6400,
      remaining: 600,
      percentUsed: 91,
      warningLevel: 'hot',
    })
    const projection = makeProjection({
      projectionStatus: 'unavailable',
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('hot')
    expect(result.primarySignal).toBe('insufficient_history')
    expect(result.summary).toMatch(/91%/)
  })

  it('returns warm level for warm warningLevel', () => {
    const usage = makeUsage({
      used: 5500,
      remaining: 1500,
      percentUsed: 79,
      warningLevel: 'warm',
    })
    const projection = makeProjection({
      projectionStatus: 'unavailable',
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
    })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('warm')
    expect(result.primarySignal).toBe('insufficient_history')
  })
})

// ---------------------------------------------------------------------------
// Scenario 11: Unlimited
// ---------------------------------------------------------------------------

describe('computeComfortStatus — unlimited', () => {
  it('returns safe level with unlimited signal', () => {
    const usage = makeUsage({
      billingPhase: 'unlimited',
      remaining: 0,
      percentUsed: 0,
      warningLevel: 'normal',
      overagePermitted: true,
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('unlimited')
    expect(result.summary).toMatch(/unlimited/i)
  })

  it('ignores projection when billing phase is unlimited', () => {
    const usage = makeUsage({ billingPhase: 'unlimited' })
    const projection = makeProjection({ projectionStatus: 'exhaustion_before_reset' })
    const result = computeComfortStatus(usage, projection, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('unlimited')
  })
})

// ---------------------------------------------------------------------------
// Scenario 12: Missing projection entirely
// ---------------------------------------------------------------------------

describe('computeComfortStatus — no projection provided', () => {
  it('returns safe with remaining signal for low usage', () => {
    const usage = makeUsage({ percentUsed: 30, warningLevel: 'normal' })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('safe')
    expect(result.primarySignal).toBe('remaining')
  })

  it('returns warm with remaining signal for warm warningLevel', () => {
    const usage = makeUsage({ used: 5600, remaining: 1400, percentUsed: 80, warningLevel: 'warm' })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('warm')
    expect(result.primarySignal).toBe('remaining')
  })

  it('returns hot with remaining signal for hot warningLevel', () => {
    const usage = makeUsage({ used: 6500, remaining: 500, percentUsed: 93, warningLevel: 'hot' })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('hot')
    expect(result.primarySignal).toBe('remaining')
  })

  it('returns hot with remaining signal for over warningLevel', () => {
    const usage = makeUsage({
      used: 7000,
      remaining: 0,
      percentUsed: 100,
      warningLevel: 'over',
      billingPhase: 'credits_available', // edge case: phase not yet updated
    })
    const result = computeComfortStatus(usage, undefined, NOW)

    expect(result.level).toBe('hot')
    expect(result.primarySignal).toBe('remaining')
  })
})
