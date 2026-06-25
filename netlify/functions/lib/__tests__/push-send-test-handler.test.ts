/**
 * Contract tests for the /api/push/test handler (push-send-test.ts).
 *
 * Verified contracts:
 * 1. Returns 405 for non-POST methods (GET, PUT, etc.) — sends are user-initiated only.
 * 2. Returns 401 when not authenticated.
 * 3. Returns 503 when VAPID config is missing.
 * 4. Returns 404 when the user has no subscriptions.
 * 5. Returns 200 with sent: true when push delivery succeeds.
 * 6. Returns 500 when all deliveries fail (provider error).
 * 7. Returns 500 with "expired" message when all subscriptions are expired.
 * 8. Returns 200 (partial success) when at least one delivery succeeds.
 * 9. Calls sendPushNotification with the test notification title and body.
 * 10. Does NOT send on page load — GET returns 405 immediately.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerEvent } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { signSession } from '../session'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn(),
}))

const mockSendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: { sendNotification: mockSendNotification },
}))

// ---------------------------------------------------------------------------
// Test fixtures
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

function makeEvent(overrides: Partial<HandlerEvent> = {}): HandlerEvent {
  return {
    httpMethod: 'POST',
    path: '/api/push/test',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    rawUrl: 'http://localhost/api/push/test',
    rawQuery: '',
    ...overrides,
  }
}

const SESSION_SECRET = 'test-secret-push-test'
const USER_ID = 43296127

function makeSessionCookie(): string {
  return `session=${encodeURIComponent(
    signSession({ login: 'testuser', id: USER_ID, accessToken: 'fake-token' }, SESSION_SECRET),
  )}`
}

const SUBSCRIPTION_RECORD = {
  subscriptionVersion: '1',
  userId: USER_ID,
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-sub',
  keys: { p256dh: 'BPm8s4z_valid_p256dh', auth: 'qK8Hx_valid_auth' },
  createdAt: '2026-06-25T10:00:00.000Z',
  updatedAt: '2026-06-25T10:00:00.000Z',
}

const BLOB_KEY = `${USER_ID}/abc123.json`

// ---------------------------------------------------------------------------
// Helpers to configure env
// ---------------------------------------------------------------------------

function setVapidConfig(): void {
  process.env['VAPID_PUBLIC_KEY'] = 'BPm8s4z_test_public_key'
  process.env['VAPID_PRIVATE_KEY'] = 'test-private-key-placeholder'
  process.env['VAPID_SUBJECT'] = 'mailto:test@example.com'
}

function clearVapidConfig(): void {
  delete process.env['VAPID_PUBLIC_KEY']
  delete process.env['VAPID_PRIVATE_KEY']
  delete process.env['VAPID_SUBJECT']
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStore: MockStore

beforeEach(() => {
  mockStore = makeMockStore()
  vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  process.env['SESSION_SECRET'] = SESSION_SECRET
  clearVapidConfig()
  mockSendNotification.mockReset()
})

// ---------------------------------------------------------------------------
// Contract 1 & 10: non-POST methods are rejected
// ---------------------------------------------------------------------------

describe('method guard', () => {
  it('returns 405 for GET — does not send on page load', async () => {
    const { handler } = await import('../../push-send-test')
    const result = await handler(makeEvent({ httpMethod: 'GET' }), {} as never)
    expect(result!.statusCode).toBe(405)
    expect(result!.headers!['allow']).toBe('POST')
    // sendNotification must not be called for GET requests
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns 405 for PUT', async () => {
    const { handler } = await import('../../push-send-test')
    const result = await handler(makeEvent({ httpMethod: 'PUT' }), {} as never)
    expect(result!.statusCode).toBe(405)
  })

  it('returns 405 for DELETE', async () => {
    const { handler } = await import('../../push-send-test')
    const result = await handler(makeEvent({ httpMethod: 'DELETE' }), {} as never)
    expect(result!.statusCode).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// Contract 2: auth boundary
// ---------------------------------------------------------------------------

describe('auth boundary', () => {
  it('returns 401 when no session cookie', async () => {
    setVapidConfig()
    const { handler } = await import('../../push-send-test')
    const result = await handler(makeEvent(), {} as never)
    expect(result!.statusCode).toBe(401)
  })

  it('returns 401 when SESSION_SECRET is missing', async () => {
    setVapidConfig()
    delete process.env['SESSION_SECRET']
    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Contract 3: config missing → 503
// ---------------------------------------------------------------------------

describe('VAPID config missing', () => {
  it('returns 503 when VAPID environment variables are not configured', async () => {
    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(503)
    const body = JSON.parse(result!.body!) as { error: string }
    expect(body.error).toMatch(/not configured/i)
  })

  it('does not call sendNotification when config is missing', async () => {
    const { handler } = await import('../../push-send-test')
    await handler(makeEvent({ headers: { cookie: makeSessionCookie() } }), {} as never)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Contract 4: no subscriptions → 404
// ---------------------------------------------------------------------------

describe('no subscriptions', () => {
  it('returns 404 when the user has no subscriptions', async () => {
    setVapidConfig()
    // list returns no blobs → no subscriptions
    mockStore.list.mockResolvedValue({ blobs: [] })

    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(404)
    const body = JSON.parse(result!.body!) as { error: string }
    expect(body.error).toMatch(/no push subscriptions/i)
  })

  it('does not call sendNotification when no subscriptions exist', async () => {
    setVapidConfig()
    mockStore.list.mockResolvedValue({ blobs: [] })

    const { handler } = await import('../../push-send-test')
    await handler(makeEvent({ headers: { cookie: makeSessionCookie() } }), {} as never)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Contract 5: successful delivery → 200
// ---------------------------------------------------------------------------

describe('successful delivery', () => {
  beforeEach(() => {
    setVapidConfig()
    mockStore.list.mockResolvedValue({ blobs: [{ key: BLOB_KEY }] })
    mockStore.get.mockResolvedValue(SUBSCRIPTION_RECORD)
    mockSendNotification.mockResolvedValue({ statusCode: 201 })
  })

  it('returns 200 with sent: true', async () => {
    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
    const body = JSON.parse(result!.body!) as { sent: boolean; successCount: number }
    expect(body.sent).toBe(true)
    expect(body.successCount).toBe(1)
  })

  it('calls sendNotification with the test notification content', async () => {
    const { handler } = await import('../../push-send-test')
    await handler(makeEvent({ headers: { cookie: makeSessionCookie() } }), {} as never)

    expect(mockSendNotification).toHaveBeenCalledOnce()
    const [, payloadArg] = mockSendNotification.mock.calls[0] as [unknown, string, unknown]
    const parsed = JSON.parse(payloadArg) as { title: string; body: string }
    expect(parsed.title).toBe('CopeLimit test notification')
    expect(parsed.body).toBe('Notifications are working for this browser.')
  })

  it('calls sendNotification with the subscription endpoint', async () => {
    const { handler } = await import('../../push-send-test')
    await handler(makeEvent({ headers: { cookie: makeSessionCookie() } }), {} as never)

    const [subscription] = mockSendNotification.mock.calls[0] as [
      { endpoint: string; keys: { p256dh: string; auth: string } },
      ...unknown[]
    ]
    expect(subscription.endpoint).toBe(SUBSCRIPTION_RECORD.endpoint)
    expect(subscription.keys.p256dh).toBe(SUBSCRIPTION_RECORD.keys.p256dh)
    expect(subscription.keys.auth).toBe(SUBSCRIPTION_RECORD.keys.auth)
  })
})

// ---------------------------------------------------------------------------
// Contract 6 & 7: all deliveries fail → 500
// ---------------------------------------------------------------------------

describe('all deliveries fail', () => {
  function makeStatusError(statusCode: number): Error & { statusCode: number } {
    const err = new Error(`Push error ${statusCode}`) as Error & { statusCode: number }
    err.statusCode = statusCode
    return err
  }

  beforeEach(() => {
    setVapidConfig()
    mockStore.list.mockResolvedValue({ blobs: [{ key: BLOB_KEY }] })
    mockStore.get.mockResolvedValue(SUBSCRIPTION_RECORD)
  })

  it('returns 500 when the push provider fails', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(500))

    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(500)
    const body = JSON.parse(result!.body!) as { error: string; successCount: number }
    expect(body.successCount).toBe(0)
  })

  it('returns 500 with an "expired" message when subscription is gone (410)', async () => {
    mockSendNotification.mockRejectedValue(makeStatusError(410))

    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(500)
    const body = JSON.parse(result!.body!) as { error: string }
    expect(body.error).toMatch(/expired/i)
  })
})

// ---------------------------------------------------------------------------
// Contract 8: partial success → 200
// ---------------------------------------------------------------------------

describe('partial success', () => {
  it('returns 200 when at least one delivery succeeds', async () => {
    setVapidConfig()

    const key1 = `${USER_ID}/sub1.json`
    const key2 = `${USER_ID}/sub2.json`
    const rec2 = { ...SUBSCRIPTION_RECORD, endpoint: 'https://push.example.com/sub2' }

    mockStore.list.mockResolvedValue({ blobs: [{ key: key1 }, { key: key2 }] })
    mockStore.get
      .mockResolvedValueOnce(SUBSCRIPTION_RECORD)
      .mockResolvedValueOnce(rec2)

    const statusErr = new Error('Push error 500') as Error & { statusCode: number }
    statusErr.statusCode = 500
    // First succeeds, second fails
    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(statusErr)

    const { handler } = await import('../../push-send-test')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
    const body = JSON.parse(result!.body!) as { sent: boolean; successCount: number; failCount: number }
    expect(body.sent).toBe(true)
    expect(body.successCount).toBe(1)
    expect(body.failCount).toBe(1)
  })
})
