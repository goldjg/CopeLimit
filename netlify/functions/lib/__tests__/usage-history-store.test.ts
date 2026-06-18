import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import {
  _resetHistoryStoreForTesting,
  appendSnapshot,
  buildHistoryIndexKey,
  buildHistoryKey,
  calculateDelta,
  getHistory,
  isDateExpired,
} from '../usage-history-store'
import type { UsageHistoryConfig, UsageHistoryEntry, UsageHistorySnapshot } from '../usage-history-types'

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

function makeMockStore(): MockStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    setJSON: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ blobs: [] }),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

const ENABLED_CONFIG: UsageHistoryConfig = {
  enabled: true,
  retentionDays: 90,
  maxPerDay: 48,
}

const BASE_SNAPSHOT: UsageHistorySnapshot = {
  capturedAt: '2026-06-15T10:00:00.000Z',
  used: 3000,
  quota: 7000,
  remaining: 4000,
  billingPhase: 'credits_available',
}

const USER_ID = 43296126

// ---------------------------------------------------------------------------
// Contract assertion 1: key helper correctness
// ---------------------------------------------------------------------------

describe('usage-history key helpers', () => {
  it('buildHistoryKey produces correct format', () => {
    const key = buildHistoryKey(123, '2026-06-15T10:00:00.000Z')
    expect(key).toBe('123/2026-06-15/2026-06-15T10:00:00.000Z.json')
  })

  it('buildHistoryIndexKey produces correct format', () => {
    const key = buildHistoryIndexKey(123, '2026-06-15')
    expect(key).toBe('123/2026-06-15/_index.json')
  })

  it('buildHistoryKey uses the date from the ISO timestamp', () => {
    const key = buildHistoryKey(99, '2026-01-31T23:59:59.999Z')
    expect(key).toContain('2026-01-31')
    expect(key.endsWith('2026-01-31T23:59:59.999Z.json')).toBe(true)
  })

  it('buildHistoryKey partitions by userId', () => {
    const key1 = buildHistoryKey(1, '2026-06-15T10:00:00.000Z')
    const key2 = buildHistoryKey(2, '2026-06-15T10:00:00.000Z')
    expect(key1.startsWith('1/')).toBe(true)
    expect(key2.startsWith('2/')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 2: isDateExpired retention logic
// ---------------------------------------------------------------------------

describe('isDateExpired', () => {
  it('returns true for a date older than retentionDays', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-03-16', 90, now)).toBe(true)
  })

  it('returns false for a date within retentionDays', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-03-17', 90, now)).toBe(false)
  })

  it('returns false for today', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-06-15', 90, now)).toBe(false)
  })

  it('returns false for yesterday', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-06-14', 90, now)).toBe(false)
  })

  it('treats the exact cutoff boundary as expired', () => {
    // retentionDays=30 with now=2026-06-15: cutoff is 2026-05-16
    // 2026-05-15 is strictly before cutoff → expired
    const now = new Date('2026-06-15T00:00:00Z')
    expect(isDateExpired('2026-05-15', 30, now)).toBe(true)
    expect(isDateExpired('2026-05-16', 30, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 3: calculateDelta — pure function, no I/O
// ---------------------------------------------------------------------------

describe('calculateDelta', () => {
  const before: UsageHistorySnapshot = {
    capturedAt: '2026-06-15T09:00:00.000Z',
    used: 1000,
    quota: 7000,
    remaining: 6000,
    billingPhase: 'credits_available',
  }

  const after: UsageHistorySnapshot = {
    capturedAt: '2026-06-15T10:00:00.000Z',
    used: 1500,
    quota: 7000,
    remaining: 5500,
    billingPhase: 'credits_available',
  }

  it('computes correct usedDelta and remainingDelta', () => {
    const delta = calculateDelta(before, after)
    expect(delta.usedDelta).toBe(500)
    expect(delta.remainingDelta).toBe(-500)
  })

  it('computes correct durationMs', () => {
    const delta = calculateDelta(before, after)
    expect(delta.durationMs).toBe(3600_000) // 1 hour
  })

  it('preserves from and to references', () => {
    const delta = calculateDelta(before, after)
    expect(delta.from).toBe(before)
    expect(delta.to).toBe(after)
  })

  it('sets overageCountDelta when both snapshots have overageCount', () => {
    const b = { ...before, overageCount: 10 }
    const a = { ...after, overageCount: 25 }
    const delta = calculateDelta(b, a)
    expect(delta.overageCountDelta).toBe(15)
  })

  it('sets overageCountDelta when only after has overageCount (treats absent as 0)', () => {
    const a = { ...after, overageCount: 25 }
    const delta = calculateDelta(before, a)
    expect(delta.overageCountDelta).toBe(25)
  })

  it('sets overageCountDelta when only before has overageCount (treats absent as 0)', () => {
    const b = { ...before, overageCount: 10 }
    const delta = calculateDelta(b, after)
    expect(delta.overageCountDelta).toBe(-10)
  })

  it('omits overageCountDelta when both snapshots lack overageCount', () => {
    const delta = calculateDelta(before, after)
    expect(delta.overageCountDelta).toBeUndefined()
  })

  it('sets derivedOverageCreditsDelta when at least one snapshot has derivedOverageCredits', () => {
    const b = { ...before, derivedOverageCredits: 0 }
    const a = { ...after, derivedOverageCredits: 473 }
    const delta = calculateDelta(b, a)
    expect(delta.derivedOverageCreditsDelta).toBe(473)
  })

  it('omits derivedOverageCreditsDelta when both snapshots lack derivedOverageCredits', () => {
    const delta = calculateDelta(before, after)
    expect(delta.derivedOverageCreditsDelta).toBeUndefined()
  })

  it('returns negative durationMs when snapshots are passed in reverse order', () => {
    const delta = calculateDelta(after, before)
    expect(delta.durationMs).toBe(-3600_000)
  })

  it('usedDelta is negative when a quota reset occurs (used decreases)', () => {
    const afterReset: UsageHistorySnapshot = {
      capturedAt: '2026-07-01T00:00:00.000Z',
      used: 0,
      quota: 7000,
      remaining: 7000,
      billingPhase: 'credits_available',
    }
    const delta = calculateDelta(after, afterReset)
    expect(delta.usedDelta).toBe(-1500)
  })

  it('handles budget_active phase snapshots with overageCount', () => {
    const budgetBefore: UsageHistorySnapshot = {
      capturedAt: '2026-06-15T09:00:00.000Z',
      used: 7000,
      quota: 7000,
      remaining: 0,
      billingPhase: 'budget_active',
      overageCount: 100,
    }
    const budgetAfter: UsageHistorySnapshot = {
      capturedAt: '2026-06-15T10:00:00.000Z',
      used: 7000,
      quota: 7000,
      remaining: 0,
      billingPhase: 'budget_active',
      overageCount: 250,
    }
    const delta = calculateDelta(budgetBefore, budgetAfter)
    expect(delta.usedDelta).toBe(0)
    expect(delta.overageCountDelta).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 4: appendSnapshot guards
// ---------------------------------------------------------------------------

describe('appendSnapshot — guards', () => {
  it('resolves without writing when config.enabled is false', async () => {
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()

    await appendSnapshot(USER_ID, BASE_SNAPSHOT, { ...ENABLED_CONFIG, enabled: false })

    expect(mockStore.setJSON).not.toHaveBeenCalled()
  })

  it('resolves without writing when userId is missing (undefined cast)', async () => {
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()

    // Cast to satisfy TypeScript; the guard handles runtime undefined
    await appendSnapshot(undefined as unknown as number, BASE_SNAPSHOT, ENABLED_CONFIG)

    expect(mockStore.setJSON).not.toHaveBeenCalled()
  })

  it('resolves without writing when userId is not a positive integer', async () => {
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()

    await appendSnapshot(0, BASE_SNAPSHOT, ENABLED_CONFIG)
    await appendSnapshot(-1, BASE_SNAPSHOT, ENABLED_CONFIG)
    await appendSnapshot(1.5, BASE_SNAPSHOT, ENABLED_CONFIG)

    expect(mockStore.setJSON).not.toHaveBeenCalled()
  })

  it('resolves without writing when daily cap is reached', async () => {
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()

    // daily index returns count at cap
    mockStore.get.mockResolvedValue({ count: 48, date: '2026-06-15' })

    await appendSnapshot(USER_ID, BASE_SNAPSHOT, { ...ENABLED_CONFIG, maxPerDay: 48 })

    // setJSON should not be called for the entry (only index read happened)
    const entryWriteCalls = mockStore.setJSON.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).endsWith('.json') && !(call[0] as string).endsWith('_index.json')
    )
    expect(entryWriteCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 5: appendSnapshot — happy path
// ---------------------------------------------------------------------------

describe('appendSnapshot — happy path', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a UsageHistoryEntry with correct shape', async () => {
    await appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)

    const setJSONCalls: Array<[string, unknown]> = mockStore.setJSON.mock.calls
    const entryCall = setJSONCalls.find(
      ([key]) => typeof key === 'string' && key.endsWith('.json') && !key.endsWith('_index.json')
    )
    expect(entryCall).toBeDefined()
    const [key, data] = entryCall!
    expect(key).toBe(buildHistoryKey(USER_ID, BASE_SNAPSHOT.capturedAt))
    expect((data as UsageHistoryEntry).historyVersion).toBe('1')
    expect((data as UsageHistoryEntry).userId).toBe(USER_ID)
    expect((data as UsageHistoryEntry).snapshot).toEqual(BASE_SNAPSHOT)
  })

  it('increments the daily index after writing an entry', async () => {
    mockStore.get.mockResolvedValue({ count: 2, date: '2026-06-15' })

    await appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)

    const setJSONCalls: Array<[string, unknown]> = mockStore.setJSON.mock.calls
    const indexCall = setJSONCalls.find(
      ([key]) => typeof key === 'string' && key.endsWith('_index.json')
    )
    expect(indexCall).toBeDefined()
    expect((indexCall![1] as { count: number }).count).toBe(3)
  })

  it('resolves without rethrowing when entry write fails (fire-and-forget)', async () => {
    mockStore.setJSON.mockRejectedValueOnce(new Error('write failure'))

    await expect(appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)).resolves.toBeUndefined()
  })

  it('resolves without rethrowing when index write fails after successful entry write', async () => {
    // First setJSON call (entry) succeeds; second (index) fails
    mockStore.setJSON.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('index write failure'))

    await expect(appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)).resolves.toBeUndefined()
  })

  it('writes entry with overageCount and derivedOverageCredits when present', async () => {
    const snapshotWithOverage: UsageHistorySnapshot = {
      ...BASE_SNAPSHOT,
      billingPhase: 'budget_active',
      overageCount: 120,
      derivedOverageCredits: 473,
    }

    await appendSnapshot(USER_ID, snapshotWithOverage, ENABLED_CONFIG)

    const setJSONCalls: Array<[string, unknown]> = mockStore.setJSON.mock.calls
    const entryCall = setJSONCalls.find(
      ([key]) => typeof key === 'string' && key.endsWith('.json') && !key.endsWith('_index.json')
    )
    const stored = (entryCall![1] as UsageHistoryEntry).snapshot
    expect(stored.overageCount).toBe(120)
    expect(stored.derivedOverageCredits).toBe(473)
    expect(stored.billingPhase).toBe('budget_active')
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 6: getHistory
// ---------------------------------------------------------------------------

describe('getHistory', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns [] for invalid userId', async () => {
    const result = await getHistory(0)
    expect(result).toEqual([])
    expect(mockStore.list).not.toHaveBeenCalled()
  })

  it('returns [] when no blobs exist', async () => {
    mockStore.list.mockResolvedValue({ blobs: [] })

    const result = await getHistory(USER_ID)
    expect(result).toEqual([])
  })

  it('skips _index.json blobs when listing', async () => {
    mockStore.list.mockResolvedValue({
      blobs: [
        { key: `${USER_ID}/2026-06-15/_index.json` },
        { key: buildHistoryKey(USER_ID, '2026-06-15T10:00:00.000Z') },
      ],
    })

    const entry: UsageHistoryEntry = {
      historyVersion: '1',
      userId: USER_ID,
      snapshot: BASE_SNAPSHOT,
    }
    // Index get returns null; entry get returns the entry
    mockStore.get.mockImplementation(async (key: string) => {
      if (key.endsWith('_index.json')) return null
      return entry
    })

    const result = await getHistory(USER_ID)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(BASE_SNAPSHOT)
  })

  it('returns snapshots sorted by capturedAt descending', async () => {
    const ts1 = '2026-06-15T08:00:00.000Z'
    const ts2 = '2026-06-15T10:00:00.000Z'
    const ts3 = '2026-06-15T09:00:00.000Z'

    const makeEntry = (capturedAt: string): UsageHistoryEntry => ({
      historyVersion: '1',
      userId: USER_ID,
      snapshot: { ...BASE_SNAPSHOT, capturedAt, used: 1000 },
    })

    mockStore.list.mockResolvedValue({
      blobs: [
        { key: buildHistoryKey(USER_ID, ts1) },
        { key: buildHistoryKey(USER_ID, ts2) },
        { key: buildHistoryKey(USER_ID, ts3) },
      ],
    })

    mockStore.get.mockImplementation(async (key: string) => {
      if (key.includes(ts1)) return makeEntry(ts1)
      if (key.includes(ts2)) return makeEntry(ts2)
      if (key.includes(ts3)) return makeEntry(ts3)
      return null
    })

    const result = await getHistory(USER_ID)
    expect(result.map(s => s.capturedAt)).toEqual([ts2, ts3, ts1])
  })

  it('filters by fromDate (inclusive)', async () => {
    const ts1 = '2026-06-14T10:00:00.000Z' // date: 2026-06-14 — before fromDate
    const ts2 = '2026-06-15T10:00:00.000Z' // date: 2026-06-15 — matches

    const makeEntry = (capturedAt: string): UsageHistoryEntry => ({
      historyVersion: '1',
      userId: USER_ID,
      snapshot: { ...BASE_SNAPSHOT, capturedAt },
    })

    mockStore.list.mockResolvedValue({
      blobs: [
        { key: buildHistoryKey(USER_ID, ts1) },
        { key: buildHistoryKey(USER_ID, ts2) },
      ],
    })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key.includes(ts1)) return makeEntry(ts1)
      if (key.includes(ts2)) return makeEntry(ts2)
      return null
    })

    const result = await getHistory(USER_ID, { fromDate: '2026-06-15' })
    expect(result).toHaveLength(1)
    expect(result[0].capturedAt).toBe(ts2)
  })

  it('filters by toDate (inclusive)', async () => {
    const ts1 = '2026-06-15T10:00:00.000Z' // date: 2026-06-15 — matches
    const ts2 = '2026-06-16T10:00:00.000Z' // date: 2026-06-16 — after toDate

    const makeEntry = (capturedAt: string): UsageHistoryEntry => ({
      historyVersion: '1',
      userId: USER_ID,
      snapshot: { ...BASE_SNAPSHOT, capturedAt },
    })

    mockStore.list.mockResolvedValue({
      blobs: [
        { key: buildHistoryKey(USER_ID, ts1) },
        { key: buildHistoryKey(USER_ID, ts2) },
      ],
    })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key.includes(ts1)) return makeEntry(ts1)
      if (key.includes(ts2)) return makeEntry(ts2)
      return null
    })

    const result = await getHistory(USER_ID, { toDate: '2026-06-15' })
    expect(result).toHaveLength(1)
    expect(result[0].capturedAt).toBe(ts1)
  })

  it('respects the limit option', async () => {
    const timestamps = [
      '2026-06-15T08:00:00.000Z',
      '2026-06-15T09:00:00.000Z',
      '2026-06-15T10:00:00.000Z',
    ]

    mockStore.list.mockResolvedValue({
      blobs: timestamps.map(ts => ({ key: buildHistoryKey(USER_ID, ts) })),
    })
    mockStore.get.mockImplementation(async (key: string) => {
      const ts = timestamps.find(t => key.includes(t))
      if (!ts) return null
      return { historyVersion: '1', userId: USER_ID, snapshot: { ...BASE_SNAPSHOT, capturedAt: ts } }
    })

    const result = await getHistory(USER_ID, { limit: 2 })
    expect(result).toHaveLength(2)
    // most recent first, so limit slices the first 2
    expect(result[0].capturedAt).toBe('2026-06-15T10:00:00.000Z')
    expect(result[1].capturedAt).toBe('2026-06-15T09:00:00.000Z')
  })

  it('skips entries with malformed snapshot data', async () => {
    const ts1 = '2026-06-15T08:00:00.000Z'
    const ts2 = '2026-06-15T10:00:00.000Z'

    mockStore.list.mockResolvedValue({
      blobs: [
        { key: buildHistoryKey(USER_ID, ts1) },
        { key: buildHistoryKey(USER_ID, ts2) },
      ],
    })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key.includes(ts1)) return { historyVersion: '1', userId: USER_ID, snapshot: null } // malformed
      return { historyVersion: '1', userId: USER_ID, snapshot: { ...BASE_SNAPSHOT, capturedAt: ts2 } }
    })

    const result = await getHistory(USER_ID)
    expect(result).toHaveLength(1)
    expect(result[0].capturedAt).toBe(ts2)
  })

  it('returns [] and logs warning when list throws', async () => {
    mockStore.list.mockRejectedValue(new Error('blob list failure'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await getHistory(USER_ID)
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      '[usage-history] Failed to persist usage snapshot',
      expect.objectContaining({ operation: 'listBlobs', storeName: 'usage-history' })
    )
  })
})
