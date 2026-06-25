/**
 * @file Netlify Function: `push-subscribe`
 *
 * CRUD endpoint for managing WebPush subscriptions for the authenticated user.
 *
 * ## Endpoint
 * `/api/push/subscribe` — requires a valid session cookie for all methods.
 *
 * | Method   | Behaviour                                                                   |
 * |----------|-----------------------------------------------------------------------------|
 * | `GET`    | Returns VAPID public key and subscription status for the authenticated user |
 * | `POST`   | Registers (or updates) a push subscription                                  |
 * | `DELETE` | Unregisters a push subscription by endpoint                                 |
 *
 * ## GET response
 * ```json
 * {
 *   "vapidPublicKey": "<base64url-key or null>",
 *   "subscriptionCount": 0,
 *   "hasSubscriptions": false
 * }
 * ```
 *
 * `vapidPublicKey` is `null` when `VAPID_PUBLIC_KEY` is not configured. The
 * client should show a "notifications not configured" state in that case.
 *
 * ## POST request body
 * ```json
 * {
 *   "endpoint": "https://push.example.com/...",
 *   "keys": { "p256dh": "...", "auth": "..." },
 *   "userAgent": "Mozilla/5.0 ...",
 *   "source": "copelimit-pwa"
 * }
 * ```
 *
 * ## POST response
 * ```json
 * { "registered": true, "createdAt": "2026-06-25T20:00:00.000Z" }
 * ```
 *
 * ## DELETE request body
 * ```json
 * { "endpoint": "https://push.example.com/..." }
 * ```
 *
 * ## DELETE response
 * ```json
 * { "unregistered": true }
 * ```
 *
 * ## Required environment variables
 * - `SESSION_SECRET`           — HMAC-SHA256 signing secret for session cookies
 * - `SESSION_ENCRYPTION_KEY`   — (optional) AES-256 key for encrypted session cookies
 * - `VAPID_PUBLIC_KEY`         — (optional) Base64url VAPID public key; when absent,
 *                                  `vapidPublicKey` is `null` in GET responses
 * - `VAPID_PRIVATE_KEY`        — (optional) Server-side VAPID private key; never sent to clients
 * - `VAPID_SUBJECT`            — (optional) VAPID subject URI
 */
import type { Handler, HandlerEvent } from '@netlify/functions'
import { parseCookies, verifySession } from './lib/session'
import { readPushConfig } from './lib/push-config'
import {
  saveSubscription,
  deleteSubscription,
  countSubscriptions,
} from './lib/push-subscription-store'
import type { PushSubscriptionPayload } from './lib/push-subscription-types'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

type AuthResult =
  | { session: { login: string; id: number } }
  | { error: { statusCode: number; body: string } }

function requireSession(event: HandlerEvent): AuthResult {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthenticated' }),
      },
    }
  }

  const cookies = parseCookies(event.headers['cookie'])
  const rawSession = cookies['session']
  if (!rawSession) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthenticated' }),
      },
    }
  }

  const encKey = process.env.SESSION_ENCRYPTION_KEY
  const session = verifySession(rawSession, secret, encKey || undefined)
  if (!session) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthenticated' }),
      },
    }
  }

  return { session }
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

type PayloadError = { payloadError: string }

/**
 * Validates the POST request body as a {@link PushSubscriptionPayload}.
 *
 * Returns a `PayloadError` when:
 * - Body is missing or not valid JSON
 * - `endpoint` is missing or not a non-empty string
 * - `keys` is missing or not an object
 * - `keys.p256dh` is missing or not a non-empty string
 * - `keys.auth` is missing or not a non-empty string
 */
