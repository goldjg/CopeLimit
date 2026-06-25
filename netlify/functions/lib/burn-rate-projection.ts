/**
 * @file Pure burn-rate projection helper.
 *
 * Accepts the current normalised {@link Usage} record, a list of recent usage
 * snapshots (newest-first, as returned by {@link getHistory}), and an optional
 * injectable time source. Returns a conservative forward projection of credit
 * exhaustion.
 *
 * All logic is stateless and has no I/O. The projection is conservative:
 * - Insufficient or zero-delta history → `projectionStatus: 'unavailable'`
 * - Already exhausted (no budget)      → `projectionStatus: 'exhausted'`
 * - Reset before projected exhaustion  → `projectionStatus: 'reset_before_exhaustion'`
 * - Exhaustion before reset            → `projectionStatus: 'exhaustion_before_reset'`
 *
 * @see {@link projectBurnRate} for the main entry point
 */

import type { Usage } from './copilot'
import type { UsageHistorySnapshot } from './usage-history-types'

/**
 * Status of the burn-rate projection.
 *
 * - `'unavailable'`             – Not enough history, or burn rate is zero/negative.
 * - `'exhaustion_before_reset'` – Credits will be exhausted before the next billing reset
 *                                 at the current burn rate. This indicates the projection
 *                                 is confident (stable maths), **not** that usage is safe —
 *                                 the user is on track to run out of credits this period.
 * - `'exhausted'`               – Credits are already exhausted (`billingPhase` is
 *                                 `credits_exhausted` or `hard_stop`).
 * - `'reset_before_exhaustion'` – The billing reset will occur before credits run out
 *                                 at the current burn rate.
 */
export type ProjectionStatus =
  | 'unavailable'
  | 'exhaustion_before_reset'
  | 'exhausted'
  | 'reset_before_exhaustion'

/**
 * Forward projection of credit consumption derived from usage history.
 *
 * Returned by {@link projectBurnRate} and intended to be included as an
 * optional field on the `/api/usage` response payload.
 */
export type BurnRateProjection = {
  /** Hours spanned by the history window used to compute the burn rate. */
  windowHours: number;
  /** Sum of positive used-credit deltas across the history window. */
  creditsUsedInWindow: number;
  /** Projected average credit consumption per calendar day. */
  averageCreditsPerDay: number;
  /**
   * ISO 8601 timestamp when credits are projected to reach zero.
   * Present when `projectionStatus === 'exhaustion_before_reset'`.
   */
  projectedExhaustionAt?: string;
  /**
   * Projected overage credits consumed by the next billing reset.
   *
   * Set when:
   * - `projectionStatus === 'exhaustion_before_reset'` and `overagePermitted === true`:
   *   the overage that will accumulate between projected exhaustion and reset.
   * - `projectionStatus === 'reset_before_exhaustion'` and currently in
   *   `budget_active` phase: overage that will accumulate between now and reset.
   */
  projectedOverageCreditsAtReset?: number;
  /** Summary status of the projection. */
  projectionStatus: ProjectionStatus;
  /** Human-readable explanation, especially when `projectionStatus` is `'unavailable'`. */
  projectionReason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Hours per millisecond constant. */
const MS_PER_HOUR = 3_600_000

/**
 * Computes total positive-delta credits consumed and the average rate (credits/hour)
 * from a chronologically sorted array of snapshots.
 *
 * Only intervals where `used` increased are counted; negative deltas (which
 * indicate a quota reset between billing periods) are excluded.
 *
 * @param sorted - Snapshots ordered oldest → newest.
 * @returns `{ creditsUsedInWindow, creditsPerHour }` or `null` when the window
 *   is zero-length or yields no positive consumption.
 */
function computeBurnRate(sorted: UsageHistorySnapshot[]): {
  creditsUsedInWindow: number;
  creditsPerHour: number;
  windowHours: number;
} | null {
  const oldestMs = new Date(sorted[0].capturedAt).getTime()
  const newestMs = new Date(sorted[sorted.length - 1].capturedAt).getTime()
  const windowMs = newestMs - oldestMs

  if (windowMs <= 0) return null

  let creditsUsedInWindow = 0
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i].used - sorted[i - 1].used
    if (delta > 0) creditsUsedInWindow += delta
  }

  if (creditsUsedInWindow <= 0) return null

  const windowHours = windowMs / MS_PER_HOUR
  return { creditsUsedInWindow, creditsPerHour: creditsUsedInWindow / windowHours, windowHours }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a conservative burn-rate projection from usage history.
 *
 * ## Conservative rules
 * - Returns `'unavailable'` when fewer than two snapshots are provided, when
 *   all consumption deltas are zero or negative, or when the billing phase
 *   cannot be meaningfully projected (e.g. `unlimited`).
 * - Returns `'exhausted'` when `billingPhase` is `credits_exhausted` or
 *   `hard_stop`.
 * - Returns `'reset_before_exhaustion'` when the billing reset is projected
 *   to arrive before credits (or overage budget) are exhausted.
 * - Clamps all computed durations and credit quantities to ≥ 0.
 *
 * @param usage     - Current normalised {@link Usage} record.
 * @param snapshots - Recent snapshots **newest-first** (as returned by
 *   {@link getHistory}). At least two are required for a meaningful projection.
 * @param now       - Injectable time source (defaults to `new Date()`).
 * @returns A {@link BurnRateProjection} describing the forward outlook.
 */
