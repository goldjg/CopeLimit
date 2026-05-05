import { createHmac, randomBytes } from 'crypto';

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
