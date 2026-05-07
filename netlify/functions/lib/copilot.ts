/**
 * @file Core types and shared utilities for GitHub Copilot usage data.
 *
 * This module is the single source of truth for the `Usage` shape that is
 * returned by every provider and consumed by both the React PWA and the
 * Scriptable iOS widget. All providers normalise their data into this shape
 * via {@link normaliseUsage} before returning it to callers.
 */

/**
 * The billing mode reported by GitHub's Copilot APIs.
 *
 * - `premium_requests` – the current quota model (counted interactions)
 * - `ai_credits`       – the upcoming credit-based model (from 1 June 2026)
 */
export type Mode = 'premium_requests' | 'ai_credits';

/**
 * A colour-coded severity level derived from `percentUsed`.
 *
 * | Value    | `percentUsed` threshold |
 * |----------|-------------------------|
 * | `normal` | < 75 %                  |
 * | `warm`   | ≥ 75 %                  |
 * | `hot`    | ≥ 90 %                  |
 * | `over`   | ≥ 100 %                 |
 */
export type WarningLevel = 'normal' | 'warm' | 'hot' | 'over';

/**
 * The canonical usage response shape returned by every provider and
 * exposed to the PWA and the iOS Scriptable widget.
 */
export type Usage = {
  /** Billing mode reported by the upstream Copilot API. */
  mode: Mode;
  /** Number of requests/credits consumed in the current period. */
  used: number;
  /** Total quota allocated for the current period. */
  quota: number;
  /** `quota - used`, clamped to ≥ 0. */
  remaining: number;
  /** `used / quota * 100`, rounded to the nearest integer, or 0 when quota is 0. */
  percentUsed: number;
  /** ISO 8601 timestamp when the quota resets. */
  resetAt: string;
  /** GitHub login or organisation that owns the quota. */
  billingEntity: string;
  /** Identifier of the data provider (e.g. `mock`, `github-copilot-internal`). */
  source: string;
  /** Severity level derived from `percentUsed`. */
  warningLevel: WarningLevel;
  /** ISO 8601 timestamp of when this record was generated. */
  updatedAt: string;
  /** Human-readable notes from the provider (e.g. warnings, caveats). */
  notes: string[];
};

/** A plain JSON object whose values are unknown at compile time. */
export type JsonObject = Record<string, unknown>;

/**
 * Derives a {@link WarningLevel} from a `percentUsed` value.
 *
 * @param percentUsed - The percentage of quota used (0–100+).
 * @returns The appropriate warning level.
 */
export function warningLevel(percentUsed: number): WarningLevel {
  if (percentUsed >= 100) return 'over';
  if (percentUsed >= 90) return 'hot';
  if (percentUsed >= 75) return 'warm';
  return 'normal';
}

/**
 * Returns the ISO 8601 timestamp for the first moment of the next calendar
 * month in UTC. Used as the default `resetAt` value when a provider does not
 * supply one.
 *
 * @returns ISO 8601 string for the start of next month, e.g. `"2026-06-01T00:00:00.000Z"`.
 */
export function nextMonthReset(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

/**
 * Type-guard that narrows `unknown` to {@link JsonObject}.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a non-null, non-array plain object.
 */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the first finite numeric value found at any of the specified keys.
 * Accepts both `number` and numeric `string` values.
 *
 * @param input - The source object.
 * @param keys  - Candidate property names, tried in order.
 * @returns The first valid finite number found, or `undefined` if none.
 */
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

/**
 * Reads the first non-empty string found at any of the specified keys.
 *
 * @param input - The source object.
 * @param keys  - Candidate property names, tried in order.
 * @returns The first trimmed non-empty string found, or `undefined` if none.
 */
export function readString(input: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  return undefined;
}

/**
 * Reads a finite numeric value by traversing a dot-path of property names.
 * Accepts both `number` and numeric `string` leaf values.
 *
 * @param input - The root object.
 * @param path  - An ordered array of property names to traverse.
 * @returns The resolved finite number, or `undefined` if the path does not exist.
 *
 * @example
 * readNumberAtPath(body, ['limited_user_quotas', 'premium_requests', 'entitlement'])
 */
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

/**
 * Constructs a complete {@link Usage} object from raw provider fields by
 * computing the derived properties (`remaining`, `percentUsed`, `warningLevel`,
 * `updatedAt`).
 *
 * @param input - Core usage fields from the provider (without derived values).
 * @returns A fully populated `Usage` record with a current `updatedAt` timestamp.
 */
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

/**
 * Returns a zeroed-out {@link Usage} record with `source: "unsupported"` and
 * a set of informational notes explaining why real data is unavailable.
 *
 * Used as a graceful fallback when a provider cannot return live quota data
 * (e.g. missing OAuth scope, plan not supported, or API shape changed).
 *
 * @param login      - The authenticated GitHub login; falls back to `GITHUB_LOGIN` env var.
 * @param extraNotes - Additional provider-specific notes appended to the defaults.
 * @returns A resolved `Usage` with all quota values set to 0.
 */
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
