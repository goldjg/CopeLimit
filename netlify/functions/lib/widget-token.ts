import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type WidgetTokenPayload = {
  login: string;
  accessToken: string;
  exp: number; // Unix timestamp in seconds
};

const WIDGET_TOKEN_VERSION = 'wt1';
const DEFAULT_TTL_DAYS = 90;

function readEncryptionKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('WIDGET_TOKEN_ENCRYPTION_KEY must be a 64-character hex string');
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

/**
 * Signs (and optionally encrypts) a widget token payload.
 * Uses the same HMAC-SHA256 + optional AES-256-GCM pattern as session cookies.
 * The signed data includes a version prefix to prevent cross-domain token reuse.
 */
export function signWidgetToken(
  payload: WidgetTokenPayload,
  secret: string,
  encryptionKey?: string
): string {
  const json = JSON.stringify(payload);
  const inner = encryptionKey ? `e:${encryptPayload(json, encryptionKey)}` : json;
  // Version-prefix prevents session cookies being used as widget tokens and vice versa
  const versioned = `${WIDGET_TOKEN_VERSION}:${inner}`;
  const data = Buffer.from(versioned, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

/**
 * Verifies a widget token. Returns the payload if valid and unexpired, null otherwise.
 */
export function verifyWidgetToken(
  token: string,
  secret: string,
  encryptionKey?: string
): WidgetTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;

  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(data).digest('hex');

  let match: boolean;
  try {
    match = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return null;
  }

  if (!match) return null;

  try {
    const versioned = Buffer.from(data, 'base64url').toString('utf8');
    if (!versioned.startsWith(`${WIDGET_TOKEN_VERSION}:`)) return null;

    const inner = versioned.slice(WIDGET_TOKEN_VERSION.length + 1);
    let json = inner;

    if (inner.startsWith('e:')) {
      if (!encryptionKey) return null;
      const decrypted = decryptPayload(inner.slice(2), encryptionKey);
      if (!decrypted) return null;
      json = decrypted;
    }

    const payload = JSON.parse(json) as WidgetTokenPayload;

    // Check expiry
    if (typeof payload.exp !== 'number' || Date.now() / 1000 >= payload.exp) {
      return null;
    }

    if (
      typeof payload.login !== 'string' ||
      typeof payload.accessToken !== 'string' ||
      !payload.login ||
      !payload.accessToken
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns the token TTL in seconds, derived from WIDGET_TOKEN_TTL_DAYS env var (default: 90 days).
 */
export function widgetTokenTtlSeconds(): number {
  const days = parseInt(process.env.WIDGET_TOKEN_TTL_DAYS || '', 10);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  return safeDays * 86400;
}
