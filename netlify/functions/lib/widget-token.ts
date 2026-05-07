/**
 * @file Widget token generation, hashing, and TTL helpers.
 *
 * Widget tokens are opaque random bearer tokens (32 bytes, base64url-encoded)
 * stored as HMAC-SHA256 hashes so that the raw token is never written to disk.
 * The TTL is configurable via the `WIDGET_TOKEN_TTL_DAYS` environment variable
 * and defaults to {@link DEFAULT_TTL_DAYS} days.
 */
import { createHmac, randomBytes } from 'crypto';

const DEFAULT_TTL_DAYS = 90;

/**
 * Returns the widget token TTL in seconds.
 *
 * Reads `WIDGET_TOKEN_TTL_DAYS` from the environment. Falls back to
 * {@link DEFAULT_TTL_DAYS} (90 days) if the variable is absent or invalid.
 *
 * @returns Positive integer number of seconds for the token TTL.
 */
export function widgetTokenTtlSeconds(): number {
  const days = parseInt(process.env.WIDGET_TOKEN_TTL_DAYS || '', 10);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  return safeDays * 86400;
}

/**
 * Returns the widget token TTL rounded to whole days (for display purposes).
 *
 * @returns Positive integer number of days for the token TTL.
 */
export function widgetTokenTtlDays(): number {
  return Math.round(widgetTokenTtlSeconds() / 86400);
}

/**
 * Generates a new opaque widget bearer token.
 *
 * The token is 32 cryptographically random bytes encoded as base64url,
 * producing a 43-character URL-safe string. The raw token is given to the
 * user exactly once; only its HMAC-SHA256 hash is persisted.
 *
 * @returns A 43-character base64url-encoded random token string.
 */
export function generateOpaqueWidgetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hashes a widget bearer token for storage/lookup using HMAC-SHA256.
 * Requires WIDGET_TOKEN_HASH_SECRET or SESSION_SECRET to be configured.
 */
export function hashWidgetToken(token: string): string {
  const hashSecret = process.env.WIDGET_TOKEN_HASH_SECRET || process.env.SESSION_SECRET;
  if (!hashSecret) {
    throw new Error('WIDGET_TOKEN_HASH_SECRET or SESSION_SECRET must be configured');
  }

  return createHmac('sha256', hashSecret).update(token, 'utf8').digest('hex');
}
