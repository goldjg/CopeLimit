import { clampNonNegative, creditsToUsd } from './cost-metrics';

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
 * Detection priority (first match wins, uses rawRemaining — the pre-clamp API value):
 *  1. `unlimited`         — `unlimited === true`
 *  2. `credits_available` — `rawRemaining > 0`
 *  3. `budget_active`     — `(overage_count > 0 || rawRemaining < 0) && overage_permitted === true`
 *  4. `budget_available`  — `rawRemaining === 0 && overage_permitted === true && overage_count === 0`
 *  5. `hard_stop`         — `has_quota === false` (unlimited already ruled out at priority 1)
 *  6. `credits_exhausted` — `rawRemaining <= 0 && overage_permitted !== true` (default)
 */
export type BillingPhase =
  | 'credits_available'  // Included credits remaining; budget not yet needed
  | 'credits_exhausted'  // Included credits = 0; no budget configured or enabled
  | 'budget_available'   // Included credits = 0; budget enabled; no overage consumed yet
  | 'budget_active'      // Budget spending in progress (overage_count > 0 OR rawRemaining < 0)
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
  /**
   * Derived overage credits estimated from a negative `rawRemaining` value during the
   * settlement-lag window (before `overage_count` updates). Equal to `Math.max(0, -rawRemaining)`.
   * Present only when `rawRemaining < 0` at normalisation time.
   */
  derivedOverageCredits?: number;
  /** Estimated USD value of included credits consumed in the current period. */
  includedQuotaCostUsd: number;
  /** Estimated USD value of all credits consumed (included + overage). */
  totalUsedCostUsd: number;
  /** Estimated USD value of overage credits consumed beyond included quota. */
  overageCostUsd: number;
  /** Estimated USD value of configured overage budget entitlement. */
  overageBudgetCostUsd: number;
  /** Estimated USD budget remaining based on settled overage counters. */
  budgetRemainingCostUsd: number;
  /** Estimated USD budget remaining using derived overage during settlement lag. */
  estimatedRemainingBudgetCostUsd: number;
  /** Optional projected estimated total cost at reset. */
  projectedCostAtResetUsd?: number;
  /**
   * Whether overage/budget spending is permitted for this billing entity.
   * Present when the API payload provides an `overage_permitted` flag.
   * Represents the "budget/overage enabled state" in the canonical model.
   */
  overagePermitted?: boolean;
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
 * Derives the {@link BillingPhase} from raw (pre-clamp) remaining and overage fields.
 *
 * Detection follows a fixed priority (first match wins, uses rawRemaining):
 * 1. `unlimited`         — `unlimited === true`
 * 2. `credits_available` — `rawRemaining > 0`
 * 3. `budget_active`     — `(overageCount > 0 || rawRemaining < 0) && overagePermitted === true`
 * 4. `budget_available`  — `rawRemaining === 0 && overagePermitted === true && overageCount === 0`
 * 5. `hard_stop`         — `hasQuota === false` (unlimited already ruled out at step 1)
 * 6. `credits_exhausted` — default (`rawRemaining <= 0 && overagePermitted !== true`)
 *
 * Uses rawRemaining (pre-clamp API value) so that the settlement-lag window — where
 * remaining goes negative before overage_count updates — is correctly detected as
 * budget_active rather than budget_available.
 *
 * When overage fields are absent (e.g. for the `mock` or `copilot-local` providers),
 * the result is `credits_available` when rawRemaining > 0, or `credits_exhausted` otherwise.
 *
 * @param input - Raw remaining value plus optional overage flags from the API.
 * @returns The detected {@link BillingPhase}.
 */
