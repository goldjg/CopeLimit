import type { Handler } from '@netlify/functions';
import {
  signSession,
  serializeCookie,
  parseCookies,
  isSecureContext
} from './lib/session';

type GitHubUser = {
  id: number;
  login: string;
  avatar_url: string;
};

function isGitHubUser(value: unknown): value is GitHubUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'number' &&
    typeof (value as Record<string, unknown>).login === 'string' &&
    typeof (value as Record<string, unknown>).avatar_url === 'string'
  );
}

export const handler: Handler = async (event) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const encKey = process.env.SESSION_ENCRYPTION_KEY;

  const code = event.queryStringParameters?.['code'];
  const state = event.queryStringParameters?.['state'];
  const cookies = parseCookies(event.headers['cookie']);
  const savedState = cookies['oauth_state'];

  const clearStateCookie = serializeCookie('oauth_state', '', {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0
  });

  try {
    if (!clientId || !clientSecret) {
      throw new Error('OAuth credentials are not configured');
    }

    if (!sessionSecret) {
      throw new Error('SESSION_SECRET is not configured');
    }

    if (!code || !state) {
      return {
        statusCode: 302,
        headers: { location: '/?error=auth_failed', 'set-cookie': clearStateCookie },
        body: ''
      };
    }

    if (!savedState || state !== savedState) {
      return {
        statusCode: 302,
        headers: { location: '/?error=auth_state_mismatch', 'set-cookie': clearStateCookie },
        body: ''
      };
    }

    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });

    if (!tokenResponse.ok) {
      throw new Error(`GitHub token exchange returned HTTP ${tokenResponse.status}`);
    }

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
    const accessToken = typeof tokenData['access_token'] === 'string' ? tokenData['access_token'] : null;

    if (!accessToken) {
      const description = typeof tokenData['error_description'] === 'string'
        ? tokenData['error_description']
        : 'no access_token in response';
      throw new Error(`Token exchange failed: ${description}`);
    }

    // Fetch user identity
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    });

    if (!userResponse.ok) {
      throw new Error(`GitHub user API returned HTTP ${userResponse.status}`);
    }

    const user: unknown = await userResponse.json();
    if (!isGitHubUser(user)) {
      throw new Error('GitHub user API returned unexpected shape');
    }

    const sessionToken = signSession(
      { login: user.login, id: user.id, avatar_url: user.avatar_url, accessToken },
      sessionSecret,
      encKey || undefined
    );

    const secure = isSecureContext();
    const sessionCookie = serializeCookie('session', sessionToken, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7 // 7 days
    });

    return {
      statusCode: 302,
      headers: { location: '/' },
      multiValueHeaders: { 'set-cookie': [sessionCookie, clearStateCookie] },
      body: ''
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[auth-callback]', message);
    return {
      statusCode: 302,
      headers: { location: '/?error=auth_failed', 'set-cookie': clearStateCookie },
      body: ''
    };
  }
};
