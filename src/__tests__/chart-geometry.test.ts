import { describe, expect, it } from 'vitest'
import { buildBurnTrailGeometry } from '../chart-geometry'
import { buildChartSeries } from '../../netlify/functions/lib/chart-data'
import type { ChartSnapshotInput } from '../../netlify/functions/lib/chart-data'

function snap(capturedAt: string, used: number, quota = 7000): ChartSnapshotInput {
  return { capturedAt, used, quota, remaining: Math.max(0, quota - used), billingPhase: 'credits_available' }
}

const SIZE = { width: 300, height: 80 }

/** Asserts a path string contains only finite coordinate numbers. */
function expectFinitePath(d: string): void {
  const numbers = d.match(/-?\d+(\.\d+)?/g) ?? []
  for (const n of numbers) {
    expect(Number.isFinite(Number(n))).toBe(true)
  }
  expect(d.includes('NaN')).toBe(false)
  expect(d.includes('Infinity')).toBe(false)
}

describe('buildBurnTrailGeometry — empty/malformed', () => {
  it('returns a safe empty geometry for empty history', () => {
    const geo = buildBurnTrailGeometry(buildChartSeries([]), SIZE)
    expect(geo.hasData).toBe(false)
    expect(geo.segments).toEqual([])
    expect(geo.current).toBeNull()
    expect(geo.projection).toBeNull()
    expect(Number.isFinite(geo.baselineY)).toBe(true)
  })

  it('does not crash and emits no NaN for malformed history', () => {
    const series = buildChartSeries([
      { capturedAt: '2026-06-15T10:00:00.000Z', used: NaN, quota: Infinity },
      { capturedAt: 'bad', used: 5, quota: 5 },
    ] as unknown as ChartSnapshotInput[])
    const geo = buildBurnTrailGeometry(series, SIZE)
    for (const seg of geo.segments) {
      expectFinitePath(seg.line)
      expectFinitePath(seg.area)
    }
  })

  it('returns empty geometry when dimensions are zero', () => {
    const series = buildChartSeries([snap('2026-06-15T10:00:00.000Z', 1000)])
    const geo = buildBurnTrailGeometry(series, { width: 0, height: 0 })
    expect(geo.hasData).toBe(false)
  })
})

describe('buildBurnTrailGeometry — single point', () => {
  it('centres a single point and produces a visible area', () => {
    const series = buildChartSeries([snap('2026-06-15T10:00:00.000Z', 1000)])
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.hasData).toBe(true)
    expect(geo.segments).toHaveLength(1)
    expect(geo.current).not.toBeNull()
    // Single point is horizontally centred.
    expect(geo.current!.x).toBeCloseTo(150, 0)
    expectFinitePath(geo.segments[0].line)
    expectFinitePath(geo.segments[0].area)
  })
})

describe('buildBurnTrailGeometry — increasing history', () => {
  it('plots used rising toward the ceiling (higher used = smaller y)', () => {
    const series = buildChartSeries([
      snap('2026-06-15T08:00:00.000Z', 1000),
      snap('2026-06-15T10:00:00.000Z', 4000),
      snap('2026-06-15T12:00:00.000Z', 6000),
    ])
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.segments).toHaveLength(1)
    expect(geo.ceilingY).not.toBeNull()
    // Current (used=6000) is closer to the ceiling than the baseline.
    expect(geo.current!.y).toBeLessThan(geo.baselineY)
    expect(geo.current!.y).toBeGreaterThan(geo.ceilingY!)
    expectFinitePath(geo.segments[0].line)
  })
})

describe('buildBurnTrailGeometry — reset segmentation', () => {
  it('breaks the trail into two segments across a quota reset', () => {
    const series = buildChartSeries([
      snap('2026-06-15T08:00:00.000Z', 1000),
      snap('2026-06-15T10:00:00.000Z', 6000),
      snap('2026-06-16T00:00:00.000Z', 200),
      snap('2026-06-16T02:00:00.000Z', 900),
    ])
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.segments).toHaveLength(2)
  })
})

describe('buildBurnTrailGeometry — projection marker', () => {
  it('draws a continuation toward a future projected exhaustion', () => {
    const series = buildChartSeries(
      [
        snap('2026-06-15T08:00:00.000Z', 1000),
        snap('2026-06-15T12:00:00.000Z', 4000),
      ],
      { projectedExhaustionAt: '2026-06-15T20:00:00.000Z', projectionStatus: 'exhaustion_before_reset' },
    )
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.projection).not.toBeNull()
    expect(geo.projection!.status).toBe('exhaustion_before_reset')
    expect(geo.projection!.marker).toBeDefined()
    // Projection marker sits to the right of the current point (future).
    expect(geo.projection!.marker!.x).toBeGreaterThan(geo.current!.x)
    expectFinitePath(geo.projection!.line!)
  })

  it('exposes reset_before_exhaustion status without a marker when no timestamp', () => {
    const series = buildChartSeries(
      [
        snap('2026-06-15T08:00:00.000Z', 1000),
        snap('2026-06-15T12:00:00.000Z', 2000),
      ],
      { projectionStatus: 'reset_before_exhaustion' },
    )
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.projection).not.toBeNull()
    expect(geo.projection!.status).toBe('reset_before_exhaustion')
    expect(geo.projection!.marker).toBeUndefined()
  })

  it('returns no projection when none is supplied', () => {
    const series = buildChartSeries([
      snap('2026-06-15T08:00:00.000Z', 1000),
      snap('2026-06-15T12:00:00.000Z', 2000),
    ])
    const geo = buildBurnTrailGeometry(series, SIZE)
    expect(geo.projection).toBeNull()
  })

  it('targets projection to baseline in remaining mode', () => {
    const series = buildChartSeries(
      [
        snap('2026-06-15T08:00:00.000Z', 1000),
        snap('2026-06-15T12:00:00.000Z', 4000),
      ],
      { projectedExhaustionAt: '2026-06-15T20:00:00.000Z', projectionStatus: 'exhaustion_before_reset' },
    )
    const geo = buildBurnTrailGeometry(series, { ...SIZE, valueMode: 'remaining' })
    expect(geo.projection).not.toBeNull()
    expect(geo.projection!.marker).toBeDefined()
    expect(geo.projection!.marker!.y).toBeCloseTo(geo.baselineY, 4)
  })
})
