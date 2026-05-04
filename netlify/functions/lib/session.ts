import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type SessionPayload = {
  login: string;
  id: number;
  avatar_url: string;
  accessToken: string;
};

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number;
  path?: string;
};

export function signSession(payload: SessionPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

export function verifySession(cookie: string, secret: string): SessionPayload | null {
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;

  const data = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(data).digest('hex');

  let match: boolean;
  try {
    match = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return null;
  }

  if (!match) return null;

  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
}

export function generateState(): string {
  return randomBytes(16).toString('hex');
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];

  if (opts.path !== undefined) parts.push(`Path=${opts.path}`);
  else parts.push('Path=/');

  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);

  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return [part.trim(), ''];
      return [part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim())];
    })
  );
}

export function isSecureContext(): boolean {
  const siteUrl = process.env.URL || '';
  return siteUrl.startsWith('https://');
}
