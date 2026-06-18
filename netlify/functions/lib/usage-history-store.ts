/**
 * @file Netlify Blobs storage layer for usage history snapshots.
 *
 * ## Blob store layout (`usage-history`)
 *
 * ```
 * <userId>/<YYYY-MM-DD>/<ISO-timestamp>.json   — individual snapshot entry
 * <userId>/<YYYY-MM-DD>/_index.json            — daily counter
 * ```
 *
 * History is partitioned by user and UTC date for efficient enumeration and
 * retention-based cleanup. There is no provider dimension in the key because
 * history is provider-independent.
 *
 * ## Retention and cleanup
 *
 * Old entries are deleted lazily: whenever a new snapshot is about to be
 * persisted, {@link runLazyHistoryCleanup} lists all blobs for the user
 * prefix and deletes any whose date folder is older than `retentionDays`.
 * This avoids a separate scheduled cleanup job.
 *
 * ## Daily cap
 *
 * The daily index (`_index.json`) tracks how many snapshots have been stored
 * for a given user/day. If the count reaches `maxPerDay` the write is silently
 * dropped to prevent runaway storage growth.
 *
 * ## Tier classification
 *
 * All records in `usage-history` are **Tier 2** (sanitized append-only
 * telemetry). Application-level encryption is not required. Records contain
 * only normalised, non-credential usage data (no `billingEntity`, no tokens,
 * no raw provider payloads).
 */

import { getBlobStore } from './blob-store'
import type {
  GetHistoryOptions,
  HistoryDailyIndex,
  UsageHistoryConfig,
  UsageHistoryDelta,
  UsageHistoryEntry,
  UsageHistorySnapshot,
} from './usage-history-types'

const HISTORY_STORE = 'usage-history'
const HISTORY_VERSION = '1' as const

/** Maximum characters retained from an error message in structured log output. */
const MAX_ERROR_SUMMARY_LENGTH = 200

/** Patterns that suggest an error message may contain sensitive data. */
const SENSITIVE_IN_MESSAGE_PATTERNS = [
  /token/i, /auth/i, /key/i, /secret/i, /bearer/i, /credential/i, /password/i, /cookie/i,
]

/** Per-error-code failure counts used to suppress repeated log entries. */
const historyFailureCounts = new Map<string, number>()

/** Number of warn-level log entries per error code before switching to suppressed mode. */
const SUPPRESS_AFTER = 5

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getHistoryStore() {
  return getBlobStore(HISTORY_STORE)
}

function isValidUserId(userId: number | undefined): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId) && Number.isInteger(userId) && userId > 0
}

function buildDateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

function buildSafeErrorSummary(error: unknown): { isErrorInstance: boolean; errorClass?: string; errorSummary?: string; messageSuppressed?: boolean } {
  if (!(error instanceof Error)) return { isErrorInstance: false }
  const errorClass = error.constructor?.name || 'Error'
  const msg = error.message
  if (!msg) return { isErrorInstance: true, errorClass }
  if (SENSITIVE_IN_MESSAGE_PATTERNS.some(p => p.test(msg))) {
    return { isErrorInstance: true, errorClass, messageSuppressed: true }
  }
  const errorSummary = msg.length > MAX_ERROR_SUMMARY_LENGTH
    ? `${msg.slice(0, MAX_ERROR_SUMMARY_LENGTH)}\u2026`
    : msg
  return { isErrorInstance: true, errorClass, errorSummary }
}

function logHistoryFailure(userId: number, errorCode: string, operation: string, error: unknown): void {
  const count = (historyFailureCounts.get(errorCode) ?? 0) + 1
  historyFailureCounts.set(errorCode, count)

  if (count > SUPPRESS_AFTER) {
    if (count === SUPPRESS_AFTER + 1) {
      console.info('[usage-history] Repeated history failures suppressed', {
        errorCode,
        storeName: HISTORY_STORE,
      })
    }
    return
  }

  const diagnostics = buildSafeErrorSummary(error)
  console.warn('[usage-history] Failed to persist usage snapshot', {
    userId,
    errorCode,
    operation,
    storeName: HISTORY_STORE,
    ...diagnostics,
  })
}

function classifyBlobError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const msg = error.message
  if (/\b403\b/.test(msg)) return 'blob_forbidden'
  if (/\b401\b/.test(msg) || /unauthorized/i.test(msg)) return 'blob_unavailable'
  return 'unknown'
}

function getDateFolderFromKey(userId: number, key: string): string | null {
  const prefix = `${userId}/`
  if (!key.startsWith(prefix)) return null
  const remainder = key.slice(prefix.length)
  const slash = remainder.indexOf('/')
  if (slash === -1) return null
  const dateFolder = remainder.slice(0, slash)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFolder)) return null
  return dateFolder
}

// ---------------------------------------------------------------------------
// Exported key helpers (also used in tests)
// ---------------------------------------------------------------------------