export function detectBillingPhase(input: {
  rawRemaining: number;
  overageCount?: number;
  overagePermitted?: boolean;
  unlimited?: boolean;
  hasQuota?: boolean;
}): BillingPhase {
  if (input.unlimited === true) return 'unlimited';
  if (input.rawRemaining > 0) return 'credits_available';
  // rawRemaining <= 0 is guaranteed from here on (both early-return guards above have passed).
  // priority 3: budget_active fires when overageCount > 0 OR rawRemaining < 0 (settlement lag)
  if (((input.overageCount ?? 0) > 0 || input.rawRemaining < 0) && input.overagePermitted === true) return 'budget_active';
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
 *   The optional `rawRemaining` field carries the pre-clamp API value (which may
 *   be negative during the settlement-lag window). When present it is passed to
 *   {@link detectBillingPhase} so that a negative balance is correctly detected
 *   as `budget_active`. When absent, the value is inferred from `quota - used`.
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
  /** Pre-clamp API remaining value; may be negative (settlement lag). */
  rawRemaining?: number;
  overageCount?: number;
  overageEntitlement?: number;
  overagePermitted?: boolean;
  unlimited?: boolean;
  hasQuota?: boolean;
}): Usage {
  // Use rawRemaining when explicitly provided (may be negative); fall back to
  // computing from quota - used for backward-compatible callers that do not supply it.
  const rawRemaining = input.rawRemaining ?? (input.quota - input.used);
  const remaining = Math.max(0, rawRemaining);
  const percentUsed = input.quota > 0 ? Math.round((input.used / input.quota) * 100) : 0;
  const billingPhase = detectBillingPhase({
    rawRemaining,
    overageCount: input.overageCount,
    overagePermitted: input.overagePermitted,
    unlimited: input.unlimited,
    hasQuota: input.hasQuota
  });
  // During the settlement-lag window rawRemaining < 0 means credits were consumed
  // beyond the quota before overage_count updated. Expose the estimated overage so
  // the UI can show real-time consumption.
  const derivedOverageCredits = rawRemaining < 0 ? Math.max(0, -rawRemaining) : undefined;
  const includedCreditsUsed = Math.min(input.used, input.quota);
  const overageUsedCredits = clampNonNegative(input.overageCount ?? derivedOverageCredits ?? 0);
  const overageBudgetCredits = clampNonNegative(input.overageEntitlement);
  const budgetRemainingCredits =
    input.overageEntitlement === undefined
      ? 0
      : clampNonNegative(overageBudgetCredits - overageUsedCredits);
  const estimatedOverageUsedCredits = clampNonNegative(derivedOverageCredits ?? overageUsedCredits);
  const estimatedRemainingBudgetCredits =
    input.overageEntitlement === undefined
      ? 0
      : clampNonNegative(overageBudgetCredits - estimatedOverageUsedCredits);
  const includedQuotaCostUsd = creditsToUsd(includedCreditsUsed);
  const totalUsedCostUsd = creditsToUsd(input.used);
  const overageCostUsd = creditsToUsd(overageUsedCredits);
  const overageBudgetCostUsd = creditsToUsd(overageBudgetCredits);
  const budgetRemainingCostUsd = creditsToUsd(budgetRemainingCredits);
  const estimatedRemainingBudgetCostUsd = creditsToUsd(estimatedRemainingBudgetCredits);

  // Fields are listed explicitly (rather than spreading ...input) so that
  // unlimited and hasQuota — which are computation inputs only — are not
  // accidentally included in the response. overagePermitted is now carried
  // through to the Usage output as the "budget/overage enabled state" field.
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
    includedQuotaCostUsd,
    totalUsedCostUsd,
    overageCostUsd,
    overageBudgetCostUsd,
    budgetRemainingCostUsd,
    estimatedRemainingBudgetCostUsd,
    ...(input.overageCount !== undefined ? { overageCount: input.overageCount } : {}),
    ...(input.overageEntitlement !== undefined ? { overageEntitlement: input.overageEntitlement } : {}),
    ...(derivedOverageCredits !== undefined ? { derivedOverageCredits } : {}),
    ...(input.overagePermitted !== undefined ? { overagePermitted: input.overagePermitted } : {})
  };
}

/**
 * Extracts overage and quota-state flags from a raw `copilot_internal/user`
 * API payload. All fields are read from `quota_snapshots.premium_interactions.*`
 * with a top-level fallback for `unlimited` and `has_quota`.
 *
 * Used by both the `usage` and `widget-usage` functions to avoid duplicating
 * the extraction logic across providers.
 *
 * @param body - The raw JSON response object from `copilot_internal/user`.
 * @returns An object containing the optional overage fields for {@link normaliseUsage}.
 */
