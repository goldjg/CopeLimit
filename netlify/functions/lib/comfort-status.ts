/**
 * @file Pure comfort-status helper.
 *
 * Translates a normalised {@link Usage} record and an optional
 * {@link BurnRateProjection} into a machine-readable {@link ComfortStatus}
 * object that UI layers, widgets, and notification logic can consume
 * consistently without re-implementing billing-phase or projection logic.
 *
 * ## Priority order (first matching rule wins)
 * 1. Hard billing-phase stops (`hard_stop`, `credits_exhausted`)
 * 2. Overage in progress (`budget_active`)
 * 3. Unlimited usage (`unlimited`)
 * 4. Projection-driven levels when a projection is supplied
 * 5. Fallback to current `warningLevel` / `percentUsed`
 *
 * All logic is stateless and has no I/O.
 *
 * @see {@link computeComfortStatus} for the main entry point.
 */

import type { Usage } from './copilot'
import type { BurnRateProjection } from './burn-rate-projection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity level of the comfort status.
 *
 * | Level      | Meaning                                                         |
 * |------------|-----------------------------------------------------------------|
 * | `safe`     | Healthy; no action needed.                                      |
 * | `watch`    | Burn rate is elevated but the billing reset arrives first.      |
 * | `warm`     | On track to exhaust credits before reset (not imminent).        |
 * | `hot`      | Exhaustion projected within 24 h, or at the budget boundary.   |
 * | `overage`  | Actively spending the configured overage budget.                |
 * | `blocked`  | Usage is blocked (hard stop or credits exhausted, no budget).   |
 * | `unknown`  | Insufficient data to assign a confident level.                  |
 */
export type ComfortLevel =
  | 'safe'
  | 'watch'
  | 'warm'
  | 'hot'
  | 'overage'
  | 'blocked'
  | 'unknown'

/**
 * The strongest signal that drove the assigned {@link ComfortLevel}.
 *
 * | Signal                  | Meaning                                                  |
 * |-------------------------|----------------------------------------------------------|
 * | `remaining`             | Driven by current remaining credits / `warningLevel`.   |
 * | `burn_rate`             | Driven by the burn-rate projection.                     |
 * | `overage`               | Overage spending is in progress.                        |
 * | `hard_stop`             | Billing phase is `hard_stop`.                           |
 * | `insufficient_history`  | Projection was unavailable; fell back to current usage. |
 * | `unlimited`             | Billing phase is `unlimited`; no quota enforced.        |
 */
export type PrimarySignal =
  | 'remaining'
  | 'burn_rate'
  | 'overage'
  | 'hard_stop'
  | 'insufficient_history'
  | 'unlimited'

/**
 * Machine-readable representation of the current usage comfort level.
 *
 * Returned by {@link computeComfortStatus} and intended as a stable
 * field on the `/api/usage` response payload consumed by UI, widgets,
 * and notification logic.
 */
