import { createHash, createHmac, randomBytes } from 'crypto';

const DEFAULT_TTL_DAYS = 90;

export function widgetTokenTtlSeconds(): number {
  const days = parseInt(process.env.WIDGET_TOKEN_TTL_DAYS || '', 10);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  return safeDays * 86400;
}

export function widgetTokenTtlDays(): number {
  return Math.round(widgetTokenTtlSeconds() / 86400);
}

export function generateOpaqueWidgetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hashes a widget bearer token for storage/lookup. If WIDGET_TOKEN_HASH_SECRET
 * is configured, we use HMAC-SHA256. Otherwise we use SHA-256.
 */
export function hashWidgetToken(token: string): string {
  const pepper = process.env.WIDGET_TOKEN_HASH_SECRET || process.env.SESSION_SECRET;

  if (pepper) {
    return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
  }

  return createHash('sha256').update(token, 'utf8').digest('hex');
}
