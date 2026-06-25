/**
 * Contract tests for evaluateAlertDecision() in alert-decision.ts.
 *
 * Scenarios covered:
 *  1.  Safe usage → no alert
 *  2.  Watch level → no alert by default
 *  3.  Warm level → no alert by default; alert when alertOnWarm enabled
 *  4.  Hot level, exhaustion within 24 h → critical approaching_exhaustion alert
 *  5.  Hot level, exhaustion after 24 h  → warning budget_risk alert
 *  6.  Credits exhausted (blocked)       → critical exhausted alert
 *  7.  Hard stop (blocked)               → critical hard_stop alert
 *  8.  Overage active                    → warning overage_active alert
 *  9.  Unknown comfort level             → no alert by default; alert when opt-in
 * 10.  No comfortStatus, projection exhaustion within 24 h → critical alert
 * 11.  No comfortStatus, projection exhaustion after 24 h  → no alert by default
 * 12.  No comfortStatus, projection unavailable → no alert by default
 * 13.  No comfortStatus, billing phase hard_stop → critical alert
 * 14.  Custom preferences disabling specific alert types
 * 15.  Stable dedupeKey generation
 * 16.  alertOnBlocked=false suppresses blocked/exhausted alerts
 * 17.  alertOnOverage=false suppresses overage alerts
 */

import { describe, expect, it } from 'vitest'
import { evaluateAlertDecision } from '../alert-decision'
import type { AlertDecision, AlertDecisionInput } from '../alert-decision'
import type { Usage } from '../copilot'
import type { BurnRateProjection } from '../burn-rate-projection'
import type { ComfortStatus } from '../comfort-status'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

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

function makeProjection(overrides: Partial<BurnRateProjection> = {}): BurnRateProjection {
  return {
    windowHours: 24,
    creditsUsedInWindow: 1000,
    averageCreditsPerDay: 1000,
    projectionStatus: 'reset_before_exhaustion',
    ...overrides,
  }
}

function makeComfortStatus(overrides: Partial<ComfortStatus> = {}): ComfortStatus {
  return {
    level: 'safe',
    summary: 'Usage is at 21% of quota.',
    primarySignal: 'remaining',
    ...overrides,
  }
}

/** Fixed "now" for deterministic timestamp assertions: 2026-06-25T12:00:00.000Z */
const NOW = new Date('2026-06-25T12:00:00.000Z')

function evaluate(overrides: Partial<AlertDecisionInput> & { usage?: Partial<Usage> } = {}): AlertDecision {
  const { usage: usageOverrides, ...rest } = overrides
  return evaluateAlertDecision({
    usage: makeUsage(usageOverrides),
    now: NOW,
    ...rest,
  })
}

