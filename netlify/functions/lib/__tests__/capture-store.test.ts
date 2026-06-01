import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStore } from '@netlify/blobs'
import { buildCaptureKey, buildIndexKey, isDateExpired, maybeCapture, _resetCaptureStoreForTesting } from '../capture-store'

vi.mock('@netlify/blobs', () => ({
  getStore: vi.fn()
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
    delete: vi.fn().mockResolvedValue(undefined)
  }
}

/** Matches the actual Netlify Blobs error message format for HTTP 403 failures. */
const MOCK_403_ERROR_MESSAGE = 'Netlify Blobs has generated an internal error (403 status code)'

const ENABLED_CONFIG = {
  enabled: true,
  retentionDays: 30,
  maxPerDay: 10,
  includeNormalized: true
}

const VALID_USAGE = {
  mode: 'premium_requests' as const,
  used: 1,
  quota: 10,
  remaining: 9,
  percentUsed: 10,
  resetAt: '2026-07-01T00:00:00.000Z',
  billingEntity: 'octocat',
  source: 'github-copilot-internal',
  warningLevel: 'normal',
  updatedAt: '2026-06-01T00:00:00.000Z',
  notes: [] as string[]
}

const VALID_INPUT = {
  config: ENABLED_CONFIG,
  provider: 'github-copilot-internal',
  userId: 43296126,
  usage: VALID_USAGE,
  rawPayload: { quota: 10, remaining: 9 }
}

// ---------------------------------------------------------------------------
// Existing key helper tests (unchanged)
// ---------------------------------------------------------------------------

describe('capture-store key helpers', () => {
  it('builds capture keys by provider/user/day/timestamp', () => {
    const key = buildCaptureKey('github-copilot-internal', 123, '2026-05-07T04:06:21.390Z')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/2026-05-07T04:06:21.390Z.json')
  })

  it('builds daily index key', () => {
    const key = buildIndexKey('github-copilot-internal', 123, '2026-05-07')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/_index.json')
  })

  it('rejects unsafe provider path values', () => {
    expect(() => buildCaptureKey('../evil', 123, '2026-05-07T04:06:21.390Z')).toThrow('Invalid provider key')
    expect(() => buildIndexKey('../evil', 123, '2026-05-07')).toThrow('Invalid provider key')
  })

  it('expires keys older than retention cutoff', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-05-15', 30, now)).toBe(true)
    expect(isDateExpired('2026-05-16', 30, now)).toBe(false)
    expect(isDateExpired('2026-06-14', 30, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Existing maybeCapture guard tests (unchanged)
// ---------------------------------------------------------------------------

describe('maybeCapture guards', () => {
  it('skips capture when userId is missing', async () => {
    await expect(
      maybeCapture({
        config: {
          enabled: true,
          retentionDays: 30,
          maxPerDay: 10,
          includeNormalized: true
        },
        provider: 'github-copilot-internal',
        usage: {
          mode: 'premium_requests',
          used: 1,
          quota: 10,
          remaining: 9,
          percentUsed: 10,
          resetAt: '2026-06-01T00:00:00.000Z',
          billingEntity: 'x',
          source: 'github-copilot-internal',
          warningLevel: 'normal',
          updatedAt: '2026-05-07T00:00:00.000Z',
          notes: []
        },
        rawPayload: { quota: 10 }
      })
    ).resolves.toBeUndefined()
  })

  it('skips capture when userId is non-integer', async () => {
    await expect(
      maybeCapture({
        config: {
          enabled: true,
          retentionDays: 30,
          maxPerDay: 10,
          includeNormalized: true
        },
        provider: 'github-copilot-internal',
        userId: 1.5,
        usage: {
          mode: 'premium_requests',
          used: 1,
          quota: 10,
          remaining: 9,
          percentUsed: 10,
          resetAt: '2026-06-01T00:00:00.000Z',
          billingEntity: 'x',
          source: 'github-copilot-internal',
          warningLevel: 'normal',
          updatedAt: '2026-05-07T00:00:00.000Z',
          notes: []
        },
        rawPayload: { quota: 10 }
      })
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Error classification and safe structured logging
// ---------------------------------------------------------------------------

describe('maybeCapture — Blob error classification and safe logging', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetCaptureStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves without rethrowing when readIndex throws 403', async () => {
    mockStore.get.mockRejectedValue(
      new Error(MOCK_403_ERROR_MESSAGE)
    )
    await expect(maybeCapture(VALID_INPUT)).resolves.toBeUndefined()
  })

  it('logs errorCode blob_forbidden for 403 failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(
      new Error(MOCK_403_ERROR_MESSAGE)
    )
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'blob_forbidden' })
    )
  })

  it('logs operation readIndex for index read failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(
      new Error(MOCK_403_ERROR_MESSAGE)
    )
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ operation: 'readIndex' })
    )
  })

  it('classifies 401 errors as blob_unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('401 unauthorized'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'blob_unavailable' })
    )
  })

  it('classifies unauthorized errors as blob_unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('Request is Unauthorized'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'blob_unavailable' })
    )
  })

  it('classifies capture write failure with operation captureWrite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // get returns null → readIndex yields count:0; first setJSON (capture write) fails
    mockStore.setJSON.mockRejectedValueOnce(new Error('403 status code'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ operation: 'captureWrite', errorCode: 'blob_forbidden' })
    )
  })

  it('classifies index write failure with operation indexWrite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // First setJSON (capture write) succeeds; second (index write) fails
    mockStore.setJSON
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('403 status code'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ operation: 'indexWrite', errorCode: 'blob_forbidden' })
    )
  })

  it('does not log stack in failure diagnostics', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).not.toHaveProperty('stack')
  })

  it('includes safe error summary when message contains no sensitive terms', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(
      new Error(MOCK_403_ERROR_MESSAGE)
    )
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('errorSummary')
    expect(typeof loggedObj.errorSummary).toBe('string')
  })

  it('omits errorSummary when message contains sensitive terms', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('invalid auth token was rejected'))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).not.toHaveProperty('errorSummary')
    expect(loggedObj).toHaveProperty('messageSuppressed', true)
  })

  it('does not log raw payload, sanitizedRaw, or token-adjacent fields', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))
    await maybeCapture(VALID_INPUT)
    const loggedStr = JSON.stringify(warnSpy.mock.calls[0])
    expect(loggedStr).not.toContain('rawPayload')
    expect(loggedStr).not.toContain('sanitizedRaw')
    expect(loggedStr).not.toContain('billingEntity')
    expect(loggedStr).not.toContain('quota')
  })

  it('includes storeName provider and userId in log fields', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).toMatchObject({
      provider: 'github-copilot-internal',
      userId: 43296126,
      storeName: 'provider-captures'
    })
  })

  it('resolves successfully when all Blob calls succeed', async () => {
    await expect(maybeCapture(VALID_INPUT)).resolves.toBeUndefined()
  })

  it('resolves without rethrowing when store.list throws during cleanup', async () => {
    mockStore.list.mockRejectedValue(new Error('403 status code'))
    // store.get succeeds (readIndex returns count:0), cleanup list fails but should not propagate
    await expect(maybeCapture(VALID_INPUT)).resolves.toBeUndefined()
  })

  it('classifies non-blob readIndex failure as index_read_failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('network timeout'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'index_read_failure', operation: 'readIndex' })
    )
  })

  it('classifies non-blob captureWrite failure as capture_write_failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.setJSON.mockRejectedValueOnce(new Error('network timeout'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'capture_write_failure', operation: 'captureWrite' })
    )
  })

  it('classifies non-blob indexWrite failure as index_write_failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.setJSON
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network timeout'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'index_write_failure', operation: 'indexWrite' })
    )
  })

  it('logs structured fields for list failure during cleanup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.list.mockRejectedValue(new Error('503 service unavailable'))
    await maybeCapture(VALID_INPUT)
    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({
        provider: 'github-copilot-internal',
        userId: 43296126,
        storeName: 'provider-captures',
        operation: 'listBlobs'
      })
    )
  })

  it('logs structured fields for delete failure during cleanup without raw key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Seed an expired key so cleanup tries to delete it
    const expiredKey = 'github-copilot-internal/43296126/2020-01-01/2020-01-01T00:00:00.000Z.json'
    mockStore.list.mockResolvedValue({ blobs: [{ key: expiredKey }] })
    mockStore.delete.mockRejectedValue(new Error('503 service unavailable'))
    await maybeCapture(VALID_INPUT)
    const deleteFailureCall = warnSpy.mock.calls.find(
      (call) => {
        const fields = call[1] as Record<string, unknown>
        return typeof fields === 'object' && fields.operation === 'deleteBlob'
      }
    )
    expect(deleteFailureCall).toBeDefined()
    const loggedFields = deleteFailureCall![1] as Record<string, unknown>
    expect(loggedFields).toMatchObject({
      provider: 'github-copilot-internal',
      userId: 43296126,
      storeName: 'provider-captures',
      operation: 'deleteBlob'
    })
    // Raw key must not appear directly in log fields
    expect(loggedFields).not.toHaveProperty('key')
    // Raw error message must not appear directly (only safe errorSummary allowed)
    expect(loggedFields).not.toHaveProperty('error')
  })
})

