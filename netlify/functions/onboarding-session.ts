import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import {
  isOnboardingStoreNotConfiguredError,
  isOnboardingStoreUnavailableError,
  issueBootstrapToken,
  onboardingBootstrapTtlSeconds
} from './lib/onboarding-store';

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

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const auth = await requireSession(event);
  if ('error' in auth) {
    return { ...auth.error, headers: baseHeaders };
  }

  try {
    const issued = await issueBootstrapToken(auth.session);
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        bootstrapToken: issued.token,
        expiresAt: issued.expiresAt,
        ttlSeconds: onboardingBootstrapTtlSeconds()
      })
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
