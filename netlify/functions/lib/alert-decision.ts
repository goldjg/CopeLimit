/**
 * @file Pure alert-decision helper.
 *
 * Determines whether CopeLimit should alert the user about their AI credit
 * usage, and if so, what kind of alert to surface.
 *
 * ## Design principles
 * - **Stateless and side-effect-free.** No I/O, no scheduling, no push.
 * - **Consumes `comfortStatus` where available** rather than re-examining raw
 *   usage or projection fields, so billing-phase logic is never duplicated.
 * - Falls back to `usage` / `projection` only for alert-specific thresholds
 *   that `comfortStatus` does not encode (e.g. "within 24 h").
 * - Conservative defaults: alerts only for actionable states; `safe`, `watch`,
 *   `warm`, and `unknown` levels are silent unless the caller opts in.
 *
 * ## Usage
 * ```ts
 * const decision = evaluateAlertDecision({ usage, projection, comfortStatus })
 * if (decision.shouldAlert) { ... }
 * ```
 *
 * @see {@link evaluateAlertDecision} for the main entry point.
 */

import type { Usage } from './copilot'
import type { BurnRateProjection } from './burn-rate-projection'
import type { ComfortStatus, ComfortLevel } from './comfort-status'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The category of alert that should be surfaced.
 *
 * | Type                   | Trigger                                                            |
 * |------------------------|--------------------------------------------------------------------|
 * | `approaching_exhaustion` | Credits will run out within the configured threshold window.     |
 * | `exhausted`            | Included credits are exhausted; no overage budget is active.      |
 * | `overage_active`       | The configured budget/overage is now being consumed.              |
 * | `hard_stop`            | All usage is blocked; no quota, no budget, no unlimited plan.     |
 * | `budget_risk`          | On track to exhaust credits before the next billing reset.        |
 * | `unknown_risk`         | Insufficient data, but enough signals to warrant attention.       |
 */
export type AlertType =
  | 'approaching_exhaustion'
  | 'exhausted'
  | 'overage_active'
  | 'hard_stop'
  | 'budget_risk'
  | 'unknown_risk'

/**
 * How severe the alert is.
 *
 * | Severity   | Meaning                                           |
 * |------------|---------------------------------------------------|
 * | `info`     | Informational — worth noting but not urgent.      |
 * | `warning`  | Attention warranted; action may be needed soon.   |
 * | `critical` | Immediate action required or usage is blocked.    |
 */
export type AlertSeverity = 'info' | 'warning' | 'critical'

/**
 * The result of the alert-decision evaluation.
 *
 * When `shouldAlert` is `false`, all optional fields are omitted.
 * When `shouldAlert` is `true`, `alertType` and `severity` are always set.
 */
export type AlertDecision = {
  /** Whether an alert should be surfaced to the user. */
  shouldAlert: boolean;
  /** Category of the alert. Present when `shouldAlert` is `true`. */
  alertType?: AlertType;
  /** How severe the situation is. Present when `shouldAlert` is `true`. */
  severity?: AlertSeverity;
  /** Short headline for the alert (one sentence, no trailing period). */
  title?: string;
  /** Human-readable description with additional context. */
  message?: string;
  /**
   * Machine-readable explanation of why this decision was reached.
   * Always present — useful for logging and debugging even when no alert fires.
   */
  reason: string;
  /**
   * Stable deduplication key.
   *
   * When two successive evaluations produce the same `dedupeKey`, the
   * notification layer may suppress the second delivery. Changes when the
   * underlying situation changes (different alert type + severity + billing
   * phase + day boundary).
   *
   * Present when `shouldAlert` is `true`.
   */
  dedupeKey?: string;
}

/**
 * Caller-supplied alert preferences that override the conservative defaults.
 *
 * All fields are optional; omitted fields fall back to the library defaults.
 */
export type AlertPreferences = {
  /**
   * Alert when `comfortStatus.level` is `'hot'`.
   * Default: `true` (exhaustion within 24 h is always actionable).
   */
  alertOnHot?: boolean;
  /**
   * Alert when `comfortStatus.level` is `'warm'` (on track to exhaust before reset,
   * but not imminent).
   * Default: `false`.
   */
  alertOnWarm?: boolean;
  /**
   * Alert when `comfortStatus.level` is `'watch'` (burn rate elevated but reset wins).
   * Default: `false`.
   */
  alertOnWatch?: boolean;
  /**
   * Alert when `comfortStatus.level` is `'overage'` (budget is actively being spent).
   * Default: `true`.
   */
  alertOnOverage?: boolean;
  /**
   * Alert when `comfortStatus.level` is `'blocked'` (hard stop or credits exhausted).
   * Default: `true`.
   */
  alertOnBlocked?: boolean;
  /**
   * Alert when `comfortStatus.level` is `'unknown'`.
   * Default: `false`.
   */
  alertOnUnknown?: boolean;
  /**
   * Window in hours within which a projected exhaustion triggers an alert.
   * Only applies when the `comfortStatus` is insufficient to determine imminence
   * on its own (e.g. when `comfortStatus` is absent).
   * Default: `24`.
   */
  exhaustionWindowHours?: number;
}