// ---------------------------------------------------------------------------
// Diagnostic metadata fields
// ---------------------------------------------------------------------------

describe('maybeCapture — diagnostic metadata', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetCaptureStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes errorClass for a normal Error instance', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // list errors are passed to logCaptureFailure unwrapped, so errorClass reflects the real type
    mockStore.list.mockRejectedValue(new TypeError('network timeout'))
    await maybeCapture(VALID_INPUT)
    const listFailureCall = warnSpy.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.operation === 'listBlobs'
    )
    const loggedObj = listFailureCall?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('errorClass', 'TypeError')
    expect(loggedObj).toHaveProperty('isErrorInstance', true)
  })

  it('includes isErrorInstance: true for Error instances', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('network timeout'))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('isErrorInstance', true)
  })

  it('includes isErrorInstance: false for non-Error thrown values without serializing them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // list errors are passed to logCaptureFailure unwrapped; throw a plain object
    mockStore.list.mockRejectedValue({ status: 403, body: 'secret-token=abc' })
    await maybeCapture(VALID_INPUT)
    const listFailureCall = warnSpy.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.operation === 'listBlobs'
    )
    const loggedObj = listFailureCall?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('isErrorInstance', false)
    // The thrown object must not be serialized into the log string
    const loggedStr = JSON.stringify(listFailureCall)
    expect(loggedStr).not.toContain('secret-token')
    expect(loggedStr).not.toContain('"status"')
  })

  it('reports hasErrorMessage: false when error has an empty message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error())
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('hasErrorMessage', false)
    expect(loggedObj).not.toHaveProperty('errorSummary')
    expect(loggedObj).not.toHaveProperty('messageSuppressed')
  })

  it('includes hasErrorMessage: true alongside errorSummary for safe messages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error(MOCK_403_ERROR_MESSAGE))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).toHaveProperty('hasErrorMessage', true)
    expect(loggedObj).toHaveProperty('errorSummary')
    expect(loggedObj).not.toHaveProperty('messageSuppressed')
  })

  it('omits messageSuppressed when message is safe', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('503 service unavailable'))
    await maybeCapture(VALID_INPUT)
    const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(loggedObj).not.toHaveProperty('messageSuppressed')
  })

  it('sets messageSuppressed: true and omits errorSummary for all sensitive term variants', async () => {
    const sensitiveMessages = [
      'invalid token supplied',
      'auth failed',
      'bad key in request',
      'secret mismatch',
      'bearer rejected',
      'credential not valid',
      'wrong password',
      'cookie expired'
    ]
    for (const msg of sensitiveMessages) {
      _resetCaptureStoreForTesting()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockStore.get.mockRejectedValue(new Error(msg))
      await maybeCapture(VALID_INPUT)
      const loggedObj = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>
      expect(loggedObj, `msg: "${msg}"`).toHaveProperty('messageSuppressed', true)
      expect(loggedObj, `msg: "${msg}"`).not.toHaveProperty('errorSummary')
      vi.restoreAllMocks()
    }
  })
})
// Repeated-failure suppression
// ---------------------------------------------------------------------------

