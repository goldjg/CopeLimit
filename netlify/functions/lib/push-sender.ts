/**
 * @file WebPush notification sender.
 *
 * Thin wrapper around the `web-push` library for sending a single push
 * notification to a stored {@link PushSubscriptionRecord}.
 *
 * This module is intentionally narrow: it handles only the network delivery
 * layer. Subscription lookup and request validation remain in the calling
 * handler.
 *
 * ## Delivery result semantics
 * - `{ ok: true }` — push accepted by the push service.
 * - `{ ok: false, reason: 'expired' }` — push service returned 404 or 410
 *   (subscription is invalid or expired; caller should suggest re-subscribing).
 * - `{ ok: false, reason: 'provider_error', statusCode? }` — push service
 *   returned a non-success, non-expired status.
 * - `{ ok: false, reason: 'send_failed' }` — network or library error (no
 *   HTTP status available).
 */

import webpush from 'web-push'
import type { PushConfig } from './push-config'
import type { PushSubscriptionRecord } from './push-subscription-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The result of a single push delivery attempt. */
export type PushDeliveryResult =
  | { ok: true }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'provider_error'; statusCode?: number }
  | { ok: false; reason: 'send_failed' }

/** Notification content sent inside the push payload. */
export type PushNotificationPayload = {
  /** Notification title shown by the browser. */
  title: string;
  /** Notification body text. */
  body: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a push notification to a single subscription record.
 *
 * @param record  - The stored subscription record (endpoint + keys).
 * @param config  - The VAPID configuration. Must have `isConfigured: true`
 *   — callers must verify config before calling this function.
 * @param payload - The notification title and body to deliver.
 * @returns A {@link PushDeliveryResult} indicating success or the failure mode.
 */
export async function sendPushNotification(
  record: PushSubscriptionRecord,
  config: PushConfig & { isConfigured: true },
  payload: PushNotificationPayload,
): Promise<PushDeliveryResult> {
  const subscription = {
    endpoint: record.endpoint,
    keys: {
      p256dh: record.keys.p256dh,
      auth: record.keys.auth,
    },
  }

  const vapidDetails = {
    subject: config.vapidSubject as string,
    publicKey: config.vapidPublicKey as string,
    privateKey: config.vapidPrivateKey as string,
  }

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { vapidDetails },
    )
    return { ok: true }
  } catch (err: unknown) {
    if (err !== null && typeof err === 'object' && 'statusCode' in err) {
      const statusCode = (err as { statusCode: number }).statusCode
      // 404 and 410 both indicate the subscription is no longer valid.
      if (statusCode === 404 || statusCode === 410) {
        return { ok: false, reason: 'expired' }
      }
      return { ok: false, reason: 'provider_error', statusCode }
    }
    return { ok: false, reason: 'send_failed' }
  }
}
