import type { Handler } from '@netlify/functions';
import { verifySession, parseCookies } from './lib/session';

export const handler: Handler = async (event) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[me] SESSION_SECRET is not set; all sessions are unauthenticated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ authenticated: false })
    };
  }

  const cookies = parseCookies(event.headers['cookie']);
  const raw = cookies['session'];

  if (!raw) {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ authenticated: false })
    };
  }

  const payload = verifySession(raw, secret);
  if (!payload) {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ authenticated: false })
    };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      authenticated: true,
      login: payload.login,
      avatar_url: payload.avatar_url
    })
  };
};
