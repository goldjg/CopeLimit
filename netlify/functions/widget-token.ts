/**
 * @file Netlify Function: `widget-token`
 *
 * CRUD endpoint for managing per-user widget bearer tokens.
 *
 * ## Endpoint
 * `/api/widget-token` — requires a valid session cookie for all methods.
 *
 * | Method   | Behaviour                                                      |
 * |----------|----------------------------------------------------------------|
 * | `GET`    | Returns token status (`hasActiveToken`, `expiresAt`, `ttlDays`) without revealing the raw token |
 * | `POST`   | Issues a new token (replacing any existing one) and returns the raw token **once** |
 * | `DELETE` | Revokes the active token                                       |
 *
 * ## POST response
 * ```json
 * {
 *   "token": "<opaque-bearer-token>",
 *   "expiresAt": "2026-08-05T00:00:00.000Z",
 *   "ttlDays": 90,
 *   "login": "octocat",
 *   "replacedExisting": false
 * }
 * ```
 *
 * ## Required environment variables
 * - `SESSION_SECRET`          – For session verification
 * - `SESSION_ENCRYPTION_KEY`  – For encrypted session cookies
 * - `BLOB_ENCRYPTION_KEY`     – For encrypting token records in Netlify Blobs
 * - `WIDGET_TOKEN_TTL_DAYS`   – (optional) Token TTL; defaults to 90 days
 */
import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import { widgetTokenTtlDays } from './lib/widget-token';
import {
  getWidgetTokenStatusForUser,
  isWidgetStoreNotConfiguredError,
  isWidgetStoreUnavailableError,
  issueWidgetTokenForUser,
  revokeWidgetTokenForUser
} from './lib/widget-store';

async function requireSession(event: Parameters<Handler>[0]) {
  const sessionSecret = process.env.SESSION_SECRET;
  const encKey = process.env.SESSION_ENCRYPTION_KEY;

  if (!sessionSecret) {
    return {
      error: {
        statusCode: 503,
        body: JSON.stringify({ error: 'Session secret not configured' })
      }
    };
  }

  const cookies = parseCookies(event.headers['cookie']);
  const rawSession = cookies['session'];
  if (!rawSession) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Not authenticated' })
      }
    };
  }

  const session = verifySession(rawSession, sessionSecret, encKey || undefined);
  if (!session) {
    return {
      error: {
        statusCode: 401,
        body: JSON.stringify({ error: 'Session invalid or expired' })
      }
    };
  }

  return { session };
}

export const handler: Handler = async (event) => {
  const baseHeaders = { 'content-type': 'application/json; charset=utf-8' };
  const storeUnavailable = () => ({
    statusCode: 503,
    headers: baseHeaders,
    body: JSON.stringify({ error: 'Widget token storage is unavailable' })
  });
  const serviceNotConfigured = () => ({
    statusCode: 503,
    headers: baseHeaders,
    body: JSON.stringify({ error: 'Service not configured' })
  });

  if (event.httpMethod === 'GET') {
    const auth = await requireSession(event);
    if ('error' in auth && auth.error) {
      const { statusCode, body } = auth.error;
      return {
        statusCode,
        headers: baseHeaders,
        body,
      };
    }

    let status;
    try {
      status = await getWidgetTokenStatusForUser(auth.session.id);
    } catch (error) {
      if (isWidgetStoreNotConfiguredError(error)) {
        return serviceNotConfigured();
      }
      if (isWidgetStoreUnavailableError(error)) {
        return storeUnavailable();
      }
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Internal server error' })
      };
    }

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ ttlDays: widgetTokenTtlDays(), ...status })
    };
  }

  if (event.httpMethod === 'DELETE') {
    const auth = await requireSession(event);
    if ('error' in auth && auth.error) {
      const { statusCode, body } = auth.error;
      return {
        statusCode,
        headers: baseHeaders,
        body,
      };
    }

    let revoked;
    try {
      revoked = await revokeWidgetTokenForUser(auth.session.id);
    } catch (error) {
      if (isWidgetStoreNotConfiguredError(error)) {
        return serviceNotConfigured();
      }
      if (isWidgetStoreUnavailableError(error)) {
        return storeUnavailable();
      }
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Internal server error' })
      };
    }

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ revoked })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'GET, POST, DELETE' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const auth = await requireSession(event);
  if ('error' in auth && auth.error) {
    const { statusCode, body } = auth.error;
    return {
      statusCode,
      headers: baseHeaders,
      body,
    };
  }

  let issued;
  try {
    issued = await issueWidgetTokenForUser(auth.session);
  } catch (error) {
    if (isWidgetStoreNotConfiguredError(error)) {
      return serviceNotConfigured();
    }
    if (isWidgetStoreUnavailableError(error)) {
      return storeUnavailable();
    }
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }

  return {
    statusCode: 200,
    headers: baseHeaders,
    body: JSON.stringify({
      token: issued.token,
      expiresAt: issued.record.expiresAt,
      ttlDays: widgetTokenTtlDays(),
      login: auth.session.login,
      replacedExisting: issued.replacedExisting
    })
  };
};
