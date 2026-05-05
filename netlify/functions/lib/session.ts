import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type SessionPayload = {
  login: string;
  id: number;
  avatar_url: string;
  accessToken: string;
};

function readEncryptionKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('SESSION_ENCRYPTION_KEY must be a 64-character hex string');
  }
  return Buffer.from(keyHex, 'hex');
}

function encryptPayload(json: string, keyHex: string): string {
  const key = readEncryptionKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
}

function decryptPayload(encrypted: string, keyHex: string): string | null {
  const parts = encrypted.split(':');
  if (parts.length !== 3) return null;

  const [ivHex, ciphertextHex, tagHex] = parts;
  if (!ivHex || !ciphertextHex || !tagHex) return null;

  try {
    const key = readEncryptionKey(keyHex);
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return null;
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number;
  path?: string;
};

export function signSession(payload: SessionPayload, secret: string, encryptionKey?: string): string {
  const json = JSON.stringify(payload);
  const content = encryptionKey ? `e:${encryptPayload(json, encryptionKey)}` : json;
  const data = Buffer.from(content, 'utf8').toString('base64');
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

export function verifySession(cookie: string, secret: string, encryptionKey?: string): SessionPayload | null {
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
    const inner = Buffer.from(data, 'base64').toString('utf8');
    let json = inner;

    if (inner.startsWith('e:')) {
      if (!encryptionKey) return null;
      const decrypted = decryptPayload(inner.slice(2), encryptionKey);
      if (!decrypted) return null;
      json = decrypted;
    }

    return JSON.parse(json) as SessionPayload;
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
