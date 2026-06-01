/**
 * @file Netlify Blobs storage layer for provider response captures.
 *
 * ## Blob store layout (`provider-captures`)
 *
 * ```
 * <provider>/<userId>/<YYYY-MM-DD>/<ISO-timestamp>.json   — individual capture
 * <provider>/<userId>/<YYYY-MM-DD>/_index.json            — daily counter
 * ```
 *
 * Captures are partitioned by provider, user, and UTC date for efficient
 * enumeration and retention-based cleanup.
 *
 * ## Retention and cleanup
 *
 * Old captures are deleted lazily: whenever a new capture is about to be
 * persisted, {@link runLazyCleanup} lists all blobs for the
 * provider/user prefix and deletes any whose date folder is older than
 * `retentionDays`. This avoids a separate scheduled cleanup job.
 *
 * ## Daily cap
 *
 * The daily index (`_index.json`) tracks how many captures have already been
 * stored for a given provider/user/day. If the count reaches `maxPerDay` the
 * capture is silently dropped to prevent runaway storage growth.
 */
import { getStore } from '@netlify/blobs'
import type { JsonObject, Usage } from './copilot'
import { sanitizeProviderPayload } from './capture-sanitize'
import type { CaptureConfig, CaptureIndex, ProviderCapture } from './capture-types'

const CAPTURE_STORE = 'provider-captures'
const CAPTURE_VERSION = '1'
const SANITIZER_VERSION = '1'
const SKIPPED_PROVIDERS = new Set(['mock', 'unsupported', 'github'])
const SAFE_PROVIDER_PATTERN = /^[a-z0-9_-]+$/i

/**
 * Number of warn-level log entries per error code before switching to suppressed mode.
 * Five occurrences is enough to surface the issue in log monitoring without drowning
 * repeated-request traffic in identical warnings.
 */
const SUPPRESS_AFTER = 5

/** Maximum characters retained from an error message in structured log output. */
const MAX_ERROR_SUMMARY_LENGTH = 200

/** Patterns that suggest an error message may contain sensitive data. */
const SENSITIVE_IN_MESSAGE_PATTERNS = [
  /token/i, /auth/i, /key/i, /secret/i, /bearer/i, /credential/i, /password/i, /cookie/i
]

/**
 * Patterns that identify specific Netlify Blobs HTTP failure codes in error messages.
 * Netlify Blobs surfaces status codes in messages of the form:
 *   "Netlify Blobs has generated an internal error (<N> status code)"
 * These patterns are intentionally narrow to avoid false-positive classification.
 */
const BLOB_403_PATTERN = /\b403\b/
const BLOB_401_PATTERN = /\b401\b/
const BLOB_UNAUTHORIZED_PATTERN = /unauthorized/i

let captureStore: ReturnType<typeof getStore> | null = null

/** Per-error-code failure counts used to suppress repeated log entries. */
const captureFailureCounts = new Map<string, number>()

/**
 * Stable error codes for capture persistence failures.
 * Safe to log; never contains raw payload or credential data.
 */
export type CaptureErrorCode =
  | 'blob_forbidden'        // Netlify Blobs returned 403
  | 'blob_unavailable'      // Netlify Blobs returned 401 or is otherwise inaccessible
  | 'config_invalid'        // Environment misconfiguration detected before attempting I/O
  | 'index_read_failure'    // readIndex threw an unclassified error
  | 'capture_write_failure' // capture setJSON threw an unclassified error
  | 'index_write_failure'   // index setJSON threw an unclassified error
  | 'unknown'               // Unclassified error

/** @internal Tagged error that carries an operation label through `persistCapture`. */
class CaptureStageError extends Error {
  readonly operation: string
  constructor(operation: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'CaptureStageError'
    this.operation = operation
  }
}

function buildDateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

function assertSafeProvider(provider: string): void {
  if (!SAFE_PROVIDER_PATTERN.test(provider)) {
    throw new Error('Invalid provider key')
  }
}

function getCaptureStore() {
  if (captureStore) return captureStore

  const siteID = process.env.NETLIFY_SITE_ID
  const token = process.env.NETLIFY_AUTH_TOKEN

  if (siteID && token) {
    captureStore = getStore({ name: CAPTURE_STORE, siteID, token })
    return captureStore
  }

  captureStore = getStore({ name: CAPTURE_STORE })
  return captureStore
}

/**
 * Classifies a Blob I/O error into a stable {@link CaptureErrorCode}.
 * Inspects only the error message; never logs or exposes raw fields.
 */
function classifyBlobError(error: unknown): CaptureErrorCode {
  if (!(error instanceof Error)) return 'unknown'
  const msg = error.message
  if (BLOB_403_PATTERN.test(msg)) return 'blob_forbidden'
  if (BLOB_401_PATTERN.test(msg) || BLOB_UNAUTHORIZED_PATTERN.test(msg)) return 'blob_unavailable'
  return 'unknown'
}

/**
 * Returns a safe subset of an error message for diagnostic logging.
 * Returns `undefined` when the message may contain sensitive terms.
 */