// ---------------------------------------------------------------------------
// Scenario 1: Safe usage → no alert
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — safe usage', () => {
  it('returns shouldAlert: false', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'safe' }),
    })
    expect(result.shouldAlert).toBe(false)
  })

  it('includes a reason', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'safe' }),
    })
    expect(result.reason).toBeTruthy()
  })

  it('does not include alertType, severity, or dedupeKey', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'safe' }),
    })
    expect(result.alertType).toBeUndefined()
    expect(result.severity).toBeUndefined()
    expect(result.dedupeKey).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: Watch level → no alert by default
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — watch level (default)', () => {
  it('returns shouldAlert: false by default', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'watch', primarySignal: 'burn_rate' }),
    })
    expect(result.shouldAlert).toBe(false)
    expect(result.reason).toMatch(/alertOnWatch is false/i)
  })

  it('alerts when alertOnWatch is explicitly enabled', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'watch', primarySignal: 'burn_rate' }),
      preferences: { alertOnWatch: true },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('budget_risk')
    expect(result.severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: Warm level → no alert by default; alert when opt-in
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — warm level', () => {
  it('returns shouldAlert: false by default', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'warm', primarySignal: 'burn_rate' }),
    })
    expect(result.shouldAlert).toBe(false)
    expect(result.reason).toMatch(/alertOnWarm is false/i)
  })

  it('returns shouldAlert: true when alertOnWarm is enabled', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({
        level: 'warm',
        primarySignal: 'burn_rate',
        detail: 'Projected exhaustion: 2026-06-29T00:00:00.000Z.',
      }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-29T00:00:00.000Z',
      }),
      preferences: { alertOnWarm: true },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('budget_risk')
    expect(result.severity).toBe('info')
    expect(result.dedupeKey).toBeTruthy()
  })

  it('includes projected exhaustion timestamp in message when available', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'warm' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-29T00:00:00.000Z',
      }),
      preferences: { alertOnWarm: true },
    })
    expect(result.message).toContain('2026-06-29T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: Hot level, exhaustion within 24 h → critical approaching_exhaustion
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — hot level, exhaustion within 24 h', () => {
  // Exhaustion is 8 hours from NOW
  const exhaustionAt = '2026-06-25T20:00:00.000Z'

  it('returns shouldAlert: true with approaching_exhaustion and critical severity', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_available', percentUsed: 90, warningLevel: 'hot' },
      comfortStatus: makeComfortStatus({ level: 'hot', primarySignal: 'burn_rate' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('approaching_exhaustion')
    expect(result.severity).toBe('critical')
  })

  it('message includes the projected exhaustion timestamp', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    expect(result.message).toContain(exhaustionAt)
  })

  it('dedupeKey is present and stable across identical calls', () => {
    const input: AlertDecisionInput = {
      usage: makeUsage({ billingPhase: 'credits_available' }),
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
      now: NOW,
    }
    const r1 = evaluateAlertDecision(input)
    const r2 = evaluateAlertDecision(input)
    expect(r1.dedupeKey).toBe(r2.dedupeKey)
    expect(r1.dedupeKey).toBeTruthy()
  })

  it('dedupeKey contains the billing phase and date', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_available' },
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    expect(result.dedupeKey).toContain('credits_available')
    expect(result.dedupeKey).toContain('2026-06-25')
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Hot level, exhaustion after 24 h → warning budget_risk
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — hot level, exhaustion after 24 h', () => {
  // Exhaustion is 4 days from NOW (well beyond 24 h)
  const exhaustionAt = '2026-06-29T12:00:00.000Z'

  it('returns shouldAlert: true with budget_risk and warning severity', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'hot', primarySignal: 'burn_rate' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('budget_risk')
    expect(result.severity).toBe('warning')
  })

  it('message includes the projected exhaustion timestamp', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    expect(result.message).toContain(exhaustionAt)
  })

  it('dedupeKey differs from the within-24-h variant', () => {
    const within24Result = evaluate({
      usage: { billingPhase: 'credits_available' },
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-25T20:00:00.000Z',
      }),
    })
    const after24Result = evaluate({
      usage: { billingPhase: 'credits_available' },
      comfortStatus: makeComfortStatus({ level: 'hot' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: exhaustionAt,
      }),
    })
    // Different alertType → different dedupeKey prefix
    expect(within24Result.dedupeKey).not.toBe(after24Result.dedupeKey)
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: Credits exhausted (blocked) → critical exhausted alert
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — credits exhausted', () => {
  it('returns shouldAlert: true with exhausted and critical severity', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_exhausted', remaining: 0, percentUsed: 100, warningLevel: 'over' },
      comfortStatus: makeComfortStatus({
        level: 'blocked',
        primarySignal: 'remaining',
        summary: 'Included credits exhausted; no budget configured.',
      }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('exhausted')
    expect(result.severity).toBe('critical')
  })

  it('dedupeKey contains credits_exhausted billing phase', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_exhausted' },
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'remaining' }),
    })
    expect(result.dedupeKey).toContain('credits_exhausted')
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: Hard stop → critical hard_stop alert
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — hard stop', () => {
  it('returns shouldAlert: true with hard_stop and critical severity', () => {
    const result = evaluate({
      usage: { billingPhase: 'hard_stop' },
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'hard_stop' }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('hard_stop')
    expect(result.severity).toBe('critical')
  })

  it('title mentions blocked/hard stop', () => {
    const result = evaluate({
      usage: { billingPhase: 'hard_stop' },
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'hard_stop' }),
    })
    expect(result.title).toMatch(/hard stop|blocked/i)
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: Overage active → warning overage_active alert
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — overage active', () => {
  it('returns shouldAlert: true with overage_active and warning severity', () => {
    const result = evaluate({
      usage: { billingPhase: 'budget_active', overageCount: 5 },
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('overage_active')
    expect(result.severity).toBe('warning')
  })

  it('dedupeKey contains budget_active billing phase', () => {
    const result = evaluate({
      usage: { billingPhase: 'budget_active' },
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
    })
    expect(result.dedupeKey).toContain('budget_active')
  })
})

// ---------------------------------------------------------------------------
// Scenario 9: Unknown comfort level → no alert by default; alert when opt-in
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — unknown comfort level', () => {
  it('returns shouldAlert: false by default', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'unknown', primarySignal: 'insufficient_history' }),
    })
    expect(result.shouldAlert).toBe(false)
    expect(result.reason).toMatch(/alertOnUnknown is false/i)
  })

  it('returns shouldAlert: true when alertOnUnknown is enabled', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'unknown', primarySignal: 'insufficient_history' }),
      preferences: { alertOnUnknown: true },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('unknown_risk')
    expect(result.severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// Scenario 10: No comfortStatus, projection exhaustion within 24 h
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — no comfortStatus, exhaustion within 24 h', () => {
  it('returns approaching_exhaustion critical alert', () => {
    // Exhaustion is 6 hours from NOW
    const result = evaluate({
      usage: { billingPhase: 'credits_available' },
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-25T18:00:00.000Z',
      }),
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('approaching_exhaustion')
    expect(result.severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// Scenario 11: No comfortStatus, projection exhaustion after 24 h
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — no comfortStatus, exhaustion after 24 h', () => {
  it('returns shouldAlert: false by default (alertOnWarm is false)', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_available' },
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-30T12:00:00.000Z',
      }),
    })
    expect(result.shouldAlert).toBe(false)
    expect(result.reason).toMatch(/alertOnWarm is false/i)
  })

  it('returns budget_risk warning when alertOnWarm is enabled', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_available' },
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-30T12:00:00.000Z',
      }),
      preferences: { alertOnWarm: true },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('budget_risk')
    expect(result.severity).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// Scenario 12: No comfortStatus, projection unavailable → no alert by default
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — no comfortStatus, projection unavailable', () => {
  it('returns shouldAlert: false by default', () => {
    const result = evaluate({
      projection: makeProjection({ projectionStatus: 'unavailable', projectionReason: 'No history.' }),
    })
    expect(result.shouldAlert).toBe(false)
    expect(result.reason).toMatch(/alertOnUnknown is false/i)
  })

  it('returns unknown_risk info alert when alertOnUnknown is enabled', () => {
    const result = evaluate({
      projection: makeProjection({ projectionStatus: 'unavailable' }),
      preferences: { alertOnUnknown: true },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('unknown_risk')
  })
})