export type ComfortStatus = {
  /** Severity level. */
  level: ComfortLevel;
  /** Short human-readable summary (one sentence, no trailing full stop unless natural). */
  summary: string;
  /** Optional elaboration — projected exhaustion timestamp, overage detail, etc. */
  detail?: string;
  /** The strongest signal that determined `level`. */
  primarySignal: PrimarySignal;
  /** Optional next-step guidance. Omitted when the situation is clear and no action is needed. */
  recommendedAction?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const HOURS_24 = 24
const MS_PER_HOUR = 3_600_000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives a comfort status from the current `warningLevel` and `percentUsed`
 * when no strong projection signal is available.
 *
 * @param usage         - Current normalised usage.
 * @param primarySignal - Signal to attach, indicating why the projection was
 *                        not used (`'remaining'` or `'insufficient_history'`).
 */
function computeFromCurrentUsage(
  usage: Usage,
  primarySignal: Extract<PrimarySignal, 'remaining' | 'insufficient_history'>,
): ComfortStatus {
  if (usage.billingPhase === 'budget_available') {
    return {
      level: 'hot',
      summary: 'Included credits exhausted; budget is available but not yet active.',
      primarySignal,
    }
  }

  const pct = usage.percentUsed

  switch (usage.warningLevel) {
    case 'over':
    case 'hot':
      return {
        level: 'hot',
        summary: `Usage is at ${pct}% of quota.`,
        primarySignal,
      }
    case 'warm':
      return {
        level: 'warm',
        summary: `Usage is at ${pct}% of quota.`,
        primarySignal,
      }
    case 'normal':
    default:
      return {
        level: 'safe',
        summary: `Usage is at ${pct}% of quota.`,
        primarySignal,
      }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a {@link ComfortStatus} from the current normalised usage and an
 * optional burn-rate projection.
 *
 * ## Conservative rules
 * - Hard billing-phase stops take unconditional priority.
 * - The `unlimited` phase always returns `safe` with `primarySignal: 'unlimited'`.
 * - When a projection is supplied, its status drives the level (except for
 *   terminal billing phases that are resolved first).
 * - When the projection is `'unavailable'`, the function falls back to
 *   `warningLevel` / `percentUsed` and marks `primarySignal` as
 *   `'insufficient_history'` so consumers know the level is less certain.
 * - When no projection is supplied at all, the fallback uses
 *   `primarySignal: 'remaining'`.
 *
 * @param usage      - Current normalised {@link Usage} record.
 * @param projection - Optional burn-rate projection from {@link projectBurnRate}.
 * @param now        - Injectable time source (defaults to `new Date()`).
 * @returns A {@link ComfortStatus} describing the current outlook.
 */
export function computeComfortStatus(
  usage: Usage,
  projection?: BurnRateProjection,
  now: Date = new Date(),
): ComfortStatus {

  // ---- Priority 1: Hard billing-phase stops --------------------------------

  if (usage.billingPhase === 'hard_stop') {
    return {
      level: 'blocked',
      summary: 'Usage is blocked; no active quota.',
      primarySignal: 'hard_stop',
      recommendedAction: 'Contact your administrator to review billing settings.',
    }
  }

  if (usage.billingPhase === 'credits_exhausted') {
    return {
      level: 'blocked',
      summary: 'Included credits exhausted; no budget configured.',
      primarySignal: 'remaining',
      recommendedAction: 'Usage is blocked until the quota resets.',
    }
  }

  // ---- Priority 2: Overage in progress ------------------------------------

  if (usage.billingPhase === 'budget_active') {
    let detail: string | undefined
    if (usage.overageCount !== undefined) {
      detail = `${usage.overageCount} overage credits consumed.`
    } else if (usage.derivedOverageCredits !== undefined) {
      detail = `Approximately ${usage.derivedOverageCredits} overage credits consumed (estimated, settlement pending).`
    }
    return {
      level: 'overage',
      summary: 'Spending against configured budget.',
      detail,
      primarySignal: 'overage',
    }
  }

  // ---- Priority 3: Unlimited -----------------------------------------------

  if (usage.billingPhase === 'unlimited') {
    return {
      level: 'safe',
      summary: 'Unlimited usage; no quota enforced.',
      primarySignal: 'unlimited',
    }
  }

  // ---- Priority 4: Projection-driven levels --------------------------------
  // Applies to credits_available and budget_available billing phases.

  if (projection !== undefined) {
    const { projectionStatus, projectedExhaustionAt } = projection

    if (projectionStatus === 'exhaustion_before_reset') {
      const hoursUntilExhaustion = projectedExhaustionAt !== undefined
        ? (new Date(projectedExhaustionAt).getTime() - now.getTime()) / MS_PER_HOUR
        : Infinity
      const level = hoursUntilExhaustion <= HOURS_24 ? 'hot' : 'warm'
      return {
        level,
        summary: level === 'hot'
          ? 'Credits projected to run out within 24 hours.'
          : 'On track to exhaust credits before the billing reset.',
        detail: projectedExhaustionAt !== undefined
          ? `Projected exhaustion: ${projectedExhaustionAt}.`
          : undefined,
        primarySignal: 'burn_rate',
        recommendedAction: 'Reduce usage or wait for the next billing reset.',
      }
    }

    if (projectionStatus === 'reset_before_exhaustion') {
      const level = usage.percentUsed >= 75 ? 'watch' : 'safe'
      return {
        level,
        summary: 'On track to reach the billing reset with credits remaining.',
        primarySignal: 'burn_rate',
      }
    }

    if (projectionStatus === 'unavailable') {
      return computeFromCurrentUsage(usage, 'insufficient_history')
    }

    // 'exhausted' — should be covered by billing-phase checks above, but handle
    // defensively in case the projection was computed with a stale billing state.
    return {
      level: 'blocked',
      summary: 'Credits are already exhausted.',
      primarySignal: 'remaining',
    }
  }

  // ---- Priority 5: No projection supplied → fall back to current usage -----

  return computeFromCurrentUsage(usage, 'remaining')
}
