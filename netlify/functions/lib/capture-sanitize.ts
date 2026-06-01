/**
 * @file Sanitises raw provider API responses before capture/storage.
 *
 * ## Security model
 *
 * Provider responses may contain sensitive fields such as OAuth tokens,
 * credentials, or user identifiers. This module applies two layers of
 * protection before any raw data is persisted:
 *
 * 1. **Sensitive-key blocking** – Any field whose name matches a pattern in
 *    {@link FORBIDDEN_KEY_PATTERNS} (e.g. `/token/i`, `/auth/i`, `/key/i`) is
 *    stripped and its path recorded in `_unknown_fields`.
 *
 * 2. **Allow-listing** – Only field names explicitly listed in
 *    {@link PROVIDER_ALLOWLISTS} for the given provider pass through. Unknown
 *    fields are stripped and their paths recorded in `_unknown_fields`.
 *
 * 3. **Long-string redaction** – String values longer than
 *    {@link SENSITIVE_STRING_REDACTION_LENGTH} characters that match a
 *    base64/url-safe-base64 pattern are replaced with `"[REDACTED]"`.
 *
 * The `_rawFieldNames` property in the output always records the original
 * top-level field names so that schema changes can be detected without
 * storing potentially sensitive values.
 */
import type { JsonObject } from './copilot'
import { isObject } from './copilot'
import type { SanitizedPayload } from './capture-types'

const FORBIDDEN_KEY_PATTERNS = [
  /token/i,
  /access[_-]?token/i,
  /auth/i,
  /authorization/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /session/i,
  /credential/i,
  /key/i
]

const BASE_ALLOWED_FIELDS = [
  'limited_user_quotas',
  'premium_requests',
  'quota_snapshots',
  'quota_reset_at',
  'quota_reset_date_utc',
  'resetAt',
  'reset_at',
  'periodEndsAt',
  'copilot_plan',
  'billing_type',
  'token_type',
  'model_accounting',
  'dimensions',
  'enterprise',
  'organization',
  'pooled_usage',
  'rolling_window',
  'sku',
  'plan',
  'seat_type',
  'status',
  'overage_allowed',
  'mode',
  'metric',
  'kind',
  'token_based_billing',
  'entitlement',
  'remaining',
  'used',
  'quota',
  'limit',
  'total',
  'usage',
  'usedCount',
  'consumed',
  'premium_interactions'
]

const PROVIDER_ALLOWLISTS: Record<string, Set<string>> = {
  'github-copilot-internal': new Set(BASE_ALLOWED_FIELDS),
  'copilot-local': new Set(BASE_ALLOWED_FIELDS)
}

const BASE64_LIKE_PATTERN = /^[a-zA-Z0-9+/=_-]+$/
const SENSITIVE_STRING_REDACTION_LENGTH = 128

function looksSensitiveKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

function maybeRedactString(value: string): string {
  // Strings beyond this size that look token/base64-like are treated as likely secret-bearing telemetry.
  if (value.length > SENSITIVE_STRING_REDACTION_LENGTH && BASE64_LIKE_PATTERN.test(value)) return '[REDACTED]'
  return value
}

function sanitizeValue(
  value: unknown,
  allowlist: Set<string>,
  unknownFields: Set<string>,
  path: string
): unknown | undefined {
  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((entry, index) => sanitizeValue(entry, allowlist, unknownFields, `${path}[${index}]`))
      .filter((entry) => entry !== undefined)
    return sanitizedArray
  }

  if (isObject(value)) {
    return sanitizeObjectInternal(value, allowlist, unknownFields, path)
  }

  if (typeof value === 'string') return maybeRedactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value

  unknownFields.add(path)
  return undefined
}

function sanitizeObjectInternal(
  input: JsonObject,
  allowlist: Set<string>,
  unknownFields: Set<string>,
  pathPrefix: string
): JsonObject {
  const output: JsonObject = {}

  for (const [key, value] of Object.entries(input)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key

    if (looksSensitiveKey(key)) {
      unknownFields.add(path)
      continue
    }

    if (!allowlist.has(key)) {
      unknownFields.add(path)
      continue
    }

    const sanitized = sanitizeValue(value, allowlist, unknownFields, path)
    if (sanitized !== undefined) {
      output[key] = sanitized
    }
  }

  return output
}

/**
 * Sanitises a raw provider API response for safe capture/storage.
 *
 * - Strips any fields whose names match {@link FORBIDDEN_KEY_PATTERNS}.
 * - Strips any fields not in the allow-list for the given provider.
 * - Redacts suspiciously long token-like string values.
 * - Records all stripped field paths in `_unknown_fields`.
 * - Records all original top-level field names in `_rawFieldNames`.
 *
 * @param provider - The provider identifier (e.g. `github-copilot-internal`).
 * @param raw      - The raw response body from the provider API.
 * @returns A {@link SanitizedPayload} safe for persistence.
 */
export function sanitizeProviderPayload(provider: string, raw: unknown): SanitizedPayload {
  if (!isObject(raw)) {
    return {
      _rawFieldNames: [],
      _unknown_fields: ['__non_object_payload__']
    }
  }

  const allowlist = PROVIDER_ALLOWLISTS[provider] ?? new Set<string>()
  const unknownFields = new Set<string>()
  const sanitized = sanitizeObjectInternal(raw, allowlist, unknownFields, '')

  return {
    ...sanitized,
    _rawFieldNames: Object.keys(raw),
    _unknown_fields: Array.from(unknownFields).sort()
  }
}
