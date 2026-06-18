/**
 * @file Types for the usage history and ledger subsystem.
 *
 * The usage history subsystem persists timestamped snapshots of normalised
 * Copilot quota data to Netlify Blobs. Snapshots are provider-independent:
 * they are derived from the `Usage` shape returned by any provider and
 * stored without credential data or raw provider payloads.
 *
 * This module contains TypeScript type definitions only. It has no runtime
 * behaviour, no I/O, and no validation logic.
 *
 * @see {@link appendSnapshot} for the write entry point
 * @see {@link getHistory} for history retrieval
 * @see {@link calculateDelta} for computing deltas between snapshots
 */

import type { BillingPhase } from './copilot'

/** Schema version for usage history records in this release. */
export type UsageHistorySchemaVersion = '1'

/**
 * A single point-in-time snapshot of normalised Copilot quota state.
 *
 * Derived from the `Usage` shape returned by any provider. Contains no
 * credential data, no raw provider payloads, and no `billingEntity` to
 * avoid storing GitHub logins alongside usage data.
 */
export type UsageHistorySnapshot = {
  /** ISO 8601 timestamp when this snapshot was captured. */
  capturedAt: string;
  /** Number of requests/credits consumed in the current billing period. */
  used: number;
  /** Total quota allocated for the current billing period. */
  quota: number;
  /** `quota - used`, clamped to ≥ 0. */
  remaining: number;
  /** Where in the credit/budget lifecycle this snapshot falls. */
  billingPhase: BillingPhase;
  /**
   * Budget-backed credits consumed beyond the included quota.
   * Present when the `Usage` record includes an `overageCount` value.
   */
  overageCount?: number;
  /**
   * Derived overage credits estimated from a negative `rawRemaining` value
   * during the settlement-lag window. Present when `derivedOverageCredits`
   * is set on the source `Usage` record.
   */
  derivedOverageCredits?: number;
}

/**
 * A persisted usage history record stored in Netlify Blobs.
 *
 * Wraps a {@link UsageHistorySnapshot} with schema version metadata and the
 * numeric GitHub user ID that owns the record.
 */
export type UsageHistoryEntry = {
  /** Schema version for migration support. Always `"1"`. */
  historyVersion: UsageHistorySchemaVersion;
  /** Numeric GitHub user ID of the user who owns this entry. */
  userId: number;
  /** The usage snapshot captured at `snapshot.capturedAt`. */
  snapshot: UsageHistorySnapshot;
}

/**
 * Daily counter stored alongside the history entries for each user.
 *
 * Used to enforce the per-user per-day write cap configured via
 * `USAGE_HISTORY_MAX_PER_DAY`.
 */
export type HistoryDailyIndex = {
  /** Number of snapshots recorded on `date`. */
  count: number;
  /** UTC date string (`YYYY-MM-DD`) this index covers. */
  date: string;
}

/**
 * The computed difference between two {@link UsageHistorySnapshot} records.
 *
 * `usedDelta` is positive when more credits were consumed between snapshots.
 * A negative `usedDelta` indicates a quota reset occurred between the two
 * snapshots (new billing period started).
 */
export type UsageHistoryDelta = {
  /** The earlier snapshot. */
  from: UsageHistorySnapshot;
  /** The later snapshot. */
  to: UsageHistorySnapshot;
  /** `to.used - from.used`. Positive = more consumed; negative = quota reset. */
  usedDelta: number;
  /** `to.remaining - from.remaining`. Positive = more remaining. */
  remainingDelta: number;
  /**
   * `to.overageCount - from.overageCount`.
   * Present when at least one snapshot has `overageCount` defined.
   */
  overageCountDelta?: number;
  /**
   * `to.derivedOverageCredits - from.derivedOverageCredits`.
   * Present when at least one snapshot has `derivedOverageCredits` defined.
   */
  derivedOverageCreditsDelta?: number;
  /** Milliseconds elapsed between `from.capturedAt` and `to.capturedAt`. May be negative if snapshots are passed in reverse order. */
  durationMs: number;
}

/**
 * Runtime configuration for the usage history subsystem.
 *
 * Parsed from environment variables by the caller (see README for variable names).
 */
export type UsageHistoryConfig = {
  /** Whether snapshot persistence is enabled (default: `false`). */
  enabled: boolean;
  /**
   * Number of calendar days to retain history entries.
   * Entries older than this are deleted lazily when a new snapshot is
   * appended for the same user (default: 90).
   */
  retentionDays: number;
  /**
   * Maximum number of snapshots stored per user per UTC day.
   * Further writes on the same day are silently dropped (default: 48).
   */
  maxPerDay: number;
}

/**
 * Options for {@link getHistory} history retrieval.
 */
export type GetHistoryOptions = {
  /**
   * Earliest UTC date to include (`YYYY-MM-DD`, inclusive).
   * When omitted, no lower bound is applied.
   */
  fromDate?: string;
  /**
   * Latest UTC date to include (`YYYY-MM-DD`, inclusive).
   * When omitted, no upper bound is applied.
   */
  toDate?: string;
  /**
   * Maximum number of snapshots to return.
   * Results are ordered by `capturedAt` descending (most recent first).
   * When omitted, all matching snapshots are returned.
   */
  limit?: number;
}