/**
 * Builds the Blobs key for a single history entry.
 *
 * Format: `<userId>/<YYYY-MM-DD>/<isoTimestamp>.json`
 *
 * @param userId       - Numeric GitHub user ID.
 * @param isoTimestamp - ISO 8601 timestamp of the snapshot.
 * @returns The Blobs key string.
 */
export function buildHistoryKey(userId: number, isoTimestamp: string): string {
  return `${userId}/${buildDateFromIso(isoTimestamp)}/${isoTimestamp}.json`
}

/**
 * Builds the Blobs key for a daily history index record.
 *
 * Format: `<userId>/<YYYY-MM-DD>/_index.json`
 *
 * @param userId  - Numeric GitHub user ID.
 * @param dateUtc - UTC date string (`YYYY-MM-DD`).
 * @returns The Blobs key string.
 */
export function buildHistoryIndexKey(userId: number, dateUtc: string): string {
  return `${userId}/${dateUtc}/_index.json`
}

/**
 * Returns `true` when the given `dateFolder` (`YYYY-MM-DD`) is older than the
 * retention cutoff calculated from `retentionDays` before `now`.
 *
 * @param dateFolder    - UTC date string in `YYYY-MM-DD` format.
 * @param retentionDays - Number of calendar days to retain.
 * @param now           - Reference date (defaults to current wall-clock time).
 * @returns `true` if the date is before the retention cutoff.
 */
export function isDateExpired(dateFolder: string, retentionDays: number, now = new Date()): boolean {
  const cutoff = new Date(now)
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  return dateFolder < cutoffDate
}

// ---------------------------------------------------------------------------
// Daily index helpers
// ---------------------------------------------------------------------------

async function readDailyIndex(key: string, date: string, userId: number): Promise<HistoryDailyIndex> {
  const store = getHistoryStore()

  let readError: unknown = null
  try {
    const index = await store.get(key, { type: 'json' }) as HistoryDailyIndex | null

    if (
      !index ||
      typeof index.count !== 'number' ||
      !Number.isFinite(index.count) ||
      !Number.isInteger(index.count) ||
      index.count < 0 ||
      index.date !== date
    ) {
      return { count: 0, date }
    }

    return index
  } catch (err) {
    readError = err
  }

  // Index read failed — attempt to rebuild from listed captures
  const datePrefix = `${userId}/${date}/`
  try {
    const result = await store.list({ prefix: datePrefix })
    const rebuiltCount = result.blobs.filter(b => !b.key.endsWith('_index.json')).length
    const recovered: HistoryDailyIndex = { count: rebuiltCount, date }

    // Best-effort write of recovered index
    try {
      await store.setJSON(key, recovered)
    } catch {
      // Non-blocking: loss of the recovered index is acceptable
    }

    console.warn('[usage-history] Index read failed; count rebuilt from listed entries', {
      event: 'index_recovered',
      userId,
      date,
      storeName: HISTORY_STORE,
      rebuiltCount,
      ...buildSafeErrorSummary(readError),
    })

    return recovered
  } catch {
    console.warn('[usage-history] Index read and list both failed; resetting count to 0', {
      event: 'index_reset_fallback',
      userId,
      date,
      storeName: HISTORY_STORE,
      ...buildSafeErrorSummary(readError),
    })
    return { count: 0, date }
  }
}

async function writeDailyIndex(key: string, index: HistoryDailyIndex): Promise<void> {
  const store = getHistoryStore()
  await store.setJSON(key, index)
}

// ---------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------

