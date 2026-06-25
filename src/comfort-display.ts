/**
 * @file Pure display helpers for comfort status labels and CSS class modifiers.
 *
 * Extracted into its own module so it can be tested without importing
 * browser-only React bootstrapping code.
 *
 * Types mirror the backend {@link ComfortStatus} shape so the UI can render
 * the API-provided object without re-implementing any comfort logic.
 */

/** All possible comfort levels returned by the usage API. */
export type ComfortLevel =
  | 'safe'
  | 'watch'
  | 'warm'
  | 'hot'
  | 'overage'
  | 'blocked'
  | 'unknown';

/**
 * The comfort status object returned by the API in the `comfortStatus` field.
 *
 * The UI must render this as-is and must not recalculate or reinterpret it.
 */
export type ComfortStatus = {
  level: ComfortLevel;
  summary: string;
  detail?: string;
  primarySignal: string;
  recommendedAction?: string;
};

/**
 * Returns a short user-friendly label for a {@link ComfortLevel}.
 *
 * @param level - The comfort level string from the usage API.
 * @returns A display label suitable for a badge or chip.
 */
export function labelForComfortLevel(level: ComfortLevel): string {
  switch (level) {
    case 'safe':    return 'Safe';
    case 'watch':   return 'Watch';
    case 'warm':    return 'Warm';
    case 'hot':     return 'Hot';
    case 'overage': return 'Overage';
    case 'blocked': return 'Blocked';
    case 'unknown': return 'Unknown';
    default:        return level;
  }
}

/**
 * Returns the CSS modifier class for a comfort level badge.
 *
 * Compose with the base `.comfortBadge` class in styles.css.
 *
 * @param level - The comfort level string from the usage API.
 * @returns A CSS class string such as `"level-safe"` or `"level-hot"`.
 */
export function classForComfortLevel(level: ComfortLevel): string {
  return `level-${level}`;
}
