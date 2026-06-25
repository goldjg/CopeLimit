/**
 * @file Netlify Blobs storage layer for WebPush subscription records.
 *
 * ## Blob store layout (`push-subscriptions`)
 *
 * ```
 * <userId>/<endpointHash>.json   — individual subscription record
 * ```
 *
 * The endpoint hash is a SHA-256 digest (hex) of the subscription endpoint
 * URL, truncated to 32 characters. This provides a deterministic, URL-safe,
 * fixed-length key that enables idempotent writes: re-registering the same
 * browser subscription at the same endpoint overwrites the existing record.
 *
 * ## Tier classification
 *
 * All records in `push-subscriptions` are **Tier 2** (user-controlled device
 * registration metadata). Application-level encryption is not required.
 * Records contain only endpoint URLs, VAPID keys, timestamps, and optional
 * labels — no access tokens, no raw provider payloads, no credential data.
 */

import { createHash } from 'crypto'
import { getBlobStore } from './blob-store'
import type { PushSubscriptionPayload, PushSubscriptionRecord } from './push-subscription-types'

const PUSH_STORE = 'push-subscriptions'
const SUBSCRIPTION_VERSION = '1' as const

/** Maximum characters retained from an error message in structured log output. */
const MAX_ERROR_SUMMARY_LENGTH = 200

/** Patterns that suggest an error message may contain sensitive data. */
const SENSITIVE_IN_MESSAGE_PATTERNS = [
  /token/i, /auth/i, /key/i, /secret/i, /bearer/i, /credential/i, /password/i, /cookie/i,
]

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getPushStore() {
  return getBlobStore(PUSH_STORE)
}

function isValidUserId(userId: number | undefined): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId) && Number.isInteger(userId) && userId > 0
}

/**
 * Returns a deterministic, URL-safe 32-character hex key component derived
 * from a subscription endpoint URL.
 *
 * SHA-256 is used so the key is collision-resistant and fixed-length.
 * The endpoint URL itself is not stored in the key to avoid path length issues
 * and to keep the key format stable.
 *
 * @param endpoint - The push subscription endpoint URL.
 * @returns A 64-character lowercase hex string (full SHA-256 output).
 */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

/**
 * Builds the Blobs key for a single push subscription record.
 *
 * Format: `<userId>/<endpointHash>.json`
 *
 * @param userId   - Numeric GitHub user ID.
 * @param endpoint - The push subscription endpoint URL.
 * @returns The Blobs key string.
 */
export function buildSubscriptionKey(userId: number, endpoint: string): string {
  return `${userId}/${endpointHash(endpoint)}.json`
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

function logPushStoreFailure(userId: number, operation: string, error: unknown): void {
  const diagnostics = buildSafeErrorSummary(error)
  console.warn('[push-subscriptions] Store operation failed', {
    userId,
    operation,
    storeName: PUSH_STORE,
    ...diagnostics,
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Saves (registers or updates) a push subscription for the given user.
 *
 * If a subscription with the same endpoint already exists for this user, its
 * `updatedAt` timestamp is refreshed and the keys are updated. `createdAt` is
 * preserved from the first registration.
 *
 * @param userId  - Numeric GitHub user ID.
 * @param payload - The push subscription payload from the browser.
 * @param now     - Reference timestamp (defaults to current wall-clock time).
 * @returns The stored {@link PushSubscriptionRecord}, or `null` on failure.
 */
export async function saveSubscription(
  userId: number,
  payload: PushSubscriptionPayload,
  now = new Date(),
): Promise<PushSubscriptionRecord | null> {
  if (!isValidUserId(userId)) return null

  const store = getPushStore()
  const key = buildSubscriptionKey(userId, payload.endpoint)
  const nowIso = now.toISOString()

  // Preserve createdAt from existing record if present.
  // Trade-off: if the blob read throws (transient error), createdAt resets to
  // nowIso. This is fail-open: the subscription is still saved successfully and
  // the registration date will reflect the re-registration time rather than the
  // original. Acceptable for a non-critical metadata field; the alternative of
  // failing the entire save on a transient read error would be worse UX.
  let createdAt = nowIso
  try {
    const existing = await store.get(key, { type: 'json' }) as PushSubscriptionRecord | null
    if (existing && typeof existing.createdAt === 'string') {
      createdAt = existing.createdAt
    }
  } catch {
    // Fail-open: see trade-off note above
  }

  const record: PushSubscriptionRecord = {
    subscriptionVersion: SUBSCRIPTION_VERSION,
    userId,
    endpoint: payload.endpoint,
    keys: payload.keys,
    createdAt,
    updatedAt: nowIso,
    ...(payload.userAgent ? { userAgent: payload.userAgent } : {}),
    ...(payload.source ? { source: payload.source } : {}),
  }

  try {
    await store.setJSON(key, record)
    return record
  } catch (error) {
    logPushStoreFailure(userId, 'saveSubscription', error)
    return null
  }
}

/**
 * Deletes a push subscription for the given user by endpoint URL.
 *
 * Returns `true` when the deletion succeeds, `false` when no record was found
 * or the deletion fails.
 *
 * @param userId   - Numeric GitHub user ID.
 * @param endpoint - The push subscription endpoint URL to remove.
 * @returns `true` if deleted, `false` otherwise.
 */
export async function deleteSubscription(
  userId: number,
  endpoint: string,
): Promise<boolean> {
  if (!isValidUserId(userId)) return false

  const store = getPushStore()
  const key = buildSubscriptionKey(userId, endpoint)

  // Verify the record exists and belongs to this user before deleting
  try {
    const existing = await store.get(key, { type: 'json' }) as PushSubscriptionRecord | null
    if (!existing || existing.userId !== userId) return false
  } catch {
    return false
  }

  try {
    await store.delete(key)
    return true
  } catch (error) {
    logPushStoreFailure(userId, 'deleteSubscription', error)
    return false
  }
}

/**
 * Returns all push subscription records for the given user.
 *
 * Records that cannot be read or parsed are silently skipped so that a single
 * corrupt record does not prevent the remainder from being returned.
 *
 * @param userId - Numeric GitHub user ID.
 * @returns An array of {@link PushSubscriptionRecord} objects. Returns an empty
 *   array when no subscriptions exist or `userId` is invalid.
 */
export async function getSubscriptions(
  userId: number,
): Promise<PushSubscriptionRecord[]> {
  if (!isValidUserId(userId)) return []

  const store = getPushStore()
  const prefix = `${userId}/`

  let blobs: Array<{ key: string }>
  try {
    const result = await store.list({ prefix })
    blobs = result.blobs
  } catch (error) {
    logPushStoreFailure(userId, 'getSubscriptions.list', error)
    return []
  }

  const recordResults = await Promise.allSettled(
    blobs.map(b => store.get(b.key, { type: 'json' }) as Promise<PushSubscriptionRecord | null>)
  )

  const records: PushSubscriptionRecord[] = []
  for (const result of recordResults) {
    if (result.status === 'rejected') continue
    const rec = result.value
    if (!rec || typeof rec.endpoint !== 'string' || rec.userId !== userId) continue
    records.push(rec)
  }

  return records
}

/**
 * Returns the number of active push subscriptions for the given user.
 *
 * @param userId - Numeric GitHub user ID.
 * @returns The number of registered subscriptions, or `0` on failure / invalid user.
 */
export async function countSubscriptions(userId: number): Promise<number> {
  const records = await getSubscriptions(userId)
  return records.length
}
