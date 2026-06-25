/**
 * Contract tests for push-subscription-store.ts.
 *
 * Verified contracts:
 * 1. `buildSubscriptionKey` produces the expected deterministic key format.
 * 2. `saveSubscription` stores a record with correct fields.
 * 3. `saveSubscription` preserves `createdAt` and updates `updatedAt` on re-registration.
 * 4. `saveSubscription` returns `null` for an invalid userId.
 * 5. `deleteSubscription` removes the correct key and returns `true`.
 * 6. `deleteSubscription` returns `false` when the record does not exist or belongs to another user.
 * 7. `getSubscriptions` returns all valid records for a user and skips corrupt entries.
 * 8. `getSubscriptions` returns an empty array for a user with no subscriptions.
 * 9. `countSubscriptions` returns the correct count.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import {
  buildSubscriptionKey,
  countSubscriptions,
  deleteSubscription,
  endpointHash,
  getSubscriptions,
  saveSubscription,
} from '../push-subscription-store'
import type { PushSubscriptionRecord } from '../push-subscription-types'

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

type MockStore = {
  get: ReturnType<typeof vi.fn>
  setJSON: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

function makeMockStore(overrides: Partial<MockStore> = {}): MockStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    setJSON: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ blobs: [] }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const USER_ID = 12345
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-subscription-id'
const KEYS = { p256dh: 'BPm8s4z...', auth: 'qK8Hx...' }

const PAYLOAD = { endpoint: ENDPOINT, keys: KEYS }

const BASE_RECORD: PushSubscriptionRecord = {
  subscriptionVersion: '1',
  userId: USER_ID,
  endpoint: ENDPOINT,
  keys: KEYS,
  createdAt: '2026-06-25T10:00:00.000Z',
  updatedAt: '2026-06-25T10:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Contract 1: key helpers
// ---------------------------------------------------------------------------

describe('buildSubscriptionKey', () => {
  it('produces a key in the expected format', () => {
    const key = buildSubscriptionKey(USER_ID, ENDPOINT)
    expect(key).toMatch(/^12345\/[0-9a-f]{32}\.json$/)
  })

  it('is deterministic for the same endpoint', () => {
    expect(buildSubscriptionKey(USER_ID, ENDPOINT)).toBe(buildSubscriptionKey(USER_ID, ENDPOINT))
  })

  it('differs for different endpoints', () => {
    const key1 = buildSubscriptionKey(USER_ID, ENDPOINT)
    const key2 = buildSubscriptionKey(USER_ID, ENDPOINT + '/other')
    expect(key1).not.toBe(key2)
  })

  it('differs for different user IDs with the same endpoint', () => {
    const key1 = buildSubscriptionKey(USER_ID, ENDPOINT)
    const key2 = buildSubscriptionKey(99999, ENDPOINT)
    expect(key1).not.toBe(key2)
    // different user prefix
    expect(key1.split('/')[0]).toBe('12345')
    expect(key2.split('/')[0]).toBe('99999')
    // same hash segment since endpoint is the same
    expect(key1.split('/')[1]).toBe(key2.split('/')[1])
  })
})

describe('endpointHash', () => {
  it('returns a 32-character lowercase hex string', () => {
    const hash = endpointHash(ENDPOINT)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic', () => {
    expect(endpointHash(ENDPOINT)).toBe(endpointHash(ENDPOINT))
  })
})

// ---------------------------------------------------------------------------
// Contract 2: saveSubscription stores a record
// ---------------------------------------------------------------------------

describe('saveSubscription', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  it('stores a record with the correct fields', async () => {
    const now = new Date('2026-06-25T20:00:00.000Z')
    const record = await saveSubscription(USER_ID, PAYLOAD, now)

    expect(record).not.toBeNull()
    expect(record!.subscriptionVersion).toBe('1')
    expect(record!.userId).toBe(USER_ID)
    expect(record!.endpoint).toBe(ENDPOINT)
    expect(record!.keys).toEqual(KEYS)
    expect(record!.createdAt).toBe('2026-06-25T20:00:00.000Z')
    expect(record!.updatedAt).toBe('2026-06-25T20:00:00.000Z')
  })

  it('stores at the correct key', async () => {
    const now = new Date('2026-06-25T20:00:00.000Z')
    await saveSubscription(USER_ID, PAYLOAD, now)

    const expectedKey = buildSubscriptionKey(USER_ID, ENDPOINT)
    expect(mockStore.setJSON).toHaveBeenCalledWith(expectedKey, expect.objectContaining({
      endpoint: ENDPOINT,
      userId: USER_ID,
    }))
  })

  it('stores optional userAgent and source when provided', async () => {
    const payloadWithMeta = { ...PAYLOAD, userAgent: 'Mozilla/5.0', source: 'copelimit-pwa' }
    const record = await saveSubscription(USER_ID, payloadWithMeta)

    expect(record!.userAgent).toBe('Mozilla/5.0')
    expect(record!.source).toBe('copelimit-pwa')
  })

  it('omits userAgent and source when not provided', async () => {
    const record = await saveSubscription(USER_ID, PAYLOAD)

    expect(record!.userAgent).toBeUndefined()
    expect(record!.source).toBeUndefined()
  })

  // Contract 3: createdAt preserved on re-registration
  it('preserves createdAt and updates updatedAt on re-registration', async () => {
    const existingRecord: PushSubscriptionRecord = {
      ...BASE_RECORD,
      createdAt: '2026-06-20T08:00:00.000Z',
      updatedAt: '2026-06-20T08:00:00.000Z',
    }
    mockStore.get.mockResolvedValue(existingRecord)

    const later = new Date('2026-06-25T20:00:00.000Z')
    const record = await saveSubscription(USER_ID, PAYLOAD, later)

    expect(record!.createdAt).toBe('2026-06-20T08:00:00.000Z')
    expect(record!.updatedAt).toBe('2026-06-25T20:00:00.000Z')
  })

  // Contract 4: invalid userId
  it('returns null for userId 0', async () => {
    const record = await saveSubscription(0, PAYLOAD)
    expect(record).toBeNull()
    expect(mockStore.setJSON).not.toHaveBeenCalled()
  })

  it('returns null for a negative userId', async () => {
    const record = await saveSubscription(-1, PAYLOAD)
    expect(record).toBeNull()
    expect(mockStore.setJSON).not.toHaveBeenCalled()
  })

  it('returns null when setJSON throws', async () => {
    mockStore.setJSON.mockRejectedValue(new Error('Blob write failed'))
    const record = await saveSubscription(USER_ID, PAYLOAD)
    expect(record).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract 5 & 6: deleteSubscription
// ---------------------------------------------------------------------------

describe('deleteSubscription', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  it('deletes the correct key and returns true', async () => {
    mockStore.get.mockResolvedValue(BASE_RECORD)

    const result = await deleteSubscription(USER_ID, ENDPOINT)

    expect(result).toBe(true)
    const expectedKey = buildSubscriptionKey(USER_ID, ENDPOINT)
    expect(mockStore.delete).toHaveBeenCalledWith(expectedKey)
  })

  it('returns false when record does not exist', async () => {
    mockStore.get.mockResolvedValue(null)

    const result = await deleteSubscription(USER_ID, ENDPOINT)

    expect(result).toBe(false)
    expect(mockStore.delete).not.toHaveBeenCalled()
  })

  it('returns false when the record belongs to a different user', async () => {
    const otherRecord = { ...BASE_RECORD, userId: 99999 }
    mockStore.get.mockResolvedValue(otherRecord)

    const result = await deleteSubscription(USER_ID, ENDPOINT)

    expect(result).toBe(false)
    expect(mockStore.delete).not.toHaveBeenCalled()
  })

  it('returns false when get throws', async () => {
    mockStore.get.mockRejectedValue(new Error('read error'))
    const result = await deleteSubscription(USER_ID, ENDPOINT)
    expect(result).toBe(false)
  })

  it('returns false for an invalid userId', async () => {
    const result = await deleteSubscription(0, ENDPOINT)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Contract 7 & 8: getSubscriptions
// ---------------------------------------------------------------------------

describe('getSubscriptions', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  it('returns all valid records for a user', async () => {
    const key1 = buildSubscriptionKey(USER_ID, ENDPOINT)
    const key2 = buildSubscriptionKey(USER_ID, ENDPOINT + '/2')
    const record2: PushSubscriptionRecord = { ...BASE_RECORD, endpoint: ENDPOINT + '/2' }

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation((key: string) => {
      if (key === key1) return Promise.resolve(BASE_RECORD)
      if (key === key2) return Promise.resolve(record2)
      return Promise.resolve(null)
    })

    const records = await getSubscriptions(USER_ID)
    expect(records).toHaveLength(2)
  })

  it('returns an empty array when no subscriptions exist', async () => {
    mockStore.list.mockResolvedValue({ blobs: [] })
    const records = await getSubscriptions(USER_ID)
    expect(records).toEqual([])
  })

  it('returns an empty array for an invalid userId', async () => {
    const records = await getSubscriptions(0)
    expect(records).toEqual([])
    expect(mockStore.list).not.toHaveBeenCalled()
  })

  it('skips records that belong to a different user', async () => {
    const key = buildSubscriptionKey(USER_ID, ENDPOINT)
    const foreignRecord = { ...BASE_RECORD, userId: 99999 }
    mockStore.list.mockResolvedValue({ blobs: [{ key }] })
    mockStore.get.mockResolvedValue(foreignRecord)

    const records = await getSubscriptions(USER_ID)
    expect(records).toHaveLength(0)
  })

  it('skips records where get throws', async () => {
    const key1 = buildSubscriptionKey(USER_ID, ENDPOINT)
    const key2 = buildSubscriptionKey(USER_ID, ENDPOINT + '/2')
    const record2: PushSubscriptionRecord = { ...BASE_RECORD, endpoint: ENDPOINT + '/2' }

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation((key: string) => {
      if (key === key1) return Promise.reject(new Error('read error'))
      return Promise.resolve(record2)
    })

    const records = await getSubscriptions(USER_ID)
    expect(records).toHaveLength(1)
    expect(records[0].endpoint).toBe(ENDPOINT + '/2')
  })

  it('returns empty array when list throws', async () => {
    mockStore.list.mockRejectedValue(new Error('list error'))
    const records = await getSubscriptions(USER_ID)
    expect(records).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Contract 9: countSubscriptions
// ---------------------------------------------------------------------------

describe('countSubscriptions', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  it('returns the number of valid subscriptions', async () => {
    const key1 = buildSubscriptionKey(USER_ID, ENDPOINT)
    const key2 = buildSubscriptionKey(USER_ID, ENDPOINT + '/2')
    const record2: PushSubscriptionRecord = { ...BASE_RECORD, endpoint: ENDPOINT + '/2' }

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation((key: string) => {
      if (key === key1) return Promise.resolve(BASE_RECORD)
      if (key === key2) return Promise.resolve(record2)
      return Promise.resolve(null)
    })

    expect(await countSubscriptions(USER_ID)).toBe(2)
  })

  it('returns 0 for a user with no subscriptions', async () => {
    mockStore.list.mockResolvedValue({ blobs: [] })
    expect(await countSubscriptions(USER_ID)).toBe(0)
  })
})
