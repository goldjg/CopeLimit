/**
 * @file Netlify Function: `auth-start`
 *
 * Initiates the GitHub OAuth 2.0 authorisation code flow.
 *
 * ## Endpoint
 * `GET /api/auth/start`
 *
 * ## Behaviour
 * 1. Generates a cryptographically random CSRF `state` parameter.
 * 2. Stores the state in an `oauth_state` HttpOnly cookie (10-minute TTL).
 * 3. Redirects the browser to GitHub's OAuth authorisation endpoint requesting
 *    the `read:user copilot` scopes.
 *
 * ## Error handling
 * If `GITHUB_CLIENT_ID` is not configured the handler redirects to
 * `/?error=auth_unavailable` and logs the error.
 *
 * ## Required environment variables
 * - `GITHUB_CLIENT_ID` – GitHub OAuth App client ID
 */
import type { Handler } from '@netlify/functions';
import { generateState, serializeCookie, isSecureContext } from './lib/session';

export const handler: Handler = async () => {
  const clientId = process.env.GITHUB_CLIENT_ID;

  try {
    if (!clientId) {
      throw new Error('GITHUB_CLIENT_ID is not configured');
    }

    const state = generateState();
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'read:user',
      state
    });

    const stateCookie = serializeCookie('oauth_state', state, {
      httpOnly: true,
      secure: isSecureContext(),
      sameSite: 'Lax',
      maxAge: 600
    });

    return {
      statusCode: 302,
      headers: {
        location: `https://github.com/login/oauth/authorize?${params.toString()}`,
        'set-cookie': stateCookie
      },
      body: ''
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[auth-start]', message);
    return {
      statusCode: 302,
      headers: { location: '/?error=auth_unavailable' },
      body: ''
    };
  }
};
