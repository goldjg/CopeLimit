/**
 * @file Shared chart-data normalization for usage history visualisations.
 *
 * Both the PWA "burn trail" chart and the Scriptable widget's mini chart consume
 * the same normalised series so that the visual metaphor (a fuel tank consumed
 * over time, with quota as the ceiling and projection as the direction of
 * travel) stays consistent across surfaces.
 *
 * The normaliser is a pure function with no I/O. It is intentionally defensive:
 *
 * - Snapshots are sorted chronologically (oldest → newest).
 * - Empty / single-snapshot history is handled gracefully.
 * - Non-finite or impossible values (NaN, Infinity, negatives) are dropped or
 *   clamped — the output never contains `NaN` or `Infinity`.
 * - Quota resets (a sharp drop in `used` at the start of a new billing period)
 *   are detected and flagged so renderers can break the trail instead of
 *   drawing a misleading vertical cliff.
 * - Small negative deltas from settlement-lag noise are smoothed (carried
 *   forward) so the trail does not show scary fake dips within a period.
 *
 * This module derives only from existing fields. It does not change history
 * storage, burn-rate/projection logic, comfort-status logic, or alert logic.
 */

import type { BillingPhase } from './copilot'
import type { ProjectionStatus } from './burn-rate-projection'

/**
 * A single chronological point on the burn-trail chart.
 *
 * All numeric fields are guaranteed finite and non-negative.
 */
export type ChartPoint = {
  /** ISO 8601 timestamp when the snapshot was captured. */
  capturedAt: string
  /** Epoch milliseconds for `capturedAt` (finite). */
  t: number
  /**
   * Credits consumed, after noise smoothing within a billing period.
   * Monotonic non-decreasing within a period; resets start a new period.
   */
  used: number
  /** Quota allocated for the period (finite, ≥ 0). */
  quota: number
  /** Remaining credits, derived as `max(0, quota - used)`. */
  remaining: number
  /** Percent of quota consumed, clamped to `0..100`. */
  percentUsed: number
  /**
   * `true` when this point is the first of a new billing period (i.e. a quota
   * reset was detected immediately before it). Renderers should break the
   * trail here rather than connecting across the discontinuity.
   */
  isPeriodStart: boolean
}

/**
 * Optional projection context, derived from an existing
 * {@link BurnRateProjection} without recomputing any projection logic.
 */
export type ChartProjection = {
  /** ISO timestamp of projected exhaustion, when available. */
  projectedExhaustionAt?: string
  /** Epoch milliseconds for `projectedExhaustionAt`, when finite. */
  projectedExhaustionT?: number
  /** Projection status passed through from the source projection. */
  projectionStatus?: ProjectionStatus
}

/**
 * The fully normalised series consumed by chart renderers.
 */
export type ChartSeries = {
  /** Chronological points, oldest → newest. Empty when no valid history. */
  points: ChartPoint[]
  /** Representative quota ceiling (max quota across points, ≥ 0). */
  quotaCeiling: number
  /** Maximum smoothed `used` across points (≥ 0). */
  maxUsed: number
  /** `true` when at least one point is present. */
  hasData: boolean
  /** `true` when at least one quota reset was detected across the window. */
  hasReset: boolean
  /** Optional projection marker context. */
  projection?: ChartProjection
}

/** A loosely-typed snapshot accepted by the normaliser. */
export type ChartSnapshotInput = {
  capturedAt?: unknown
  used?: unknown
  quota?: unknown
  remaining?: unknown
  billingPhase?: BillingPhase
}

/** Source projection fields the normaliser reads (a subset of BurnRateProjection). */
export type ChartProjectionInput = {
  projectedExhaustionAt?: unknown
  projectionStatus?: unknown
}

/**
 * A drop in `used` larger than this fraction of the previous value is treated
 * as a genuine quota reset (new billing period) rather than settlement noise.
 */
const RESET_DROP_RATIO = 0.5

/** Returns `true` only for finite numbers. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Clamps a value to a finite, non-negative number (default `0`). */
function clampNonNegativeFinite(value: unknown): number {
  if (!isFiniteNumber(value)) return 0
  return value < 0 ? 0 : value
}

