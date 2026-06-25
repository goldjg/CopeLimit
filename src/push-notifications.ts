/**
 * @file Client-side WebPush notification helpers.
 *
 * Provides pure, side-effect-free utility functions for detecting browser push
 * support, requesting notification permission, subscribing, and unsubscribing.
 *
 * ## Key design constraints
 * - **No auto-prompting.** Permission is never requested automatically. All
 *   calls to `requestNotificationPermission` must originate from an explicit
 *   user action (e.g. a button click).
 * - **No side effects at import time.** Importing this module never calls
 *   `Notification.requestPermission()`, accesses `navigator.serviceWorker`,
 *   or makes any network requests.
 * - **Graceful degradation.** Every function returns a clear result or `null`
 *   when the browser lacks support or configuration is missing.
 *
 * ## Usage
 * ```ts
 * const support = detectPushSupport()
 * if (support !== 'supported') { ... show fallback ... }
 *
 * // Only call from a user action:
 * const permission = await requestNotificationPermission()
 * if (permission !== 'granted') { ... }
 *
 * const subscription = await subscribeToPush(vapidPublicKey)
 * if (subscription) { await registerSubscription(subscription) }
 * ```
 */

/**
 * Indicates whether WebPush is available and usable in the current environment.
 *
 * | Value              | Meaning                                                           |
 * |--------------------|-------------------------------------------------------------------|
 * | `'supported'`      | Browser supports push notifications and service workers.          |
 * | `'unsupported'`    | Browser lacks the required APIs (`Notification`, `PushManager`).  |
 * | `'config_missing'` | APIs present but VAPID public key was not provided.               |
 */
export type PushNotificationSupport = 'supported' | 'unsupported' | 'config_missing'

/**
 * Detects whether WebPush is available in the current browser.
 *
 * Does **not** request any permissions and has no side effects.
 *
 * @param vapidPublicKey - The VAPID public key from the server config. If
 *   `null` or empty, returns `'config_missing'` even when the browser supports
 *   push.
 * @returns A {@link PushNotificationSupport} value.
 */
export function detectPushSupport(vapidPublicKey: string | null | undefined): PushNotificationSupport {
  if (
    typeof window === 'undefined' ||
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return 'unsupported'
  }

  if (!vapidPublicKey || !vapidPublicKey.trim()) {
    return 'config_missing'
  }

  return 'supported'
}

/**
 * Returns the current notification permission status without requesting it.
 *
 * Returns `'denied'` (the most restrictive default) when the `Notification`
 * API is not available so callers can safely gate on the result.
 *
 * @returns The current `NotificationPermission` value, or `'denied'` when
 *   the API is unavailable.
 */
export function getCurrentPermission(): NotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  return (window as Window & { Notification: { permission: NotificationPermission } }).Notification.permission
}

/**
 * Requests notification permission from the user.
 *
 * **This function must only be called from an explicit user action** (e.g. a
 * button click). Calling it on page load violates the "no auto-prompt"
 * constraint and will be blocked by most browsers.
 *
 * @returns The resulting `NotificationPermission`, or `'denied'` if the API
 *   is unavailable or the request throws.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  try {
    const notif = (window as Window & { Notification: { requestPermission: () => Promise<NotificationPermission> } }).Notification
    return await notif.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * Converts a base64url-encoded string to a `Uint8Array`.
 *
 * Used to convert the VAPID public key into the format required by the browser
 * `PushManager.subscribe` call.
 *
 * @param base64url - A base64url-encoded string (may include padding `=`).
 * @returns The decoded bytes as a `Uint8Array`.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

/**
 * Subscribes the current browser to push notifications using the given
 * VAPID public key.
 *
 * Prerequisites:
 * - The service worker must already be registered.
 * - `Notification.permission` must be `'granted'` before calling this
 *   function (or the subscribe call will fail).
 *
 * @param vapidPublicKey - Base64url-encoded VAPID public key.
 * @returns The `PushSubscription` object, or `null` if subscribing fails or
 *   the required APIs are unavailable.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return null
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
    return subscription
  } catch {
    return null
  }
}

/**
 * Unsubscribes the current browser from push notifications.
 *
 * Returns `true` when the browser had an active subscription and it was
 * successfully cancelled. Returns `false` when there was no subscription or
 * the unsubscribe call failed.
 *
 * @returns `true` if unsubscribed, `false` otherwise.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return false
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return false
    return await subscription.unsubscribe()
  } catch {
    return false
  }
}

/**
 * Returns the currently active `PushSubscription` for this browser, or `null`
 * if no subscription is registered or the API is unavailable.
 *
 * Does **not** request any permissions and has no side effects.
 *
 * @returns The active `PushSubscription`, or `null`.
 */
export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return null
  }

  try {
    const registration = await navigator.serviceWorker.ready
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}
