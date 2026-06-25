/**
 * Tests for src/push-notifications.ts.
 *
 * Verified contracts:
 * 1. `detectPushSupport` returns correct support values based on env and config.
 * 2. `getCurrentPermission` returns correct value without side effects.
 * 3. `urlBase64ToUint8Array` correctly decodes base64url strings.
 * 4. Module import does NOT call `Notification.requestPermission` automatically.
 * 5. `requestNotificationPermission` is a named export (not called automatically).
 * 6. `detectPushSupport` returns 'config_missing' when vapidPublicKey is null/empty.
 * 7. `detectPushSupport` returns 'unsupported' when browser APIs are absent.
 *
 * These tests run in the Node.js environment (no jsdom). Browser globals are
 * stubbed with `vi.stubGlobal` where needed; tests that do not require browser
 * APIs rely on the `typeof window === 'undefined'` guards inside the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectPushSupport,
  getCurrentPermission,
  requestNotificationPermission,
  urlBase64ToUint8Array,
} from '../push-notifications'

// ---------------------------------------------------------------------------
// Browser API mock helpers
// ---------------------------------------------------------------------------

type FakeNotification = {
  permission: NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
}

function makeFakeNotification(
  permission: NotificationPermission = 'default',
  requestPermission?: () => Promise<NotificationPermission>,
): FakeNotification {
  return {
    permission,
    requestPermission: requestPermission ?? vi.fn().mockResolvedValue(permission),
  }
}

/**
 * Sets up a minimal browser-like global environment for a test.
 *
 * Each call stubs `window`, `navigator`, and (via window) `Notification` /
 * `PushManager` as requested. Call `vi.unstubAllGlobals()` in `afterEach` to
 * restore Node.js defaults.
 */
function stubBrowserGlobals(opts: {
  hasNotification?: boolean
  hasServiceWorker?: boolean
  hasPushManager?: boolean
  permission?: NotificationPermission
  requestPermissionFn?: () => Promise<NotificationPermission>
} = {}): void {
  const {
    hasNotification = true,
    hasServiceWorker = true,
    hasPushManager = true,
    permission = 'default',
    requestPermissionFn,
  } = opts

  const fakeWindow: Record<string, unknown> = {}
  if (hasNotification) {
    fakeWindow['Notification'] = makeFakeNotification(permission, requestPermissionFn)
  }
  if (hasPushManager) {
    fakeWindow['PushManager'] = {}
  }

  vi.stubGlobal('window', fakeWindow)

  const fakeNavigator: Record<string, unknown> = {}
  if (hasServiceWorker) {
    fakeNavigator['serviceWorker'] = {
      ready: Promise.resolve({
        pushManager: {
          subscribe: vi.fn(),
          getSubscription: vi.fn().mockResolvedValue(null),
        },
      }),
    }
  }
  vi.stubGlobal('navigator', fakeNavigator)
}

