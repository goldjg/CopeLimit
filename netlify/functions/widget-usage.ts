import type { Handler, HandlerEvent } from '@netlify/functions';
import { timingSafeEqual } from 'crypto';
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

function verifyWidgetToken(event: HandlerEvent): boolean {
  const configuredToken = process.env.WIDGET_TOKEN;
  if (!configuredToken) return false;

  const auth = event.headers['authorization'];
  const provided =
    event.headers['x-widget-token'] ??
    (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);

  if (!provided) return false;

  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(configuredToken, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function getWidgetCopilotInternalUsage(): Promise<Usage> {
  const githubToken = process.env.WIDGET_GITHUB_TOKEN;
  if (!githubToken) {
    return getUnsupportedUsage(undefined, [
      'WIDGET_GITHUB_TOKEN is not configured. Set this environment variable to a GitHub OAuth token with the copilot scope.'
    ]);
  }

  if (!/^[\x20-\x7E]+$/.test(githubToken)) {
    return getUnsupportedUsage(undefined, ['WIDGET_GITHUB_TOKEN contains invalid characters.']);
  }

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
      return getUnsupportedUsage(undefined, [
        'WIDGET_GITHUB_TOKEN is not valid or has expired. Update the environment variable.'
      ]);
    }
    if (response.status === 403) {
      return getUnsupportedUsage(undefined, [
        'WIDGET_GITHUB_TOKEN does not have access to Copilot internal APIs. A Copilot subscription and the copilot OAuth scope are required.'
      ]);
    }
    if (response.status === 404) {
      return getUnsupportedUsage(undefined, ['No Copilot subscription found for the widget GitHub token.']);
    }
    throw new Error(`Copilot internal API returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) {
    return getUnsupportedUsage(undefined, [
      'Copilot API responded but did not include quota data. The response shape may have changed.'
    ]);
  }

  const login = readString(body, 'login') ?? (process.env.GITHUB_LOGIN || 'unknown');

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
  if (!verifyWidgetToken(event)) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const provider = process.env.COPELIMIT_PROVIDER || 'mock';
    let usage: Usage;

    if (provider === 'github-copilot-internal') {
      usage = await getWidgetCopilotInternalUsage();
    } else {
      usage = await getUnsupportedUsage(undefined, [
        'Widget usage only supports the github-copilot-internal provider. Set COPELIMIT_PROVIDER=github-copilot-internal.'
      ]);
    }

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60'
      },
      body: JSON.stringify(usage)
    };
  } catch (error) {
    console.error('[widget-usage] unexpected error:', error instanceof Error ? error.message : String(error));
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