/** Parses a timestamp to finite epoch ms, or `null` when unparseable. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** Computes a 0..100 percent, clamped and finite. */
function clampPercent(used: number, quota: number): number {
  if (quota <= 0) return 0
  const pct = (used / quota) * 100
  if (!Number.isFinite(pct)) return 0
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

/**
 * Normalises raw usage-history snapshots into a clean, defensive
 * {@link ChartSeries} suitable for the PWA burn-trail chart and the widget
 * mini-chart.
 *
 * @param snapshots - Raw snapshots in any order (newest-first from `getHistory`
 *   is fine). Malformed or non-finite entries are skipped.
 * @param projection - Optional projection context (e.g. from
 *   `usage.burnRateProjection`). Only `projectedExhaustionAt` and
 *   `projectionStatus` are read; no projection logic is recomputed.
 * @returns A normalised series. Never throws; never emits `NaN`/`Infinity`.
 */
export function buildChartSeries(
  snapshots: readonly ChartSnapshotInput[] | null | undefined,
  projection?: ChartProjectionInput | null,
): ChartSeries {
  const empty: ChartSeries = {
    points: [],
    quotaCeiling: 0,
    maxUsed: 0,
    hasData: false,
    hasReset: false,
    projection: buildProjection(projection),
  }

  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return empty
  }

  // 1. Parse + drop malformed entries (require a valid timestamp).
  const parsed: { t: number; capturedAt: string; used: number; quota: number }[] = []
  for (const snap of snapshots) {
    if (snap == null || typeof snap !== 'object') continue
    const t = parseTimestamp(snap.capturedAt)
    if (t === null) continue
    parsed.push({
      t,
      capturedAt: snap.capturedAt as string,
      used: clampNonNegativeFinite(snap.used),
      quota: clampNonNegativeFinite(snap.quota),
    })
  }

  if (parsed.length === 0) {
    return empty
  }

  // 2. Sort chronologically (oldest → newest), stable on timestamp.
  parsed.sort((a, b) => a.t - b.t)

  // 3. Walk the series: detect resets, smooth noise, build points.
  const points: ChartPoint[] = []
  let hasReset = false
  let prevUsed: number | null = null

  for (const entry of parsed) {
    let used = entry.used
    let isPeriodStart = false

    if (prevUsed !== null && used < prevUsed) {
      const isReset = used < prevUsed * RESET_DROP_RATIO
      if (isReset) {
        // Genuine quota reset: keep the real low value, flag a new period so
        // renderers break the trail instead of drawing a vertical cliff.
        isPeriodStart = true
        hasReset = true
      } else {
        // Settlement-lag noise: carry the previous value forward so the trail
        // stays monotonic within the period (no scary fake dip).
        used = prevUsed
      }
    }

    const quota = entry.quota
    const remaining = quota > used ? quota - used : 0
    points.push({
      capturedAt: entry.capturedAt,
      t: entry.t,
      used,
      quota,
      remaining,
      percentUsed: clampPercent(used, quota),
      isPeriodStart,
    })
    prevUsed = used
  }

  let quotaCeiling = 0
  let maxUsed = 0
  for (const p of points) {
    if (p.quota > quotaCeiling) quotaCeiling = p.quota
    if (p.used > maxUsed) maxUsed = p.used
  }

  return {
    points,
    quotaCeiling,
    maxUsed,
    hasData: true,
    hasReset,
    projection: buildProjection(projection),
  }
}

/** Builds the optional {@link ChartProjection}, dropping unusable values. */
function buildProjection(
  projection: ChartProjectionInput | null | undefined,
): ChartProjection | undefined {
  if (projection == null || typeof projection !== 'object') return undefined

  const status =
    typeof projection.projectionStatus === 'string'
      ? (projection.projectionStatus as ProjectionStatus)
      : undefined

  let projectedExhaustionAt: string | undefined
  let projectedExhaustionT: number | undefined
  if (typeof projection.projectedExhaustionAt === 'string') {
    const t = parseTimestamp(projection.projectedExhaustionAt)
    if (t !== null) {
      projectedExhaustionAt = projection.projectedExhaustionAt
      projectedExhaustionT = t
    }
  }

  if (status === undefined && projectedExhaustionAt === undefined) {
    return undefined
  }

  return { projectedExhaustionAt, projectedExhaustionT, projectionStatus: status }
}
