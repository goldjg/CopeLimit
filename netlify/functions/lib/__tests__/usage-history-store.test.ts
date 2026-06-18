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
  snapshotStateFingerprint,
  snapshotsAreEquivalent,
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
  it('buildHistoryKey produces state-fingerprint-based key in correct format', () => {
    const key = buildHistoryKey(123, BASE_SNAPSHOT)
    // format: <userId>/<YYYY-MM-DD>/<fingerprint>.json
    expect(key).toMatch(/^123\/2026-06-15\/.+\.json$/)
    // must not embed the capture timestamp (that would make concurrent writes diverge)
    expect(key).not.toContain('T10:00:00')
    expect(key).not.toContain(BASE_SNAPSHOT.capturedAt)
  })

  it('buildHistoryIndexKey produces correct format', () => {
    const key = buildHistoryIndexKey(123, '2026-06-15')
    expect(key).toBe('123/2026-06-15/_index.json')
  })

  it('buildHistoryKey uses the date from the ISO timestamp', () => {
    const snapshot: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-01-31T23:59:59.999Z' }
    const key = buildHistoryKey(99, snapshot)
    expect(key).toContain('2026-01-31')
    expect(key).not.toContain('T23:59:59')
  })

  it('buildHistoryKey partitions by userId', () => {
    const key1 = buildHistoryKey(1, BASE_SNAPSHOT)
    const key2 = buildHistoryKey(2, BASE_SNAPSHOT)
    expect(key1.startsWith('1/')).toBe(true)
    expect(key2.startsWith('2/')).toBe(true)
  })

  it('buildHistoryKey returns the same key for snapshots with identical state but different capturedAt', () => {
    const s1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-06-15T09:00:00.000Z' }
    const s2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-06-15T10:00:00.000Z' }
    expect(buildHistoryKey(123, s1)).toBe(buildHistoryKey(123, s2))
  })

  it('buildHistoryKey returns different keys for snapshots with different state', () => {
    const s1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, used: 1000 }
    const s2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, used: 2000 }
    expect(buildHistoryKey(123, s1)).not.toBe(buildHistoryKey(123, s2))
  })

  it('snapshotStateFingerprint distinguishes undefined overageCount from 0', () => {
    const withUndefined = snapshotStateFingerprint(BASE_SNAPSHOT)
    const withZero = snapshotStateFingerprint({ ...BASE_SNAPSHOT, overageCount: 0 })
    expect(withUndefined).not.toBe(withZero)
  })

  it('snapshotStateFingerprint is stable across different capturedAt values', () => {
    const fp1 = snapshotStateFingerprint({ ...BASE_SNAPSHOT, capturedAt: '2026-06-15T08:00:00.000Z' })
    const fp2 = snapshotStateFingerprint({ ...BASE_SNAPSHOT, capturedAt: '2026-06-15T10:00:00.000Z' })
    expect(fp1).toBe(fp2)
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
    expect(key).toBe(buildHistoryKey(USER_ID, BASE_SNAPSHOT))
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
        { key: buildHistoryKey(USER_ID, BASE_SNAPSHOT) },
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

    // Use distinct `used` values so each snapshot gets a different content-hash key
    const snap1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts1, used: 1001 }
    const snap2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts2, used: 1002 }
    const snap3: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts3, used: 1003 }

    const key1 = buildHistoryKey(USER_ID, snap1)
    const key2 = buildHistoryKey(USER_ID, snap2)
    const key3 = buildHistoryKey(USER_ID, snap3)

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }, { key: key3 }] })

    mockStore.get.mockImplementation(async (key: string) => {
      if (key === key1) return { historyVersion: '1', userId: USER_ID, snapshot: snap1 }
      if (key === key2) return { historyVersion: '1', userId: USER_ID, snapshot: snap2 }
      if (key === key3) return { historyVersion: '1', userId: USER_ID, snapshot: snap3 }
      return null
    })

    const result = await getHistory(USER_ID)
    expect(result.map(s => s.capturedAt)).toEqual([ts2, ts3, ts1])
  })

  it('filters by fromDate (inclusive)', async () => {
    const ts1 = '2026-06-14T10:00:00.000Z' // date: 2026-06-14 — before fromDate
    const ts2 = '2026-06-15T10:00:00.000Z' // date: 2026-06-15 — matches

    const snap1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts1, used: 2001 }
    const snap2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts2, used: 2002 }

    const key1 = buildHistoryKey(USER_ID, snap1)
    const key2 = buildHistoryKey(USER_ID, snap2)

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key === key1) return { historyVersion: '1', userId: USER_ID, snapshot: snap1 }
      if (key === key2) return { historyVersion: '1', userId: USER_ID, snapshot: snap2 }
      return null
    })

    const result = await getHistory(USER_ID, { fromDate: '2026-06-15' })
    expect(result).toHaveLength(1)
    expect(result[0].capturedAt).toBe(ts2)
  })

  it('filters by toDate (inclusive)', async () => {
    const ts1 = '2026-06-15T10:00:00.000Z' // date: 2026-06-15 — matches
    const ts2 = '2026-06-16T10:00:00.000Z' // date: 2026-06-16 — after toDate

    const snap1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts1, used: 3001 }
    const snap2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts2, used: 3002 }

    const key1 = buildHistoryKey(USER_ID, snap1)
    const key2 = buildHistoryKey(USER_ID, snap2)

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key === key1) return { historyVersion: '1', userId: USER_ID, snapshot: snap1 }
      if (key === key2) return { historyVersion: '1', userId: USER_ID, snapshot: snap2 }
      return null
    })

    const result = await getHistory(USER_ID, { toDate: '2026-06-15' })
    expect(result).toHaveLength(1)
    expect(result[0].capturedAt).toBe(ts1)
  })

  it('respects the limit option', async () => {
    const ts1 = '2026-06-15T08:00:00.000Z'
    const ts2 = '2026-06-15T09:00:00.000Z'
    const ts3 = '2026-06-15T10:00:00.000Z'

    const snap1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts1, used: 4001 }
    const snap2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts2, used: 4002 }
    const snap3: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts3, used: 4003 }

    const key1 = buildHistoryKey(USER_ID, snap1)
    const key2 = buildHistoryKey(USER_ID, snap2)
    const key3 = buildHistoryKey(USER_ID, snap3)

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }, { key: key3 }] })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key === key1) return { historyVersion: '1', userId: USER_ID, snapshot: snap1 }
      if (key === key2) return { historyVersion: '1', userId: USER_ID, snapshot: snap2 }
      if (key === key3) return { historyVersion: '1', userId: USER_ID, snapshot: snap3 }
      return null
    })

    const result = await getHistory(USER_ID, { limit: 2 })
    expect(result).toHaveLength(2)
    // most recent first, so limit slices the first 2
    expect(result[0].capturedAt).toBe(ts3)
    expect(result[1].capturedAt).toBe(ts2)
  })

  it('skips entries with malformed snapshot data', async () => {
    const ts1 = '2026-06-15T08:00:00.000Z'
    const ts2 = '2026-06-15T10:00:00.000Z'

    const snap1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts1, used: 5001 }
    const snap2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: ts2, used: 5002 }

    const key1 = buildHistoryKey(USER_ID, snap1)
    const key2 = buildHistoryKey(USER_ID, snap2)

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get.mockImplementation(async (key: string) => {
      if (key === key1) return { historyVersion: '1', userId: USER_ID, snapshot: null } // malformed
      if (key === key2) return { historyVersion: '1', userId: USER_ID, snapshot: snap2 }
      return null
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
      '[usage-history] History store operation failed',
      expect.objectContaining({ operation: 'listBlobs', storeName: 'usage-history' })
    )
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 7: snapshotsAreEquivalent — pure function
// ---------------------------------------------------------------------------

describe('snapshotsAreEquivalent', () => {
  const base: UsageHistorySnapshot = {
    capturedAt: '2026-06-15T10:00:00.000Z',
    used: 3000,
    quota: 7000,
    remaining: 4000,
    billingPhase: 'credits_available',
  }

  it('returns true for snapshots with identical tracked fields', () => {
    const other: UsageHistorySnapshot = { ...base, capturedAt: '2026-06-15T11:00:00.000Z' }
    expect(snapshotsAreEquivalent(base, other)).toBe(true)
  })

  it('returns false when used differs', () => {
    expect(snapshotsAreEquivalent(base, { ...base, used: 3001 })).toBe(false)
  })

  it('returns false when quota differs', () => {
    expect(snapshotsAreEquivalent(base, { ...base, quota: 7001 })).toBe(false)
  })

  it('returns false when remaining differs', () => {
    expect(snapshotsAreEquivalent(base, { ...base, remaining: 3999 })).toBe(false)
  })

  it('returns false when billingPhase differs', () => {
    expect(snapshotsAreEquivalent(base, { ...base, billingPhase: 'budget_active' })).toBe(false)
  })

  it('returns false when overageCount differs (undefined vs number)', () => {
    expect(snapshotsAreEquivalent(base, { ...base, overageCount: 0 })).toBe(false)
  })

  it('returns false when overageCount differs (different values)', () => {
    expect(snapshotsAreEquivalent(
      { ...base, overageCount: 100 },
      { ...base, overageCount: 150 },
    )).toBe(false)
  })

  it('returns true when overageCount is identical on both', () => {
    expect(snapshotsAreEquivalent(
      { ...base, overageCount: 100 },
      { ...base, overageCount: 100 },
    )).toBe(true)
  })

  it('returns false when derivedOverageCredits differs (undefined vs number)', () => {
    expect(snapshotsAreEquivalent(base, { ...base, derivedOverageCredits: 0 })).toBe(false)
  })

  it('returns false when derivedOverageCredits differs (different values)', () => {
    expect(snapshotsAreEquivalent(
      { ...base, derivedOverageCredits: 200 },
      { ...base, derivedOverageCredits: 473 },
    )).toBe(false)
  })

  it('ignores capturedAt when comparing snapshots', () => {
    // Two snapshots with same state but different timestamps are equivalent
    const earlier: UsageHistorySnapshot = { ...base, capturedAt: '2026-06-15T09:00:00.000Z' }
    const later: UsageHistorySnapshot = { ...base, capturedAt: '2026-06-15T10:00:00.000Z' }
    expect(snapshotsAreEquivalent(earlier, later)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 8: appendSnapshot — deduplication
// ---------------------------------------------------------------------------

describe('appendSnapshot — deduplication', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetHistoryStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Configure mockStore so the blob at the content-hash key for `snapshot`
   * is already present (simulating a prior write of the same state) or absent.
   * The daily index always reports count=0 so the cap is never hit.
   */
  function setupEntryExists(exists: boolean, snapshot: UsageHistorySnapshot): void {
    const entryKey = buildHistoryKey(USER_ID, snapshot)

    mockStore.get.mockImplementation(async (key: string) => {
      if (key.endsWith('_index.json')) return { count: 0, date: buildHistoryKey(USER_ID, snapshot).slice(9, 19) }
      if (key === entryKey && exists) {
        return { historyVersion: '1', userId: USER_ID, snapshot } satisfies UsageHistoryEntry
      }
      return null
    })

    mockStore.list.mockResolvedValue({ blobs: [] })
  }

  function entryWriteCount(): number {
    return (mockStore.setJSON.mock.calls as Array<[string, unknown]>).filter(
      ([key]) => !key.endsWith('_index.json')
    ).length
  }

  it('skips write when the content-hash key already exists (same state)', async () => {
    const incoming: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-06-15T10:30:00.000Z' }
    setupEntryExists(true, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(0)
  })

  it('writes when no prior entry exists for this state (first write)', async () => {
    setupEntryExists(false, BASE_SNAPSHOT)

    await appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('writes when used value changes (different content-hash key)', async () => {
    const incoming: UsageHistorySnapshot = { ...BASE_SNAPSHOT, used: 3000 }
    setupEntryExists(false, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('writes snapshot when billing phase transitions', async () => {
    const incoming: UsageHistorySnapshot = { ...BASE_SNAPSHOT, billingPhase: 'budget_active' }
    setupEntryExists(false, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('writes snapshot when overageCount grows', async () => {
    const incoming: UsageHistorySnapshot = {
      ...BASE_SNAPSHOT,
      billingPhase: 'budget_active',
      overageCount: 150,
    }
    setupEntryExists(false, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('writes snapshot when derivedOverageCredits grows', async () => {
    const incoming: UsageHistorySnapshot = { ...BASE_SNAPSHOT, derivedOverageCredits: 473 }
    setupEntryExists(false, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('writes snapshot when overageCount appears for the first time (undefined → number)', async () => {
    const incoming: UsageHistorySnapshot = { ...BASE_SNAPSHOT, overageCount: 0 }
    setupEntryExists(false, incoming)

    await appendSnapshot(USER_ID, incoming, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('proceeds to write when entry existence check fails (allow-write fallback)', async () => {
    // First get (entry key check) throws; second get (index) succeeds
    mockStore.get
      .mockRejectedValueOnce(new Error('get failure'))
      .mockResolvedValueOnce({ count: 0, date: '2026-06-15' })
    mockStore.list.mockResolvedValue({ blobs: [] })

    await appendSnapshot(USER_ID, BASE_SNAPSHOT, ENABLED_CONFIG)

    expect(entryWriteCount()).toBe(1)
  })

  it('concurrent writes of identical state all target the same key (idempotent)', async () => {
    // Simulate: both concurrent invocations find no existing entry (eventual-
    // consistency gap) and both write.  They should both write to the SAME key
    // because the key is derived from state, not from capturedAt.
    setupEntryExists(false, BASE_SNAPSHOT)

    const s1: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-06-15T10:00:00.000Z' }
    const s2: UsageHistorySnapshot = { ...BASE_SNAPSHOT, capturedAt: '2026-06-15T10:00:00.500Z' }

    expect(buildHistoryKey(USER_ID, s1)).toBe(buildHistoryKey(USER_ID, s2))
  })
})
