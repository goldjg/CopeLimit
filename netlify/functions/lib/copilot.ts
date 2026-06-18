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
 * - `premium_requests` – the legacy quota model (counted interactions); used as fallback
 * - `ai_credits`       – the credit-based model (active from 1 June 2026); selected when
 *                        `token_based_billing` markers are detected in the API payload
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
 * The billing phase captures where in the credit/budget lifecycle the
 * current usage falls.
 *
 * Detection priority (first match wins):
 *  1. `unlimited`         — `unlimited === true`
 *  2. `credits_available` — `remaining > 0`
 *  3. `budget_active`     — `overage_count > 0 && overage_permitted === true`
 *  4. `budget_available`  — `remaining === 0 && overage_permitted === true && overage_count === 0`
 *  5. `hard_stop`         — `has_quota === false` (unlimited already ruled out at priority 1)
 *  6. `credits_exhausted` — `remaining === 0 && overage_permitted !== true` (default)
 */
export type BillingPhase =
  | 'credits_available'  // Included credits remaining; budget not yet needed
  | 'credits_exhausted'  // Included credits = 0; no budget configured or enabled
  | 'budget_available'   // Included credits = 0; budget enabled; no overage consumed yet
  | 'budget_active'      // Budget spending in progress (overage_count > 0)
  | 'unlimited'          // Unlimited usage (unlimited === true)
  | 'hard_stop';         // No quota, no budget, no unlimited (has_quota === false)

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
  /** Where in the credit/budget lifecycle this usage record falls. */
  billingPhase: BillingPhase;
  /** Budget-backed credits consumed beyond the included quota (present in `budget_active` phase). */
  overageCount?: number;
  /** Budget allocation expressed in credit-equivalent units (present when a budget is configured). */
  overageEntitlement?: number;
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
 * Detects the billing {@link Mode} from a raw Copilot internal API payload by
 * checking for `token_based_billing` markers.
 *
 * The API may expose the marker at:
 * - top-level `token_based_billing: true`
 * - nested `quota_snapshots.premium_interactions.token_based_billing: true`
 *
 * When either marker is `true`, the mode is `ai_credits`. Otherwise the mode
 * falls back to `premium_requests` for compatibility with legacy payloads.
 *
 * @param body - The raw JSON response object from `copilot_internal/user`.
 * @returns `'ai_credits'` when token-based billing is detected; `'premium_requests'` otherwise.
 */
export function detectMode(body: JsonObject): Mode {
  if (body['token_based_billing'] === true) return 'ai_credits';
  const snapshots = body['quota_snapshots'];
  if (isObject(snapshots)) {
    const pi = snapshots['premium_interactions'];
    if (isObject(pi) && pi['token_based_billing'] === true) return 'ai_credits';
  }
  return 'premium_requests';
}

/**
 * Derives the {@link BillingPhase} from normalised usage and overage fields.
 *
 * Detection follows a fixed priority (first match wins):
 * 1. `unlimited`         — `unlimited === true`
 * 2. `credits_available` — `remaining > 0`
 * 3. `budget_active`     — `overageCount > 0 && overagePermitted === true`
 * 4. `budget_available`  — `remaining === 0 && overagePermitted === true && overageCount === 0`
 * 5. `hard_stop`         — `hasQuota === false` (unlimited already ruled out at step 1)
 * 6. `credits_exhausted` — default (`remaining === 0 && overagePermitted !== true`)
 *
 * When overage fields are absent (e.g. for the `mock` or `copilot-local` providers),
 * the result is `credits_available` when credits remain, or `credits_exhausted` otherwise.
 *
 * @param input - Normalised usage values plus optional overage flags from the API.
 * @returns The detected {@link BillingPhase}.
 */
export function detectBillingPhase(input: {
  remaining: number;
  overageCount?: number;
  overagePermitted?: boolean;
  unlimited?: boolean;
  hasQuota?: boolean;
}): BillingPhase {
  if (input.unlimited === true) return 'unlimited';
  if (input.remaining > 0) return 'credits_available';
  if ((input.overageCount ?? 0) > 0 && input.overagePermitted === true) return 'budget_active';
  if (input.overagePermitted === true) return 'budget_available';
  if (input.hasQuota === false) return 'hard_stop';
  return 'credits_exhausted';
}

/**
 * Constructs a complete {@link Usage} object from raw provider fields by
 * computing the derived properties (`remaining`, `percentUsed`, `warningLevel`,
 * `billingPhase`, `updatedAt`).
 *
 * @param input - Core usage fields from the provider (without derived values).
 *   The optional `overageCount`, `overageEntitlement`, `overagePermitted`,
 *   `unlimited`, and `hasQuota` fields are used to detect the {@link BillingPhase};
 *   `overageCount` and `overageEntitlement` are also carried through to the
 *   returned `Usage` when present.
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
  overageCount?: number;
  overageEntitlement?: number;
  overagePermitted?: boolean;
  unlimited?: boolean;
  hasQuota?: boolean;
}): Usage {
  const remaining = Math.max(0, input.quota - input.used);
  const percentUsed = input.quota > 0 ? Math.round((input.used / input.quota) * 100) : 0;
  const billingPhase = detectBillingPhase({
    remaining,
    overageCount: input.overageCount,
    overagePermitted: input.overagePermitted,
    unlimited: input.unlimited,
    hasQuota: input.hasQuota
  });

  return {
    mode: input.mode,
    used: input.used,
    quota: input.quota,
    remaining,
    percentUsed,
    resetAt: input.resetAt,
    billingEntity: input.billingEntity,
    source: input.source,
    warningLevel: warningLevel(percentUsed),
    updatedAt: new Date().toISOString(),
    notes: input.notes ?? [],
    billingPhase,
    ...(input.overageCount !== undefined ? { overageCount: input.overageCount } : {}),
    ...(input.overageEntitlement !== undefined ? { overageEntitlement: input.overageEntitlement } : {})
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
