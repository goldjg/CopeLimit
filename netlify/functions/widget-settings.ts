/**
 * @file Netlify Function: `widget-settings`
 *
 * Session-authenticated endpoint for reading and updating per-user widget
 * preferences (currently: desired refresh cadence).
 *
 * ## Endpoint
 * `/api/widget-settings` — requires a valid session cookie.
 *
 * | Method  | Behaviour                                                     |
 * |---------|---------------------------------------------------------------|
 * | `GET`   | Returns the current widget settings (or defaults if unset).   |
 * | `PATCH` | Validates and saves the provided widget settings.             |
 *
 * ## GET response
 * ```json
 * { "desiredRefreshMinutes": 30 }
 * ```
 * `desiredRefreshMinutes` is `null` when no preference has been saved
 * (manual / let iOS decide).
 *
 * ## PATCH request body
 * ```json
 * { "desiredRefreshMinutes": 30 }
 * ```
 * Accepted values: `15`, `30`, `60`, `120`, `240`, or `null` (manual).
 * Values outside this set are silently clamped to `null`.
 *
 * ## Required environment variables
 * - `SESSION_SECRET`          – For session verification
 * - `SESSION_ENCRYPTION_KEY`  – For encrypted session cookies
 * - `BLOB_ENCRYPTION_KEY`     – For encrypting settings records in Netlify Blobs
 */
import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import {
  getWidgetUserSettings,
  isWidgetStoreNotConfiguredError,
  isWidgetStoreUnavailableError,
  parseWidgetRefreshCadence,
  setWidgetUserSettings
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

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'PATCH') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'GET, PATCH' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const auth = await requireSession(event);
  if ('error' in auth) {
    return { ...auth.error, headers: baseHeaders };
  }

  if (event.httpMethod === 'GET') {
    let settings;
    try {
      settings = await getWidgetUserSettings(auth.session.id);
    } catch (error) {
      if (isWidgetStoreNotConfiguredError(error)) return serviceNotConfigured();
      if (isWidgetStoreUnavailableError(error)) return storeUnavailable();
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Internal server error' })
      };
    }

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ desiredRefreshMinutes: settings?.desiredRefreshMinutes ?? null })
    };
  }

  // PATCH
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const cadence = parseWidgetRefreshCadence(body['desiredRefreshMinutes']);

  try {
    await setWidgetUserSettings(auth.session.id, {
      desiredRefreshMinutes: cadence,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    if (isWidgetStoreNotConfiguredError(error)) return serviceNotConfigured();
    if (isWidgetStoreUnavailableError(error)) return storeUnavailable();
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }

  return {
    statusCode: 200,
    headers: baseHeaders,
    body: JSON.stringify({ desiredRefreshMinutes: cadence })
  };
};
