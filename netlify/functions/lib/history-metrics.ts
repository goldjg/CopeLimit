/**
 * @file Pure functions for computing derived metrics from usage history snapshots.
 *
 * All functions in this module are stateless and have no I/O. They operate
 * only on snapshot values already returned by {@link getHistory}.
 *
 * ## Period isolation
 *
 * {@link computeHistorySummary} treats a calendar-month crossing as a billing
 * period boundary. When the snapshot array spans two or more calendar months,
 * only snapshots from the **most recent** calendar month are used to compute
 * burn-rate metrics. This ensures that after a monthly quota reset, the
 * current-period burn rate starts from zero rather than inheriting the
 * previous month's consumption.
 *
 * Intra-month usage drops (e.g. API noise or mid-month resets) are treated as
 * ordinary negative deltas and are excluded from `deltaUsed` but do not
 * trigger period isolation.
 *
 * ## Derived metrics
 *
 * | Metric           | Description                                                            |
 * |------------------|------------------------------------------------------------------------|
 * | `deltaUsed`      | Sum of positive per-interval `used` deltas (current period only).     |
 * | `creditsPerHour` | `deltaUsed` / total span in hours. `null` when < 2 snapshots.         |
 * | `creditsPerDay`  | `creditsPerHour × 24`. `null` when < 2 snapshots.                     |
 * | `averageBurnRate`| Mean of per-interval burn rates (credits/hour). `null` when < 2.      |
 *
 * @see {@link computeHistorySummary}
 * @see {@link computeMonthlyPeriodSummaries}
 */

import { creditsToUsd } from './cost-metrics'

// ---------------------------------------------------------------------------
// Minimal input type
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot shape required by history-metrics functions.
 * {@link UsageHistorySnapshot} satisfies this type structurally.
 */
export type SnapshotForPeriod = {
  capturedAt: string;
  used: number;
}

// ---------------------------------------------------------------------------
// HistorySummary output type
// ---------------------------------------------------------------------------

/**
 * Derived summary metrics computed from a set of usage history snapshots.
 *
 * All rate fields are `null` when fewer than two snapshots are present (a
 * burn-rate calculation requires at least one interval).
 */
export type HistorySummary = {
  /**
   * Sum of positive per-interval `used` deltas across the current period.
   * Negative deltas (quota resets or API noise) are excluded.
   */
  deltaUsed: number;
  /**
   * Overall burn rate in credits per hour across the current period.
   * Computed as `deltaUsed / windowHours`.
   * `null` when fewer than two snapshots are in the current period.
   */
  creditsPerHour: number | null;
  /**
   * Overall burn rate in credits per calendar day.
   * Computed as `creditsPerHour × 24`.
   * `null` when fewer than two snapshots are in the current period.
   */
  creditsPerDay: number | null;
  /**
   * Mean of per-interval burn rates (credits/hour) across all consecutive
   * snapshot pairs where `usedDelta > 0` and `intervalMs > 0`.
   * This can differ from `creditsPerHour` when consumption is bursty or
   * when the current period includes idle intervals.
   * `null` when no qualifying intervals exist.
   */
  averageBurnRate: number | null;
  /** Overall burn rate in estimated USD per hour (`creditsPerHour × 0.01`). */
  burnRateCostPerHourUsd: number | null;
  /** Mean per-interval burn rate in estimated USD per hour (`averageBurnRate × 0.01`). */
  averageBurnRateCostPerHourUsd: number | null;
  /** Overall burn rate in estimated USD per day (`creditsPerDay × 0.01`). */
  burnCostPerDayUsd: number | null;
  /** Number of snapshots in the current period used to produce this summary. */
  snapshotCount: number;
  /**
   * ISO 8601 timestamp of the oldest snapshot in the current period.
   * `null` when the snapshot list is empty.
   */
  oldestAt: string | null;
  /**
   * ISO 8601 timestamp of the newest snapshot in the current period.
   * `null` when the snapshot list is empty.
   */
  newestAt: string | null;
}

// ---------------------------------------------------------------------------
// Period aggregation types
// ---------------------------------------------------------------------------

