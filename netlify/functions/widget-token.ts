import type { Handler } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import { signWidgetToken, widgetTokenTtlSeconds } from './lib/widget-token';

export const handler: Handler = async (event) => {
  // GET: return configured TTL so the UI can display it before generating
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ttlDays: Math.round(widgetTokenTtlSeconds() / 86400) })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sessionSecret = process.env.SESSION_SECRET;
  const encKey = process.env.SESSION_ENCRYPTION_KEY;

  if (!sessionSecret) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Session secret not configured' })
    };
  }

  const cookies = parseCookies(event.headers['cookie']);
  const rawSession = cookies['session'];
  if (!rawSession) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Not authenticated' })
    };
  }

  const session = verifySession(rawSession, sessionSecret, encKey || undefined);
  if (!session) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Session invalid or expired' })
    };
  }

  const widgetSecret = process.env.WIDGET_TOKEN_SECRET || sessionSecret;
  const widgetEncKey = process.env.WIDGET_TOKEN_ENCRYPTION_KEY || encKey || undefined;

  const ttl = widgetTokenTtlSeconds();
  const exp = Math.floor(Date.now() / 1000) + ttl;

  const token = signWidgetToken(
    { login: session.login, accessToken: session.accessToken, exp },
    widgetSecret,
    widgetEncKey
  );

  const expiresAt = new Date(exp * 1000).toISOString();
  const ttlDays = Math.round(ttl / 86400);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ token, expiresAt, ttlDays, login: session.login })
  };
};
