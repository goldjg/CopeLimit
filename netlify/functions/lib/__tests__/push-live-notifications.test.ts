/**
 * @file Contract tests for push-live-notifications.ts
 *
 * Verified contracts:
 * 1. No push is sent when userId is invalid.
 * 2. alertDecision trigger: sends when dedupeKey is new and preference allows.
 * 3. alertDecision trigger: suppressed when dedupeKey is a duplicate.
 * 4. alertDecision trigger: suppressed when preference disallows the alert type.
 * 5. Status transition trigger: sends on first entry to 'hot'.
 * 6. Status transition trigger: suppressed when same-day dedupe key matches.
 * 7. Status transition trigger: does not fire for safe/watch transitions (not in preference filter).
 * 8. Exhaustion threshold trigger: sends when first crossing into threshold.
 * 9. Exhaustion threshold trigger: suppressed when already within threshold.
 * 10. Burn rate increase trigger: sends when increase >= configured threshold.
 * 11. Burn rate increase trigger: suppressed when increase < threshold.
 * 12. No subscriptions: skips send and still updates baseline state.
 * 13. Baseline state is refreshed even when no push is sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import { maybeSendLivePushNotification } from '../push-live-notifications'
import type { ComfortStatus } from '../comfort-status'
import type { BurnRateProjection } from '../burn-rate-projection'
import type { AlertDecision } from '../alert-decision'
import type { PushUserPreferences, PushUserNotificationState } from '../push-preferences-store'
import type { PushSubscriptionRecord } from '../push-subscription-types'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn(),
}))

vi.mock('../push-config', () => ({
  readPushConfig: vi.fn(() => ({
    isConfigured: true,
    vapidPublicKey: 'test-pubkey',
    vapidPrivateKey: 'test-privkey',
    vapidSubject: 'mailto:test@example.com',
  })),
}))

vi.mock('../push-sender', () => ({
  sendPushNotification: vi.fn().mockResolvedValue({ ok: true }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { sendPushNotification } from '../push-sender'

const DEFAULT_PREFS: PushUserPreferences = {
  notifyOnStatusLevelChange: true,
  notifyWhenStatusBecomesHot: true,
  notifyWhenStatusBecomesOverage: true,
  notifyWhenStatusBecomesBlocked: true,
  notifyWhenProjectedExhaustionWithinHours: true,
  projectedExhaustionThresholdHours: 24,
  notifyOnBurnRateIncrease: true,
  burnRateIncreasePercentThreshold: 25,
  updatedAt: '2025-01-01T00:00:00.000Z',
}

const EMPTY_STATE: PushUserNotificationState = {
  lastComfortLevel: null,
  lastBurnRatePerHour: null,
  lastAlertDedupeKey: null,
  lastExhaustionWithinThreshold: false,
  lastCustomDedupeKey: null,
  updatedAt: '2025-01-01T00:00:00.000Z',
}

const SAFE_STATUS: ComfortStatus = {
  level: 'safe',
  summary: 'All good',
  primarySignal: 'remaining',
}

const HOT_STATUS: ComfortStatus = {
  level: 'hot',
  summary: 'Usage is hot',
  primarySignal: 'burn_rate',
}

const SUBSCRIPTION: PushSubscriptionRecord = {
  subscriptionVersion: '1',
  userId: 1,
  endpoint: 'https://push.example.com/send/sub-1',
  keys: { p256dh: 'abc', auth: 'xyz' },
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
}

function makeBlobStoreWith({
  prefs = DEFAULT_PREFS,
  state = EMPTY_STATE,
  subscriptions = [SUBSCRIPTION],
}: {
  prefs?: PushUserPreferences;
  state?: PushUserNotificationState;
  subscriptions?: PushSubscriptionRecord[];
}) {
  const setJsonSpy = vi.fn().mockResolvedValue(undefined)
  const listSpy = vi.fn().mockResolvedValue({
    blobs: subscriptions.map((s) => ({
      key: `1/${Buffer.from(s.endpoint).toString('hex').slice(0, 16)}.json`,
    })),
  })
  const getSpy = vi.fn().mockImplementation((key: string, _opts?: unknown) => {
    if (key.startsWith('settings/')) return Promise.resolve(prefs)
    if (key.startsWith('state/')) return Promise.resolve(state)
    // subscription record
    return Promise.resolve(subscriptions[0] ?? null)
  })
  const store = { get: getSpy, setJSON: setJsonSpy, list: listSpy }
  ;(getStore as ReturnType<typeof vi.fn>).mockReturnValue(store)
  return { store, setJsonSpy, listSpy, getSpy }
}

function futureIso(plusHours: number): string {
  return new Date(Date.now() + plusHours * 3_600_000).toISOString()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maybeSendLivePushNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      siteID: 'test-site',
      token: 'test-token',
    })
  })

  it('contract 1: does nothing for invalid userId (0)', async () => {
    const { store } = makeBlobStoreWith({})
    await maybeSendLivePushNotification({
      userId: 0,
      comfortStatus: SAFE_STATUS,
    })
    expect(store.get).not.toHaveBeenCalled()
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 2: alertDecision trigger sends when dedupeKey is new and pref allows', async () => {
    makeBlobStoreWith({})
    const alertDecision: AlertDecision = {
      shouldAlert: true,
      alertType: 'overage_active',
      dedupeKey: 'overage:2025-07-01',
      reason: 'In overage',
      title: 'Overage',
      message: 'You are in overage',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
      alertDecision,
    })
    expect(sendPushNotification).toHaveBeenCalledOnce()
  })

  it('contract 3: alertDecision trigger suppressed when dedupeKey matches stored key', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastAlertDedupeKey: 'overage:2025-07-01' },
    })
    const alertDecision: AlertDecision = {
      shouldAlert: true,
      alertType: 'overage_active',
      dedupeKey: 'overage:2025-07-01',
      reason: 'In overage',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
      alertDecision,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 4: alertDecision trigger suppressed when preference disallows the type', async () => {
    makeBlobStoreWith({
      prefs: { ...DEFAULT_PREFS, notifyWhenStatusBecomesOverage: false },
    })
    const alertDecision: AlertDecision = {
      shouldAlert: true,
      alertType: 'overage_active',
      dedupeKey: 'overage:2025-07-02',
      reason: 'In overage',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
      alertDecision,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 5: status transition trigger sends on first entry to hot', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastComfortLevel: 'safe' },
    })
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
    })
    expect(sendPushNotification).toHaveBeenCalledOnce()
    const payload = (sendPushNotification as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(payload.title).toContain('hot')
  })

  it('contract 6: status transition suppressed by same-day custom dedupe key', async () => {
    const todayDedupeKey = `status:hot:${new Date().toISOString().slice(0, 10)}`
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastComfortLevel: 'safe', lastCustomDedupeKey: todayDedupeKey },
    })
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 7: status transition to safe does not fire (not in preference filter)', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastComfortLevel: 'hot' },
    })
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 8: exhaustion threshold trigger sends on first crossing', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastExhaustionWithinThreshold: false },
    })
    const projection: BurnRateProjection = {
      windowHours: 24,
      creditsUsedInWindow: 100,
      averageCreditsPerDay: 100,
      projectedExhaustionAt: futureIso(12), // 12 h < 24 h threshold
      projectionStatus: 'exhaustion_before_reset',
      projectionReason: 'test',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
      burnRateProjection: projection,
    })
    expect(sendPushNotification).toHaveBeenCalledOnce()
  })

  it('contract 9: exhaustion threshold suppressed when already within threshold', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastExhaustionWithinThreshold: true },
    })
    const projection: BurnRateProjection = {
      windowHours: 24,
      creditsUsedInWindow: 100,
      averageCreditsPerDay: 100,
      projectedExhaustionAt: futureIso(6), // still within threshold
      projectionStatus: 'exhaustion_before_reset',
      projectionReason: 'test',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
      burnRateProjection: projection,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 10: burn rate increase trigger sends when >= configured threshold', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastBurnRatePerHour: 4 },
    })
    const projection: BurnRateProjection = {
      windowHours: 24,
      creditsUsedInWindow: 144,
      averageCreditsPerDay: 4 * 1.5 * 24, // +50% — above 25% threshold
      projectionStatus: 'reset_before_exhaustion',
      projectionReason: 'test',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
      burnRateProjection: projection,
    })
    expect(sendPushNotification).toHaveBeenCalledOnce()
    const payload = (sendPushNotification as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(payload.title).toContain('burn rate')
  })

  it('contract 11: burn rate increase suppressed when increase < threshold', async () => {
    makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastBurnRatePerHour: 4 },
    })
    const projection: BurnRateProjection = {
      windowHours: 24,
      creditsUsedInWindow: 105.6,
      averageCreditsPerDay: 4 * 1.1 * 24, // +10% — below 25% threshold
      projectionStatus: 'reset_before_exhaustion',
      projectionReason: 'test',
    }
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
      burnRateProjection: projection,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it('contract 12: no subscriptions — skips send and updates baseline state', async () => {
    const { setJsonSpy } = makeBlobStoreWith({ subscriptions: [] })
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: HOT_STATUS,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
    // baseline state write should still happen
    expect(setJsonSpy).toHaveBeenCalled()
  })

  it('contract 13: baseline state is always refreshed when no push is sent', async () => {
    const { setJsonSpy } = makeBlobStoreWith({
      state: { ...EMPTY_STATE, lastComfortLevel: 'safe' },
      // no alertDecision; SAFE_STATUS → no status trigger
    })
    await maybeSendLivePushNotification({
      userId: 1,
      comfortStatus: SAFE_STATUS,
    })
    expect(sendPushNotification).not.toHaveBeenCalled()
    expect(setJsonSpy).toHaveBeenCalledOnce()
    const saved = setJsonSpy.mock.calls[0][1]
    expect(saved.lastComfortLevel).toBe('safe')
  })
})

