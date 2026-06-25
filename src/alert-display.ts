/**
 * @file Pure display helpers for alert decision labels and CSS class modifiers.
 *
 * Extracted into its own module so it can be tested without importing
 * browser-only React bootstrapping code.
 *
 * Types mirror the backend {@link AlertDecision} shape so the UI can render
 * the API-provided object without re-implementing any alert logic.
 */

/** Severity of an alert decision, matching the backend `AlertSeverity` type. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Category of alert, matching the backend `AlertType` type. */
export type AlertType =
  | 'approaching_exhaustion'
  | 'exhausted'
  | 'overage_active'
  | 'hard_stop'
  | 'budget_risk'
  | 'unknown_risk';

/**
 * The alert decision object returned by the API in the `alertDecision` field.
 *
 * The UI must render this as-is and must not recalculate or reinterpret it.
 * When `shouldAlert` is `false`, optional fields may be omitted.
 */
export type AlertDecision = {
  shouldAlert: boolean;
  alertType?: AlertType;
  severity?: AlertSeverity;
  title?: string;
  message?: string;
  reason: string;
  dedupeKey?: string;
};

/**
 * Returns a short user-friendly label for an {@link AlertSeverity}.
 *
 * @param severity - The severity value from the API, or `undefined`.
 * @returns A display label suitable for a badge.
 */
export function labelForAlertSeverity(severity: AlertSeverity | undefined): string {
  switch (severity) {
    case 'info':     return 'Info';
    case 'warning':  return 'Warning';
    case 'critical': return 'Critical';
    default:         return 'Alert';
  }
}

/**
 * Returns the CSS modifier class for a severity badge.
 *
 * Compose with the base `.alertSeverityBadge` class in styles.css.
 *
 * @param severity - The severity value from the API, or `undefined`.
 * @returns A CSS class string such as `"severity-warning"`.
 */
export function classForAlertSeverity(severity: AlertSeverity | undefined): string {
  return severity ? `severity-${severity}` : 'severity-unknown';
}

/**
 * Returns a short user-friendly label for an {@link AlertType}.
 *
 * @param alertType - The alert type value from the API, or `undefined`.
 * @returns A display label suitable for a compact indicator.
 */
export function labelForAlertType(alertType: AlertType | undefined): string {
  switch (alertType) {
    case 'approaching_exhaustion': return 'Running out soon';
    case 'exhausted':              return 'Credits exhausted';
    case 'overage_active':         return 'Overage active';
    case 'hard_stop':              return 'Hard stop';
    case 'budget_risk':            return 'Budget at risk';
    case 'unknown_risk':           return 'Unknown risk';
    default:                       return 'Alert';
  }
}