export function projectBurnRate(
  usage: Usage,
  snapshots: UsageHistorySnapshot[],
  now: Date = new Date(),
): BurnRateProjection {

  // ---- Phase 1: early-exit for terminal or unprojectable billing states ----

  if (usage.billingPhase === 'credits_exhausted' || usage.billingPhase === 'hard_stop') {
    return {
      windowHours: 0,
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
      projectionStatus: 'exhausted',
      projectionReason: 'Credits are already exhausted.',
    }
  }

  if (usage.billingPhase === 'unlimited') {
    return {
      windowHours: 0,
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
      projectionStatus: 'unavailable',
      projectionReason: 'Unlimited usage; exhaustion cannot be projected.',
    }
  }

  // ---- Phase 2: require at least two snapshots ----

  if (snapshots.length < 2) {
    return {
      windowHours: 0,
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
      projectionStatus: 'unavailable',
      projectionReason: snapshots.length === 0
        ? 'No usage history available.'
        : 'Only one snapshot in history; burn rate cannot be computed.',
    }
  }

  // ---- Phase 3: compute burn rate from snapshot window ----

  // getHistory returns newest-first; sort chronologically for interval computation.
  const sorted = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  const burnRate = computeBurnRate(sorted)
  if (burnRate === null) {
    const windowMs =
      new Date(sorted[sorted.length - 1].capturedAt).getTime() -
      new Date(sorted[0].capturedAt).getTime()
    const windowHours = Math.max(0, windowMs / MS_PER_HOUR)
    return {
      windowHours,
      creditsUsedInWindow: 0,
      averageCreditsPerDay: 0,
      projectionStatus: 'unavailable',
      projectionReason: windowMs <= 0
        ? 'Snapshots cover a zero-length time window.'
        : 'No positive credit consumption detected in the history window.',
    }
  }

  const { creditsUsedInWindow, creditsPerHour, windowHours } = burnRate
  const averageCreditsPerDay = creditsPerHour * 24

  // ---- Phase 4: determine effective remaining credits ----

  let effectiveRemaining: number

  if (usage.billingPhase === 'budget_active' || usage.billingPhase === 'budget_available') {
    // Included credits are exhausted; project against the remaining overage budget.
    if (usage.overageEntitlement === undefined) {
      return {
        windowHours,
        creditsUsedInWindow,
        averageCreditsPerDay,
        projectionStatus: 'unavailable',
        projectionReason: 'Overage entitlement not available for projection.',
      }
    }
    const overageUsed = usage.overageCount ?? usage.derivedOverageCredits ?? 0
    effectiveRemaining = Math.max(0, usage.overageEntitlement - overageUsed)
  } else {
    // credits_available: project against remaining included credits.
    effectiveRemaining = Math.max(0, usage.remaining)
  }

  // ---- Phase 5: project forward ----

  const nowMs = now.getTime()
  const resetAtMs = new Date(usage.resetAt).getTime()
  const hoursUntilReset = Math.max(0, (resetAtMs - nowMs) / MS_PER_HOUR)

  if (effectiveRemaining === 0) {
    // Edge case: remaining reached zero but billing phase isn't `credits_exhausted`.
    // (e.g. budget_available with zero overage entitlement)
    return {
      windowHours,
      creditsUsedInWindow,
      averageCreditsPerDay,
      projectionStatus: 'exhausted',
      projectionReason: 'No remaining credits available for projection.',
    }
  }

  const hoursUntilExhaustion = effectiveRemaining / creditsPerHour

  if (hoursUntilExhaustion <= 0) {
    // Projected exhaustion is now or in the past — treat as exhausted.
    return {
      windowHours,
      creditsUsedInWindow,
      averageCreditsPerDay,
      projectionStatus: 'exhausted',
      projectionReason: 'Credits are already exhausted.',
    }
  }

  const projectedExhaustionMs = nowMs + hoursUntilExhaustion * MS_PER_HOUR

  if (projectedExhaustionMs > resetAtMs) {
    // Reset arrives before projected exhaustion.
    let projectedOverageCreditsAtReset: number | undefined
    if (usage.billingPhase === 'budget_active' || usage.billingPhase === 'budget_available') {
      // Burning (or about to start burning) overage: project how much will be used by reset.
      projectedOverageCreditsAtReset = Math.max(0, creditsPerHour * hoursUntilReset)
    }
    return {
      windowHours,
      creditsUsedInWindow,
      averageCreditsPerDay,
      projectedOverageCreditsAtReset,
      projectionStatus: 'reset_before_exhaustion',
      projectionReason: 'Credits will not be exhausted before the next billing reset.',
    }
  }

  // Credits will be exhausted before the next reset.
  const projectedExhaustionAt = new Date(projectedExhaustionMs).toISOString()

  // When overage/budget is enabled and we're in credits_available phase, project
  // how much overage will accumulate between projected exhaustion and the reset.
  let projectedOverageCreditsAtReset: number | undefined
  if (usage.overagePermitted === true && usage.billingPhase === 'credits_available') {
    const hoursOfOverage = Math.max(0, (resetAtMs - projectedExhaustionMs) / MS_PER_HOUR)
    projectedOverageCreditsAtReset = Math.max(0, creditsPerHour * hoursOfOverage)
  }

  return {
    windowHours,
    creditsUsedInWindow,
    averageCreditsPerDay,
    projectedExhaustionAt,
    projectedOverageCreditsAtReset,
    projectionStatus: 'exhaustion_before_reset',
  }
}