/** Summary for a single calendar month. */
export type MonthPeriodSummary = {
  /** `"YYYY-MM"` identifier for this month. */
  month: string;
  summary: HistorySummary;
}

/** Summary for a single calendar quarter derived from monthly summaries. */
export type QuarterPeriodSummary = {
  /** `"YYYY-Q1"` through `"YYYY-Q4"` identifier. */
  quarter: string;
  months: MonthPeriodSummary[];
  /** Sum of `deltaUsed` across all months in this quarter. */
  totalConsumed: number;
  /** Sum of `snapshotCount` across all months in this quarter. */
  snapshotCount: number;
}

/** Summary for a single calendar year derived from monthly summaries. */
export type YearPeriodSummary = {
  /** Four-digit year string, e.g. `"2026"`. */
  year: string;
  months: MonthPeriodSummary[];
  /** Sum of `deltaUsed` across all months in this year. */
  totalConsumed: number;
  /** Sum of `snapshotCount` across all months in this year. */
  snapshotCount: number;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Returns the `"YYYY-MM"` prefix of an ISO 8601 timestamp. */
function getYearMonth(capturedAt: string): string {
  return capturedAt.slice(0, 7)
}

/** Returns the `"YYYY-Q1"` quarter label for a `"YYYY-MM"` month string. */
function getQuarterLabel(month: string): string {
  const q = Math.ceil(parseInt(month.slice(5, 7), 10) / 3)
  return `${month.slice(0, 4)}-Q${q}`
}

// ---------------------------------------------------------------------------
// computeHistorySummary
// ---------------------------------------------------------------------------

/**
 * Computes derived burn-rate metrics from a list of usage history snapshots,
 * restricted to the **most recent calendar-month period**.
 *
 * When the snapshot array spans two or more calendar months, only snapshots
 * from the newest calendar month are used. This ensures that a monthly quota
 * reset produces a clean period boundary: after reset the current burn rate
 * starts from zero (or remains `null` until two same-month snapshots exist).
 *
 * The `snapshots` array is expected to be in **newest-first** order as
 * returned by {@link getHistory}. The function processes intervals
 * chronologically within the current-period slice.
 *
 * @param snapshots - Array of snapshots (newest first). May be empty.
 * @returns A {@link HistorySummary} with all derived metrics.
 */
export function computeHistorySummary(snapshots: SnapshotForPeriod[]): HistorySummary {
  const n = snapshots.length

  if (n === 0) {
    return {
      deltaUsed: 0,
      creditsPerHour: null,
      creditsPerDay: null,
      averageBurnRate: null,
      burnRateCostPerHourUsd: null,
      averageBurnRateCostPerHourUsd: null,
      burnCostPerDayUsd: null,
      snapshotCount: 0,
      oldestAt: null,
      newestAt: null,
    }
  }

  // Find the most recent month-boundary crossing (newest-first order).
  // When snapshots[i] and snapshots[i+1] are in different months, all of
  // snapshots[0..i] belong to the current period.
  let currentPeriodEnd = n // exclusive upper bound; default = use all
  for (let i = 0; i < n - 1; i++) {
    if (getYearMonth(snapshots[i].capturedAt) !== getYearMonth(snapshots[i + 1].capturedAt)) {
      currentPeriodEnd = i + 1
      break
    }
  }

  const period = snapshots.slice(0, currentPeriodEnd)
  const m = period.length

  // snapshots are newest-first; index 0 is newest, index m-1 is oldest
  const newestAt = period[0].capturedAt
  const oldestAt = period[m - 1].capturedAt

  if (m === 1) {
    return {
      deltaUsed: 0,
      creditsPerHour: null,
      creditsPerDay: null,
      averageBurnRate: null,
      burnRateCostPerHourUsd: null,
      averageBurnRateCostPerHourUsd: null,
      burnCostPerDayUsd: null,
      snapshotCount: 1,
      oldestAt,
      newestAt,
    }
  }

  // Process intervals chronologically (oldest → newest within current period)
  let deltaUsed = 0
  const intervalRates: number[] = []

  for (let i = m - 1; i > 0; i--) {
    const before = period[i]    // older
    const after = period[i - 1] // newer

    const usedDelta = after.used - before.used
    const intervalMs =
      new Date(after.capturedAt).getTime() - new Date(before.capturedAt).getTime()

    // Only accumulate positive deltas; negative deltas are API noise or
    // intra-month resets and must not corrupt the burn-rate calculation.
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
  const burnRateCostPerHourUsd = creditsPerHour === null ? null : creditsToUsd(creditsPerHour)
  const averageBurnRateCostPerHourUsd =
    averageBurnRate === null ? null : creditsToUsd(averageBurnRate)
  const burnCostPerDayUsd = creditsPerDay === null ? null : creditsToUsd(creditsPerDay)

  return {
    deltaUsed,
    creditsPerHour,
    creditsPerDay,
    averageBurnRate,
    burnRateCostPerHourUsd,
    averageBurnRateCostPerHourUsd,
    burnCostPerDayUsd,
    snapshotCount: m,
    oldestAt,
    newestAt,
  }
}

// ---------------------------------------------------------------------------
// Period aggregation functions
// ---------------------------------------------------------------------------

/**
 * Groups snapshots by calendar month and computes a {@link HistorySummary}
 * for each month. Returns summaries in **newest-month-first** order.
 *
 * Because each group contains only same-month snapshots, no month-boundary
 * detection fires inside `computeHistorySummary` — the full month is used.
 *
 * @param snapshots - Array of snapshots (newest first). May be empty.
 */
export function computeMonthlyPeriodSummaries(
  snapshots: SnapshotForPeriod[],
): MonthPeriodSummary[] {
  // Group snapshots by "YYYY-MM", preserving newest-first order within each group.
  const groups = new Map<string, SnapshotForPeriod[]>()
  for (const snap of snapshots) {
    const month = getYearMonth(snap.capturedAt)
    const group = groups.get(month)
    if (group) {
      group.push(snap)
    } else {
      groups.set(month, [snap])
    }
  }

  // Sort months descending (newest first)
  const months = Array.from(groups.keys()).sort().reverse()
  return months.map(month => ({
    month,
    summary: computeHistorySummary(groups.get(month)!),
  }))
}

/**
 * Aggregates monthly summaries into quarterly totals.
 * Returns summaries in **newest-quarter-first** order.
 *
 * @param monthly - Monthly summaries (newest first), e.g. from {@link computeMonthlyPeriodSummaries}.
 */
export function computeQuarterlyPeriodSummaries(
  monthly: MonthPeriodSummary[],
): QuarterPeriodSummary[] {
  const groups = new Map<string, MonthPeriodSummary[]>()
  for (const m of monthly) {
    const q = getQuarterLabel(m.month)
    const group = groups.get(q)
    if (group) {
      group.push(m)
    } else {
      groups.set(q, [m])
    }
  }

  const quarters = Array.from(groups.keys()).sort().reverse()
  return quarters.map(quarter => {
    const months = groups.get(quarter)!
    return {
      quarter,
      months,
      totalConsumed: months.reduce((sum, m) => sum + m.summary.deltaUsed, 0),
      snapshotCount: months.reduce((sum, m) => sum + m.summary.snapshotCount, 0),
    }
  })
}

/**
 * Aggregates monthly summaries into yearly totals.
 * Returns summaries in **newest-year-first** order.
 *
 * @param monthly - Monthly summaries (newest first), e.g. from {@link computeMonthlyPeriodSummaries}.
 */
export function computeYearlyPeriodSummaries(
  monthly: MonthPeriodSummary[],
): YearPeriodSummary[] {
  const groups = new Map<string, MonthPeriodSummary[]>()
  for (const m of monthly) {
    const year = m.month.slice(0, 4)
    const group = groups.get(year)
    if (group) {
      group.push(m)
    } else {
      groups.set(year, [m])
    }
  }

  const years = Array.from(groups.keys()).sort().reverse()
  return years.map(year => {
    const months = groups.get(year)!
    return {
      year,
      months,
      totalConsumed: months.reduce((sum, m) => sum + m.summary.deltaUsed, 0),
      snapshotCount: months.reduce((sum, m) => sum + m.summary.snapshotCount, 0),
    }
  })
}
