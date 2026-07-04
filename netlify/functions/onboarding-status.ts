import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import {
  isOnboardingStoreNotConfiguredError,
  isOnboardingStoreUnavailableError,
  readOnboardingSessionStatus
} from './lib/onboarding-store';

function isValidSessionId(value: string | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_\-]{16,128}$/.test(value);
}

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

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'GET' },
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

  const sessionId = event.queryStringParameters?.sessionId ?? null;
  if (!isValidSessionId(sessionId)) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Invalid sessionId' })
    };
  }

  try {
    const status = await readOnboardingSessionStatus(sessionId, auth.session.id);
    if (!status) {
      return {
        statusCode: 404,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Onboarding session not found' })
      };
    }

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify(status)
    };
  } catch (error) {
    if (isOnboardingStoreNotConfiguredError(error)) {
      return {
        statusCode: 503,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Service not configured' })
      };
    }
    if (isOnboardingStoreUnavailableError(error)) {
      return {
        statusCode: 503,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Onboarding storage is unavailable' })
      };
    }
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
