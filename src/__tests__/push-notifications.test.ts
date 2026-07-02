import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNotificationCapability,
  detectPushSupport,
  getCurrentPermission,
  inspectNotificationCapability,
  requestNotificationPermission,
  subscribeToPush,
  urlBase64ToUint8Array,
} from '../push-notifications'

type FakeNotification = {
  permission: NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
}

type FakePushManager = {
  subscribe: ReturnType<typeof vi.fn>
  getSubscription: ReturnType<typeof vi.fn>
}

type FakeRegistration = {
  scope: string
  pushManager: FakePushManager
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

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function makeRegistration(subscription: PushSubscription | null = null): FakeRegistration {
  return {
    scope: '/',
    pushManager: {
      subscribe: vi.fn().mockResolvedValue(subscription ?? { endpoint: 'https://example.test/sub' }),
      getSubscription: vi.fn().mockResolvedValue(subscription),
    },
  }
}

function stubBrowserGlobals(opts: {
  hasNotification?: boolean
  hasServiceWorker?: boolean
  hasPushManager?: boolean
  permission?: NotificationPermission
  requestPermissionFn?: () => Promise<NotificationPermission>
  standalone?: boolean
  displayModeStandalone?: boolean
  registration?: FakeRegistration | null
  readyRegistration?: FakeRegistration | null
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
} = {}): {
  registerSpy: ReturnType<typeof vi.fn>
  getRegistrationSpy: ReturnType<typeof vi.fn>
} {
  const {
    hasNotification = true,
    hasServiceWorker = true,
    hasPushManager = true,
    permission = 'default',
    requestPermissionFn,
    standalone = false,
    displayModeStandalone = false,
    registration = null,
    readyRegistration = registration ?? makeRegistration(null),
    userAgent = 'Mozilla/5.0',
    platform = 'MacIntel',
    maxTouchPoints = 0,
  } = opts

  const fakeWindow: Record<string, unknown> = {
    matchMedia: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)' ? displayModeStandalone : false,
    })),
  }

  if (hasNotification) {
    fakeWindow.Notification = makeFakeNotification(permission, requestPermissionFn)
  }

  if (hasPushManager) {
    fakeWindow.PushManager = function PushManager() {}
  }

  vi.stubGlobal('window', fakeWindow)

  const registerSpy = vi.fn().mockResolvedValue(readyRegistration)
  const getRegistrationSpy = vi.fn().mockImplementation(async (scope?: string) => {
    if (scope === '/') return registration
    return registration
  })

  const fakeNavigator: Record<string, unknown> = {
    userAgent,
    platform,
    maxTouchPoints,
    standalone,
  }

  if (hasServiceWorker) {
    fakeNavigator.serviceWorker = {
      ready: Promise.resolve(readyRegistration),
      register: registerSpy,
      getRegistration: getRegistrationSpy,
    }
  }

  vi.stubGlobal('navigator', fakeNavigator)

  return { registerSpy, getRegistrationSpy }
}

