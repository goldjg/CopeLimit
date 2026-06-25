/**
 * Contract tests for netlify/functions/lib/push-sender.ts.
 *
 * Verified contracts:
 * 1. Returns `{ ok: true }` when web-push.sendNotification resolves successfully.
 * 2. Returns `{ ok: false, reason: 'expired' }` when the push service returns 410.
 * 3. Returns `{ ok: false, reason: 'expired' }` when the push service returns 404.
 * 4. Returns `{ ok: false, reason: 'provider_error', statusCode }` for other HTTP errors.
 * 5. Returns `{ ok: false, reason: 'send_failed' }` when the library throws a non-status error.
 * 6. Passes the correct endpoint, keys, and VAPID details to sendNotification.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushConfig } from '../push-config'
import type { PushSubscriptionRecord } from '../push-subscription-types'

// ---------------------------------------------------------------------------
// Mock web-push before importing the module under test
// ---------------------------------------------------------------------------

const mockSendNotification = vi.fn()

vi.mock('web-push', () => ({
  default: { sendNotification: mockSendNotification },
}))

// Import after mocking
const { sendPushNotification } = await import('../push-sender')

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RECORD: PushSubscriptionRecord = {
  subscriptionVersion: '1',
  userId: 12345,
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-abc123',
  keys: { p256dh: 'BPm8s4z_valid_p256dh_key', auth: 'qK8Hx_valid_auth' },
  createdAt: '2026-06-25T10:00:00.000Z',
  updatedAt: '2026-06-25T10:00:00.000Z',
}

const CONFIG: PushConfig & { isConfigured: true } = {
  isConfigured: true,
  vapidPublicKey: 'BPm8s4z_test_public_key',
  vapidPrivateKey: 'test-private-key',
  vapidSubject: 'mailto:test@example.com',
}

const PAYLOAD = {
  title: 'CopeLimit test notification',
  body: 'Notifications are working for this browser.',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`WebPush error ${statusCode}`) as Error & { statusCode: number }
  err.statusCode = statusCode
  return err
}

beforeEach(() => {
  mockSendNotification.mockReset()
})

// ---------------------------------------------------------------------------
// Contract 1: successful delivery
// ---------------------------------------------------------------------------

describe('sendPushNotification — success', () => {
  it('returns { ok: true } when sendNotification resolves', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201 })
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Contract 2 & 3: expired subscription
// ---------------------------------------------------------------------------

describe('sendPushNotification — expired subscription', () => {
  it('returns { ok: false, reason: "expired" } when push service returns 410', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(410))
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('returns { ok: false, reason: "expired" } when push service returns 404', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(404))
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })
})

// ---------------------------------------------------------------------------
// Contract 4: provider error (non-expired HTTP error)
// ---------------------------------------------------------------------------

describe('sendPushNotification — provider error', () => {
  it('returns { ok: false, reason: "provider_error", statusCode } for 429', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(429))
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'provider_error', statusCode: 429 })
  })

  it('returns { ok: false, reason: "provider_error", statusCode } for 500', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(500))
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'provider_error', statusCode: 500 })
  })
})

// ---------------------------------------------------------------------------
// Contract 5: non-status error (network failure etc.)
// ---------------------------------------------------------------------------

describe('sendPushNotification — send failed', () => {
  it('returns { ok: false, reason: "send_failed" } for a plain Error', async () => {
    mockSendNotification.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'send_failed' })
  })

  it('returns { ok: false, reason: "send_failed" } for a non-Error throw', async () => {
    mockSendNotification.mockRejectedValue('something went wrong')
    const result = await sendPushNotification(RECORD, CONFIG, PAYLOAD)
    expect(result).toEqual({ ok: false, reason: 'send_failed' })
  })
})

// ---------------------------------------------------------------------------
// Contract 6: correct arguments passed to sendNotification
// ---------------------------------------------------------------------------

describe('sendPushNotification — argument forwarding', () => {
  it('passes endpoint and keys from the record to sendNotification', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201 })
    await sendPushNotification(RECORD, CONFIG, PAYLOAD)

    expect(mockSendNotification).toHaveBeenCalledOnce()
    const [subscription] = mockSendNotification.mock.calls[0] as [
      { endpoint: string; keys: { p256dh: string; auth: string } },
      unknown,
      unknown,
    ]
    expect(subscription.endpoint).toBe(RECORD.endpoint)
    expect(subscription.keys.p256dh).toBe(RECORD.keys.p256dh)
    expect(subscription.keys.auth).toBe(RECORD.keys.auth)
  })

  it('passes the payload as a JSON string', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201 })
    await sendPushNotification(RECORD, CONFIG, PAYLOAD)

    const [, payloadArg] = mockSendNotification.mock.calls[0] as [unknown, string, unknown]
    const parsed = JSON.parse(payloadArg) as typeof PAYLOAD
    expect(parsed.title).toBe(PAYLOAD.title)
    expect(parsed.body).toBe(PAYLOAD.body)
  })

  it('passes the VAPID details from config', async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201 })
    await sendPushNotification(RECORD, CONFIG, PAYLOAD)

    const [, , options] = mockSendNotification.mock.calls[0] as [
      unknown,
      unknown,
      { vapidDetails: { subject: string; publicKey: string; privateKey: string } },
    ]
    expect(options.vapidDetails.subject).toBe(CONFIG.vapidSubject)
    expect(options.vapidDetails.publicKey).toBe(CONFIG.vapidPublicKey)
    expect(options.vapidDetails.privateKey).toBe(CONFIG.vapidPrivateKey)
  })
})
