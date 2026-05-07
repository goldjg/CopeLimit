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

const LONG_SECRET_PATTERN = /^[a-zA-Z0-9+/=_-]+$/

function looksSensitiveKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

function maybeRedactString(value: string): string {
  if (value.length > 512 && LONG_SECRET_PATTERN.test(value)) return '[REDACTED]'
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