async function runLazyHistoryCleanup(userId: number, retentionDays: number): Promise<void> {
  const store = getHistoryStore()
  const prefix = `${userId}/`

  let blobs: Array<{ key: string }>
  try {
    const result = await store.list({ prefix })
    blobs = result.blobs
  } catch (error) {
    logHistoryFailure(userId, classifyBlobError(error), 'listBlobs', error)
    return
  }

  const keysToDelete = blobs
    .map(b => b.key)
    .filter(key => {
      const dateFolder = getDateFolderFromKey(userId, key)
      if (!dateFolder) return false
      return isDateExpired(dateFolder, retentionDays)
    })

  const deleteResults = await Promise.allSettled(keysToDelete.map(key => store.delete(key)))
  for (const result of deleteResults) {
    if (result.status === 'rejected') {
      logHistoryFailure(userId, classifyBlobError(result.reason), 'deleteBlob', result.reason)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Appends a timestamped usage snapshot to the history ledger for the given user.
 *
 * This function is **fire-and-forget**: failures are logged but never rethrown
 * so that history persistence never blocks the user-facing usage response.
 *
 * Guards applied before persisting:
 * - `config.enabled` must be `true`.
 * - `userId` must be a positive integer.
 * - The daily snapshot count for the user must not have reached `config.maxPerDay`.
 *
 * Lazy retention cleanup is run before each write: entries older than
 * `config.retentionDays` are deleted.
 *
 * @param userId   - Numeric GitHub user ID.
 * @param snapshot - The snapshot to persist. `capturedAt` must be an ISO 8601 timestamp.
 * @param config   - History subsystem configuration.
 */
export async function appendSnapshot(
  userId: number,
  snapshot: UsageHistorySnapshot,
  config: UsageHistoryConfig,
): Promise<void> {
  if (!config.enabled) return
  if (!isValidUserId(userId)) return

  const dateUtc = buildDateFromIso(snapshot.capturedAt)
  const indexKey = buildHistoryIndexKey(userId, dateUtc)
  const dailyIndex = await readDailyIndex(indexKey, dateUtc, userId)

  if (dailyIndex.count >= config.maxPerDay) return

  await runLazyHistoryCleanup(userId, config.retentionDays)

  const entry: UsageHistoryEntry = {
    historyVersion: HISTORY_VERSION,
    userId,
    snapshot,
  }

  const store = getHistoryStore()
  const entryKey = buildHistoryKey(userId, snapshot.capturedAt)

  try {
    await store.setJSON(entryKey, entry)
  } catch (error) {
    logHistoryFailure(userId, classifyBlobError(error), 'entryWrite', error)
    return
  }

  try {
    await writeDailyIndex(indexKey, { date: dateUtc, count: dailyIndex.count + 1 })
  } catch (error) {
    logHistoryFailure(userId, classifyBlobError(error), 'indexWrite', error)
  }
}

/**
 * Retrieves usage history snapshots for a user, ordered by `capturedAt`
 * descending (most recent first).
 *
 * Entries that cannot be read or parsed are silently skipped so that a
 * single corrupt record does not prevent the remainder from being returned.
 *
 * @param userId  - Numeric GitHub user ID.
 * @param options - Optional date range and result limit.
 * @returns An array of {@link UsageHistorySnapshot} objects. Returns an empty
 *   array when no history exists or `userId` is invalid.
 */
export async function getHistory(
  userId: number,
  options?: GetHistoryOptions,
): Promise<UsageHistorySnapshot[]> {
  if (!isValidUserId(userId)) return []

  const store = getHistoryStore()
  const prefix = `${userId}/`

  let blobs: Array<{ key: string }>
  try {
    const result = await store.list({ prefix })
    blobs = result.blobs
  } catch (error) {
    logHistoryFailure(userId, classifyBlobError(error), 'listBlobs', error)
    return []
  }

  const entryKeys = blobs
    .map(b => b.key)
    .filter(key => {
      if (key.endsWith('_index.json')) return false
      if (!options?.fromDate && !options?.toDate) return true
      const dateFolder = getDateFolderFromKey(userId, key)
      if (!dateFolder) return false
      if (options.fromDate && dateFolder < options.fromDate) return false
      if (options.toDate && dateFolder > options.toDate) return false
      return true
    })

  const entryResults = await Promise.allSettled(
    entryKeys.map(key => store.get(key, { type: 'json' }) as Promise<UsageHistoryEntry | null>)
  )

  const snapshots: UsageHistorySnapshot[] = []
  for (const result of entryResults) {
    if (result.status === 'rejected') continue
    const entry = result.value
    if (!entry || typeof entry.snapshot !== 'object' || entry.snapshot === null) continue
    snapshots.push(entry.snapshot)
  }

  // Sort descending by capturedAt (most recent first)
  snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))

  if (typeof options?.limit === 'number' && options.limit >= 0) {
    return snapshots.slice(0, options.limit)
  }

  return snapshots
}

/**
 * Computes the difference between two {@link UsageHistorySnapshot} records.
 *
 * This is a pure function with no I/O. The caller is responsible for passing
 * snapshots in the desired order. Passing `after` before `before` will yield a
 * negative `durationMs` and inverted deltas — this is intentional and can be
 * used to detect regressions.
 *
 * @param before - The earlier snapshot (lower `capturedAt`).
 * @param after  - The later snapshot (higher `capturedAt`).
 * @returns A {@link UsageHistoryDelta} describing the change between the two snapshots.
 */
export function calculateDelta(
  before: UsageHistorySnapshot,
  after: UsageHistorySnapshot,
): UsageHistoryDelta {
  const fromMs = new Date(before.capturedAt).getTime()
  const toMs = new Date(after.capturedAt).getTime()

  const usedDelta = after.used - before.used
  const remainingDelta = after.remaining - before.remaining

  const hasOverageCount = before.overageCount !== undefined || after.overageCount !== undefined
  const overageCountDelta = hasOverageCount
    ? (after.overageCount ?? 0) - (before.overageCount ?? 0)
    : undefined

  const hasDerivedOverage = before.derivedOverageCredits !== undefined || after.derivedOverageCredits !== undefined
  const derivedOverageCreditsDelta = hasDerivedOverage
    ? (after.derivedOverageCredits ?? 0) - (before.derivedOverageCredits ?? 0)
    : undefined

  return {
    from: before,
    to: after,
    usedDelta,
    remainingDelta,
    overageCountDelta,
    derivedOverageCreditsDelta,
    durationMs: toMs - fromMs,
  }
}

/** @internal Reset module-level state between tests. Do not use in production code. */
export function _resetHistoryStoreForTesting(): void {
  historyFailureCounts.clear()
}
