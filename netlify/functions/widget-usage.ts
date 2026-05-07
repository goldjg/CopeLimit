/**
 * @file Netlify Function: `widget-usage`
 *
 * Unauthenticated (token-authenticated) Copilot usage endpoint for the
 * Scriptable iOS widget. This endpoint is called directly by
 * `CopeLimitWidget.js` on the device, which presents the widget bearer token
 * instead of a session cookie.
 *
 * ## Endpoint
 * `GET /api/widget-usage`
 *
 * ## Authentication
 * The widget token must be supplied in **one** of:
 * - `Authorization: Bearer <token>` header
 * - `X-Widget-Token: <token>` header
 *
 * ## Behaviour
 * 1. Extracts the raw bearer token from the request.
 * 2. Looks up the token hash in Netlify Blobs via {@link resolveWidgetToken}.
 * 3. Calls `api.github.com/copilot_internal/user` using the stored GitHub
 *    access token associated with the widget token record.
 * 4. Returns a normalised {@link Usage} JSON response.
 *
 * ## Response shape
 * Same as `/api/usage` — a {@link Usage} JSON object.
 *
 * ## Required environment variables
 * - `SESSION_SECRET` or `WIDGET_TOKEN_HASH_SECRET` – For HMAC token hashing
 * - `BLOB_ENCRYPTION_KEY` – For decrypting token records
 */
import type { Handler, HandlerEvent } from '@netlify/functions';
import {
  type Usage,
  isObject,
  nextMonthReset,
  normaliseUsage,
  readNumber,
  readNumberAtPath,
  readString,
  getUnsupportedUsage
} from './lib/copilot';
import { isWidgetStoreNotConfiguredError, isWidgetStoreUnavailableError, resolveWidgetToken } from './lib/widget-store';

function extractToken(event: HandlerEvent): string | undefined {
  const auth = event.headers['authorization'];
  return event.headers['x-widget-token'] ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
}

async function getWidgetCopilotInternalUsage(githubToken: string, login: string): Promise<Usage> {
  const response = await fetch('https://api.github.com/copilot_internal/user', {
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/json',
      'x-github-api-version': '2022-11-28',
      'editor-version': 'vscode/1.95.0',
      'copilot-integration-id': 'vscode-chat',
      'user-agent': 'CopeLimit/1.0'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      return getUnsupportedUsage(login, [
        'Stored GitHub token has expired or been revoked. Re-generate your widget token in CopeLimit.'
      ]);
    }
    if (response.status === 403) {
      return getUnsupportedUsage(login, [
        'Stored GitHub token does not have access to Copilot internal APIs. A Copilot subscription and the copilot OAuth scope are required.'
      ]);
    }
    if (response.status === 404) {
      return getUnsupportedUsage(login, ['No Copilot subscription found for this account.']);
    }
    throw new Error(`Copilot internal API returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) {
    return getUnsupportedUsage(login, [
      'Copilot API responded but did not include quota data. The response shape may have changed.'
    ]);
  }

  const quota =
    readNumberAtPath(body, ['limited_user_quotas', 'premium_requests', 'entitlement']) ??
    readNumberAtPath(body, ['premium_requests', 'entitlement']) ??
    readNumberAtPath(body, ['quota_snapshots', 'premium_interactions', 'entitlement']) ??
    readNumber(body, 'entitlement', 'quota', 'limit', 'total');

  const remaining =
    readNumberAtPath(body, ['limited_user_quotas', 'premium_requests', 'remaining']) ??
    readNumberAtPath(body, ['premium_requests', 'remaining']) ??
    readNumberAtPath(body, ['quota_snapshots', 'premium_interactions', 'remaining']) ??
    readNumber(body, 'remaining');

  if (quota === undefined && remaining === undefined) {
    console.warn('[widget-usage] copilot_internal user payload missing quota fields');
    return getUnsupportedUsage(login, [
      'Copilot API responded but did not include quota data. The response shape may have changed.'
    ]);
  }

  const safeQuota = Math.max(0, quota ?? 0);
  const safeRemaining = Math.max(0, remaining ?? 0);
  const used = Math.max(0, safeQuota - safeRemaining);
  const resetAt =
    readString(body, 'quota_reset_at', 'quota_reset_date_utc', 'resetAt', 'reset_at', 'periodEndsAt') ??
    nextMonthReset();

  return normaliseUsage({
    mode: 'premium_requests',
    used,
    quota: safeQuota,
    resetAt,
    billingEntity: login,
    source: 'github-copilot-internal',
    notes: ['Live data via GitHub Copilot internal API (widget token).']
  });
}

export const handler: Handler = async (event) => {
  if (!process.env.WIDGET_TOKEN_HASH_SECRET && !process.env.SESSION_SECRET) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Service not configured' })
    };
  }

  const raw = extractToken(event);
  if (!raw) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const record = await resolveWidgetToken(raw);
    if (!record) {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    const usage = await getWidgetCopilotInternalUsage(record.githubAccessToken, record.login);

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60'
      },
      body: JSON.stringify(usage)
    };
  } catch (error) {
    if (isWidgetStoreNotConfiguredError(error)) {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Service not configured' })
      };
    }
    if (isWidgetStoreUnavailableError(error)) {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Widget token storage is unavailable' })
      };
    }
    const errorType = error instanceof Error ? error.name : typeof error;
    console.error('[widget-usage] unexpected error while resolving widget usage', errorType);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
