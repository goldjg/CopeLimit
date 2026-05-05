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
      scope: 'read:user copilot',
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
