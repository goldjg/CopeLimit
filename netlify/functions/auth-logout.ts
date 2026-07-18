/**
 * @file Netlify Function: `auth-logout`
 *
 * Ends the authenticated session by clearing the `session` cookie.
 *
 * ## Endpoint
 * `GET /api/auth/logout`
 *
 * ## Behaviour
 * Sets `session` to an empty string with `Max-Age=0` (causing browsers to
 * delete the cookie) then redirects to `/`.
 *
 * No server-side state is maintained for sessions so there is no additional
 * cleanup required.
 */
import type { Handler } from '@netlify/functions';
import { serializeCookie } from './lib/session';

export const handler: Handler = async () => {
  return {
    statusCode: 302,
    headers: {
      location: '/',
      'set-cookie': serializeCookie('session', '', { maxAge: 0, httpOnly: true, sameSite: 'Lax', path: '/' })
    },
    body: ''
  };
};