// ---------------------------------------------------------------------------
// Internal defaults
// ---------------------------------------------------------------------------

const DEFAULT_PREFS: Required<AlertPreferences> = {
  alertOnHot: true,
  alertOnWarm: false,
  alertOnWatch: false,
  alertOnOverage: true,
  alertOnBlocked: true,
  alertOnUnknown: false,
  exhaustionWindowHours: 24,
}

const MS_PER_HOUR = 3_600_000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Merges caller preferences with the conservative defaults. */
function resolvePrefs(prefs?: AlertPreferences): Required<AlertPreferences> {
  if (prefs === undefined) return DEFAULT_PREFS
  return { ...DEFAULT_PREFS, ...prefs }
}

/**
 * Builds a stable dedupe key from alert type, severity, billing phase, and
 * UTC day. Notifications with the same key on the same day can be suppressed.
 */
function buildDedupeKey(
  alertType: AlertType,
  severity: AlertSeverity,
  billingPhase: string,
  now: Date,
): string {
  const dayStr = now.toISOString().slice(0, 10) // YYYY-MM-DD
  return `${alertType}:${severity}:${billingPhase}:${dayStr}`
}

/** Returns true when a projected exhaustion timestamp is within the given window. */
function isWithinWindow(projectedExhaustionAt: string | undefined, windowHours: number, now: Date): boolean {
  if (projectedExhaustionAt === undefined) return false
  const hoursUntil = (new Date(projectedExhaustionAt).getTime() - now.getTime()) / MS_PER_HOUR
  return hoursUntil <= windowHours
}

// ---------------------------------------------------------------------------
// Decision cases driven by comfortStatus.level
// ---------------------------------------------------------------------------