describe('maybeCapture — log suppression', () => {
  let mockStore: MockStore

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetCaptureStoreForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits warn logs for the first 5 failures then suppresses', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))

    for (let i = 0; i < 7; i++) {
      await maybeCapture(VALID_INPUT)
    }

    expect(warnSpy).toHaveBeenCalledTimes(5)
  })

  it('emits a single info log when suppression begins (6th failure)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))

    for (let i = 0; i < 7; i++) {
      await maybeCapture(VALID_INPUT)
    }

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith(
      '[capture-store] Repeated capture failures suppressed',
      expect.objectContaining({ errorCode: 'blob_forbidden', storeName: 'provider-captures' })
    )
  })

  it('does not emit further info logs beyond the first suppression notice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    mockStore.get.mockRejectedValue(new Error('403 status code'))

    for (let i = 0; i < 10; i++) {
      await maybeCapture(VALID_INPUT)
    }

    expect(infoSpy).toHaveBeenCalledTimes(1)
  })

  it('tracks suppression counts independently per error code', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})

    // 5 blob_forbidden failures (readIndex 403)
    mockStore.get.mockRejectedValue(new Error('403 status code'))
    for (let i = 0; i < 5; i++) {
      await maybeCapture(VALID_INPUT)
    }

    // Reset mock so get succeeds but capture write fails with 401 (different code)
    mockStore.get.mockResolvedValue(null)
    mockStore.setJSON.mockRejectedValue(new Error('401 unauthorized'))
    for (let i = 0; i < 3; i++) {
      await maybeCapture(VALID_INPUT)
    }

    // 5 blob_forbidden + 3 blob_unavailable = 8 warn calls
    expect(warnSpy).toHaveBeenCalledTimes(8)
  })
})

