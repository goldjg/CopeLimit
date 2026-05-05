import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import { widgetTokenTtlDays } from './lib/widget-token';
import {
  getWidgetTokenStatusForUser,
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

  if (event.httpMethod === 'GET') {
    const auth = await requireSession(event);
    if ('error' in auth) {
      return { ...auth.error, headers: baseHeaders };
    }

    let status;
    try {
      status = await getWidgetTokenStatusForUser(auth.session.id);
    } catch (error) {
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
    if ('error' in auth) {
      return { ...auth.error, headers: baseHeaders };
    }

    let revoked;
    try {
      revoked = await revokeWidgetTokenForUser(auth.session.id);
    } catch (error) {
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
  if ('error' in auth) {
    return { ...auth.error, headers: baseHeaders };
  }

  let issued;
  try {
    issued = await issueWidgetTokenForUser(auth.session);
  } catch (error) {
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
