/**
 * @file Pure SVG geometry for the PWA "burn trail" usage chart.
 *
 * Converts a normalised {@link ChartSeries} into SVG path strings and marker
 * coordinates for a compact fuel-gauge / area chart:
 *
 * - `used` credits form the burn trail (area filled down to the baseline).
 * - The quota acts as a ceiling reference line.
 * - The most recent point is the current position.
 * - When a projected-exhaustion marker exists, a dashed continuation shows the
 *   direction of travel toward the quota ceiling.
 * - Quota resets break the trail into segments instead of drawing a vertical
 *   cliff.
 *
 * This module has no DOM/React dependency so the geometry can be unit-tested in
 * isolation. It never returns `NaN`/`Infinity` and never throws on empty input.
 */

import type { ChartSeries } from '../netlify/functions/lib/chart-data'
import type { ProjectionStatus } from '../netlify/functions/lib/burn-rate-projection'

/** Layout padding (SVG user units) reserved around the plot area. */
export type ChartPadding = { top: number; right: number; bottom: number; left: number }

export type ChartGeometryOptions = {
  width: number
  height: number
  padding?: ChartPadding
  /**
   * Value orientation for projection semantics:
   * - `consumed` (default): projected exhaustion marker points at the ceiling.
   * - `remaining`: projected exhaustion marker points at baseline (0 remaining).
   */
  valueMode?: 'consumed' | 'remaining'
}

export type ChartGeometry = {
  width: number
  height: number
  /** `true` when at least one point could be plotted. */
  hasData: boolean
  /** Y coordinate of `used = 0`. */
  baselineY: number
  /** Y coordinate of the quota ceiling reference line (null when quota is 0). */
  ceilingY: number | null
  /** Burn-trail segments (split at quota resets), each with a line + area path. */
  segments: { line: string; area: string }[]
  /** Current position marker (the most recent point). */
  current: { x: number; y: number } | null
  /** Projection continuation + marker, when projection context is present. */
  projection: {
    status?: ProjectionStatus
    /** Dashed continuation path from the current point toward exhaustion. */
    line?: string
    /** Marker at the projected exhaustion point. */
    marker?: { x: number; y: number }
  } | null
}

const DEFAULT_PADDING: ChartPadding = { top: 8, right: 10, bottom: 8, left: 10 }

/** Rounds to 2 decimals; maps non-finite to 0. */
function r(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Builds {@link ChartGeometry} for the burn-trail chart.
 *
 * @param series - Normalised series from `buildChartSeries`.
 * @param options - Target SVG dimensions and optional padding.
 */
export function buildBurnTrailGeometry(
  series: ChartSeries,
  options: ChartGeometryOptions,
): ChartGeometry {
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 0
  const height = Number.isFinite(options.height) && options.height > 0 ? options.height : 0
  const pad = options.padding ?? DEFAULT_PADDING

  const plotLeft = pad.left
  const plotRight = Math.max(plotLeft, width - pad.right)
  const plotTop = pad.top
  const plotBottom = Math.max(plotTop, height - pad.bottom)
  const plotWidth = Math.max(0, plotRight - plotLeft)
  const plotHeight = Math.max(0, plotBottom - plotTop)

  const baselineY = r(plotBottom)
  const valueMode = options.valueMode ?? 'consumed'

  const empty: ChartGeometry = {
    width,
    height,
    hasData: false,
    baselineY,
    ceilingY: null,
    segments: [],
    current: null,
    projection: null,
  }

  if (!series.hasData || series.points.length === 0 || plotWidth === 0 || plotHeight === 0) {
    return empty
  }

  const points = series.points
  const firstT = points[0].t
  const lastT = points[points.length - 1].t
  const projT = series.projection?.projectedExhaustionT

  // X domain: span the history window, extended to include a future projected
  // exhaustion so the dashed continuation reads as direction-of-travel.
  const domainMin = firstT
  let domainMax = lastT
  if (typeof projT === 'number' && projT > domainMax) domainMax = projT
  const domainSpan = domainMax - domainMin

  // Y domain: 0 → ceiling. Fall back to maxUsed when no quota is known.
  const yMax = Math.max(series.quotaCeiling, series.maxUsed, 1)

  const scaleX = (t: number): number => {
    if (domainSpan <= 0) return r(plotLeft + plotWidth / 2)
    const frac = (t - domainMin) / domainSpan
    return r(plotLeft + frac * plotWidth)
  }
  const scaleY = (used: number): number => {
    const frac = used / yMax
    const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac
    return r(plotBottom - clamped * plotHeight)
  }

  // Split into segments at reset boundaries (isPeriodStart, except the first).
  const segments: { line: string; area: string }[] = []
  let group: { x: number; y: number }[] = []
  const flush = (): void => {
    if (group.length === 0) return
    const line = group
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)
      .join(' ')
    const first = group[0]
    const last = group[group.length - 1]
    const area =
      group.length === 1
        // Single point: render a 1px-wide sliver so the fill is visible.
        ? `M${first.x} ${baselineY} L${first.x} ${first.y} L${first.x} ${baselineY} Z`
        : `M${first.x} ${baselineY} ${group
            .map(p => `L${p.x} ${p.y}`)
            .join(' ')} L${last.x} ${baselineY} Z`
    segments.push({ line, area })
    group = []
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i > 0 && p.isPeriodStart) flush()
    group.push({ x: scaleX(p.t), y: scaleY(p.used) })
  }
  flush()

  const lastPoint = points[points.length - 1]
  const current = { x: scaleX(lastPoint.t), y: scaleY(lastPoint.used) }

  const ceilingY = series.quotaCeiling > 0 ? scaleY(series.quotaCeiling) : null

  // Projection continuation: from the current point toward the projected
  // exhaustion. In consumed mode exhaustion sits at the quota ceiling; in
  // remaining mode exhaustion is 0 remaining (baseline).
  let projection: ChartGeometry['projection'] = null
  if (series.projection) {
    const status = series.projection.projectionStatus
    if (typeof projT === 'number' && projT >= lastT) {
      const markerY = valueMode === 'remaining'
        ? baselineY
        : (ceilingY ?? scaleY(yMax))
      const marker = { x: scaleX(projT), y: markerY }
      projection = {
        status,
        line: `M${current.x} ${current.y} L${marker.x} ${marker.y}`,
        marker,
      }
    } else if (status !== undefined) {
      projection = { status }
    }
  }

  return {
    width,
    height,
    hasData: true,
    baselineY,
    ceilingY,
    segments,
    current,
    projection,
  }
}