// ---------------------------------------------------------------------------
// Scenario 13: No comfortStatus, billing phase hard_stop
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — no comfortStatus, billing phase hard_stop', () => {
  it('returns hard_stop critical alert', () => {
    const result = evaluate({
      usage: { billingPhase: 'hard_stop' },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('hard_stop')
    expect(result.severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// Scenario 14: Custom preferences disabling specific alert types
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — custom preferences', () => {
  it('alertOnBlocked=false suppresses hard_stop', () => {
    const result = evaluate({
      usage: { billingPhase: 'hard_stop' },
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'hard_stop' }),
      preferences: { alertOnBlocked: false },
    })
    expect(result.shouldAlert).toBe(false)
  })

  it('alertOnBlocked=false suppresses credits_exhausted', () => {
    const result = evaluate({
      usage: { billingPhase: 'credits_exhausted' },
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'remaining' }),
      preferences: { alertOnBlocked: false },
    })
    expect(result.shouldAlert).toBe(false)
  })

  it('alertOnOverage=false suppresses overage_active', () => {
    const result = evaluate({
      usage: { billingPhase: 'budget_active' },
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
      preferences: { alertOnOverage: false },
    })
    expect(result.shouldAlert).toBe(false)
  })

  it('alertOnHot=false suppresses hot-level alert', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'hot', primarySignal: 'burn_rate' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-25T18:00:00.000Z',
      }),
      preferences: { alertOnHot: false },
    })
    expect(result.shouldAlert).toBe(false)
  })

  it('custom exhaustionWindowHours widens the imminence window', () => {
    // Exhaustion is 30 h from NOW — outside default 24 h but inside 48 h window
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'hot', primarySignal: 'burn_rate' }),
      projection: makeProjection({
        projectionStatus: 'exhaustion_before_reset',
        projectedExhaustionAt: '2026-06-26T18:00:00.000Z',
      }),
      preferences: { exhaustionWindowHours: 48 },
    })
    expect(result.shouldAlert).toBe(true)
    expect(result.alertType).toBe('approaching_exhaustion')
    expect(result.severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// Scenario 15: Stable dedupeKey generation
// ---------------------------------------------------------------------------

describe('evaluateAlertDecision — dedupeKey stability', () => {
  it('identical inputs produce identical dedupeKeys', () => {
    const baseInput: AlertDecisionInput = {
      usage: makeUsage({ billingPhase: 'budget_active' }),
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
      now: NOW,
    }
    expect(evaluateAlertDecision(baseInput).dedupeKey).toBe(
      evaluateAlertDecision(baseInput).dedupeKey,
    )
  })

  it('different billing phases produce different dedupeKeys', () => {
    const exhaustedResult = evaluateAlertDecision({
      usage: makeUsage({ billingPhase: 'credits_exhausted' }),
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'remaining' }),
      now: NOW,
    })
    const hardStopResult = evaluateAlertDecision({
      usage: makeUsage({ billingPhase: 'hard_stop' }),
      comfortStatus: makeComfortStatus({ level: 'blocked', primarySignal: 'hard_stop' }),
      now: NOW,
    })
    expect(exhaustedResult.dedupeKey).not.toBe(hardStopResult.dedupeKey)
  })

  it('dedupeKey changes on a different UTC day', () => {
    const day1 = evaluateAlertDecision({
      usage: makeUsage({ billingPhase: 'budget_active' }),
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
      now: new Date('2026-06-25T12:00:00.000Z'),
    })
    const day2 = evaluateAlertDecision({
      usage: makeUsage({ billingPhase: 'budget_active' }),
      comfortStatus: makeComfortStatus({ level: 'overage', primarySignal: 'overage' }),
      now: new Date('2026-06-26T12:00:00.000Z'),
    })
    expect(day1.dedupeKey).not.toBe(day2.dedupeKey)
    expect(day1.dedupeKey).toContain('2026-06-25')
    expect(day2.dedupeKey).toContain('2026-06-26')
  })

  it('shouldAlert: false decisions do not have a dedupeKey', () => {
    const result = evaluate({
      comfortStatus: makeComfortStatus({ level: 'safe' }),
    })
    expect(result.dedupeKey).toBeUndefined()
  })
})
