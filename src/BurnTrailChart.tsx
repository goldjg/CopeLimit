/**
 * @file `BurnTrailChart` — the PWA fuel-gauge / burn-trail usage chart.
 *
 * Renders a compact SVG area chart from a normalised {@link ChartSeries}:
 *
 * - The filled area is the burn trail (credits used over time).
 * - A dashed reference line marks the quota ceiling (the top of the tank).
 * - The current position is highlighted with a dot.
 * - When a projection exists, a dashed continuation and marker show the
 *   direction of travel; colour communicates whether reset arrives before
 *   exhaustion (safe) or exhaustion arrives before reset (risk).
 *
 * Presentational only: all geometry is computed by the pure
 * `buildBurnTrailGeometry` helper, which is unit-tested separately.
 */

import React from 'react'
import type { ChartSeries } from '../netlify/functions/lib/chart-data'
import { buildBurnTrailGeometry } from './chart-geometry'

const VIEW_WIDTH = 320
const VIEW_HEIGHT = 96
const QUOTA_FILL_TOP_OPACITY = 0.55
const QUOTA_FILL_BOTTOM_OPACITY = 0.05
const BUDGET_FILL_TOP_OPACITY = 0.68
const BUDGET_FILL_BOTTOM_OPACITY = 0.16

function sanitizePositiveFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Accent colour for the burn trail, keyed to the warning level. */
function trailColor(level: ChartWarningLevel): string {
  switch (level) {
    case 'over':
    case 'hot':
      return '#ef4444'
    case 'warm':
      return '#f59e0b'
    default:
      return '#60a5fa'
  }
}

export type ChartWarningLevel = 'normal' | 'warm' | 'hot' | 'over'

export type BurnTrailChartProps = {
  series: ChartSeries
  /** Drives the trail accent colour. Defaults to `normal`. */
  warningLevel?: ChartWarningLevel
  /** Optional billing context used to select quota-vs-budget gauge mode. */
  usageContext?: {
    billingPhase?: 'credits_available' | 'credits_exhausted' | 'budget_available' | 'budget_active' | 'unlimited' | 'hard_stop'
    overageEntitlement?: number
  }
}

/**
 * Returns a short, human-readable caption describing the projection outlook,
 * or `null` when no projection context is available.
 */
function projectionCaption(series: ChartSeries): string | null {
  const status = series.projection?.projectionStatus
  if (!status) return null
  switch (status) {
    case 'exhaustion_before_reset':
      return 'On track to run out before reset'
    case 'reset_before_exhaustion':
      return 'Reset arrives before you run out'
    case 'exhausted':
      return 'Credits already exhausted'
    default:
      return null
  }
}

function deriveGaugeSeries(
  series: ChartSeries,
  usageContext?: BurnTrailChartProps['usageContext'],
): { mode: 'quota' | 'budget'; series: ChartSeries } {
  const budgetCap = usageContext?.overageEntitlement
  const isBudgetPhase = usageContext?.billingPhase === 'budget_active' || usageContext?.billingPhase === 'budget_available'
  const useBudgetMode = isBudgetPhase && typeof budgetCap === 'number' && Number.isFinite(budgetCap) && budgetCap > 0
  const mode: 'quota' | 'budget' = useBudgetMode ? 'budget' : 'quota'
  const ceiling = mode === 'budget'
    ? (budgetCap as number)
    : Math.max(series.quotaCeiling, 1)

  let maxRemaining = 0
  const points = series.points.map((point) => {
    const pointQuota = sanitizePositiveFinite(point.quota, series.quotaCeiling)
    const usageOverPointQuota = Math.max(0, point.used - Math.max(0, pointQuota))
    const remaining = mode === 'budget'
      ? Math.max(0, ceiling - usageOverPointQuota)
      : Math.max(0, point.remaining)
    if (remaining > maxRemaining) maxRemaining = remaining
    return {
      ...point,
      used: remaining,
      quota: ceiling,
      remaining,
      percentUsed: ceiling > 0 ? Math.round((remaining / ceiling) * 100) : 0,
    }
  })

  return {
    mode,
    series: {
      ...series,
      points,
      quotaCeiling: ceiling,
      maxUsed: maxRemaining,
    },
  }
}

