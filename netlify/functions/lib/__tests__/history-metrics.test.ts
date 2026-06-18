import { describe, expect, it } from 'vitest'
import { computeHistorySummary } from '../history-metrics'
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

  it('excludes negative deltas caused by quota resets', () => {
    // newest-first: period 2 is 200, period 1 ended at 7000 (reset occurred)
    const snapshots = [
      makeSnapshot('2026-07-01T02:00:00.000Z', 200),  // new period
      makeSnapshot('2026-07-01T01:00:00.000Z', 100),  // new period start
      makeSnapshot('2026-06-30T23:00:00.000Z', 7000), // end of old period
      makeSnapshot('2026-06-30T22:00:00.000Z', 6500), // old period
    ]
    const result = computeHistorySummary(snapshots)
    // Positive deltas: 22→23: +500, new period 01→02: +100.
    // Negative delta at reset (7000→100) is excluded.
    expect(result.deltaUsed).toBe(600)
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
