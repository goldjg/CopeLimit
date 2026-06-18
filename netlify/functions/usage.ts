/**
 * @file Netlify Function: `usage`
 *
 * The primary Copilot usage endpoint. Dispatches to the configured provider
 * and returns a normalised {@link Usage} JSON response.
 *
 * ## Endpoint
 * `GET /api/usage`
 *
 * ## Providers (controlled by `COPELIMIT_PROVIDER` env var)
 *
 * | Value                      | Data source                                        | Auth required |
 * |----------------------------|----------------------------------------------------|---------------|
 * | `mock` (default)           | Configurable static values via `MOCK_*` env vars   | No            |
 * | `github-copilot-internal`  | `api.github.com/copilot_internal/user`             | Session cookie|
 * | `copilot-local`            | Local `copilot-api` proxy (`http://127.0.0.1:4141`)| No            |
 * | `github` / `unsupported`   | Returns zeroed unsupported usage                   | No            |
 *
 * ## Response shape
 * ```json
 * {
 *   "mode": "premium_requests",
 *   "used": 321,
 *   "quota": 500,
 *   "remaining": 179,
 *   "percentUsed": 64,
 *   "resetAt": "2026-06-01T00:00:00.000Z",
 *   "billingEntity": "octocat",
 *   "source": "github-copilot-internal",
 *   "warningLevel": "normal",
 *   "updatedAt": "2026-05-07T21:00:00.000Z",
 *   "notes": []
 * }
 * ```
 *
 * ## Capture
 * When `CAPTURE_PROVIDER_RESPONSES=true`, a sanitised snapshot of the raw
 * provider response is written to Netlify Blobs asynchronously (fire-and-forget)
 * via {@link maybeCapture}. This never blocks the usage response.
 *
 * ## Cache
 * Responses are marked `Cache-Control: private, max-age=60`.
 *
 * ## Required environment variables (provider-dependent)
 * - `COPELIMIT_PROVIDER`      – Provider selection
 * - `SESSION_SECRET`          – Required for `github-copilot-internal`
 * - `SESSION_ENCRYPTION_KEY`  – Recommended for `github-copilot-internal`
 * - `MOCK_USED` / `MOCK_QUOTA` / `MOCK_RESET_AT` – Mock provider overrides
 * - `COPILOT_API_URL`         – Override for `copilot-local` (default: `http://127.0.0.1:4141`)
 */
import type { Handler, HandlerEvent } from '@netlify/functions';
import { parseCookies, verifySession } from './lib/session';
import {
  type Mode,
  type JsonObject,
  type Usage,
  isObject,
  nextMonthReset,
  normaliseUsage,
  readNumber,
  readNumberAtPath,
  readString,
  getUnsupportedUsage,
  detectMode,
  readOverageFields
} from './lib/copilot';
import { maybeCapture } from './lib/capture-store';
import { readCaptureConfig } from './lib/capture-config';

type UsageResult = {
  usage: Usage;
  rawPayload: JsonObject | null;
  userId?: number;
};

function readMode(input: JsonObject): Mode {
  const modeText = readString(input, 'mode', 'metric', 'kind');
  if (!modeText) return 'premium_requests';

  return modeText.toLowerCase().includes('credit') ? 'ai_credits' : 'premium_requests';
}

function resolveCopilotApiUrl(): string {
  const configured = process.env.COPELIMIT_COPILOT_API_URL || process.env.COPILOT_API_URL || 'http://127.0.0.1:4141';
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('COPILOT_API_URL must be a valid URL');
  }

  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('COPILOT_API_URL must point to localhost/loopback only');
  }

  return parsed.toString();
}

async function getMockUsage(): Promise<UsageResult> {
  const used = Number(process.env.MOCK_USED ?? 321);
  const quota = Number(process.env.MOCK_QUOTA ?? 500);

  return {
    usage: normaliseUsage({
      mode: 'premium_requests',
      used,
      quota,
      resetAt: process.env.MOCK_RESET_AT || nextMonthReset(),
      billingEntity: process.env.GITHUB_LOGIN || 'goldjg',
      source: 'mock',
      notes: [
        'Mock provider active. Replace with GitHub billing/usage provider when API access is confirmed.'
      ]
    }),
    rawPayload: null
  };
}

