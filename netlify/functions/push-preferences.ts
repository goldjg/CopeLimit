/**
 * @file Netlify Function: `push-preferences`
 *
 * Session-authenticated endpoint for reading/updating per-user push alert
 * preferences.
 *
 * Endpoint: `/api/push/preferences`
 * Methods:
 * - GET   -> current effective preferences (defaults when unset)
 * - PATCH -> save partial preferences
 */

import type { Handler } from '@netlify/functions'
import { parseCookies, verifySession } from './lib/session'
import {
  getPushUserPreferences,
  type PushUserPreferencesPatch,
  setPushUserPreferences,
} from './lib/push-preferences-store'

async function requireSession(event: Parameters<Handler>[0]) {
  const sessionSecret = process.env.SESSION_SECRET
  const encKey = process.env.SESSION_ENCRYPTION_KEY

  if (!sessionSecret) {
    return {
      error: {
        statusCode: 503,
        body: JSON.stringify({ error: 'Session secret not configured' }),
      },
    }
  }

  const cookies = parseCookies(event.headers.cookie)
  const rawSession = cookies.session
  if (!rawSession) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Not authenticated' }),
      },
    }
  }

  const session = verifySession(rawSession, sessionSecret, encKey || undefined)
  if (!session) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Session invalid or expired' }),
      },
    }
  }

  return { session }
}

export const handler: Handler = async (event) => {
  const baseHeaders = { 'content-type': 'application/json; charset=utf-8' }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'PATCH') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'GET, PATCH' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  const auth = await requireSession(event)
  if ('error' in auth) {
    return { ...auth.error, headers: baseHeaders }
  }

  try {
    if (event.httpMethod === 'GET') {
      const prefs = await getPushUserPreferences(auth.session.id)
      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify(prefs),
      }
    }

    // PATCH
    let body: Record<string, unknown>
    try {
      body = JSON.parse(event.body || '{}') as Record<string, unknown>
    } catch {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      }
    }

    const patch: PushUserPreferencesPatch = {
      notifyOnStatusLevelChange: body.notifyOnStatusLevelChange as boolean | undefined,
      notifyWhenStatusBecomesHot: body.notifyWhenStatusBecomesHot as boolean | undefined,
      notifyWhenStatusBecomesOverage: body.notifyWhenStatusBecomesOverage as boolean | undefined,
      notifyWhenStatusBecomesBlocked: body.notifyWhenStatusBecomesBlocked as boolean | undefined,
      notifyWhenProjectedExhaustionWithinHours:
        body.notifyWhenProjectedExhaustionWithinHours as boolean | undefined,
      projectedExhaustionThresholdHours: body.projectedExhaustionThresholdHours as number | undefined,
      notifyOnBurnRateIncrease: body.notifyOnBurnRateIncrease as boolean | undefined,
      burnRateIncreasePercentThreshold: body.burnRateIncreasePercentThreshold as number | undefined,
    }

    const updated = await setPushUserPreferences(auth.session.id, patch)

    if (!updated) {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid user id' }),
      }
    }

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify(updated),
    }
  } catch {
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    }
  }
}
