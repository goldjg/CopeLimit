/**
 * Contract tests for the shared chart-data normaliser (`chart-data.ts`).
 *
 * Verifies the defensive guarantees relied on by both the PWA burn-trail chart
 * and the Scriptable widget mini-chart:
 *
 * - empty history → empty, safe series
 * - one snapshot → single point, no crash
 * - normal increasing history → chronological, monotonic
 * - quota reset / noisy lower used values → reset flagged, noise smoothed
 * - missing projection → no projection context
 * - projected exhaustion present → projection marker exposed
 * - reset_before_exhaustion status → passed through
 * - malformed / non-finite history → never emits NaN/Infinity, never throws
 */

import { describe, expect, it } from 'vitest'
import { buildChartSeries } from '../chart-data'
import type { ChartSnapshotInput } from '../chart-data'

function snap(capturedAt: string, used: number, quota = 7000): ChartSnapshotInput {
  return { capturedAt, used, quota, remaining: Math.max(0, quota - used), billingPhase: 'credits_available' }
}

/** Asserts every numeric field of every point is finite. */
function expectAllFinite(series: ReturnType<typeof buildChartSeries>): void {
  expect(Number.isFinite(series.quotaCeiling)).toBe(true)
  expect(Number.isFinite(series.maxUsed)).toBe(true)
  for (const p of series.points) {
    for (const v of [p.t, p.used, p.quota, p.remaining, p.percentUsed]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  }
}

describe('buildChartSeries — empty history', () => {
  it('returns a safe empty series for an empty array', () => {
    const series = buildChartSeries([])
    expect(series.hasData).toBe(false)
    expect(series.points).toEqual([])
    expect(series.quotaCeiling).toBe(0)
    expect(series.maxUsed).toBe(0)
    expect(series.hasReset).toBe(false)
  })

  it('returns a safe empty series for null/undefined input', () => {
    expect(buildChartSeries(null).hasData).toBe(false)
    expect(buildChartSeries(undefined).hasData).toBe(false)
  })
})

describe('buildChartSeries — single snapshot', () => {
  it('returns a single point without crashing', () => {
    const series = buildChartSeries([snap('2026-06-15T10:00:00.000Z', 1200)])
    expect(series.hasData).toBe(true)
    expect(series.points).toHaveLength(1)
    expect(series.points[0].used).toBe(1200)
    expect(series.points[0].quota).toBe(7000)
    expect(series.points[0].remaining).toBe(5800)
    expect(series.points[0].isPeriodStart).toBe(false)
    expect(series.quotaCeiling).toBe(7000)
    expectAllFinite(series)
  })
})

describe('buildChartSeries — normal increasing history', () => {
  it('sorts chronologically and preserves increasing used values', () => {
    // Provided newest-first (as getHistory returns).
    const series = buildChartSeries([
      snap('2026-06-15T12:00:00.000Z', 3000),
      snap('2026-06-15T10:00:00.000Z', 2000),
      snap('2026-06-15T08:00:00.000Z', 1000),
    ])
    expect(series.points.map(p => p.used)).toEqual([1000, 2000, 3000])
    expect(series.points.map(p => p.capturedAt)).toEqual([
      '2026-06-15T08:00:00.000Z',
      '2026-06-15T10:00:00.000Z',
      '2026-06-15T12:00:00.000Z',
    ])
    expect(series.hasReset).toBe(false)
    expect(series.maxUsed).toBe(3000)
    expect(series.points[2].percentUsed).toBeCloseTo((3000 / 7000) * 100, 5)
    expectAllFinite(series)
  })

  it('clamps percentUsed to 100 when used exceeds quota', () => {
    const series = buildChartSeries([snap('2026-06-15T10:00:00.000Z', 9000, 7000)])
    expect(series.points[0].percentUsed).toBe(100)
    expect(series.points[0].remaining).toBe(0)
  })
})

describe('buildChartSeries — reset and noisy deltas', () => {
  it('flags a genuine quota reset as a new period start', () => {
    const series = buildChartSeries([
      snap('2026-06-15T08:00:00.000Z', 1000),
      snap('2026-06-15T10:00:00.000Z', 6000),
      snap('2026-06-16T00:00:00.000Z', 200), // reset: drop well below half
      snap('2026-06-16T02:00:00.000Z', 900),
    ])
    expect(series.hasReset).toBe(true)
    const resetPoint = series.points.find(p => p.isPeriodStart)
    expect(resetPoint?.used).toBe(200)
    // Only the reset point is flagged; others are continuous.
    expect(series.points.filter(p => p.isPeriodStart)).toHaveLength(1)
  })

  it('smooths small negative deltas (settlement noise) without a fake dip', () => {
    const series = buildChartSeries([
      snap('2026-06-15T08:00:00.000Z', 2000),
      snap('2026-06-15T10:00:00.000Z', 2050),
      snap('2026-06-15T12:00:00.000Z', 2040), // small dip — noise
      snap('2026-06-15T14:00:00.000Z', 2100),
    ])
    expect(series.hasReset).toBe(false)
    // The noisy point is carried forward to stay monotonic (2050, not 2040).
    expect(series.points.map(p => p.used)).toEqual([2000, 2050, 2050, 2100])
    expect(series.points.some(p => p.isPeriodStart)).toBe(false)
  })
})

describe('buildChartSeries — projection context', () => {
  it('omits projection when none is supplied', () => {
    const series = buildChartSeries([snap('2026-06-15T10:00:00.000Z', 1000)])
    expect(series.projection).toBeUndefined()
  })

  it('exposes a projected exhaustion marker when present', () => {
    const series = buildChartSeries(
      [snap('2026-06-15T10:00:00.000Z', 1000)],
      { projectedExhaustionAt: '2026-06-20T00:00:00.000Z', projectionStatus: 'exhaustion_before_reset' },
    )
    expect(series.projection?.projectedExhaustionAt).toBe('2026-06-20T00:00:00.000Z')
    expect(series.projection?.projectedExhaustionT).toBe(
      new Date('2026-06-20T00:00:00.000Z').getTime(),
    )
    expect(series.projection?.projectionStatus).toBe('exhaustion_before_reset')
  })

  it('passes through reset_before_exhaustion status without an exhaustion timestamp', () => {
    const series = buildChartSeries(
      [snap('2026-06-15T10:00:00.000Z', 1000)],
      { projectionStatus: 'reset_before_exhaustion' },
    )
    expect(series.projection?.projectionStatus).toBe('reset_before_exhaustion')
    expect(series.projection?.projectedExhaustionAt).toBeUndefined()
  })

  it('ignores an unparseable projected exhaustion timestamp', () => {
    const series = buildChartSeries(
      [snap('2026-06-15T10:00:00.000Z', 1000)],
      { projectedExhaustionAt: 'not-a-date', projectionStatus: 'exhaustion_before_reset' },
    )
    expect(series.projection?.projectedExhaustionAt).toBeUndefined()
    expect(series.projection?.projectionStatus).toBe('exhaustion_before_reset')
  })
})

describe('buildChartSeries — malformed input', () => {
  it('never emits NaN or Infinity and never throws on garbage', () => {
    const garbage = [
      { capturedAt: '2026-06-15T10:00:00.000Z', used: NaN, quota: Infinity },
      { capturedAt: '2026-06-15T11:00:00.000Z', used: -50, quota: -10 },
      { capturedAt: 'nonsense', used: 100, quota: 200 },
      { capturedAt: '', used: 1, quota: 1 },
      { used: 1, quota: 1 }, // missing timestamp
      null,
      undefined,
      'a string',
      42,
    ] as unknown as ChartSnapshotInput[]

    const series = buildChartSeries(garbage)
    // Two entries have valid timestamps (the NaN/Infinity one and the -50/-10 one).
    expect(series.points).toHaveLength(2)
    expectAllFinite(series)
    // NaN used → 0; Infinity quota → 0; negatives → 0.
    expect(series.points[0].used).toBe(0)
    expect(series.points[0].quota).toBe(0)
    expect(series.points[1].used).toBe(0)
    expect(series.points[1].quota).toBe(0)
  })

  it('returns empty series when every entry is malformed', () => {
    const series = buildChartSeries([{ capturedAt: 'bad' }, null] as unknown as ChartSnapshotInput[])
    expect(series.hasData).toBe(false)
    expect(series.points).toEqual([])
  })
})