function validateSubscriptionPayload(body: string | null): PushSubscriptionPayload | PayloadError {
  if (!body) {
    return { payloadError: 'Request body is required' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { payloadError: 'Request body must be valid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { payloadError: 'Request body must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>

  if (typeof obj['endpoint'] !== 'string' || !obj['endpoint'].trim()) {
    return { payloadError: '`endpoint` must be a non-empty string' }
  }

  if (typeof obj['keys'] !== 'object' || obj['keys'] === null || Array.isArray(obj['keys'])) {
    return { payloadError: '`keys` must be an object' }
  }

  const keys = obj['keys'] as Record<string, unknown>

  if (typeof keys['p256dh'] !== 'string' || !keys['p256dh'].trim()) {
    return { payloadError: '`keys.p256dh` must be a non-empty string' }
  }

  if (typeof keys['auth'] !== 'string' || !keys['auth'].trim()) {
    return { payloadError: '`keys.auth` must be a non-empty string' }
  }

  const payload: PushSubscriptionPayload = {
    endpoint: obj['endpoint'],
    keys: {
      p256dh: keys['p256dh'],
      auth: keys['auth'],
    },
  }

  if (typeof obj['userAgent'] === 'string' && obj['userAgent'].trim()) {
    payload.userAgent = obj['userAgent']
  }

  if (typeof obj['source'] === 'string' && obj['source'].trim()) {
    payload.source = obj['source']
  }

  return payload
}

/**
 * Validates the DELETE request body to extract the `endpoint`.
 *
 * Returns a `PayloadError` when the body is missing, not valid JSON,
 * or does not contain a non-empty `endpoint` string.
 */
function validateDeletePayload(body: string | null): { endpoint: string } | PayloadError {
  if (!body) {
    return { payloadError: 'Request body is required' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { payloadError: 'Request body must be valid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { payloadError: 'Request body must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>

  if (typeof obj['endpoint'] !== 'string' || !obj['endpoint'].trim()) {
    return { payloadError: '`endpoint` must be a non-empty string' }
  }

  return { endpoint: obj['endpoint'] }
}

function isPayloadError(v: unknown): v is PayloadError {
  return typeof v === 'object' && v !== null && 'payloadError' in (v as object)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event: HandlerEvent) => {
  const method = event.httpMethod

  // -------------------------------------------------------------------------
  // GET — return VAPID public key + subscription status
  // -------------------------------------------------------------------------
  if (method === 'GET') {
    const auth = requireSession(event)
    if ('error' in auth) {
      return { ...auth.error, headers: BASE_HEADERS }
    }

    const config = readPushConfig()
    const subscriptionCount = await countSubscriptions(auth.session.id)

    return {
      statusCode: 200,
      headers: { ...BASE_HEADERS, 'cache-control': 'private, no-store' },
      body: JSON.stringify({
        vapidPublicKey: config.vapidPublicKey,
        subscriptionCount,
        hasSubscriptions: subscriptionCount > 0,
      }),
    }
  }

  // -------------------------------------------------------------------------
  // POST — register (or update) a subscription
  // -------------------------------------------------------------------------
  if (method === 'POST') {
    const auth = requireSession(event)
    if ('error' in auth) {
      return { ...auth.error, headers: BASE_HEADERS }
    }

    const payload = validateSubscriptionPayload(event.body)
    if (isPayloadError(payload)) {
      return {
        statusCode: 400,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: payload.payloadError }),
      }
    }

    // Attach user-agent from request headers if not already in payload
    if (!payload.userAgent) {
      const ua = event.headers['user-agent']
      if (ua) payload.userAgent = ua
    }

    const record = await saveSubscription(auth.session.id, payload)
    if (!record) {
      return {
        statusCode: 500,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: 'Failed to register subscription' }),
      }
    }

    return {
      statusCode: 200,
      headers: BASE_HEADERS,
      body: JSON.stringify({
        registered: true,
        createdAt: record.createdAt,
      }),
    }
  }

  // -------------------------------------------------------------------------
  // DELETE — unregister a subscription
  // -------------------------------------------------------------------------
  if (method === 'DELETE') {
    const auth = requireSession(event)
    if ('error' in auth) {
      return { ...auth.error, headers: BASE_HEADERS }
    }

    const payload = validateDeletePayload(event.body)
    if (isPayloadError(payload)) {
      return {
        statusCode: 400,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: payload.payloadError }),
      }
    }

    const unregistered = await deleteSubscription(auth.session.id, payload.endpoint)

    return {
      statusCode: 200,
      headers: BASE_HEADERS,
      body: JSON.stringify({ unregistered }),
    }
  }

  // -------------------------------------------------------------------------
  // Other methods — 405 Method Not Allowed
  // -------------------------------------------------------------------------
  return {
    statusCode: 405,
    headers: { ...BASE_HEADERS, allow: 'GET, POST, DELETE' },
    body: JSON.stringify({ error: 'Method not allowed' }),
  }
}
