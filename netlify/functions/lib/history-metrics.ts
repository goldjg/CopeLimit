/**
 * @file Pure functions for computing derived metrics from usage history snapshots.
 *
 * All functions in this module are stateless and have no I/O. They operate
 * only on {@link UsageHistorySnapshot} values already returned by {@link getHistory}.
 *
 * ## Derived metrics
 *
 * | Metric           | Description                                                            |
 * |------------------|------------------------------------------------------------------------|
 * | `deltaUsed`      | Sum of positive per-interval `used` deltas (excludes quota resets).   |
 * | `creditsPerHour` | `deltaUsed` / total span in hours. `null` when < 2 snapshots.         |
 * | `creditsPerDay`  | `creditsPerHour × 24`. `null` when < 2 snapshots.                     |
 * | `averageBurnRate`| Mean of per-interval burn rates (credits/hour). `null` when < 2.      |
 *
 * @see {@link computeHistorySummary}
 */

import type { UsageHistorySnapshot } from './usage-history-types'

/**
 * Derived summary metrics computed from a set of usage history snapshots.
 *
 * All rate fields are `null` when fewer than two snapshots are present (a
 * burn-rate calculation requires at least one interval).
 */
export type HistorySummary = {
  /**
   * Sum of positive per-interval `used` deltas across the window.
   * Negative deltas (quota resets) are excluded so that the metric
   * represents net consumption rather than quota lifecycle churn.
   */
  deltaUsed: number;
  /**
   * Overall burn rate in credits per hour across the full window.
   * Computed as `deltaUsed / windowHours`.
   * `null` when fewer than two snapshots are provided.
   */
  creditsPerHour: number | null;
  /**
   * Overall burn rate in credits per calendar day.
   * Computed as `creditsPerHour × 24`.
   * `null` when fewer than two snapshots are provided.
   */
  creditsPerDay: number | null;
  /**
   * Mean of per-interval burn rates (credits/hour) across all consecutive
   * snapshot pairs where `usedDelta > 0` and `intervalMs > 0`.
   * This can differ from `creditsPerHour` when consumption is bursty or
   * when the overall window includes idle periods.
   * `null` when no qualifying intervals exist.
   */
  averageBurnRate: number | null;
  /** Number of snapshots used to produce this summary. */
  snapshotCount: number;
  /**
   * ISO 8601 timestamp of the oldest snapshot in the window.
   * `null` when the snapshot list is empty.
   */
  oldestAt: string | null;
  /**
   * ISO 8601 timestamp of the newest snapshot in the window.
   * `null` when the snapshot list is empty.
   */
  newestAt: string | null;
}

/**
 * Computes derived burn-rate metrics from a list of usage history snapshots.
 *
 * The `snapshots` array is expected to be in **newest-first** order as
 * returned by {@link getHistory}. The function reverses internally to process
 * intervals chronologically.
 *
 * @param snapshots - Array of snapshots (newest first). May be empty.
 * @returns A {@link HistorySummary} with all derived metrics.
 */
export function computeHistorySummary(snapshots: UsageHistorySnapshot[]): HistorySummary {
  const n = snapshots.length

  if (n === 0) {
    return {
      deltaUsed: 0,
      creditsPerHour: null,
      creditsPerDay: null,
      averageBurnRate: null,
      snapshotCount: 0,
      oldestAt: null,
      newestAt: null,
    }
  }

  // snapshots are newest-first; index 0 is newest, index n-1 is oldest
  const newestAt = snapshots[0].capturedAt
  const oldestAt = snapshots[n - 1].capturedAt

  if (n === 1) {
    return {
      deltaUsed: 0,
      creditsPerHour: null,
      creditsPerDay: null,
      averageBurnRate: null,
      snapshotCount: 1,
      oldestAt,
      newestAt,
    }
  }

  // Process intervals chronologically (oldest → newest)
  let deltaUsed = 0
  const intervalRates: number[] = []

  for (let i = n - 1; i > 0; i--) {
    const before = snapshots[i]    // older
    const after = snapshots[i - 1] // newer

    const usedDelta = after.used - before.used
    const intervalMs =
      new Date(after.capturedAt).getTime() - new Date(before.capturedAt).getTime()

    // Only accumulate positive deltas; negative deltas indicate a quota reset
    // (new billing period) and should not be counted as consumption.
    if (usedDelta > 0) {
      deltaUsed += usedDelta

      if (intervalMs > 0) {
        const intervalHours = intervalMs / 3_600_000
        intervalRates.push(usedDelta / intervalHours)
      }
    }
  }

  const totalMs =
    new Date(newestAt).getTime() - new Date(oldestAt).getTime()
  const totalHours = totalMs / 3_600_000

  const creditsPerHour = totalHours > 0 ? deltaUsed / totalHours : null
  const creditsPerDay = creditsPerHour !== null ? creditsPerHour * 24 : null

  const averageBurnRate =
    intervalRates.length > 0
      ? intervalRates.reduce((sum, r) => sum + r, 0) / intervalRates.length
      : null

  return {
    deltaUsed,
    creditsPerHour,
    creditsPerDay,
    averageBurnRate,
    snapshotCount: n,
    oldestAt,
    newestAt,
  }
}
