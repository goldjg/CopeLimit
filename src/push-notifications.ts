/**
 * @file Client-side WebPush notification helpers.
 *
 * Provides pure, side-effect-free utility functions for detecting browser push
 * support, inspecting current capability, requesting notification permission,
 * subscribing, and unsubscribing.
 */
import { isLikelyIosNavigator } from './widget-onboarding'

export type PushNotificationSupport = 'supported' | 'unsupported' | 'config_missing'

export type NotificationCapabilityReason =
  | 'supported'
  | 'subscription_active'
  | 'not_installed_on_ios'
  | 'notification_unavailable'
  | 'service_worker_unavailable'
  | 'push_manager_unavailable'
  | 'notification_permission_denied'
  | 'vapid_public_key_missing'
  | 'service_worker_registration_unavailable'

export type NotificationCapabilitySnapshot = {
  isIos: boolean
  isStandalone: boolean
  hasNotificationApi: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  permission: NotificationPermission | 'unsupported'
  hasVapidPublicKey: boolean
  hasServiceWorkerRegistration: boolean
  hasActiveSubscription: boolean
}

export type NotificationCapability = NotificationCapabilitySnapshot & {
  canSubscribe: boolean
  primaryReason: NotificationCapabilityReason
  reasons: NotificationCapabilityReason[]
}

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function hasNavigator(): boolean {
  return typeof navigator !== 'undefined'
}

export function isStandaloneDisplayMode(): boolean {
  if (!hasWindow()) return false

  const mediaMatches = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false
  const navigatorStandalone = hasNavigator()
    ? (navigator as Navigator & { standalone?: boolean }).standalone === true
    : false

  return mediaMatches || navigatorStandalone
}

export function buildNotificationCapability(
  snapshot: NotificationCapabilitySnapshot,
): NotificationCapability {
  const reasons: NotificationCapabilityReason[] = []

  if (snapshot.hasActiveSubscription) {
    reasons.push('subscription_active')
  }

  if (snapshot.isIos && !snapshot.isStandalone) {
    reasons.push('not_installed_on_ios')
  }

  if (!snapshot.hasNotificationApi) {
    reasons.push('notification_unavailable')
  }

  if (!snapshot.hasServiceWorker) {
    reasons.push('service_worker_unavailable')
  }

  if (!snapshot.hasPushManager) {
    reasons.push('push_manager_unavailable')
  }

  if (snapshot.permission === 'denied') {
    reasons.push('notification_permission_denied')
  }

  if (!snapshot.hasVapidPublicKey) {
    reasons.push('vapid_public_key_missing')
  }

  if (snapshot.hasServiceWorker && !snapshot.hasServiceWorkerRegistration) {
    reasons.push('service_worker_registration_unavailable')
  }

  const canSubscribe = !snapshot.hasActiveSubscription
    && (!snapshot.isIos || snapshot.isStandalone)
    && snapshot.hasNotificationApi
    && snapshot.hasServiceWorker
    && snapshot.hasPushManager
    && snapshot.permission !== 'denied'
    && snapshot.hasVapidPublicKey

  return {
    ...snapshot,
    canSubscribe,
    primaryReason: reasons[0] ?? 'supported',
    reasons,
  }
}

export function getCurrentPermission(): NotificationPermission {
  if (!hasWindow() || !('Notification' in window)) {
    return 'denied'
  }

  return (window as Window & { Notification: { permission: NotificationPermission } }).Notification.permission
}

export function detectPushSupport(vapidPublicKey: string | null | undefined): PushNotificationSupport {
  if (
    !hasWindow()
    || !hasNavigator()
    || !('Notification' in window)
    || !('serviceWorker' in navigator)
    || !('PushManager' in window)
  ) {
    return 'unsupported'
  }

  if (!vapidPublicKey || !vapidPublicKey.trim()) {
    return 'config_missing'
  }

  return 'supported'
}

function currentCapabilitySnapshot(
  vapidPublicKey: string | null | undefined,
): NotificationCapabilitySnapshot {
  const hasNotificationApi = hasWindow() && 'Notification' in window
  const hasServiceWorker = hasNavigator() && 'serviceWorker' in navigator
  const hasPushManager = hasWindow() && 'PushManager' in window
  const isIos = hasNavigator()
    ? isLikelyIosNavigator(navigator)
    : false

  return {
    isIos,
    isStandalone: isStandaloneDisplayMode(),
    hasNotificationApi,
    hasServiceWorker,
    hasPushManager,
    permission: hasNotificationApi ? getCurrentPermission() : 'unsupported',
    hasVapidPublicKey: Boolean(vapidPublicKey && vapidPublicKey.trim()),
    hasServiceWorkerRegistration: false,
    hasActiveSubscription: false,
  }
}

async function getExistingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasNavigator() || !('serviceWorker' in navigator)) {
    return null
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration?.('/')
    if (registration) return registration
    return await navigator.serviceWorker.getRegistration?.() ?? null
  } catch {
    return null
  }
}

async function getReadyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasNavigator() || !('serviceWorker' in navigator)) {
    return null
  }

  const existing = await getExistingServiceWorkerRegistration()
  if (existing) return existing

  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return await navigator.serviceWorker.ready
  } catch {
    return null
  }
}

export async function inspectNotificationCapability(
  vapidPublicKey: string | null | undefined,
): Promise<NotificationCapability> {
  const snapshot = currentCapabilitySnapshot(vapidPublicKey)

  if (!snapshot.hasServiceWorker) {
    return buildNotificationCapability(snapshot)
  }

  const registration = await getExistingServiceWorkerRegistration()
  if (!registration) {
    return buildNotificationCapability(snapshot)
  }

  let hasActiveSubscription = false
  if (snapshot.hasPushManager) {
    try {
      hasActiveSubscription = Boolean(await registration.pushManager.getSubscription())
    } catch {
      hasActiveSubscription = false
    }
  }

  return buildNotificationCapability({
    ...snapshot,
    hasServiceWorkerRegistration: true,
    hasActiveSubscription,
  })
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!hasWindow() || !('Notification' in window)) {
    return 'denied'
  }

  try {
    const notif = (window as Window & { Notification: { requestPermission: () => Promise<NotificationPermission> } }).Notification
    return await notif.requestPermission()
  } catch {
    return 'denied'
  }
}

export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)))
}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
  if (
    !hasNavigator()
    || !hasWindow()
    || !('serviceWorker' in navigator)
    || !('PushManager' in window)
  ) {
    return null
  }

  try {
    const registration = await getReadyServiceWorkerRegistration()
    if (!registration) return null

    const existing = await registration.pushManager.getSubscription()
    if (existing) return existing

    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
  } catch {
    return null
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (
    !hasNavigator()
    || !hasWindow()
    || !('serviceWorker' in navigator)
    || !('PushManager' in window)
  ) {
    return false
  }

  try {
    const registration = await getReadyServiceWorkerRegistration()
    if (!registration) return false

    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return false
    return await subscription.unsubscribe()
  } catch {
    return false
  }
}

export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (
    !hasNavigator()
    || !hasWindow()
    || !('serviceWorker' in navigator)
    || !('PushManager' in window)
  ) {
    return null
  }

  try {
    const registration = await getExistingServiceWorkerRegistration()
    if (!registration) return null
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}