export function BurnTrailChart({
  series,
  warningLevel = 'normal',
  usageContext,
}: BurnTrailChartProps): React.ReactElement | null {
  if (!series.hasData) return null

  const gauge = deriveGaugeSeries(series, usageContext)
  const geo = buildBurnTrailGeometry(gauge.series, { width: VIEW_WIDTH, height: VIEW_HEIGHT, valueMode: 'remaining' })
  if (!geo.hasData) return null

  const status = series.projection?.projectionStatus
  // Exhaustion-before-reset is the risk case → red; reset-before-exhaustion is
  // the safe case → green. Fall back to the warning-level accent otherwise.
  const isRisk = status === 'exhaustion_before_reset' || status === 'exhausted'
  const isSafe = status === 'reset_before_exhaustion'
  const accent = isRisk ? '#ef4444' : trailColor(warningLevel)
  const areaOpacityTop = gauge.mode === 'budget' ? BUDGET_FILL_TOP_OPACITY : QUOTA_FILL_TOP_OPACITY
  const areaOpacityBottom = gauge.mode === 'budget' ? BUDGET_FILL_BOTTOM_OPACITY : QUOTA_FILL_BOTTOM_OPACITY
  const projectionColor = isRisk ? '#ef4444' : isSafe ? '#22c55e' : '#a1a1aa'
  const gradientId = 'burnTrailFill'
  const caption = projectionCaption(series)

  return (
    <div className="burnTrail">
      <svg
        className="burnTrailSvg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={`Usage burn trail across ${series.points.length} snapshots${caption ? `. ${caption}.` : ''}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={areaOpacityTop} />
            <stop offset="100%" stopColor={accent} stopOpacity={areaOpacityBottom} />
          </linearGradient>
        </defs>

        {/* Quota ceiling reference line (top of the tank). */}
        {geo.ceilingY !== null && (
          <line
            className="burnTrailCeiling"
            x1={0}
            y1={geo.ceilingY}
            x2={VIEW_WIDTH}
            y2={geo.ceilingY}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {/* Burn-trail area + line, one path per billing period. */}
        {geo.segments.map((seg, i) => (
          <g key={i}>
            <path d={seg.area} fill={`url(#${gradientId})`} stroke="none" />
            <path d={seg.line} fill="none" stroke={accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {gauge.mode === 'budget' && (
              <path
                d={seg.line}
                fill="none"
                stroke={accent}
                strokeWidth={1}
                strokeDasharray="2 3"
                strokeOpacity={0.45}
              />
            )}
          </g>
        ))}

        {/* Projection continuation toward exhaustion. */}
        {geo.projection?.line && (
          <path
            d={geo.projection.line}
            fill="none"
            stroke={projectionColor}
            strokeWidth={1.5}
            strokeDasharray="3 4"
            opacity={0.9}
          />
        )}
        {geo.projection?.marker && (
          <circle
            cx={geo.projection.marker.x}
            cy={geo.projection.marker.y}
            r={3.5}
            fill={projectionColor}
            stroke="#111827"
            strokeWidth={1}
          />
        )}

        {/* Current position. */}
        {geo.current && (
          <circle cx={geo.current.x} cy={geo.current.y} r={4} fill={accent} stroke="#111827" strokeWidth={1.5} />
        )}
      </svg>

      {caption && (
        <p className={`burnTrailCaption ${isRisk ? 'burnTrailCaption-risk' : isSafe ? 'burnTrailCaption-safe' : ''}`}>
          {caption}
        </p>
      )}
      <p
        className="burnTrailCaption"
        role="status"
        aria-live="polite"
        aria-label={`Tank mode is ${gauge.mode === 'budget' ? 'Budget' : 'Quota'} based on current billing phase`}
      >
        Tank mode: {gauge.mode === 'budget' ? 'Budget' : 'Quota'}
      </p>
    </div>
  )
}
