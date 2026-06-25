/**
 * Contract tests for the /api/push/subscribe handler.
 *
 * Verified contracts:
 * 1. Auth boundary: 401 when unauthenticated; 200 when authenticated.
 * 2. GET: returns vapidPublicKey (null when not configured) and subscription status.
 * 3. POST: validates payload — rejects missing/invalid fields with 400.
 * 4. POST: stores subscription and returns registered: true.
 * 5. DELETE: validates payload — rejects missing/invalid endpoint with 400.
 * 6. DELETE: removes subscription and returns unregistered flag.
 * 7. Unsupported methods: 405 with Allow header.
 * 8. Config missing: GET still returns 200 with vapidPublicKey: null.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerEvent } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { signSession } from '../session'

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
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
    httpMethod: 'GET',
    path: '/api/push/subscribe',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    rawUrl: 'http://localhost/api/push/subscribe',
    rawQuery: '',
    ...overrides,
  }
}

const SESSION_SECRET = 'test-secret-handler-push'
const USER_ID = 43296126

function makeSessionCookie(): string {
  const value = signSession(
    { login: 'testuser', id: USER_ID, accessToken: 'fake-token' },
    SESSION_SECRET,
  )
  return `session=${encodeURIComponent(value)}`
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-abc123'
const KEYS = { p256dh: 'BPm8s4z_valid_p256dh_key', auth: 'qK8Hx_valid_auth' }
const VALID_POST_BODY = JSON.stringify({ endpoint: ENDPOINT, keys: KEYS })

// ---------------------------------------------------------------------------
// Contract 1: Auth boundary
// ---------------------------------------------------------------------------

describe('auth boundary', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
    delete process.env['VAPID_PUBLIC_KEY']
    delete process.env['VAPID_PRIVATE_KEY']
    delete process.env['VAPID_SUBJECT']
  })

  it('returns 401 when no session cookie', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(makeEvent(), {} as never)
    expect(result!.statusCode).toBe(401)
  })

  it('returns 401 when SESSION_SECRET is missing', async () => {
    delete process.env['SESSION_SECRET']
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(401)
  })

  it('returns 200 for GET when authenticated', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Contract 2: GET — VAPID key and status
// ---------------------------------------------------------------------------

describe('GET /api/push/subscribe', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
    delete process.env['VAPID_PUBLIC_KEY']
    delete process.env['VAPID_PRIVATE_KEY']
    delete process.env['VAPID_SUBJECT']
  })

  // Contract 8: config missing handled cleanly
  it('returns vapidPublicKey: null when VAPID vars are not configured', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    const body = JSON.parse(result!.body!)
    expect(result!.statusCode).toBe(200)
    expect(body.vapidPublicKey).toBeNull()
    expect(typeof body.subscriptionCount).toBe('number')
    expect(typeof body.hasSubscriptions).toBe('boolean')
  })

  it('returns vapidPublicKey when configured', async () => {
    const pubKey = 'BPm8s4z_test_vapid_public_key'
    process.env['VAPID_PUBLIC_KEY'] = pubKey
    process.env['VAPID_PRIVATE_KEY'] = 'private-key-placeholder'
    process.env['VAPID_SUBJECT'] = 'mailto:test@example.com'

    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    const body = JSON.parse(result!.body!)
    expect(body.vapidPublicKey).toBe(pubKey)
  })

  it('returns subscriptionCount from store', async () => {
    // Two blobs listed, each resolves to a valid record
    const rec = {
      subscriptionVersion: '1',
      userId: USER_ID,
      endpoint: ENDPOINT,
      keys: KEYS,
      createdAt: '2026-06-25T10:00:00.000Z',
      updatedAt: '2026-06-25T10:00:00.000Z',
    }
    mockStore.list.mockResolvedValue({ blobs: [
      { key: `${USER_ID}/aaaabbbbccccdddd1111222233334444.json` },
      { key: `${USER_ID}/bbbbccccddddeeee2222333344445555.json` },
    ]})
    mockStore.get.mockResolvedValue(rec)

    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    const body = JSON.parse(result!.body!)
    expect(body.subscriptionCount).toBe(2)
    expect(body.hasSubscriptions).toBe(true)
  })

  it('does not include the VAPID private key in the response', async () => {
    process.env['VAPID_PUBLIC_KEY'] = 'pub-key'
    process.env['VAPID_PRIVATE_KEY'] = 'super-secret-private-key'
    process.env['VAPID_SUBJECT'] = 'mailto:test@example.com'

    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    const body = JSON.parse(result!.body!)
    expect(body.vapidPrivateKey).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('super-secret-private-key')
  })
})

// ---------------------------------------------------------------------------
// Contract 3: POST — payload validation
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe — payload validation', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
  })

  it('returns 400 when body is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ httpMethod: 'POST', headers: { cookie: makeSessionCookie() }, body: null }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when body is not valid JSON', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ httpMethod: 'POST', headers: { cookie: makeSessionCookie() }, body: 'not-json' }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when endpoint is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ keys: KEYS }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when keys object is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ endpoint: ENDPOINT }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when keys.p256dh is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ endpoint: ENDPOINT, keys: { auth: 'valid-auth' } }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when keys.auth is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: 'valid-p256dh' } }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Contract 4: POST — stores subscription
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe — stores subscription', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
  })

  it('returns 200 with registered: true on success', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: VALID_POST_BODY,
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
    const body = JSON.parse(result!.body!)
    expect(body.registered).toBe(true)
    expect(typeof body.createdAt).toBe('string')
  })

  it('calls setJSON to persist the record', async () => {
    const { handler } = await import('../../push-subscribe')
    await handler(
      makeEvent({
        httpMethod: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: VALID_POST_BODY,
      }),
      {} as never,
    )
    expect(mockStore.setJSON).toHaveBeenCalledOnce()
    const [, record] = mockStore.setJSON.mock.calls[0] as [string, unknown]
    expect(record).toMatchObject({ endpoint: ENDPOINT, userId: USER_ID })
  })
})

// ---------------------------------------------------------------------------
// Contract 5: DELETE — payload validation
// ---------------------------------------------------------------------------

describe('DELETE /api/push/subscribe — payload validation', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
  })

  it('returns 400 when body is missing', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ httpMethod: 'DELETE', headers: { cookie: makeSessionCookie() }, body: null }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })

  it('returns 400 when endpoint is missing from body', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'DELETE',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({}),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Contract 6: DELETE — removes subscription
// ---------------------------------------------------------------------------

describe('DELETE /api/push/subscribe — removes subscription', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
  })

  it('returns 200 with unregistered: true when record found', async () => {
    mockStore.get.mockResolvedValue({
      subscriptionVersion: '1',
      userId: USER_ID,
      endpoint: ENDPOINT,
      keys: KEYS,
      createdAt: '2026-06-25T10:00:00.000Z',
      updatedAt: '2026-06-25T10:00:00.000Z',
    })

    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'DELETE',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ endpoint: ENDPOINT }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
    const body = JSON.parse(result!.body!)
    expect(body.unregistered).toBe(true)
    expect(mockStore.delete).toHaveBeenCalledOnce()
  })

  it('returns 200 with unregistered: false when record not found', async () => {
    mockStore.get.mockResolvedValue(null)

    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({
        httpMethod: 'DELETE',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ endpoint: ENDPOINT }),
      }),
      {} as never,
    )
    expect(result!.statusCode).toBe(200)
    const body = JSON.parse(result!.body!)
    expect(body.unregistered).toBe(false)
    expect(mockStore.delete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Contract 7: unsupported methods
// ---------------------------------------------------------------------------

describe('unsupported HTTP methods', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    process.env['SESSION_SECRET'] = SESSION_SECRET
  })

  it('returns 405 for PUT', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ httpMethod: 'PUT', headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(405)
    expect(result!.headers!['allow']).toContain('GET')
    expect(result!.headers!['allow']).toContain('POST')
    expect(result!.headers!['allow']).toContain('DELETE')
  })

  it('returns 405 for PATCH', async () => {
    const { handler } = await import('../../push-subscribe')
    const result = await handler(
      makeEvent({ httpMethod: 'PATCH', headers: { cookie: makeSessionCookie() } }),
      {} as never,
    )
    expect(result!.statusCode).toBe(405)
  })
})