async function getCopilotLocalUsage(): Promise<UsageResult> {
  const fallbackBillingEntity = process.env.GITHUB_LOGIN || 'unknown';
  const baseUrl = resolveCopilotApiUrl();
  const usageUrl = new URL('/usage', baseUrl).toString();
  const response = await fetch(usageUrl, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`copilot-api usage endpoint returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isObject(payload)) {
    throw new Error('copilot-api usage endpoint did not return a JSON object');
  }

  const notes = [
    'copilot-local provider active via local copilot-api proxy. This is unofficial and local-only.',
    'CopeLimit only reads /usage and never reads or returns /token.'
  ];

  // Parse the copilot-api response shape:
  // quota_snapshots.premium_interactions.entitlement → quota
  // quota_snapshots.premium_interactions.remaining   → remaining
  // quota_reset_date_utc                             → resetAt
  // login / copilot_plan                             → billingEntity
  const snapshots = payload['quota_snapshots'];
  const premiumInteractions = isObject(snapshots) ? snapshots['premium_interactions'] : undefined;
  const pi = isObject(premiumInteractions) ? premiumInteractions : undefined;

  let quota = 0;
  let remaining = 0;
  let usedFromSnapshot = false;

  if (pi) {
    const entitlement = readNumber(pi, 'entitlement');
    const rem = readNumber(pi, 'remaining');
    if (entitlement !== undefined) {
      quota = entitlement;
      usedFromSnapshot = true;
    }
    if (rem !== undefined) {
      remaining = rem;
    }
  }

  // Fall back to legacy flat fields if snapshot not present
  if (!usedFromSnapshot) {
    quota = readNumber(payload, 'quota', 'limit', 'total') ?? 0;
    remaining = readNumber(payload, 'remaining') ?? Math.max(0, quota - (readNumber(payload, 'used', 'usage', 'usedCount', 'consumed') ?? 0));
    if (quota === 0) {
      notes.push('copilot-api response did not include quota_snapshots; fell back to legacy fields and got 0 values.');
    }
  }

  const used = Math.max(0, quota - remaining);
  const resetAt = readString(payload, 'quota_reset_date_utc', 'resetAt', 'reset_at', 'periodEndsAt') ?? nextMonthReset();
  const billingEntity = readString(payload, 'login', 'username', 'billingEntity', 'billing_entity', 'copilot_plan') ?? fallbackBillingEntity;
  const mode = readMode(payload);

  return {
    usage: normaliseUsage({
      mode,
      used,
      quota,
      resetAt,
      billingEntity,
      source: 'copilot-local',
      notes
    }),
    rawPayload: payload
  };
}

async function getCopilotInternalUsage(event: HandlerEvent): Promise<UsageResult> {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    return {
      usage: await getUnsupportedUsage(undefined, ['Session secret not configured; cannot authenticate.']),
      rawPayload: null
    };
  }

  const cookies = parseCookies(event.headers['cookie']);
  const rawSession = cookies['session'];
  if (!rawSession) {
    return {
      usage: await getUnsupportedUsage(undefined, ['No session cookie present. Please sign in.']),
      rawPayload: null
    };
  }

  const encKey = process.env.SESSION_ENCRYPTION_KEY;
  const sessionPayload = verifySession(rawSession, sessionSecret, encKey || undefined);
  if (!sessionPayload) {
    return {
      usage: await getUnsupportedUsage(undefined, ['Session invalid or expired. Please sign in again.']),
      rawPayload: null
    };
  }

  const { accessToken, login, id } = sessionPayload;
  const response = await fetch('https://api.github.com/copilot_internal/user', {
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'x-github-api-version': '2022-11-28',
      'editor-version': 'vscode/1.95.0',
      'copilot-integration-id': 'vscode-chat',
      'user-agent': 'CopeLimit/1.0'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      return {
        usage: await getUnsupportedUsage(login, [
          'GitHub token is not valid or has expired. Please sign out and sign in again.'
        ]),
        rawPayload: null,
        userId: id
      };
    }
    if (response.status === 403) {
      return {
        usage: await getUnsupportedUsage(login, [
          'This GitHub account does not have access to Copilot internal APIs. A Copilot subscription and the copilot OAuth scope are required.'
        ]),
        rawPayload: null,
        userId: id
      };
    }
    if (response.status === 404) {
      return {
        usage: await getUnsupportedUsage(login, ['No Copilot subscription found for this account.']),
        rawPayload: null,
        userId: id
      };
    }
    throw new Error(`Copilot internal API returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) {
    return {
      usage: await getUnsupportedUsage(login, [
        'Copilot API responded but did not include quota data. The response shape may have changed.'
      ]),
      rawPayload: null,
      userId: id
    };
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
    console.warn('[usage] copilot_internal user payload missing quota fields', Object.keys(body));
    return {
      usage: await getUnsupportedUsage(login, [
        'Copilot API responded but did not include quota data. The response shape may have changed.'
      ]),
      rawPayload: body,
      userId: id
    };
  }

  const safeQuota = Math.max(0, quota ?? 0);
  const safeRemaining = Math.max(0, remaining ?? 0);
  const used = Math.max(0, safeQuota - safeRemaining);
  const resetAt =
    readString(body, 'quota_reset_at', 'quota_reset_date_utc', 'resetAt', 'reset_at', 'periodEndsAt') ??
    nextMonthReset();

  return {
    usage: normaliseUsage({
      mode: detectMode(body),
      used,
      quota: safeQuota,
      resetAt,
      billingEntity: login,
      source: 'github-copilot-internal',
      notes: ['Live data via GitHub Copilot internal API.'],
      ...readOverageFields(body)
    }),
    rawPayload: body,
    userId: id
  };
}

export const handler: Handler = async (event) => {
  try {
    const provider = process.env.COPELIMIT_PROVIDER || 'mock';
    const captureConfig = readCaptureConfig();
    const result =
      provider === 'copilot-local'
        ? await getCopilotLocalUsage()
        : provider === 'github-copilot-internal'
          ? await getCopilotInternalUsage(event)
          : provider === 'unsupported' || provider === 'github'
          ? { usage: await getUnsupportedUsage(), rawPayload: null }
          : await getMockUsage();
    const usage = result.usage;

    // Capture is intentionally fire-and-forget so telemetry persistence never blocks user-facing usage responses.
    void maybeCapture({
      config: captureConfig,
      provider,
      userId: result.userId,
      usage,
      rawPayload: result.rawPayload
    });

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60'
      },
      body: JSON.stringify(usage)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
