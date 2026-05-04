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
