import { describe, expect, it } from 'vitest'
import {
  computeHistorySummary,
  computeMonthlyPeriodSummaries,
  computeQuarterlyPeriodSummaries,
  computeYearlyPeriodSummaries,
} from '../history-metrics'
import type { UsageHistorySnapshot } from '../usage-history-types'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(capturedAt: string, used: number, quota = 7000): UsageHistorySnapshot {
  return {
    capturedAt,
    used,
    quota,
    remaining: Math.max(0, quota - used),
    billingPhase: 'credits_available',
  }
}

// ---------------------------------------------------------------------------
// Contract assertion 1: empty and single-snapshot edge cases
// ---------------------------------------------------------------------------

describe('computeHistorySummary — empty and single-snapshot', () => {
  it('returns zero deltaUsed and null rates for empty snapshots', () => {
    const result = computeHistorySummary([])
    expect(result.deltaUsed).toBe(0)
    expect(result.creditsPerHour).toBeNull()
    expect(result.creditsPerDay).toBeNull()
    expect(result.averageBurnRate).toBeNull()
    expect(result.burnRateCostPerHourUsd).toBeNull()
    expect(result.averageBurnRateCostPerHourUsd).toBeNull()
    expect(result.burnCostPerDayUsd).toBeNull()
    expect(result.snapshotCount).toBe(0)
    expect(result.oldestAt).toBeNull()
    expect(result.newestAt).toBeNull()
  })

  it('returns zero deltaUsed and null rates for single snapshot', () => {
    const snapshots = [makeSnapshot('2026-06-15T10:00:00.000Z', 1000)]
    const result = computeHistorySummary(snapshots)
    expect(result.deltaUsed).toBe(0)
    expect(result.creditsPerHour).toBeNull()
    expect(result.creditsPerDay).toBeNull()
    expect(result.averageBurnRate).toBeNull()
    expect(result.burnRateCostPerHourUsd).toBeNull()
    expect(result.averageBurnRateCostPerHourUsd).toBeNull()
    expect(result.burnCostPerDayUsd).toBeNull()
    expect(result.snapshotCount).toBe(1)
    expect(result.oldestAt).toBe('2026-06-15T10:00:00.000Z')
    expect(result.newestAt).toBe('2026-06-15T10:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 2: deltaUsed accumulates only positive consumption deltas
// ---------------------------------------------------------------------------

describe('computeHistorySummary — deltaUsed', () => {
  it('sums all positive deltas when there are no resets', () => {
    // newest-first: 10:00 (used=3000), 09:00 (used=2000), 08:00 (used=1000)
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T09:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    // Intervals: 08→09: +1000, 09→10: +1000. Total: 2000
    expect(result.deltaUsed).toBe(2000)
  })

  it('excludes negative deltas caused by quota resets; only current-period (July) snapshots count', () => {
    // newest-first: July snaps then June snaps — month boundary between index 1 and 2
    const snapshots = [
      makeSnapshot('2026-07-01T02:00:00.000Z', 200),  // new period
      makeSnapshot('2026-07-01T01:00:00.000Z', 100),  // new period start
      makeSnapshot('2026-06-30T23:00:00.000Z', 7000), // end of old period
      makeSnapshot('2026-06-30T22:00:00.000Z', 6500), // old period
    ]
    const result = computeHistorySummary(snapshots)
    // Period boundary at month crossing: only July snapshots (index 0-1) are used.
    // July interval 01→02: used 100→200 = +100.
    expect(result.deltaUsed).toBe(100)
    // snapshotCount reflects only current-period snapshots
    expect(result.snapshotCount).toBe(2)
    // creditsPerHour = 100 / 1 hr = 100
    expect(result.creditsPerHour).toBeCloseTo(100, 5)
    // oldestAt and newestAt are within July only
    expect(result.oldestAt).toBe('2026-07-01T01:00:00.000Z')
    expect(result.newestAt).toBe('2026-07-01T02:00:00.000Z')
  })

  it('returns zero deltaUsed when all intervals are resets or zero', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 0),
      makeSnapshot('2026-06-15T09:00:00.000Z', 7000), // reset: 7000 → 0
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.deltaUsed).toBe(0)
    expect(result.creditsPerHour).toBe(0)
    expect(result.creditsPerDay).toBe(0)
    // No qualifying intervals for averageBurnRate
    expect(result.averageBurnRate).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 3: creditsPerHour and creditsPerDay correctness
// ---------------------------------------------------------------------------

describe('computeHistorySummary — creditsPerHour and creditsPerDay', () => {
  it('computes creditsPerHour as deltaUsed / totalHours', () => {
    // 2 snapshots, 2 hours apart, 1000 credits consumed
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    // totalHours = 2, deltaUsed = 1000 → 500/hr
    expect(result.creditsPerHour).toBeCloseTo(500, 5)
  })

  it('computes creditsPerDay as creditsPerHour * 24', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.creditsPerDay).toBeCloseTo(500 * 24, 5)
    expect(result.burnRateCostPerHourUsd).toBeCloseTo(5, 5)
    expect(result.burnCostPerDayUsd).toBeCloseTo(120, 5)
  })

  it('returns creditsPerHour=0 when deltaUsed=0 and span>0', () => {
    // Used is constant (no consumption) but time has passed
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 1000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.creditsPerHour).toBe(0)
    expect(result.creditsPerDay).toBe(0)
  })

  it('returns correct rate for a 24-hour window', () => {
    const snapshots = [
      makeSnapshot('2026-06-16T00:00:00.000Z', 2400),
      makeSnapshot('2026-06-15T00:00:00.000Z', 0),
    ]
    const result = computeHistorySummary(snapshots)
    // 2400 credits over 24 hours = 100/hr, 2400/day
    expect(result.creditsPerHour).toBeCloseTo(100, 5)
    expect(result.creditsPerDay).toBeCloseTo(2400, 5)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 4: averageBurnRate is mean of per-interval rates
// ---------------------------------------------------------------------------

describe('computeHistorySummary — averageBurnRate', () => {
  it('equals creditsPerHour for a uniform consumption pattern', () => {
    // 3 snapshots equally spaced, equal consumption per interval
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T09:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    // Both intervals: 1000 credits / 1 hour = 1000/hr each
    expect(result.averageBurnRate).toBeCloseTo(result.creditsPerHour!, 5)
  })

  it('differs from creditsPerHour for a bursty consumption pattern', () => {
    // 3 snapshots: heavy consumption in first hour, idle in second hour
    // Interval 1 (08→09): 1000 used, 1 hr → 1000/hr
    // Interval 2 (09→10): 0 used → no qualifying interval
    // creditsPerHour = 1000/2hr = 500/hr
    // averageBurnRate = mean of [1000] = 1000/hr
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T09:00:00.000Z', 2000), // idle
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.deltaUsed).toBe(1000)
    expect(result.creditsPerHour).toBeCloseTo(500, 5)
    expect(result.averageBurnRate).toBeCloseTo(1000, 5)
    expect(result.burnRateCostPerHourUsd).toBeCloseTo(5, 5)
    expect(result.averageBurnRateCostPerHourUsd).toBeCloseTo(10, 5)
  })

  it('returns null averageBurnRate when no qualifying intervals exist', () => {
    // No positive deltas → no interval rates
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 1000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.averageBurnRate).toBeNull()
  })

  it('is mean of three equal interval rates', () => {
    // 4 snapshots, 1 hour apart, each consuming 500 credits
    const snapshots = [
      makeSnapshot('2026-06-15T11:00:00.000Z', 4000),
      makeSnapshot('2026-06-15T10:00:00.000Z', 3500),
      makeSnapshot('2026-06-15T09:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 2500),
    ]
    const result = computeHistorySummary(snapshots)
    // Each interval: 500 credits / 1 hr = 500/hr
    expect(result.averageBurnRate).toBeCloseTo(500, 5)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 5: snapshotCount, oldestAt, newestAt
// ---------------------------------------------------------------------------

describe('computeHistorySummary — metadata fields', () => {
  it('reports correct snapshotCount', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T09:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.snapshotCount).toBe(3)
  })

  it('sets newestAt to the first element (newest-first array)', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.newestAt).toBe('2026-06-15T10:00:00.000Z')
  })

  it('sets oldestAt to the last element (newest-first array)', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeHistorySummary(snapshots)
    expect(result.oldestAt).toBe('2026-06-15T08:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 6: budget_active phase snapshots (overageCount)
// ---------------------------------------------------------------------------

describe('computeHistorySummary — budget_active phase', () => {
  it('handles budget_active snapshots without errors', () => {
    const snapshots = [
      {
        capturedAt: '2026-06-15T10:00:00.000Z',
        used: 7000,
        quota: 7000,
        remaining: 0,
        billingPhase: 'budget_active' as const,
        overageCount: 250,
      },
      {
        capturedAt: '2026-06-15T09:00:00.000Z',
        used: 7000,
        quota: 7000,
        remaining: 0,
        billingPhase: 'budget_active' as const,
        overageCount: 100,
      },
    ]
    // used is constant (both 7000) → deltaUsed = 0 (rate from used field only)
    const result = computeHistorySummary(snapshots)
    expect(result.deltaUsed).toBe(0)
    expect(result.snapshotCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// New assertion: month-boundary period isolation
// ---------------------------------------------------------------------------

describe('computeHistorySummary — month-boundary period isolation', () => {
  it('uses only current-period snapshots when month boundary exists', () => {
    // 3 July snapshots + 2 June snapshots; boundary between index 2 and 3
    const snapshots = [
      makeSnapshot('2026-07-01T03:00:00.000Z', 300),
      makeSnapshot('2026-07-01T02:00:00.000Z', 200),
      makeSnapshot('2026-07-01T01:00:00.000Z', 100),
      makeSnapshot('2026-06-30T23:00:00.000Z', 6900),
      makeSnapshot('2026-06-30T22:00:00.000Z', 6500),
    ]
    const result = computeHistorySummary(snapshots)
    // Only July: 01→02→03 = +100 + +100 = 200
    expect(result.deltaUsed).toBe(200)
    expect(result.snapshotCount).toBe(3)
    expect(result.oldestAt).toBe('2026-07-01T01:00:00.000Z')
    expect(result.newestAt).toBe('2026-07-01T03:00:00.000Z')
  })

  it('returns null burn rate after reset with only one current-period snapshot', () => {
    // Single July snapshot after a June period
    const snapshots = [
      makeSnapshot('2026-07-01T01:00:00.000Z', 0),
      makeSnapshot('2026-06-30T23:00:00.000Z', 6900),
      makeSnapshot('2026-06-30T22:00:00.000Z', 6400),
    ]
    const result = computeHistorySummary(snapshots)
    // Only one current-period snapshot → no interval → rates are null
    expect(result.snapshotCount).toBe(1)
    expect(result.deltaUsed).toBe(0)
    expect(result.creditsPerHour).toBeNull()
    expect(result.creditsPerDay).toBeNull()
    expect(result.averageBurnRate).toBeNull()
  })

  it('treats intra-month usage drop as API noise (not a period boundary)', () => {
    // All snapshots within June; used drops from 5000 back to 3000 mid-month
    const snapshots = [
      makeSnapshot('2026-06-20T10:00:00.000Z', 5000),
      makeSnapshot('2026-06-20T09:00:00.000Z', 3000), // drop — same month, not a boundary
      makeSnapshot('2026-06-20T08:00:00.000Z', 4500),
      makeSnapshot('2026-06-20T07:00:00.000Z', 4000),
    ]
    const result = computeHistorySummary(snapshots)
    // No month boundary → all 4 snapshots used for current period
    expect(result.snapshotCount).toBe(4)
    // Positive deltas only: 07→08: +500, 08→09: skip (negative), 09→10: +2000
    expect(result.deltaUsed).toBe(2500)
  })

  it('retains previous-period summary after reset when computing monthly summaries', () => {
    // 2 July + 3 June snapshots; computeHistorySummary sees only July
    const snapshots = [
      makeSnapshot('2026-07-01T02:00:00.000Z', 150),
      makeSnapshot('2026-07-01T01:00:00.000Z', 50),
      makeSnapshot('2026-06-30T23:00:00.000Z', 7000),
      makeSnapshot('2026-06-30T22:00:00.000Z', 6600),
      makeSnapshot('2026-06-30T21:00:00.000Z', 6200),
    ]
    const monthly = computeMonthlyPeriodSummaries(snapshots)
    // Two distinct months
    expect(monthly).toHaveLength(2)
    const [julyEntry, juneEntry] = monthly
    // July summary: only the July snapshots
    expect(julyEntry.month).toBe('2026-07')
    expect(julyEntry.summary.deltaUsed).toBe(100) // 50→150
    expect(julyEntry.summary.snapshotCount).toBe(2)
    // June summary retained, not lost
    expect(juneEntry.month).toBe('2026-06')
    expect(juneEntry.summary.deltaUsed).toBe(800) // 6200→6600→7000
    expect(juneEntry.summary.snapshotCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// New assertion: computeMonthlyPeriodSummaries
// ---------------------------------------------------------------------------

describe('computeMonthlyPeriodSummaries', () => {
  it('returns empty array for empty snapshot input', () => {
    expect(computeMonthlyPeriodSummaries([])).toEqual([])
  })

  it('returns single-element array for same-month snapshots', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ]
    const result = computeMonthlyPeriodSummaries(snapshots)
    expect(result).toHaveLength(1)
    expect(result[0].month).toBe('2026-06')
    expect(result[0].summary.deltaUsed).toBe(2000)
  })

  it('returns two months in newest-first order for cross-month snapshots', () => {
    const snapshots = [
      makeSnapshot('2026-07-01T02:00:00.000Z', 200),
      makeSnapshot('2026-07-01T01:00:00.000Z', 100),
      makeSnapshot('2026-06-30T23:00:00.000Z', 7000),
      makeSnapshot('2026-06-30T22:00:00.000Z', 6500),
    ]
    const result = computeMonthlyPeriodSummaries(snapshots)
    expect(result).toHaveLength(2)
    expect(result[0].month).toBe('2026-07')
    expect(result[1].month).toBe('2026-06')
  })

  it('computes per-month deltaUsed independently for each month', () => {
    const snapshots = [
      makeSnapshot('2026-07-01T02:00:00.000Z', 300),
      makeSnapshot('2026-07-01T01:00:00.000Z', 100),
      makeSnapshot('2026-06-30T23:00:00.000Z', 5500),
      makeSnapshot('2026-06-30T22:00:00.000Z', 5000),
    ]
    const result = computeMonthlyPeriodSummaries(snapshots)
    // July: 100→300 = +200
    expect(result[0].summary.deltaUsed).toBe(200)
    // June: 5000→5500 = +500
    expect(result[1].summary.deltaUsed).toBe(500)
  })

  it('returns null rates for a month with a single snapshot', () => {
    const snapshots = [
      makeSnapshot('2026-07-01T01:00:00.000Z', 0),
      makeSnapshot('2026-06-30T23:00:00.000Z', 6900),
    ]
    const result = computeMonthlyPeriodSummaries(snapshots)
    expect(result[0].month).toBe('2026-07')
    expect(result[0].summary.snapshotCount).toBe(1)
    expect(result[0].summary.creditsPerHour).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// New assertion: computeQuarterlyPeriodSummaries
// ---------------------------------------------------------------------------

describe('computeQuarterlyPeriodSummaries', () => {
  it('returns empty array for empty monthly input', () => {
    expect(computeQuarterlyPeriodSummaries([])).toEqual([])
  })

  it('groups months into the correct quarter', () => {
    const monthly = computeMonthlyPeriodSummaries([
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
      makeSnapshot('2026-04-15T10:00:00.000Z', 5000),
      makeSnapshot('2026-04-15T08:00:00.000Z', 4000),
    ])
    const result = computeQuarterlyPeriodSummaries(monthly)
    expect(result).toHaveLength(1)
    expect(result[0].quarter).toBe('2026-Q2')
    expect(result[0].months).toHaveLength(2)
  })

  it('sums totalConsumed across all months in a quarter', () => {
    const monthly = computeMonthlyPeriodSummaries([
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000), // June: +1000
      makeSnapshot('2026-04-15T10:00:00.000Z', 5000),
      makeSnapshot('2026-04-15T08:00:00.000Z', 4000), // April: +1000
    ])
    const result = computeQuarterlyPeriodSummaries(monthly)
    expect(result[0].totalConsumed).toBe(2000)
    expect(result[0].snapshotCount).toBe(4)
  })

  it('returns two quarters in newest-first order for different-quarter months', () => {
    const monthly = computeMonthlyPeriodSummaries([
      makeSnapshot('2026-07-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-07-15T08:00:00.000Z', 1000), // July = Q3
      makeSnapshot('2026-04-15T10:00:00.000Z', 5000),
      makeSnapshot('2026-04-15T08:00:00.000Z', 4000), // April = Q2
    ])
    const result = computeQuarterlyPeriodSummaries(monthly)
    expect(result).toHaveLength(2)
    expect(result[0].quarter).toBe('2026-Q3')
    expect(result[1].quarter).toBe('2026-Q2')
  })
})

// ---------------------------------------------------------------------------
// New assertion: computeYearlyPeriodSummaries
// ---------------------------------------------------------------------------

describe('computeYearlyPeriodSummaries', () => {
  it('returns empty array for empty monthly input', () => {
    expect(computeYearlyPeriodSummaries([])).toEqual([])
  })

  it('groups months into correct year with summed totalConsumed', () => {
    const monthly = computeMonthlyPeriodSummaries([
      makeSnapshot('2026-07-15T10:00:00.000Z', 3000),
      makeSnapshot('2026-07-15T08:00:00.000Z', 1000), // July +2000
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000), // June +1000
    ])
    const result = computeYearlyPeriodSummaries(monthly)
    expect(result).toHaveLength(1)
    expect(result[0].year).toBe('2026')
    expect(result[0].totalConsumed).toBe(3000)
    expect(result[0].months).toHaveLength(2)
  })

  it('returns two years in newest-first order', () => {
    const monthly = computeMonthlyPeriodSummaries([
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
      makeSnapshot('2025-12-15T10:00:00.000Z', 5000),
      makeSnapshot('2025-12-15T08:00:00.000Z', 4000),
    ])
    const result = computeYearlyPeriodSummaries(monthly)
    expect(result).toHaveLength(2)
    expect(result[0].year).toBe('2026')
    expect(result[1].year).toBe('2025')
  })
})
