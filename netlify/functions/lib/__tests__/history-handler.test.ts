/**
 * Contract tests for the GET /api/history handler.
 *
 * These tests verify:
 * 1. Auth boundary: 401 when unauthenticated, 200 when authenticated.
 * 2. Query parameter validation: 400 for invalid params.
 * 3. Response shape: snapshots, count, and optional summary.
 * 4. No raw provider payloads in the response body.
 * 5. History-disabled operation (empty array) still returns 200.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { HandlerEvent } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { signSession } from '../session'
import type { UsageHistoryEntry, UsageHistorySnapshot } from '../usage-history-types'
import { buildHistoryKey } from '../usage-history-store'

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

/**
 * Build a minimal HandlerEvent for GET requests.
 */
function makeEvent(overrides: Partial<HandlerEvent> = {}): HandlerEvent {
  return {
    httpMethod: 'GET',
    path: '/api/history',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    rawUrl: 'http://localhost/api/history',
    rawQuery: '',
    ...overrides,
  }
}

const SESSION_SECRET = 'test-secret-for-handler-contract-tests'
const USER_ID = 43296126

/**
 * Returns a valid signed session cookie header for USER_ID.
 */
function makeSessionCookie(): string {
  const value = signSession(
    { login: 'testuser', id: USER_ID, accessToken: 'fake-token' },
    SESSION_SECRET,
  )
  return `session=${encodeURIComponent(value)}`
}

const BASE_SNAPSHOT: UsageHistorySnapshot = {
  capturedAt: '2026-06-15T10:00:00.000Z',
  used: 3000,
  quota: 7000,
  remaining: 4000,
  billingPhase: 'credits_available',
}

// ---------------------------------------------------------------------------
// Load the handler (dynamic import so env vars can be set first)
// ---------------------------------------------------------------------------

async function loadHandler() {
  const mod = await import('../../history')
  return mod.handler
}

// ---------------------------------------------------------------------------
// Contract assertion 1: Auth boundary
// ---------------------------------------------------------------------------

describe('GET /api/history — auth boundary', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SESSION_SECRET
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  afterEach(() => {
    delete process.env.SESSION_SECRET
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('returns 401 when no session cookie is present', async () => {
    const handler = await loadHandler()
    const response = await handler(makeEvent(), {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(401)
    const body = JSON.parse(response?.body ?? '{}')
    expect(body.error).toBeDefined()
  })

  it('returns 401 when session cookie is invalid', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: 'session=invalid.cookie' } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(401)
  })

  it('returns 401 when SESSION_SECRET is not configured', async () => {
    delete process.env.SESSION_SECRET
    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(401)
  })

  it('returns 200 with valid session cookie', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 2: Response shape
// ---------------------------------------------------------------------------

describe('GET /api/history — response shape', () => {
  let mockStore: MockStore

  beforeEach(() => {
    process.env.SESSION_SECRET = SESSION_SECRET
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  afterEach(() => {
    delete process.env.SESSION_SECRET
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('returns snapshots array and count when history is empty', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    const body = JSON.parse(response?.body ?? '{}')
    expect(Array.isArray(body.snapshots)).toBe(true)
    expect(body.count).toBe(0)
    expect(body.summary).toBeUndefined()
  })

  it('returns correct snapshots when history is populated', async () => {
    const entry: UsageHistoryEntry = {
      historyVersion: '1',
      userId: USER_ID,
      snapshot: BASE_SNAPSHOT,
    }
    const key = buildHistoryKey(USER_ID, BASE_SNAPSHOT.capturedAt)
    mockStore.list.mockResolvedValue({ blobs: [{ key }] })
    mockStore.get.mockResolvedValue(entry)

    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    const body = JSON.parse(response?.body ?? '{}')

    expect(body.count).toBe(1)
    expect(body.snapshots).toHaveLength(1)
    expect(body.snapshots[0].capturedAt).toBe(BASE_SNAPSHOT.capturedAt)
  })

  it('includes summary when ?summary=true', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { summary: 'true' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    const body = JSON.parse(response?.body ?? '{}')
    expect(body.summary).toBeDefined()
    expect(typeof body.summary.deltaUsed).toBe('number')
    expect(typeof body.summary.snapshotCount).toBe('number')
  })

  it('does not include summary when ?summary param is absent', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    const body = JSON.parse(response?.body ?? '{}')
    expect(body.summary).toBeUndefined()
  })

  it('response body contains no raw provider payloads', async () => {
    // The raw provider payload fields that must never appear in responses
    const FORBIDDEN_KEYS = [
      'accessToken', 'authorization', 'token_based_billing', 'quota_snapshots',
      'copilot_plan', 'billingEntity', 'rawPayload', 'login',
    ]
    const entry: UsageHistoryEntry = {
      historyVersion: '1',
      userId: USER_ID,
      snapshot: BASE_SNAPSHOT,
    }
    const key = buildHistoryKey(USER_ID, BASE_SNAPSHOT.capturedAt)
    mockStore.list.mockResolvedValue({ blobs: [{ key }] })
    mockStore.get.mockResolvedValue(entry)

    const handler = await loadHandler()
    const event = makeEvent({ headers: { cookie: makeSessionCookie() } })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    const body = JSON.parse(response?.body ?? '{}')
    const bodyStr = JSON.stringify(body)

    for (const key of FORBIDDEN_KEYS) {
      expect(bodyStr).not.toContain(`"${key}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 3: Query parameter validation
// ---------------------------------------------------------------------------

describe('GET /api/history — query parameter validation', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SESSION_SECRET
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  afterEach(() => {
    delete process.env.SESSION_SECRET
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('returns 400 for non-numeric limit', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { limit: 'abc' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(400)
  })

  it('returns 400 for negative limit', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { limit: '-1' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(400)
  })

  it('accepts limit=0 (returns empty array)', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { limit: '0' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(200)
    const body = JSON.parse(response?.body ?? '{}')
    expect(body.snapshots).toEqual([])
  })

  it('returns 400 for invalid from date format', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { from: '2026/06/15' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(400)
  })

  it('returns 400 for invalid to date format', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { to: 'not-a-date' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(400)
  })

  it('accepts valid from and to dates', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { from: '2026-06-01', to: '2026-06-15' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(200)
  })

  it('accepts valid limit', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      headers: { cookie: makeSessionCookie() },
      queryStringParameters: { limit: '10' },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 4: Method enforcement
// ---------------------------------------------------------------------------

describe('GET /api/history — method enforcement', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SESSION_SECRET
    const mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
  })

  afterEach(() => {
    delete process.env.SESSION_SECRET
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('returns 405 for POST requests', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      httpMethod: 'POST',
      headers: { cookie: makeSessionCookie() },
    })
    const response = await handler(event, {} as Parameters<typeof handler>[1])
    expect(response?.statusCode).toBe(405)
  })
})