// ---------------------------------------------------------------------------
// Environment pre-flight
// ---------------------------------------------------------------------------

describe('maybeCapture — env pre-flight', () => {
  let mockStore: MockStore
  const originalEnv = process.env

  beforeEach(() => {
    mockStore = makeMockStore()
    vi.mocked(getStore).mockReturnValue(mockStore as ReturnType<typeof getStore>)
    _resetCaptureStoreForTesting()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('logs config_invalid and skips Blob I/O when NETLIFY_AUTH_TOKEN is empty string', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env = { ...originalEnv, NETLIFY_SITE_ID: 'site123', NETLIFY_AUTH_TOKEN: '' }

    await maybeCapture(VALID_INPUT)

    expect(warnSpy).toHaveBeenCalledWith(
      '[capture-store] Failed to persist provider capture',
      expect.objectContaining({ errorCode: 'config_invalid', operation: 'env_check' })
    )
    expect(mockStore.get).not.toHaveBeenCalled()
  })

  it('proceeds normally when NETLIFY_AUTH_TOKEN is absent (runtime context path)', async () => {
    const env = { ...originalEnv, NETLIFY_SITE_ID: 'site123' }
    delete (env as Record<string, string | undefined>).NETLIFY_AUTH_TOKEN
    process.env = env

    await maybeCapture(VALID_INPUT)

    // Blob I/O was attempted (readIndex → store.get)
    expect(mockStore.get).toHaveBeenCalled()
  })

  it('proceeds normally when neither NETLIFY_SITE_ID nor NETLIFY_AUTH_TOKEN is set', async () => {
    const env = { ...originalEnv }
    delete (env as Record<string, string | undefined>).NETLIFY_SITE_ID
    delete (env as Record<string, string | undefined>).NETLIFY_AUTH_TOKEN
    process.env = env

    await maybeCapture(VALID_INPUT)

    expect(mockStore.get).toHaveBeenCalled()
  })
})
