/**
 * @file Contract tests for push-preferences-store.ts
 *
 * Verified contracts:
 * 1. Defaults are returned when no stored value exists.
 * 2. Clamp: burnRateIncreasePercentThreshold is clamped to [1, 500].
 * 3. Clamp: projectedExhaustionThresholdHours is clamped to [1, 168].
 * 4. Invalid userId returns defaults without touching the blob store.
 * 5. setPushUserPreferences merges partial update and stores correctly.
 * 6. normalizePreferences returns defaults for null/non-object input.
 * 7. getPushUserNotificationState returns empty state when no stored value.
 * 8. setPushUserNotificationState stores and returns true for valid userId.
 * 9. boolOrDefault: non-boolean values fall through to the fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import {
  DEFAULT_PUSH_USER_PREFERENCES,
  getPushUserNotificationState,
  getPushUserPreferences,
  setPushUserNotificationState,
  setPushUserPreferences,
  type PushUserNotificationState,
} from '../push-preferences-store'

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(getResult: unknown = null, setJsonSpy = vi.fn()) {
  const store = {
    get: vi.fn().mockResolvedValue(getResult),
    setJSON: setJsonSpy,
  }
  ;(getStore as ReturnType<typeof vi.fn>).mockReturnValue(store)
  return store
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getPushUserPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
    })
  })

  it('contract 1: returns defaults when blob store has no entry', async () => {
    makeStore(null)
    const prefs = await getPushUserPreferences(42)
    expect(prefs.notifyOnStatusLevelChange).toBe(true)
    expect(prefs.notifyWhenStatusBecomesHot).toBe(true)
    expect(prefs.notifyWhenStatusBecomesOverage).toBe(true)
    expect(prefs.notifyWhenStatusBecomesBlocked).toBe(true)
    expect(prefs.projectedExhaustionThresholdHours).toBe(24)
    expect(prefs.burnRateIncreasePercentThreshold).toBe(25)
  })

  it('contract 4: returns defaults without calling store for invalid userId', async () => {
    const store = makeStore(null)
    const prefs = await getPushUserPreferences(0)
    expect(store.get).not.toHaveBeenCalled()
    expect(prefs).toEqual(expect.objectContaining(DEFAULT_PUSH_USER_PREFERENCES))
  })

  it('contract 6: returns defaults when stored value is null', async () => {
    makeStore(null)
    const prefs = await getPushUserPreferences(5)
    expect(prefs.burnRateIncreasePercentThreshold).toBe(25)
  })

  it('contract 6: returns defaults when stored value is an array', async () => {
    makeStore([])
    const prefs = await getPushUserPreferences(5)
    expect(prefs.burnRateIncreasePercentThreshold).toBe(25)
  })

  it('contract 2: clamps burnRateIncreasePercentThreshold above max', async () => {
    makeStore({
      ...DEFAULT_PUSH_USER_PREFERENCES,
      burnRateIncreasePercentThreshold: 9999,
    })
    const prefs = await getPushUserPreferences(1)
    expect(prefs.burnRateIncreasePercentThreshold).toBe(500)
  })

  it('contract 2: clamps burnRateIncreasePercentThreshold below min', async () => {
    makeStore({
      ...DEFAULT_PUSH_USER_PREFERENCES,
      burnRateIncreasePercentThreshold: 0,
    })
    const prefs = await getPushUserPreferences(1)
    expect(prefs.burnRateIncreasePercentThreshold).toBe(1)
  })

  it('contract 3: clamps projectedExhaustionThresholdHours above max', async () => {
    makeStore({
      ...DEFAULT_PUSH_USER_PREFERENCES,
      projectedExhaustionThresholdHours: 999,
    })
    const prefs = await getPushUserPreferences(1)
    expect(prefs.projectedExhaustionThresholdHours).toBe(168)
  })

  it('contract 3: clamps projectedExhaustionThresholdHours below min', async () => {
    makeStore({
      ...DEFAULT_PUSH_USER_PREFERENCES,
      projectedExhaustionThresholdHours: 0,
    })
    const prefs = await getPushUserPreferences(1)
    expect(prefs.projectedExhaustionThresholdHours).toBe(1)
  })

  it('contract 9: non-boolean booleans fall through to default', async () => {
    makeStore({
      ...DEFAULT_PUSH_USER_PREFERENCES,
      notifyWhenStatusBecomesHot: 'yes',   // not a boolean
      notifyWhenStatusBecomesOverage: 1,   // not a boolean
    })
    const prefs = await getPushUserPreferences(1)
    // defaults are true; non-boolean falls through to default
    expect(prefs.notifyWhenStatusBecomesHot).toBe(true)
    expect(prefs.notifyWhenStatusBecomesOverage).toBe(true)
  })
})

describe('setPushUserPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
    })
  })

  it('contract 5: merges partial update over current stored value', async () => {
    const setJsonSpy = vi.fn().mockResolvedValue(undefined)
    makeStore(
      { ...DEFAULT_PUSH_USER_PREFERENCES, burnRateIncreasePercentThreshold: 30 },
      setJsonSpy,
    )
    const result = await setPushUserPreferences(7, {
      burnRateIncreasePercentThreshold: 50,
    })
    expect(result).not.toBeNull()
    expect(result!.burnRateIncreasePercentThreshold).toBe(50)
    expect(setJsonSpy).toHaveBeenCalledOnce()
  })

  it('contract 4: returns null without calling store for invalid userId', async () => {
    const store = makeStore(null)
    const result = await setPushUserPreferences(-1, {})
    expect(result).toBeNull()
    expect(store.get).not.toHaveBeenCalled()
    expect(store.setJSON).not.toHaveBeenCalled()
  })

  it('contract 5: stored value passes through clamp on merge', async () => {
    const setJsonSpy = vi.fn().mockResolvedValue(undefined)
    makeStore(null, setJsonSpy) // null → defaults
    const result = await setPushUserPreferences(3, {
      projectedExhaustionThresholdHours: 200, // over max 168
    })
    expect(result!.projectedExhaustionThresholdHours).toBe(168)
  })
})

describe('getPushUserNotificationState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
    })
  })

  it('contract 7: returns empty state when no stored value', async () => {
    makeStore(null)
    const s = await getPushUserNotificationState(1)
    expect(s.lastComfortLevel).toBeNull()
    expect(s.lastBurnRatePerHour).toBeNull()
    expect(s.lastAlertDedupeKey).toBeNull()
    expect(s.lastExhaustionWithinThreshold).toBe(false)
    expect(s.lastCustomDedupeKey).toBeNull()
  })

  it('contract 4: returns empty state without hitting store for invalid userId', async () => {
    const store = makeStore(null)
    await getPushUserNotificationState(0)
    expect(store.get).not.toHaveBeenCalled()
  })
})

describe('setPushUserNotificationState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
    })
  })

  it('contract 8: returns true and calls setJSON for valid userId', async () => {
    const setJsonSpy = vi.fn().mockResolvedValue(undefined)
    makeStore(null, setJsonSpy)
    const st: PushUserNotificationState = {
      lastComfortLevel: 'hot',
      lastBurnRatePerHour: 5,
      lastAlertDedupeKey: 'key-abc',
      lastExhaustionWithinThreshold: true,
      lastCustomDedupeKey: 'status:hot:2025-07-01',
      updatedAt: new Date().toISOString(),
    }
    const result = await setPushUserNotificationState(10, st)
    expect(result).toBe(true)
    expect(setJsonSpy).toHaveBeenCalledOnce()
    const storedArg = setJsonSpy.mock.calls[0][1]
    expect(storedArg.lastComfortLevel).toBe('hot')
    expect(storedArg.lastExhaustionWithinThreshold).toBe(true)
  })

  it('contract 4: returns false for invalid userId', async () => {
    const store = makeStore(null)
    const result = await setPushUserNotificationState(NaN, {
      lastComfortLevel: null,
      lastBurnRatePerHour: null,
      lastAlertDedupeKey: null,
      lastExhaustionWithinThreshold: false,
      lastCustomDedupeKey: null,
      updatedAt: new Date().toISOString(),
    })
    expect(result).toBe(false)
    expect(store.setJSON).not.toHaveBeenCalled()
  })
})
