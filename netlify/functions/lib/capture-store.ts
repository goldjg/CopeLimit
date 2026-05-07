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
let captureStore: ReturnType<typeof getStore> | null = null

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
  const { blobs } = await store.list({ prefix })

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
  const index = await readIndex(indexKey, dateUtc)

  if (index.count >= config.maxPerDay) {
    return
  }

  await runLazyCleanup(capture.provider, capture.userId, config.retentionDays)

  const store = getCaptureStore()
  const captureKey = buildCaptureKey(capture.provider, capture.userId, capture.capturedAt)

  await store.setJSON(captureKey, capture)
  await writeIndex(indexKey, {
    date: dateUtc,
    count: index.count + 1
  })
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
    console.warn('[capture-store] Failed to persist provider capture', {
      provider: input.provider,
      userId: input.userId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    })
  }
}
