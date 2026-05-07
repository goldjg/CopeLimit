/**
 * @file HMAC-SHA256-signed, optionally AES-256-GCM-encrypted session cookies.
 *
 * ## Cookie format
 *
 * ### Without encryption (`SESSION_ENCRYPTION_KEY` not set)
 * ```
 * base64(JSON.stringify(payload)).HMAC-SHA256(secret)
 * ```
 *
 * ### With encryption (`SESSION_ENCRYPTION_KEY` set)
 * ```
 * base64("e:" + AES-256-GCM(JSON.stringify(payload))).HMAC-SHA256(secret)
 * ```
 *
 * The `e:` prefix lets the server distinguish encrypted from plaintext payloads
 * and enables zero-downtime key rotation: old plaintext cookies issued before
 * enabling encryption continue to be accepted until they expire.
 *
 * @see {@link signSession} for cookie creation
 * @see {@link verifySession} for cookie verification
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Data stored inside every authenticated session cookie.
 * The entire object is HMAC-signed and optionally AES-256-GCM encrypted.
 */
export type SessionPayload = {
  /** The authenticated GitHub login (username). */
  login: string;
  /** The numeric GitHub user ID. */
  id: number;
  /** Optional GitHub avatar URL (for display only; never used server-side). */
  avatar_url?: string;
  /**
   * The GitHub OAuth access token granted during the OAuth callback.
   * **Never exposed to the browser.**
   */
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

/** Options accepted by {@link serializeCookie}. */
export type CookieOptions = {
  /** Whether to set `HttpOnly` on the cookie. Defaults to `false`. */
  httpOnly?: boolean;
  /** Whether to set `Secure` on the cookie. Defaults to `false`. */
  secure?: boolean;
  /** `SameSite` attribute value. */
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Maximum lifetime in seconds (`Max-Age`). `0` deletes the cookie. */
  maxAge?: number;
  /** Cookie path. Defaults to `/`. */
  path?: string;
};

/**
 * Serialises `payload` into a signed (and optionally encrypted) session cookie value.
 *
 * When `encryptionKey` is provided the JSON payload is encrypted with AES-256-GCM
 * before being base64-encoded. The outer HMAC-SHA256 signature is always applied
 * regardless of whether encryption is used.
 *
 * @param payload       - Session data to embed.
 * @param secret        - HMAC-SHA256 signing secret (`SESSION_SECRET`).
 * @param encryptionKey - Optional 64-char hex AES-256 key (`SESSION_ENCRYPTION_KEY`).
 * @returns An opaque cookie value string suitable for use with `set-cookie`.
 */
export function signSession(payload: SessionPayload, secret: string, encryptionKey?: string): string {
  const json = JSON.stringify(payload);
  const content = encryptionKey ? `e:${encryptPayload(json, encryptionKey)}` : json;
  const data = Buffer.from(content, 'utf8').toString('base64');
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

/**
 * Verifies and deserialises a session cookie value produced by {@link signSession}.
 *
 * Returns `null` (rather than throwing) for any input that fails HMAC verification,
 * decryption, or JSON parsing to avoid leaking timing information or throwing
 * unhandled errors in request handlers.
 *
 * @param cookie        - The raw cookie value from the `Cookie` header.
 * @param secret        - HMAC-SHA256 signing secret (`SESSION_SECRET`).
 * @param encryptionKey - Optional 64-char hex AES-256 key; required when the
 *                        cookie was signed with encryption enabled.
 * @returns The verified {@link SessionPayload}, or `null` if the cookie is
 *          invalid, tampered, or cannot be decrypted.
 */
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

/**
 * Generates a cryptographically random OAuth CSRF state parameter (16 bytes, hex).
 *
 * @returns A 32-character lowercase hex string.
 */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Serialises a `Set-Cookie` header value from a name/value pair and options.
 *
 * The cookie value is percent-encoded. `Path=/` is set by default unless
 * `opts.path` is explicitly provided.
 *
 * @param name  - Cookie name.
 * @param value - Cookie value (will be percent-encoded).
 * @param opts  - Optional cookie attributes.
 * @returns A `Set-Cookie` header string.
 */
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

/**
 * Parses a `Cookie` header string into a key–value map.
 *
 * Values are percent-decoded. Malformed pairs are returned as empty strings.
 *
 * @param header - Raw `Cookie` header value (may be `undefined`).
 * @returns A plain object mapping cookie names to their decoded values.
 */
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

/**
 * Returns `true` when the Netlify site URL begins with `https://`, which
 * indicates a production/preview deployment where the `Secure` cookie flag
 * should be set. Returns `false` in local development (`netlify dev`).
 *
 * @returns Whether the current deployment context is a secure (HTTPS) origin.
 */
export function isSecureContext(): boolean {
  const siteUrl = process.env.URL || '';
  return siteUrl.startsWith('https://');
}