function safeErrorSummary(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const msg = error.message
  if (!msg) return undefined
  if (SENSITIVE_IN_MESSAGE_PATTERNS.some(p => p.test(msg))) return undefined
  return msg.length > MAX_ERROR_SUMMARY_LENGTH ? `${msg.slice(0, MAX_ERROR_SUMMARY_LENGTH)}\u2026` : msg
}

/**
 * Logs a classified capture failure and suppresses repeated entries.
 *
 * Safe fields logged: `provider`, `userId`, `errorCode`, `operation`,
 * `storeName`, and optionally a sanitised `errorSummary`.
 * Raw payload, stack traces, and credential-adjacent terms are never logged.
 */
function logCaptureFailure(
  provider: string,
  userId: number,
  errorCode: CaptureErrorCode,
  operation: string,
  error: unknown
): void {
  const count = (captureFailureCounts.get(errorCode) ?? 0) + 1
  captureFailureCounts.set(errorCode, count)

  if (count > SUPPRESS_AFTER) {
    if (count === SUPPRESS_AFTER + 1) {
      console.info('[capture-store] Repeated capture failures suppressed', {
        errorCode,
        storeName: CAPTURE_STORE
      })
    }
    return
  }

  const fields: Record<string, unknown> = {
    provider,
    userId,
    errorCode,
    operation,
    storeName: CAPTURE_STORE
  }
  const summary = safeErrorSummary(error)
  if (summary !== undefined) fields.errorSummary = summary

  console.warn('[capture-store] Failed to persist provider capture', fields)
}

/**
 * Checks for known environment misconfigurations before attempting Blob I/O.
 * Returns a {@link CaptureErrorCode} if a problem is detected, otherwise `null`.
 */
function checkCaptureEnv(): CaptureErrorCode | null {
  const siteID = process.env.NETLIFY_SITE_ID
  const token = process.env.NETLIFY_AUTH_TOKEN
  // NETLIFY_AUTH_TOKEN set to an empty string is a misconfiguration: the
  // explicit-auth path would receive no credentials and the request will fail.
  if (siteID && token !== undefined && token.trim() === '') return 'config_invalid'
  return null
}

/**
 * Builds the Blobs key for a single capture record.
 *
 * Format: `<provider>/<userId>/<YYYY-MM-DD>/<isoTimestamp>.json`
 *
 * @param provider      - Provider identifier (must match `/^[a-z0-9_-]+$/i`).
 * @param userId        - Numeric GitHub user ID.
 * @param isoTimestamp  - ISO 8601 capture timestamp.
 * @returns The Blobs key string.
 * @throws If `provider` contains characters that could escape the key path.
 */
export function buildCaptureKey(provider: string, userId: number, isoTimestamp: string): string {
  assertSafeProvider(provider)
  return `${provider}/${userId}/${buildDateFromIso(isoTimestamp)}/${isoTimestamp}.json`
}

/**
 * Builds the Blobs key for a daily capture index record.
 *
 * Format: `<provider>/<userId>/<YYYY-MM-DD>/_index.json`
 *
 * @param provider  - Provider identifier.
 * @param userId    - Numeric GitHub user ID.
 * @param dateUtc   - UTC date string (`YYYY-MM-DD`).
 * @returns The Blobs key string.
 * @throws If `provider` contains path-unsafe characters.
 */
export function buildIndexKey(provider: string, userId: number, dateUtc: string): string {
  assertSafeProvider(provider)
  return `${provider}/${userId}/${dateUtc}/_index.json`
}

async function readIndex(key: string, date: string): Promise<CaptureIndex> {
  const store = getCaptureStore()
  const index = await store.get(key, { type: 'json' }) as CaptureIndex | null

  if (!index || typeof index.count !== 'number' || index.date !== date) {
    return { count: 0, date }
  }

  return index
}

async function writeIndex(key: string, index: CaptureIndex): Promise<void> {
  const store = getCaptureStore()
  await store.setJSON(key, index)
}

function getDateFolderFromKey(provider: string, userId: number, key: string): string | null {
  const prefix = `${provider}/${userId}/`
  if (!key.startsWith(prefix)) return null

  const remainder = key.slice(prefix.length)
  const slash = remainder.indexOf('/')
  if (slash === -1) return null

  const dateFolder = remainder.slice(0, slash)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFolder)) return null
  return dateFolder
}

/**
 * Returns `true` when the given `dateFolder` (`YYYY-MM-DD`) is older than the
 * retention cutoff calculated from `retentionDays` before `now`.
 *
 * @param dateFolder    - UTC date string in `YYYY-MM-DD` format.
 * @param retentionDays - Number of calendar days to retain.
 * @param now           - Reference date (defaults to the current wall-clock time).
 * @returns `true` if the date is before the retention cutoff.
 */
export function isDateExpired(dateFolder: string, retentionDays: number, now = new Date()): boolean {
  const cutoff = new Date(now)
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  return dateFolder < cutoffDate
}

function isValidUserId(userId: number | undefined): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId) && Number.isInteger(userId) && userId > 0
}

