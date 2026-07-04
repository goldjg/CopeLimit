/**
 * @file WebPush VAPID configuration reader.
 *
 * Reads VAPID keys and the subject URI from environment variables. The VAPID
 * public key is served to the client so the browser can subscribe to push
 * notifications. The private key and subject are kept server-side for future
 * push message delivery.
 *
 * ## Environment variables
 *
 * | Variable           | Required | Description                                                         |
 * |--------------------|----------|---------------------------------------------------------------------|
 * | `VAPID_PUBLIC_KEY` | Yes      | Base64url-encoded VAPID public key (served to clients)              |
 * | `VAPID_PRIVATE_KEY`| Yes      | Base64url-encoded VAPID private key (server-side only, never sent)  |
 * | `VAPID_SUBJECT`    | Yes      | Contact URI for the VAPID claim (`mailto:` or `https:` URL)         |
 *
 * When any required variable is absent, all fields return `null` and
 * `isConfigured` returns `false`. This allows the app to degrade gracefully
 * rather than throwing at startup.
 *
 * ## Security note
 *
 * `vapidPrivateKey` must **never** be sent to the browser. Only
 * `vapidPublicKey` is safe to serve to clients.
 */

/**
 * VAPID configuration for the WebPush subsystem.
 *
 * When `isConfigured` is `false`, the application should surface a clear
 * "notifications not configured" state rather than attempting to subscribe.
 */
export type PushConfig =
  | {
      isConfigured: true;
      vapidPublicKey: string;
      vapidPrivateKey: string;
      vapidSubject: string;
    }
  | {
      isConfigured: false;
      vapidPublicKey: null;
      vapidPrivateKey: null;
      vapidSubject: null;
    }

/**
 * Reads the WebPush VAPID configuration from environment variables.
 *
 * Returns a config object with `isConfigured: false` and all `null` keys when
 * any required variable is absent or empty.
 *
 * @returns A {@link PushConfig} object. Safe to call at any time.
 */
export function readPushConfig(): PushConfig {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null
  const vapidSubject = process.env.VAPID_SUBJECT?.trim() || null

  const isConfigured = !!(vapidPublicKey && vapidPrivateKey && vapidSubject)

  if (!isConfigured) {
    return {
      isConfigured: false,
      vapidPublicKey: null,
      vapidPrivateKey: null,
      vapidSubject: null,
    }
  }

  return {
    isConfigured: true,
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject,
  }
}