export function readOverageFields(body: JsonObject): {
  overageCount?: number;
  overageEntitlement?: number;
  overagePermitted?: boolean;
  unlimited?: boolean;
  hasQuota?: boolean;
} {
  const snapshots = body['quota_snapshots'];
  const pi = isObject(snapshots) && isObject(snapshots['premium_interactions'])
    ? snapshots['premium_interactions']
    : undefined;

  return {
    overageCount: pi ? readNumber(pi, 'overage_count') : undefined,
    overageEntitlement: pi ? readNumber(pi, 'overage_entitlement') : undefined,
    overagePermitted: pi && typeof pi['overage_permitted'] === 'boolean' ? pi['overage_permitted'] : undefined,
    unlimited:
      pi && typeof pi['unlimited'] === 'boolean'
        ? pi['unlimited']
        : typeof body['unlimited'] === 'boolean' ? body['unlimited'] : undefined,
    hasQuota:
      pi && typeof pi['has_quota'] === 'boolean'
        ? pi['has_quota']
        : typeof body['has_quota'] === 'boolean' ? body['has_quota'] : undefined
  };
}

/**
 * The canonical result of parsing a raw `copilot_internal/user` API response.
 *
 * `usage` is populated when quota fields are present in `body`.
 * `usage` is `null` when neither `entitlement` nor `remaining` could be resolved
 * from any known path — callers should fall back to {@link getUnsupportedUsage}.
 */
export type NormalizedCopilotPayload = {
  usage: Usage | null;
};

/**
 * Canonical normalizer for raw `copilot_internal/user` API payloads.
 *
 * This is the single function that both `usage.ts` and `widget-usage.ts`
 * use to convert a raw GitHub Copilot API response into the canonical
 * {@link Usage} model. It eliminates duplicated extraction logic across
 * endpoints and is the authoritative implementation of the billing-payload-to-model
 * mapping.
 *
 * Detection priority for billing mode, overage flags, and billing phase is
 * delegated to {@link detectMode}, {@link readOverageFields}, and
 * {@link detectBillingPhase} respectively.
 *
 * When neither `entitlement` nor `remaining` can be resolved from the payload,
 * `usage` is `null`; callers should return an unsupported/fallback response.
 *
 * ### Field resolution order for quota / entitlement
 * 1. `limited_user_quotas.premium_requests.entitlement`
 * 2. `premium_requests.entitlement`
 * 3. `quota_snapshots.premium_interactions.entitlement`
 * 4. Top-level `entitlement`, `quota`, `limit`, `total`
 *
 * ### Field resolution order for remaining
 * 1. `limited_user_quotas.premium_requests.remaining`
 * 2. `premium_requests.remaining`
 * 3. `quota_snapshots.premium_interactions.remaining`
 * 4. Top-level `remaining`
 *
 * @param body   - The raw JSON object from `copilot_internal/user`.
 * @param login  - The authenticated GitHub login to use as `billingEntity`.
 * @param source - Provider identifier string (e.g. `'github-copilot-internal'`).
 * @param notes  - Optional provider-specific notes appended to the `Usage.notes` array.
 * @returns `{ usage }` where `usage` is the normalised record or `null` when quota fields are absent.
 *   The wrapper intentionally exposes only `{ usage }` — no resolution metadata such as which quota
 *   path matched. No caller currently requires that detail; if diagnostic tracing is needed in future,
 *   extend `NormalizedCopilotPayload` with an optional `resolution` field at that point.
 */
export function normalizeCopilotInternalPayload(
  body: JsonObject,
  login: string,
  source: string,
  notes: string[] = []
): NormalizedCopilotPayload {
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

  // Signal to the caller that the payload is unrecognised and a fallback is required.
  if (quota === undefined && remaining === undefined) {
    return { usage: null };
  }

  const safeQuota = Math.max(0, quota ?? 0);
  // Preserve the pre-clamp value; a negative rawRemaining indicates settlement lag
  // (credits consumed beyond quota before overage_count has been settled by billing).
  const rawRemaining = remaining ?? 0;
  // Effective used: when rawRemaining < 0 this exceeds quota (e.g. 7000 - (-473) = 7473).
  // Math.max(0, ...) guards the rawRemaining > quota edge case (invalid API data) without
  // suppressing the negative-remaining signal (safeQuota - rawRemaining is positive when
  // rawRemaining < 0).
  const used = Math.max(0, safeQuota - rawRemaining);
  const resetAt =
    readString(body, 'quota_reset_at', 'quota_reset_date_utc', 'resetAt', 'reset_at', 'periodEndsAt') ??
    nextMonthReset();
  const mode = detectMode(body);
  const overageFields = readOverageFields(body);

  return {
    usage: normaliseUsage({
      mode,
      used,
      quota: safeQuota,
      rawRemaining,
      resetAt,
      billingEntity: login,
      source,
      notes,
      ...overageFields
    })
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
