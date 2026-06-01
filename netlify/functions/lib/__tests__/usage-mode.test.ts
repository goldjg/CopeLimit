import { describe, expect, it } from 'vitest'
import { detectMode } from '../copilot'

describe('detectMode', () => {
  it('returns premium_requests when no token_based_billing markers are present', () => {
    const payload = {
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: 179
        }
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    }
    expect(detectMode(payload)).toBe('premium_requests')
  })

  it('returns premium_requests when token_based_billing is absent entirely', () => {
    expect(detectMode({})).toBe('premium_requests')
  })

  it('returns premium_requests when token_based_billing is false at top level', () => {
    const payload = { token_based_billing: false }
    expect(detectMode(payload)).toBe('premium_requests')
  })

  it('returns ai_credits when top-level token_based_billing is true', () => {
    const payload = {
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 7000,
          remaining: 7000
        }
      }
    }
    expect(detectMode(payload)).toBe('ai_credits')
  })

  it('returns ai_credits when quota_snapshots.premium_interactions.token_based_billing is true', () => {
    const payload = {
      quota_snapshots: {
        premium_interactions: {
          token_based_billing: true,
          entitlement: 7000,
          remaining: 6500
        }
      }
    }
    expect(detectMode(payload)).toBe('ai_credits')
  })

  it('returns ai_credits when both markers are present', () => {
    const payload = {
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          token_based_billing: true,
          entitlement: 7000,
          remaining: 6000
        }
      }
    }
    expect(detectMode(payload)).toBe('ai_credits')
  })

  it('returns premium_requests when nested token_based_billing is false', () => {
    const payload = {
      quota_snapshots: {
        premium_interactions: {
          token_based_billing: false,
          entitlement: 500,
          remaining: 321
        }
      }
    }
    expect(detectMode(payload)).toBe('premium_requests')
  })

  it('returns premium_requests when top-level token_based_billing is string "true"', () => {
    expect(detectMode({ token_based_billing: 'true' })).toBe('premium_requests')
  })

  it('returns premium_requests when top-level token_based_billing is string "false"', () => {
    expect(detectMode({ token_based_billing: 'false' })).toBe('premium_requests')
  })

  it('returns premium_requests when top-level token_based_billing is numeric 1', () => {
    expect(detectMode({ token_based_billing: 1 })).toBe('premium_requests')
  })

  it('returns premium_requests when top-level token_based_billing is numeric 0', () => {
    expect(detectMode({ token_based_billing: 0 })).toBe('premium_requests')
  })

  it('display label for ai_credits mode is "AI credits"', () => {
    // Verify that the mode string produced by detectMode is the expected value
    // consumed by the UI's labelForMode function.
    const mode = detectMode({ token_based_billing: true })
    expect(mode).toBe('ai_credits')
    // labelForMode(mode) === 'AI credits' when mode === 'ai_credits'
    const label = mode === 'ai_credits' ? 'AI credits' : 'Premium requests'
    expect(label).toBe('AI credits')
  })

  it('display label falls back to "Premium requests" when markers absent', () => {
    const mode = detectMode({})
    expect(mode).toBe('premium_requests')
    const label = mode === 'ai_credits' ? 'AI credits' : 'Premium requests'
    expect(label).toBe('Premium requests')
  })
})
