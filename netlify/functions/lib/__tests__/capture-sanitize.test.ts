import { describe, expect, it } from 'vitest'
import { sanitizeProviderPayload } from '../capture-sanitize'

describe('sanitizeProviderPayload', () => {
  it('keeps known quota fields', () => {
    const payload = {
      limited_user_quotas: {
        premium_requests: {
          entitlement: 500,
          remaining: 250
        }
      }
    }

    const result = sanitizeProviderPayload('github-copilot-internal', payload)

    expect(result.limited_user_quotas).toBeTruthy()
    expect(result._unknown_fields).toEqual([])
  })

  it('captures unknown keys and strips sensitive keys', () => {
    const payload = {
      quota_reset_date_utc: '2026-06-01T00:00:00Z',
      token_usage: { total: 1234 },
      access_token: 'super-secret-token'
    }

    const result = sanitizeProviderPayload('github-copilot-internal', payload)

    expect(result.quota_reset_date_utc).toBe('2026-06-01T00:00:00Z')
    expect(result).not.toHaveProperty('token_usage')
    expect(result).not.toHaveProperty('access_token')
    expect(result._unknown_fields).toContain('token_usage')
    expect(result._unknown_fields).toContain('access_token')
  })

  it('captures top-level field names', () => {
    const payload = {
      quota_reset_date_utc: '2026-06-01T00:00:00Z',
      dimensions: { a: 1 },
      foo: 'bar'
    }

    const result = sanitizeProviderPayload('github-copilot-internal', payload)

    expect(result._rawFieldNames.sort()).toEqual(['dimensions', 'foo', 'quota_reset_date_utc'])
  })

  it('redacts suspiciously long token-like strings', () => {
    const payload = {
      status: 'ok',
      plan: 'pro',
      mode: 'premium_requests',
      sku: 'x'.repeat(600)
    }

    const result = sanitizeProviderPayload('github-copilot-internal', payload)

    expect(result.sku).toBe('[REDACTED]')
  })

  it('handles non-object payloads', () => {
    const result = sanitizeProviderPayload('github-copilot-internal', null)
    expect(result._rawFieldNames).toEqual([])
    expect(result._unknown_fields).toEqual(['__non_object_payload__'])
  })
})
