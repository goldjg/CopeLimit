import type { Handler } from '@netlify/functions';

type Mode = 'premium_requests' | 'ai_credits';
type WarningLevel = 'normal' | 'warm' | 'hot' | 'over';

type Usage = {
  mode: Mode;
  used: number;
  quota: number;
  remaining: number;
  percentUsed: number;
  resetAt: string;
  billingEntity: string;
  source: string;
  warningLevel: WarningLevel;
  updatedAt: string;
  notes: string[];
};

type JsonObject = Record<string, unknown>;

function warningLevel(percentUsed: number): WarningLevel {
  if (percentUsed >= 100) return 'over';
  if (percentUsed >= 90) return 'hot';
  if (percentUsed >= 75) return 'warm';
  return 'normal';
}

function nextMonthReset(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(input: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function readString(input: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  return undefined;
}

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

function normaliseUsage(input: {
  mode: Mode;
  used: number;
  quota: number;
  resetAt: string;
  billingEntity: string;
  source: string;
  notes?: string[];
}): Usage {
  const remaining = Math.max(0, input.quota - input.used);
  const percentUsed = input.quota > 0 ? Math.round((input.used / input.quota) * 100) : 0;

  return {
    ...input,
    remaining,
    percentUsed,
    warningLevel: warningLevel(percentUsed),
    updatedAt: new Date().toISOString(),
    notes: input.notes ?? []
  };
}

async function getMockUsage(): Promise<Usage> {
  const used = Number(process.env.MOCK_USED ?? 321);
  const quota = Number(process.env.MOCK_QUOTA ?? 500);

  return normaliseUsage({
    mode: 'premium_requests',
    used,
    quota,
    resetAt: process.env.MOCK_RESET_AT || nextMonthReset(),
    billingEntity: process.env.GITHUB_LOGIN || 'goldjg',
    source: 'mock',
    notes: [
      'Mock provider active. Replace with GitHub billing/usage provider when API access is confirmed.'
    ]
  });
}

async function getCopilotLocalUsage(): Promise<Usage> {
  const fallbackLogin = process.env.GITHUB_LOGIN || 'unknown';
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
  const billingEntity = readString(payload, 'login', 'username', 'billingEntity', 'billing_entity', 'copilot_plan') ?? fallbackLogin;
  const mode = readMode(payload);

  return normaliseUsage({
    mode,
    used,
    quota,
    resetAt,
    billingEntity,
    source: 'copilot-local',
    notes
  });
}

async function getUnsupportedUsage(): Promise<Usage> {
  const login = process.env.GITHUB_LOGIN || 'unknown';
  return normaliseUsage({
    mode: 'premium_requests',
    used: 0,
    quota: 0,
    resetAt: nextMonthReset(),
    billingEntity: login,
    source: 'unsupported',
    notes: [
      'Real Copilot quota is not available in hosted mode.',
      "GitHub's API does not expose personal Copilot usage. To see real data, run CopeLimit locally with the copilot-api proxy."
    ]
  });
}

export const handler: Handler = async () => {
  try {
    const provider = process.env.COPELIMIT_PROVIDER || 'mock';
    const usage =
      provider === 'copilot-local'
        ? await getCopilotLocalUsage()
        : provider === 'unsupported' || provider === 'github'
          ? await getUnsupportedUsage()
          : await getMockUsage();

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
