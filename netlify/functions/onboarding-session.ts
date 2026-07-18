/**
 * @file Netlify Function: `onboarding-session`
 *
 * Issues a short-lived, single-use bootstrap token that bridges the browser
 * session to the on-device Scriptable environment during iOS widget onboarding.
 *
 * ## Endpoint
 * `POST /api/onboarding/session` — requires a valid session cookie.
 *
 * ## Behaviour
 * 1. Verifies the session cookie.
 * 2. Issues an opaque bootstrap token (default TTL: 15 minutes) tied to the
 *    authenticated user's session.
 * 3. Any previous bootstrap token for the user is revoked.
 * 4. The token is embedded in the clipboard payload that the PWA hands to the
 *    iOS Shortcuts app, which in turn runs `CopeLimitInstall.js` to exchange
 *    it for a long-lived widget token.
 *
 * ## Response
 * ```json
 * {
 *   "onboardingSessionId": "<uuid>",
 *   "bootstrapToken": "<opaque-token>",
 *   "expiresAt": "2026-05-07T22:00:00.000Z",
 *   "ttlSeconds": 900
 * }
 * ```
 *
 * ## Required environment variables
 * - `SESSION_SECRET`         – Session verification
 * - `SESSION_ENCRYPTION_KEY` – (optional) Encrypted sessions
 * - `BLOB_ENCRYPTION_KEY`    – Encrypting bootstrap token records
 * - `ONBOARDING_BOOTSTRAP_TTL_SECONDS` – (optional) Override TTL; default 900
 */
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
  if ('error' in auth && auth.error) {
    const { statusCode, body } = auth.error;
    return {
      statusCode,
      headers: baseHeaders,
      body,
    };
  }

  try {
    const issued = await issueBootstrapToken(auth.session);
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        onboardingSessionId: issued.onboardingSessionId,
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
