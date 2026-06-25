/**
 * @file Netlify Function: `push-send-test`
 *
 * Sends a single test push notification to all registered subscriptions for
 * the authenticated user. Lets users verify that WebPush delivery works
 * end-to-end without requiring a real alert condition.
 *
 * ## Endpoint
 * `POST /api/push/test` — requires a valid session cookie.
 *
 * ## Success response (200)
 * ```json
 * { "sent": true, "successCount": 1, "failCount": 0 }
 * ```
 *
 * ## Error responses
 * | Status | Body `error` field                                              |
 * |--------|-----------------------------------------------------------------|
 * | `401`  | Unauthenticated                                                 |
 * | `404`  | No push subscriptions registered                                |
 * | `503`  | Push notifications are not configured for this environment      |
 * | `500`  | All deliveries failed (provider error or expired subscription)  |
 * | `405`  | Method not allowed (GET, PUT, etc.)                             |
 *
 * ## Test notification content
 * - **title**: `"CopeLimit test notification"`
 * - **body**: `"Notifications are working for this browser."`
 *
 * ## Required environment variables
 * - `SESSION_SECRET`    — HMAC-SHA256 signing secret for session cookies
 * - `VAPID_PUBLIC_KEY`  — Base64url-encoded VAPID public key
 * - `VAPID_PRIVATE_KEY` — Base64url-encoded VAPID private key (never sent to clients)
 * - `VAPID_SUBJECT`     — VAPID subject URI (`mailto:` or `https:`)
 */
import type { Handler, HandlerEvent } from '@netlify/functions'
import { parseCookies, verifySession } from './lib/session'
import { readPushConfig } from './lib/push-config'
import { getSubscriptions } from './lib/push-subscription-store'
import { sendPushNotification } from './lib/push-sender'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

const TEST_NOTIFICATION = {
  title: 'CopeLimit test notification',
  body: 'Notifications are working for this browser.',
}

// ---------------------------------------------------------------------------
// Auth helper (mirrors push-subscribe.ts)
// ---------------------------------------------------------------------------

type AuthResult =
  | { session: { login: string; id: number } }
  | { error: { statusCode: number; body: string } }

function requireSession(event: HandlerEvent): AuthResult {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    return { error: { statusCode: 401, body: JSON.stringify({ error: 'Unauthenticated' }) } }
  }

  const cookies = parseCookies(event.headers['cookie'])
  const rawSession = cookies['session']
  if (!rawSession) {
    return { error: { statusCode: 401, body: JSON.stringify({ error: 'Unauthenticated' }) } }
  }

  const encKey = process.env.SESSION_ENCRYPTION_KEY
  const session = verifySession(rawSession, secret, encKey || undefined)
  if (!session) {
    return { error: { statusCode: 401, body: JSON.stringify({ error: 'Unauthenticated' }) } }
  }

  return { session }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event: HandlerEvent) => {
  // Only POST is accepted — test sends must be user-initiated, never automatic.
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...BASE_HEADERS, allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  const auth = requireSession(event)
  if ('error' in auth) {
    return { ...auth.error, headers: BASE_HEADERS }
  }

  // Require full VAPID config — public key, private key, and subject.
  const config = readPushConfig()
  if (!config.isConfigured) {
    return {
      statusCode: 503,
      headers: BASE_HEADERS,
      body: JSON.stringify({
        error: 'Push notifications are not configured for this environment.',
      }),
    }
  }

  // Require at least one registered subscription.
  const subscriptions = await getSubscriptions(auth.session.id)
  if (subscriptions.length === 0) {
    return {
      statusCode: 404,
      headers: BASE_HEADERS,
      body: JSON.stringify({
        error: 'No push subscriptions registered. Subscribe first.',
      }),
    }
  }

  // Send the test notification to all registered subscriptions.
  const results = await Promise.all(
    subscriptions.map(rec => sendPushNotification(rec, config, TEST_NOTIFICATION)),
  )

  const successCount = results.filter(r => r.ok).length
  const failCount = results.length - successCount

  // At least one delivery succeeded — report partial or full success.
  if (successCount > 0) {
    return {
      statusCode: 200,
      headers: BASE_HEADERS,
      body: JSON.stringify({ sent: true, successCount, failCount }),
    }
  }

  // All deliveries failed.
  const allExpired = results.every(r => !r.ok && r.reason === 'expired')
  return {
    statusCode: 500,
    headers: BASE_HEADERS,
    body: JSON.stringify({
      error: allExpired
        ? 'Subscription appears to have expired. Try unsubscribing and re-subscribing.'
        : 'Failed to send test notification. Please try again later.',
      successCount: 0,
      failCount,
    }),
  }
}