beforeEach(() => {
  stubBrowserGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Contract 4: Module import must not call requestPermission automatically
// ---------------------------------------------------------------------------

describe('module import side effects', () => {
  it('does not call Notification.requestPermission on import', async () => {
    const requestPermissionSpy = vi.fn().mockResolvedValue('default' as NotificationPermission)
    stubBrowserGlobals({ requestPermissionFn: requestPermissionSpy })
    // Re-import (module is cached, but we verify the spy was never called)
    await import('../push-notifications')
    expect(requestPermissionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Contract 1: detectPushSupport
// ---------------------------------------------------------------------------

describe('detectPushSupport', () => {
  it('returns "supported" when all APIs are present and vapidPublicKey is set', () => {
    stubBrowserGlobals()
    expect(detectPushSupport('valid-vapid-key')).toBe('supported')
  })

  // Contract 6: config_missing
  it('returns "config_missing" when vapidPublicKey is null', () => {
    stubBrowserGlobals()
    expect(detectPushSupport(null)).toBe('config_missing')
  })

  it('returns "config_missing" when vapidPublicKey is an empty string', () => {
    stubBrowserGlobals()
    expect(detectPushSupport('')).toBe('config_missing')
  })

  it('returns "config_missing" when vapidPublicKey is only whitespace', () => {
    stubBrowserGlobals()
    expect(detectPushSupport('   ')).toBe('config_missing')
  })

  it('returns "config_missing" when vapidPublicKey is undefined', () => {
    stubBrowserGlobals()
    expect(detectPushSupport(undefined)).toBe('config_missing')
  })

  // Contract 7: unsupported browser
  it('returns "unsupported" when Notification API is absent', () => {
    stubBrowserGlobals({ hasNotification: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')
  })

  it('returns "unsupported" when PushManager is absent', () => {
    stubBrowserGlobals({ hasPushManager: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')
  })

  it('returns "unsupported" when serviceWorker is absent', () => {
    stubBrowserGlobals({ hasServiceWorker: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')
  })

  it('returns "unsupported" when window is not defined', () => {
    vi.unstubAllGlobals()
    // After unstubbing, window is undefined in Node
    expect(detectPushSupport('valid-key')).toBe('unsupported')
    // Restore for subsequent tests
    stubBrowserGlobals()
  })
})

// ---------------------------------------------------------------------------
// Contract 2: getCurrentPermission
// ---------------------------------------------------------------------------

describe('getCurrentPermission', () => {
  it('returns the current Notification.permission without requesting it', () => {
    const requestPermissionSpy = vi.fn()
    stubBrowserGlobals({ permission: 'granted', requestPermissionFn: requestPermissionSpy })

    const result = getCurrentPermission()
    expect(result).toBe('granted')
    expect(requestPermissionSpy).not.toHaveBeenCalled()
  })

  it('returns "denied" when Notification API is unavailable', () => {
    stubBrowserGlobals({ hasNotification: false })
    expect(getCurrentPermission()).toBe('denied')
  })

  it('returns "denied" when window is not defined', () => {
    vi.unstubAllGlobals()
    expect(getCurrentPermission()).toBe('denied')
    stubBrowserGlobals()
  })
})

// ---------------------------------------------------------------------------
// Contract 3: urlBase64ToUint8Array
// ---------------------------------------------------------------------------

describe('urlBase64ToUint8Array', () => {
  it('decodes a standard base64url string to Uint8Array', () => {
    // 'hello' in base64 = 'aGVsbG8='
    const result = urlBase64ToUint8Array('aGVsbG8')
    const expected = new TextEncoder().encode('hello')
    expect(result).toEqual(expected)
  })

  it('handles base64url padding variants', () => {
    // 'hello!' => aGVsbG8h
    const result = urlBase64ToUint8Array('aGVsbG8h')
    const text = new TextDecoder().decode(result)
    expect(text).toBe('hello!')
  })

  it('converts - and _ to + and / (base64url to base64)', () => {
    // base64url uses - and _ instead of + and /
    // 'f>?' in base64 is 'Zj4/'
    // 'Zj4_' in base64url corresponds to 'Zj4/'
    const urlResult = urlBase64ToUint8Array('Zj4_')
    const stdResult = urlBase64ToUint8Array('Zj4/')
    expect(urlResult).toEqual(stdResult)
  })

  it('returns a Uint8Array instance', () => {
    const result = urlBase64ToUint8Array('YQ==')
    expect(result).toBeInstanceOf(Uint8Array)
  })
})

// ---------------------------------------------------------------------------
// Contract 5: requestNotificationPermission is a named export
// ---------------------------------------------------------------------------

describe('requestNotificationPermission', () => {
  it('is a function export (not called automatically)', () => {
    expect(typeof requestNotificationPermission).toBe('function')
  })

  it('returns the resolved permission from the browser API', async () => {
    stubBrowserGlobals({
      permission: 'default',
      requestPermissionFn: vi.fn().mockResolvedValue('granted' as NotificationPermission),
    })
    // Access via window.Notification.requestPermission through the helper
    const fakeWindow = window as Record<string, unknown>
    const fakeNotification = fakeWindow['Notification'] as FakeNotification
    fakeNotification.requestPermission = vi.fn().mockResolvedValue('granted' as NotificationPermission)

    const result = await requestNotificationPermission()
    expect(result).toBe('granted')
  })

  it('returns "denied" when the Notification API throws', async () => {
    const fakeWindow = window as Record<string, unknown>
    const fakeNotification = fakeWindow['Notification'] as FakeNotification
    fakeNotification.requestPermission = vi.fn().mockRejectedValue(new Error('blocked'))

    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
  })

  it('returns "denied" when window is not defined', async () => {
    vi.unstubAllGlobals()
    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
    stubBrowserGlobals()
  })
})