function decideFromComfortLevel(
  level: ComfortLevel,
  prefs: Required<AlertPreferences>,
  usage: Usage,
  projection: BurnRateProjection | undefined,
  now: Date,
): AlertDecision | null {
  switch (level) {
    case 'blocked': {
      if (!prefs.alertOnBlocked) {
        return {
          shouldAlert: false,
          reason: 'Usage is blocked but alertOnBlocked is disabled by preferences.',
        }
      }

      if (usage.billingPhase === 'hard_stop') {
        const alertType: AlertType = 'hard_stop'
        const severity: AlertSeverity = 'critical'
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'Usage blocked — hard stop active',
          message: 'AI usage is blocked. No quota, budget, or unlimited plan is active. Contact your administrator.',
          reason: 'Billing phase is hard_stop.',
          dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
        }
      }

      // credits_exhausted (or any other blocked state)
      const alertType: AlertType = 'exhausted'
      const severity: AlertSeverity = 'critical'
      return {
        shouldAlert: true,
        alertType,
        severity,
        title: 'AI credits exhausted',
        message: 'Included credits are exhausted and no overage budget is configured. Usage is blocked until the quota resets.',
        reason: 'Comfort level is blocked (credits_exhausted).',
        dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
      }
    }

    case 'overage': {
      if (!prefs.alertOnOverage) {
        return {
          shouldAlert: false,
          reason: 'Overage is active but alertOnOverage is disabled by preferences.',
        }
      }
      const alertType: AlertType = 'overage_active'
      const severity: AlertSeverity = 'warning'
      return {
        shouldAlert: true,
        alertType,
        severity,
        title: 'Overage budget active',
        message: 'Included credits are exhausted. Spending is now drawing from your configured overage budget.',
        reason: 'Comfort level is overage (budget_active phase).',
        dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
      }
    }

    case 'hot': {
      if (!prefs.alertOnHot) {
        return {
          shouldAlert: false,
          reason: 'Hot comfort level detected but alertOnHot is disabled by preferences.',
        }
      }

      // Determine whether this is an imminence alert or a budget-boundary alert.
      const projectedExhaustionAt = projection?.projectedExhaustionAt
      const isImminent = isWithinWindow(projectedExhaustionAt, prefs.exhaustionWindowHours, now)
      const alertType: AlertType = isImminent ? 'approaching_exhaustion' : 'budget_risk'
      const severity: AlertSeverity = isImminent ? 'critical' : 'warning'

      if (isImminent) {
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'Credits running out soon',
          message: projectedExhaustionAt !== undefined
            ? `AI credits are projected to run out by ${projectedExhaustionAt}. Reduce usage or wait for the billing reset.`
            : 'AI credits are projected to run out within 24 hours. Reduce usage or wait for the billing reset.',
          reason: `Comfort level is hot and exhaustion is projected within ${prefs.exhaustionWindowHours} hours.`,
          dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
        }
      }

      return {
        shouldAlert: true,
        alertType,
        severity,
        title: 'High credit usage — budget at risk',
        message: projectedExhaustionAt !== undefined
          ? `AI credits are on track to run out by ${projectedExhaustionAt} — before the next billing reset.`
          : 'AI credit usage is high and credits may run out before the next billing reset.',
        reason: 'Comfort level is hot but exhaustion is not within the immediate window.',
        dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
      }
    }

    case 'warm': {
      if (!prefs.alertOnWarm) {
        return {
          shouldAlert: false,
          reason: 'Warm comfort level: no alert by default (alertOnWarm is false).',
        }
      }
      const alertType: AlertType = 'budget_risk'
      const severity: AlertSeverity = 'info'
      const projectedExhaustionAt = projection?.projectedExhaustionAt
      return {
        shouldAlert: true,
        alertType,
        severity,
        title: 'On track to exhaust credits before reset',
        message: projectedExhaustionAt !== undefined
          ? `AI credits are projected to run out by ${projectedExhaustionAt}.`
          : 'AI credits are on track to run out before the next billing reset.',
        reason: 'Comfort level is warm and alertOnWarm is enabled by preferences.',
        dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
      }
    }

    case 'watch': {
      if (!prefs.alertOnWatch) {
        return {
          shouldAlert: false,
          reason: 'Watch comfort level: no alert by default (alertOnWatch is false).',
        }
      }
      const alertType: AlertType = 'budget_risk'
      const severity: AlertSeverity = 'info'
      return {
        shouldAlert: true,
        alertType,
        severity,
        title: 'Elevated burn rate',
        message: 'Credit burn rate is elevated, though the billing reset is expected before credits run out.',
        reason: 'Comfort level is watch and alertOnWatch is enabled by preferences.',
        dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
      }
    }

    case 'safe':
      return {
        shouldAlert: false,
        reason: 'Comfort level is safe: no alert needed.',
      }

    case 'unknown':
      if (!prefs.alertOnUnknown) {
        return {
          shouldAlert: false,
          reason: 'Comfort level is unknown but alertOnUnknown is false: no alert.',
        }
      }
      {
        const alertType: AlertType = 'unknown_risk'
        const severity: AlertSeverity = 'info'
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'Credit usage status unknown',
          message: 'Insufficient data to determine credit usage outlook. Check back after more usage is recorded.',
          reason: 'Comfort level is unknown and alertOnUnknown is enabled by preferences.',
          dedupeKey: buildDedupeKey(alertType, severity, usage.billingPhase, now),
        }
      }

    default: {
      // Exhaustive check — TypeScript will flag any unhandled ComfortLevel.
      const _exhaustive: never = level
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback: evaluate directly from usage/projection when comfortStatus absent
// ---------------------------------------------------------------------------

function decideFromUsageAndProjection(
  usage: Usage,
  projection: BurnRateProjection | undefined,
  prefs: Required<AlertPreferences>,
  now: Date,
): AlertDecision {
  const { billingPhase } = usage

  if (billingPhase === 'hard_stop') {
    if (!prefs.alertOnBlocked) {
      return { shouldAlert: false, reason: 'Hard stop detected but alertOnBlocked is disabled.' }
    }
    const alertType: AlertType = 'hard_stop'
    const severity: AlertSeverity = 'critical'
    return {
      shouldAlert: true,
      alertType,
      severity,
      title: 'Usage blocked — hard stop active',
      message: 'AI usage is blocked. No quota, budget, or unlimited plan is active.',
      reason: 'Billing phase is hard_stop (no comfortStatus supplied).',
      dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
    }
  }

  if (billingPhase === 'credits_exhausted') {
    if (!prefs.alertOnBlocked) {
      return { shouldAlert: false, reason: 'Credits exhausted but alertOnBlocked is disabled.' }
    }
    const alertType: AlertType = 'exhausted'
    const severity: AlertSeverity = 'critical'
    return {
      shouldAlert: true,
      alertType,
      severity,
      title: 'AI credits exhausted',
      message: 'Included credits are exhausted and no overage budget is configured.',
      reason: 'Billing phase is credits_exhausted (no comfortStatus supplied).',
      dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
    }
  }

  if (billingPhase === 'budget_active') {
    if (!prefs.alertOnOverage) {
      return { shouldAlert: false, reason: 'Overage active but alertOnOverage is disabled.' }
    }
    const alertType: AlertType = 'overage_active'
    const severity: AlertSeverity = 'warning'
    return {
      shouldAlert: true,
      alertType,
      severity,
      title: 'Overage budget active',
      message: 'Included credits are exhausted. Spending is drawing from the overage budget.',
      reason: 'Billing phase is budget_active (no comfortStatus supplied).',
      dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
    }
  }

  // Projection-driven decisions (when comfortStatus is absent).
  if (projection !== undefined) {
    if (projection.projectionStatus === 'exhaustion_before_reset') {
      const projectedExhaustionAt = projection.projectedExhaustionAt
      const imminent = isWithinWindow(projectedExhaustionAt, prefs.exhaustionWindowHours, now)

      if (imminent && prefs.alertOnHot) {
        const alertType: AlertType = 'approaching_exhaustion'
        const severity: AlertSeverity = 'critical'
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'Credits running out soon',
          message: projectedExhaustionAt !== undefined
            ? `AI credits are projected to run out by ${projectedExhaustionAt}.`
            : 'AI credits are projected to run out within 24 hours.',
          reason: `Projection status is exhaustion_before_reset and exhaustion is within ${prefs.exhaustionWindowHours} hours (no comfortStatus supplied).`,
          dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
        }
      }

      if (!imminent && prefs.alertOnWarm) {
        const alertType: AlertType = 'budget_risk'
        const severity: AlertSeverity = 'warning'
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'On track to exhaust credits before reset',
          message: projectedExhaustionAt !== undefined
            ? `AI credits are projected to run out by ${projectedExhaustionAt}.`
            : 'AI credits may run out before the next billing reset.',
          reason: 'Projection status is exhaustion_before_reset (not imminent, alertOnWarm enabled, no comfortStatus).',
          dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
        }
      }

      return {
        shouldAlert: false,
        reason: imminent
          ? 'Exhaustion imminent but alertOnHot is disabled by preferences.'
          : 'Exhaustion projected before reset but not imminent; alertOnWarm is false.',
      }
    }

    if (projection.projectionStatus === 'unavailable') {
      if (prefs.alertOnUnknown) {
        const alertType: AlertType = 'unknown_risk'
        const severity: AlertSeverity = 'info'
        return {
          shouldAlert: true,
          alertType,
          severity,
          title: 'Credit usage status unknown',
          message: 'Insufficient history to project credit usage. Check back after more usage is recorded.',
          reason: 'Projection unavailable and alertOnUnknown enabled (no comfortStatus supplied).',
          dedupeKey: buildDedupeKey(alertType, severity, billingPhase, now),
        }
      }
      return {
        shouldAlert: false,
        reason: 'Projection unavailable and alertOnUnknown is false: no alert.',
      }
    }
  }

  return {
    shouldAlert: false,
    reason: 'No actionable signal detected from usage or projection alone.',
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Input parameters for {@link evaluateAlertDecision}.
 */
export type AlertDecisionInput = {
  /** Current normalised usage record. */
  usage: Usage;
  /** Optional burn-rate projection from {@link projectBurnRate}. */
  projection?: BurnRateProjection;
  /**
   * Optional pre-computed comfort status.
   *
   * When provided, alert logic delegates to `comfortStatus.level` as the
   * primary decision signal to avoid re-implementing billing-phase logic.
   * When absent, the function falls back to examining `usage.billingPhase`
   * and the raw `projection` directly.
   */
  comfortStatus?: ComfortStatus;
  /** Optional caller-supplied preferences. Missing fields use conservative defaults. */
  preferences?: AlertPreferences;
  /** Injectable time source (defaults to `new Date()`). */
  now?: Date;
}

/**
 * Evaluates whether CopeLimit should alert the user about their AI credit usage.
 *
 * ## Decision strategy
 * 1. If `comfortStatus` is provided, delegate to `comfortStatus.level` as the
 *    primary signal.  This avoids duplicating billing-phase logic from
 *    `comfort-status.ts`.
 * 2. If `comfortStatus` is absent, fall back to examining `usage.billingPhase`
 *    and `projection` directly.
 *
 * ## Conservative defaults
 * - `safe`, `watch`, and `unknown` → no alert.
 * - `warm` → no alert (alertOnWarm defaults to `false`).
 * - `hot`, `overage`, `blocked` → alert.
 *
 * @param input - Usage data, optional projection, optional comfort status, and preferences.
 * @returns An {@link AlertDecision} describing whether and how to alert.
 */
export function evaluateAlertDecision(input: AlertDecisionInput): AlertDecision {
  const { usage, projection, comfortStatus, preferences } = input
  const now = input.now ?? new Date()
  const prefs = resolvePrefs(preferences)

  if (comfortStatus !== undefined) {
    const decision = decideFromComfortLevel(comfortStatus.level, prefs, usage, projection, now)
    if (decision !== null) return decision
  }

  // comfortStatus absent, or decideFromComfortLevel returned null (shouldn't happen
  // with exhaustive switch, but handled defensively).
  return decideFromUsageAndProjection(usage, projection, prefs, now)
}
