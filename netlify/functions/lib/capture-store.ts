import { getStore } from '@netlify/blobs'
import type { JsonObject, Usage } from './copilot'
import { sanitizeProviderPayload } from './capture-sanitize'
import type { CaptureConfig, CaptureIndex, ProviderCapture } from './capture-types'

const CAPTURE_STORE = 'provider-captures'
const CAPTURE_VERSION = '1'
const SANITIZER_VERSION = '1'
const SKIPPED_PROVIDERS = new Set(['mock', 'unsupported', 'github'])

function buildDateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

function getCaptureStore() {
  const siteID = process.env.NETLIFY_SITE_ID
  const token = process.env.NETLIFY_AUTH_TOKEN

  if (siteID && token) {
    return getStore({ name: CAPTURE_STORE, siteID, token })
  }

  return getStore({ name: CAPTURE_STORE })
}

export function buildCaptureKey(provider: string, userId: number, isoTimestamp: string): string {
  return `${provider}/${userId}/${buildDateFromIso(isoTimestamp)}/${isoTimestamp}.json`
}

export function buildIndexKey(provider: string, userId: number, dateUtc: string): string {
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

export function isDateExpired(dateFolder: string, retentionDays: number, now = new Date()): boolean {
  const cutoff = new Date(now)
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  return dateFolder < cutoffDate
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

  await Promise.all(keysToDelete.map(async (key) => store.delete(key)))
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

  const capture = buildCapture(
    input.provider,
    input.userId ?? 0,
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
      userId: input.userId ?? 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