async function runLazyCleanup(provider: string, userId: number, retentionDays: number): Promise<void> {
  const store = getCaptureStore()
  const prefix = `${provider}/${userId}/`

  let blobs: Array<{ key: string }>
  try {
    const result = await store.list({ prefix })
    blobs = result.blobs
  } catch (error) {
    console.warn('[capture-store] Failed to list blobs for lazy cleanup', {
      provider,
      storeName: CAPTURE_STORE,
      errorSummary: safeErrorSummary(error)
    })
    return
  }

  const keysToDelete = blobs
    .map((blob) => blob.key)
    .filter((key) => {
      const dateFolder = getDateFolderFromKey(provider, userId, key)
      if (!dateFolder) return false
      return isDateExpired(dateFolder, retentionDays)
    })

  const deleteResults = await Promise.allSettled(keysToDelete.map(async (key) => store.delete(key)))
  for (const [index, result] of deleteResults.entries()) {
    if (result.status === 'rejected') {
      console.warn('[capture-store] Failed to delete expired capture', {
        key: keysToDelete[index],
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error'
      })
    }
  }
}

function buildCapture(
  provider: string,
  userId: number,
  capturedAt: string,
  usage: Usage,
  rawPayload: JsonObject,
  includeNormalized: boolean
): ProviderCapture {
  const sanitizedRaw = sanitizeProviderPayload(provider, rawPayload)

  return {
    captureVersion: '1',
    capturedAt,
    provider,
    userId,
    normalized: includeNormalized
      ? {
          mode: usage.mode,
          used: usage.used,
          quota: usage.quota,
          remaining: usage.remaining,
          percentUsed: usage.percentUsed,
          resetAt: usage.resetAt,
          source: usage.source,
          warningLevel: usage.warningLevel,
          updatedAt: usage.updatedAt,
          notes: usage.notes
        }
      : undefined,
    sanitizedRaw,
    meta: {
      captureSchemaVersion: CAPTURE_VERSION,
      includesNormalized: includeNormalized,
      sanitizerVersion: SANITIZER_VERSION
    }
  }
}

async function persistCapture(capture: ProviderCapture, config: CaptureConfig): Promise<void> {
  const dateUtc = buildDateFromIso(capture.capturedAt)
  const indexKey = buildIndexKey(capture.provider, capture.userId, dateUtc)

  let index: CaptureIndex
  try {
    index = await readIndex(indexKey, dateUtc)
  } catch (cause) {
    throw new CaptureStageError('readIndex', cause)
  }

  if (index.count >= config.maxPerDay) {
    return
  }

  await runLazyCleanup(capture.provider, capture.userId, config.retentionDays)

  const store = getCaptureStore()
  const captureKey = buildCaptureKey(capture.provider, capture.userId, capture.capturedAt)

  try {
    await store.setJSON(captureKey, capture)
  } catch (cause) {
    throw new CaptureStageError('captureWrite', cause)
  }

  try {
    await writeIndex(indexKey, {
      date: dateUtc,
      count: index.count + 1
    })
  } catch (cause) {
    throw new CaptureStageError('indexWrite', cause)
  }
}

/**
 * Conditionally captures a sanitised provider response to Netlify Blobs.
 *
 * Guards applied before persisting:
 * - `config.enabled` must be `true`.
 * - `provider` must not be in the skip-list (`mock`, `unsupported`, `github`).
 * - `rawPayload` must be non-null.
 * - `userId` must be a positive integer.
 *
 * Capture is **fire-and-forget**: failures are logged but never rethrown so
 * that telemetry persistence never blocks the user-facing usage response.
 *
 * @param input.config      - Capture configuration from {@link readCaptureConfig}.
 * @param input.provider    - Provider identifier.
 * @param input.userId      - Numeric GitHub user ID (omit to skip capture).
 * @param input.usage       - Normalised usage record for the optional normalised snapshot.
 * @param input.rawPayload  - Raw provider response body (will be sanitised before storage).
 */
export async function maybeCapture(input: {
  config: CaptureConfig;
  provider: string;
  userId?: number;
  usage: Usage;
  rawPayload: JsonObject | null;
}): Promise<void> {
  if (!input.config.enabled) return
  if (SKIPPED_PROVIDERS.has(input.provider)) return
  if (!input.rawPayload) return
  if (!isValidUserId(input.userId)) return

  const envError = checkCaptureEnv()
  if (envError !== null) {
    logCaptureFailure(input.provider, input.userId, envError, 'env_check', null)
    return
  }

  const capture = buildCapture(
    input.provider,
    input.userId,
    new Date().toISOString(),
    input.usage,
    input.rawPayload,
    input.config.includeNormalized
  )

  try {
    await persistCapture(capture, input.config)
  } catch (error) {
    const operation = error instanceof CaptureStageError ? error.operation : 'unknown'
    const errorCode = classifyBlobError(error)
    logCaptureFailure(input.provider, input.userId, errorCode, operation, error)
  }
}

/** @internal Reset module-level state between tests. Do not use in production code. */
export function _resetCaptureStoreForTesting(): void {
  captureStore = null
  captureFailureCounts.clear()
}
