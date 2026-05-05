export type Mode = 'premium_requests' | 'ai_credits';
export type WarningLevel = 'normal' | 'warm' | 'hot' | 'over';

export type Usage = {
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

export type JsonObject = Record<string, unknown>;

export function warningLevel(percentUsed: number): WarningLevel {
  if (percentUsed >= 100) return 'over';
  if (percentUsed >= 90) return 'hot';
  if (percentUsed >= 75) return 'warm';
  return 'normal';
}

export function nextMonthReset(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNumber(input: JsonObject, ...keys: string[]): number | undefined {
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

export function readString(input: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  return undefined;
}

export function readNumberAtPath(input: JsonObject, path: string[]): number | undefined {
  let cursor: unknown = input;
  for (const segment of path) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[segment];
  }

  if (typeof cursor === 'number' && Number.isFinite(cursor)) return cursor;
  if (typeof cursor === 'string') {
    const parsed = Number(cursor);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

export function normaliseUsage(input: {
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

export async function getUnsupportedUsage(login?: string, extraNotes: string[] = []): Promise<Usage> {
  const billingLogin = login || process.env.GITHUB_LOGIN || 'unknown';
  return normaliseUsage({
    mode: 'premium_requests',
    used: 0,
    quota: 0,
    resetAt: nextMonthReset(),
    billingEntity: billingLogin,
    source: 'unsupported',
    notes: [
      'Real Copilot quota is not available in hosted mode.',
      "GitHub's API does not expose personal Copilot usage. To see real data, run CopeLimit locally with the copilot-api proxy.",
      ...extraNotes
    ]
  });
}
