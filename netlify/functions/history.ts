/**
 * @file Netlify Function: `history`
 *
 * Read-only endpoint that returns usage history snapshots for the
 * authenticated user, with optional derived burn-rate metrics.
 *
 * ## Endpoint
 * `GET /api/history`
 *
 * ## Authentication
 * Requires a valid session cookie (`SESSION_SECRET` must be configured).
 * Returns `401` when no session is present or the session is invalid.
 *
 * ## Query parameters
 *
 * | Parameter | Type    | Description                                                         |
 * |-----------|---------|---------------------------------------------------------------------|
 * | `limit`   | integer | Return at most this many snapshots (newest first). ≥ 0.             |
 * | `from`    | date    | Earliest UTC date to include (`YYYY-MM-DD`, inclusive).             |
 * | `to`      | date    | Latest UTC date to include (`YYYY-MM-DD`, inclusive).               |
 * | `summary` | boolean | When `true`, include derived burn-rate metrics in the response.     |
 *
 * ## Response shape
 * ```json
 * {
 *   "snapshots": [
 *     {
 *       "capturedAt": "2026-06-15T10:00:00.000Z",
 *       "used": 3000,
 *       "quota": 7000,
 *       "remaining": 4000,
 *       "billingPhase": "credits_available"
 *     }
 *   ],
 *   "count": 1
 * }
 * ```
 *
 * With `?summary=true`:
 * ```json
 * {
 *   "snapshots": [...],
 *   "count": 1,
 *   "summary": {
 *     "deltaUsed": 1000,
 *     "creditsPerHour": 500,
 *     "creditsPerDay": 12000,
 *     "averageBurnRate": 500,
 *     "snapshotCount": 1,
 *     "oldestAt": "2026-06-15T08:00:00.000Z",
 *     "newestAt": "2026-06-15T10:00:00.000Z"
 *   }
 * }
 * ```
 *
 * ## Privacy
 * Snapshots are provider-independent and contain no raw provider payloads,
 * no `billingEntity`, no access tokens, and no credential data.
 *
 * ## Cache
 * Responses are marked `Cache-Control: private, no-store` because history
 * is user-specific and should not be cached at any layer.
 *
 * ## Required environment variables
 * - `SESSION_SECRET`           – HMAC-SHA256 signing secret for session cookies
 * - `SESSION_ENCRYPTION_KEY`   – (optional) AES-256 key for encrypted session cookies
 */
import type { Handler, HandlerEvent } from '@netlify/functions'
import { parseCookies, verifySession } from './lib/session'
import { getHistory } from './lib/usage-history-store'
import { computeHistorySummary } from './lib/history-metrics'

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

type ParseError = { error: string }
function isParseError<T>(v: T | ParseError): v is ParseError {
  return typeof v === 'object' && v !== null && 'error' in (v as object)
}

/**
 * Parses the `limit` query parameter.
 *
 * @returns A non-negative integer, `null` (param absent), or a `ParseError`.
 */
function parseLimit(value: string | undefined | null): number | null | ParseError {
  if (value == null) return null
  if (!/^\d+$/.test(value)) return { error: '`limit` must be a non-negative integer' }
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 0) return { error: '`limit` must be a non-negative integer' }
  return n
}

/**
 * Parses a date query parameter (`from` or `to`).
 *
 * @returns A `YYYY-MM-DD` string, `null` (param absent), or a `ParseError`.
 */
function parseDate(value: string | undefined | null): string | null | ParseError {
  if (value == null) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: 'date parameters must be in `YYYY-MM-DD` format' }
  }
  return value
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event: HandlerEvent) => {
  // Method guard
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', allow: 'GET' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  // Auth: require a valid session
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthenticated' }),
    }
  }

  const cookies = parseCookies(event.headers['cookie'])
  const rawSession = cookies['session']
  if (!rawSession) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthenticated' }),
    }
  }

  const encKey = process.env.SESSION_ENCRYPTION_KEY
  const session = verifySession(rawSession, secret, encKey || undefined)
  if (!session) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthenticated' }),
    }
  }

  // Parse query parameters
  const params = event.queryStringParameters ?? {}

  const limit = parseLimit(params['limit'])
  if (isParseError(limit)) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: limit.error }),
    }
  }

  const fromDate = parseDate(params['from'])
  if (isParseError(fromDate)) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: fromDate.error }),
    }
  }

  const toDate = parseDate(params['to'])
  if (isParseError(toDate)) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: toDate.error }),
    }
  }

  const includeSummary =
    params['summary'] === 'true' || params['summary'] === '1'

  // Fetch history for the authenticated user (by numeric userId from session)
  let snapshots
  try {
    snapshots = await getHistory(session.id, {
      fromDate: fromDate ?? undefined,
      toDate: toDate ?? undefined,
      limit: limit ?? undefined,
    })
  } catch {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Failed to retrieve history' }),
    }
  }

  // Build response — snapshots are already provider-independent (no raw payloads)
  type ResponseBody = {
    snapshots: typeof snapshots
    count: number
    summary?: ReturnType<typeof computeHistorySummary>
  }

  const body: ResponseBody = {
    snapshots,
    count: snapshots.length,
  }

  if (includeSummary) {
    body.summary = computeHistorySummary(snapshots)
  }

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
    body: JSON.stringify(body),
  }
}
