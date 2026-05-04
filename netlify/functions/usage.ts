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

async function getGitHubUsage(): Promise<Usage> {
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_LOGIN || 'goldjg';

  if (!token) {
    throw new Error('GITHUB_TOKEN is required when COPELIMIT_PROVIDER=github');
  }

  /*
    GitHub Copilot usage APIs are plan, role, and billing-model sensitive.

    This placeholder keeps the MVP honest:
    - the UI and widget contract are stable
    - the backend can be swapped once the correct endpoint is confirmed
    - tokens are never exposed to the browser or iOS widget

    Candidate implementation paths to validate:
    - GitHub billing/usage endpoints for Copilot seats/usage
    - enterprise/org Copilot metrics endpoints, if the user has suitable permissions
    - authenticated scrape/export only as a last resort, preferably not at all
  */

  return normaliseUsage({
    mode: 'premium_requests',
    used: 0,
    quota: 0,
    resetAt: nextMonthReset(),
    billingEntity: login,
    source: 'github-placeholder',
    notes: [
      'GitHub provider is a placeholder until a reliable user-level Copilot quota endpoint is confirmed for this account type.',
      'Do not expose GitHub tokens to the browser or Scriptable widget.'
    ]
  });
}

export const handler: Handler = async () => {
  try {
    const provider = process.env.COPELIMIT_PROVIDER || 'mock';
    const usage = provider === 'github' ? await getGitHubUsage() : await getMockUsage();

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
