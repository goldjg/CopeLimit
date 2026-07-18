/**
 * Tests for the shared Blob store credential selection helper.
 *
 * Covers the four behaviors required by the problem statement:
 *  1. Default path uses ambient getStore({ name }).
 *  2. Explicit path is used only when BLOBS_USE_EXPLICIT_CREDENTIALS=true
 *     AND both NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are present.
 *  3. NETLIFY_AUTH_TOKEN presence alone does NOT trigger explicit mode.
 *  4. widget-store, onboarding-store, and capture-store all apply the same rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import { getBlobStore } from '../blob-store'

// Per-store public API imports used to verify credential selection (point 4).
import { getWidgetTokenStatusForUser } from '../widget-store'
import { readOnboardingSessionStatus } from '../onboarding-store'
import { maybeCapture, _resetCaptureStoreForTesting } from '../capture-store'

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn()
}))

// blob-crypto is required by widget-store and onboarding-store; mock it out.
vi.mock('../blob-crypto', () => ({
  readBlobEncryptionKey: vi.fn().mockReturnValue('a'.repeat(64)),
  encryptBlob: vi.fn().mockReturnValue('iv:ct:tag'),
  decryptBlob: vi.fn().mockReturnValue(null)
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockStore = {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  setJSON: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

function makeMockStore(): MockStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setJSON: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ blobs: [] }),
    delete: vi.fn().mockResolvedValue(undefined)
  }
}

// ---------------------------------------------------------------------------
// 1 & 3: getBlobStore — ambient by default; NETLIFY_AUTH_TOKEN alone is not enough
// ---------------------------------------------------------------------------

describe('getBlobStore — credential selection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.mocked(getStore).mockReturnValue({} as ReturnType<typeof getStore>)
    vi.mocked(getStore).mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses ambient getStore({ name }) when no env vars are set', () => {
    const env = { ...originalEnv }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    delete (env as Record<string, string | undefined>).NETLIFY_SITE_ID
    delete (env as Record<string, string | undefined>).NETLIFY_AUTH_TOKEN
    process.env = env

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store' })
  })

  it('uses ambient getStore({ name }) when NETLIFY_AUTH_TOKEN is set but BLOBS_USE_EXPLICIT_CREDENTIALS is not', () => {
    // Point 3: NETLIFY_AUTH_TOKEN alone must NOT trigger explicit mode.
    const env = { ...originalEnv, NETLIFY_SITE_ID: 'site-x', NETLIFY_AUTH_TOKEN: 'tok-x' }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    process.env = env

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store' })
    expect(getStore).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-x' }))
  })

  it('uses ambient getStore({ name }) when BLOBS_USE_EXPLICIT_CREDENTIALS is "false"', () => {
    process.env = { ...originalEnv, BLOBS_USE_EXPLICIT_CREDENTIALS: 'false', NETLIFY_SITE_ID: 's', NETLIFY_AUTH_TOKEN: 't' }

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store' })
  })

  // Point 2: explicit credentials only when flag=true AND both creds present.

  it('uses explicit credentials when BLOBS_USE_EXPLICIT_CREDENTIALS=true and both credentials are present', () => {
    process.env = {
      ...originalEnv,
      BLOBS_USE_EXPLICIT_CREDENTIALS: 'true',
      NETLIFY_SITE_ID: 'site-abc',
      NETLIFY_AUTH_TOKEN: 'tok-abc'
    }

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store', siteID: 'site-abc', token: 'tok-abc' })
  })

  it('falls back to ambient when BLOBS_USE_EXPLICIT_CREDENTIALS=true but NETLIFY_AUTH_TOKEN is missing', () => {
    const env = { ...originalEnv, BLOBS_USE_EXPLICIT_CREDENTIALS: 'true', NETLIFY_SITE_ID: 'site-abc' }
    delete (env as Record<string, string | undefined>).NETLIFY_AUTH_TOKEN
    process.env = env

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store' })
  })

  it('falls back to ambient when BLOBS_USE_EXPLICIT_CREDENTIALS=true but NETLIFY_SITE_ID is missing', () => {
    const env = { ...originalEnv, BLOBS_USE_EXPLICIT_CREDENTIALS: 'true', NETLIFY_AUTH_TOKEN: 'tok-abc' }
    delete (env as Record<string, string | undefined>).NETLIFY_SITE_ID
    process.env = env

    getBlobStore('my-store')

    expect(getStore).toHaveBeenCalledOnce()
    expect(getStore).toHaveBeenCalledWith({ name: 'my-store' })
  })

  it('forwards the store name to getStore', () => {
    const env = { ...originalEnv }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    process.env = env

    getBlobStore('widget-tokens')
    expect(getStore).toHaveBeenCalledWith({ name: 'widget-tokens' })

    vi.mocked(getStore).mockClear()

    getBlobStore('onboarding-sessions')
    expect(getStore).toHaveBeenCalledWith({ name: 'onboarding-sessions' })
  })
})

// ---------------------------------------------------------------------------
// 4: per-store credential selection — ambient path
// ---------------------------------------------------------------------------

describe('widget-store — uses shared credential selection rule', () => {
  let mockStore: MockStore
  const originalEnv = process.env

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getStore>)
    vi.mocked(getStore).mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('uses ambient getStore({ name }) when BLOBS_USE_EXPLICIT_CREDENTIALS is not set', async () => {
    const env = { ...originalEnv, NETLIFY_SITE_ID: 'site-w', NETLIFY_AUTH_TOKEN: 'tok-w' }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    process.env = env

    await getWidgetTokenStatusForUser(1)

    expect(getStore).toHaveBeenCalledWith({ name: 'widget-tokens' })
    expect(getStore).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-w' }))
  })

  it('uses explicit credentials when BLOBS_USE_EXPLICIT_CREDENTIALS=true and both creds are set', async () => {
    process.env = {
      ...originalEnv,
      BLOBS_USE_EXPLICIT_CREDENTIALS: 'true',
      NETLIFY_SITE_ID: 'site-w',
      NETLIFY_AUTH_TOKEN: 'tok-w'
    }

    await getWidgetTokenStatusForUser(1)

    expect(getStore).toHaveBeenCalledWith({ name: 'widget-tokens', siteID: 'site-w', token: 'tok-w' })
  })
})

describe('onboarding-store — uses shared credential selection rule', () => {
  let mockStore: MockStore
  const originalEnv = process.env

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getStore>)
    vi.mocked(getStore).mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('uses ambient getStore({ name }) when BLOBS_USE_EXPLICIT_CREDENTIALS is not set', async () => {
    const env = { ...originalEnv, NETLIFY_SITE_ID: 'site-o', NETLIFY_AUTH_TOKEN: 'tok-o' }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    process.env = env

    await readOnboardingSessionStatus('sess-1', 42)

    expect(getStore).toHaveBeenCalledWith({ name: 'onboarding-sessions' })
    expect(getStore).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-o' }))
  })

  it('uses explicit credentials when BLOBS_USE_EXPLICIT_CREDENTIALS=true and both creds are set', async () => {
    process.env = {
      ...originalEnv,
      BLOBS_USE_EXPLICIT_CREDENTIALS: 'true',
      NETLIFY_SITE_ID: 'site-o',
      NETLIFY_AUTH_TOKEN: 'tok-o'
    }

    await readOnboardingSessionStatus('sess-1', 42)

    expect(getStore).toHaveBeenCalledWith({ name: 'onboarding-sessions', siteID: 'site-o', token: 'tok-o' })
  })
})

describe('capture-store — uses shared credential selection rule', () => {
  let mockStore: MockStore
  const originalEnv = process.env

  const VALID_INPUT = {
    config: { enabled: true, retentionDays: 30, maxPerDay: 10, includeNormalized: false },
    provider: 'some-provider',
    userId: 1,
    usage: {
      mode: 'premium_requests' as const,
      used: 1,
      quota: 10,
      remaining: 9,
      percentUsed: 10,
      resetAt: '2026-07-01T00:00:00.000Z',
      billingEntity: 'user',
      source: 'some-provider',
      warningLevel: 'normal',
      updatedAt: '2026-06-01T00:00:00.000Z',
      notes: [] as string[]
    },
    rawPayload: { x: 1 }
  }

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getStore>)
    vi.mocked(getStore).mockClear()
    _resetCaptureStoreForTesting()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('uses ambient getStore({ name }) when BLOBS_USE_EXPLICIT_CREDENTIALS is not set', async () => {
    const env = { ...originalEnv, NETLIFY_SITE_ID: 'site-c', NETLIFY_AUTH_TOKEN: 'tok-c' }
    delete (env as Record<string, string | undefined>).BLOBS_USE_EXPLICIT_CREDENTIALS
    process.env = env

    await maybeCapture(VALID_INPUT)

    expect(getStore).toHaveBeenCalledWith({ name: 'provider-captures' })
    expect(getStore).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-c' }))
  })

  it('uses explicit credentials when BLOBS_USE_EXPLICIT_CREDENTIALS=true and both creds are set', async () => {
    process.env = {
      ...originalEnv,
      BLOBS_USE_EXPLICIT_CREDENTIALS: 'true',
      NETLIFY_SITE_ID: 'site-c',
      NETLIFY_AUTH_TOKEN: 'tok-c'
    }

    await maybeCapture(VALID_INPUT)

    expect(getStore).toHaveBeenCalledWith({ name: 'provider-captures', siteID: 'site-c', token: 'tok-c' })
  })
})