beforeEach(() => {
  stubBrowserGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('module import side effects', () => {
  it('does not call Notification.requestPermission on import', async () => {
    const requestPermissionSpy = vi.fn().mockResolvedValue('default' as NotificationPermission)
    stubBrowserGlobals({ requestPermissionFn: requestPermissionSpy })

    await import('../push-notifications')

    expect(requestPermissionSpy).not.toHaveBeenCalled()
  })
})

describe('detectPushSupport', () => {
  it('returns "supported" when all APIs are present and vapidPublicKey is set', () => {
    stubBrowserGlobals()
    expect(detectPushSupport('valid-vapid-key')).toBe('supported')
  })

  it('returns "config_missing" when vapidPublicKey is missing', () => {
    stubBrowserGlobals()
    expect(detectPushSupport(null)).toBe('config_missing')
    expect(detectPushSupport('')).toBe('config_missing')
    expect(detectPushSupport('   ')).toBe('config_missing')
  })

  it('returns "unsupported" when required APIs are absent', () => {
    stubBrowserGlobals({ hasNotification: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')

    stubBrowserGlobals({ hasPushManager: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')

    stubBrowserGlobals({ hasServiceWorker: false })
    expect(detectPushSupport('valid-key')).toBe('unsupported')
  })
})

describe('buildNotificationCapability', () => {
  it('marks iOS browser-tab contexts as not installed and not subscribable', () => {
    const capability = buildNotificationCapability({
      isIos: true,
      isStandalone: false,
      hasNotificationApi: true,
      hasServiceWorker: true,
      hasPushManager: true,
      permission: 'default',
      hasVapidPublicKey: true,
      hasServiceWorkerRegistration: true,
      hasActiveSubscription: false,
    })

    expect(capability.primaryReason).toBe('not_installed_on_ios')
    expect(capability.canSubscribe).toBe(false)
    expect(capability.reasons).toContain('not_installed_on_ios')
  })

  it('allows capable standalone contexts to subscribe', () => {
    const capability = buildNotificationCapability({
      isIos: true,
      isStandalone: true,
      hasNotificationApi: true,
      hasServiceWorker: true,
      hasPushManager: true,
      permission: 'default',
      hasVapidPublicKey: true,
      hasServiceWorkerRegistration: true,
      hasActiveSubscription: false,
    })

    expect(capability.primaryReason).toBe('supported')
    expect(capability.canSubscribe).toBe(true)
  })

  it('reports permission denied clearly', () => {
    const capability = buildNotificationCapability({
      isIos: false,
      isStandalone: false,
      hasNotificationApi: true,
      hasServiceWorker: true,
      hasPushManager: true,
      permission: 'denied',
      hasVapidPublicKey: true,
      hasServiceWorkerRegistration: true,
      hasActiveSubscription: false,
    })

    expect(capability.primaryReason).toBe('notification_permission_denied')
    expect(capability.canSubscribe).toBe(false)
  })

  it('reports missing vapid configuration clearly', () => {
    const capability = buildNotificationCapability({
      isIos: false,
      isStandalone: false,
      hasNotificationApi: true,
      hasServiceWorker: true,
      hasPushManager: true,
      permission: 'default',
      hasVapidPublicKey: false,
      hasServiceWorkerRegistration: true,
      hasActiveSubscription: false,
    })

    expect(capability.primaryReason).toBe('vapid_public_key_missing')
    expect(capability.canSubscribe).toBe(false)
  })

  it('reports service worker unavailability clearly', () => {
    const capability = buildNotificationCapability({
      isIos: false,
      isStandalone: false,
      hasNotificationApi: true,
      hasServiceWorker: false,
      hasPushManager: true,
      permission: 'default',
      hasVapidPublicKey: true,
      hasServiceWorkerRegistration: false,
      hasActiveSubscription: false,
    })

    expect(capability.primaryReason).toBe('service_worker_unavailable')
    expect(capability.canSubscribe).toBe(false)
  })

  it('reports active subscriptions before other reasons', () => {
    const capability = buildNotificationCapability({
      isIos: false,
      isStandalone: false,
      hasNotificationApi: true,
      hasServiceWorker: true,
      hasPushManager: true,
      permission: 'granted',
      hasVapidPublicKey: true,
      hasServiceWorkerRegistration: true,
      hasActiveSubscription: true,
    })

    expect(capability.primaryReason).toBe('subscription_active')
    expect(capability.canSubscribe).toBe(false)
  })
})

describe('inspectNotificationCapability', () => {
  it('detects iOS non-standalone install guidance state', async () => {
    stubBrowserGlobals({
      standalone: false,
      displayModeStandalone: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      registration: makeRegistration(null),
    })

    const capability = await inspectNotificationCapability('valid-key')

    expect(capability.isIos).toBe(true)
    expect(capability.isStandalone).toBe(false)
    expect(capability.primaryReason).toBe('not_installed_on_ios')
  })

  it('marks service worker registration as unavailable when none is active yet', async () => {
    stubBrowserGlobals({ registration: null })

    const capability = await inspectNotificationCapability('valid-key')

    expect(capability.hasServiceWorkerRegistration).toBe(false)
    expect(capability.canSubscribe).toBe(true)
  })
})

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
})

describe('urlBase64ToUint8Array', () => {
  it('decodes a standard base64url string to Uint8Array', () => {
    const result = urlBase64ToUint8Array('aGVsbG8')
    const expected = new TextEncoder().encode('hello')
    expect(result).toEqual(expected)
  })

  it('handles base64url padding variants', () => {
    const result = urlBase64ToUint8Array('aGVsbG8h')
    const text = new TextDecoder().decode(result)
    expect(text).toBe('hello!')
  })
})

describe('requestNotificationPermission', () => {
  it('returns the resolved permission from the browser API', async () => {
    stubBrowserGlobals({
      permission: 'default',
      requestPermissionFn: vi.fn().mockResolvedValue('granted' as NotificationPermission),
    })

    const result = await requestNotificationPermission()
    expect(result).toBe('granted')
  })

  it('returns "denied" when the Notification API throws', async () => {
    stubBrowserGlobals({
      requestPermissionFn: vi.fn().mockRejectedValue(new Error('blocked')),
    })

    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
  })
})

describe('subscribeToPush', () => {
  it('waits for the service worker to become ready before subscribing', async () => {
    const registration = makeRegistration(null)
    const ready = deferredPromise<FakeRegistration>()

    const fakeWindow: Record<string, unknown> = {
      Notification: makeFakeNotification('granted'),
      PushManager: function PushManager() {},
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    }
    vi.stubGlobal('window', fakeWindow)

    const registerSpy = vi.fn().mockResolvedValue(registration)
    const getRegistrationSpy = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      serviceWorker: {
        ready: ready.promise,
        register: registerSpy,
        getRegistration: getRegistrationSpy,
      },
    })

    const subscribePromise = subscribeToPush('aGVsbG8')
    await Promise.resolve()

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()

    ready.resolve(registration)
    await subscribePromise

    expect(registerSpy).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1)
  })
})
