import { describe, expect, it } from 'vitest'
import { detectBillingPhase, normaliseUsage } from '../copilot'

// ---------------------------------------------------------------------------
// Contract assertion tests for BillingPhase (all six states)
// ---------------------------------------------------------------------------

describe('detectBillingPhase', () => {
  // Contract assertion 1: unlimited === true → 'unlimited', regardless of other fields
  describe('unlimited phase', () => {
    it('returns unlimited when unlimited === true and remaining > 0', () => {
      expect(detectBillingPhase({ remaining: 500, unlimited: true })).toBe('unlimited')
    })

    it('returns unlimited when unlimited === true and remaining === 0', () => {
      expect(detectBillingPhase({ remaining: 0, unlimited: true })).toBe('unlimited')
    })

    it('returns unlimited when unlimited === true and overage fields are present', () => {
      expect(
        detectBillingPhase({
          remaining: 0,
          unlimited: true,
          overageCount: 50,
          overagePermitted: true,
          hasQuota: false
        })
      ).toBe('unlimited')
    })
  })

  // Contract assertion 2: remaining > 0 (and unlimited !== true) → 'credits_available'
  describe('credits_available phase', () => {
    it('returns credits_available when remaining > 0 and unlimited is absent', () => {
      expect(detectBillingPhase({ remaining: 100 })).toBe('credits_available')
    })

    it('returns credits_available when remaining > 0 and unlimited === false', () => {
      expect(detectBillingPhase({ remaining: 31, unlimited: false })).toBe('credits_available')
    })

    it('returns credits_available when remaining > 0 even when overage fields are set', () => {
      expect(
        detectBillingPhase({
          remaining: 1,
          overageCount: 0,
          overagePermitted: true,
          unlimited: false,
          hasQuota: true
        })
      ).toBe('credits_available')
    })
  })

  // Contract assertion 3: overage_count > 0 && overage_permitted === true (remaining === 0) → 'budget_active'
  describe('budget_active phase', () => {
    it('returns budget_active when remaining === 0 and overageCount > 0 and overagePermitted === true', () => {
      expect(
        detectBillingPhase({ remaining: 0, overageCount: 120, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('returns budget_active when overageCount is 1 (minimum spend)', () => {
      expect(
        detectBillingPhase({ remaining: 0, overageCount: 1, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('does NOT return budget_active when overagePermitted is false', () => {
      expect(
        detectBillingPhase({ remaining: 0, overageCount: 120, overagePermitted: false })
      ).not.toBe('budget_active')
    })

    it('does NOT return budget_active when overagePermitted is absent', () => {
      expect(
        detectBillingPhase({ remaining: 0, overageCount: 120 })
      ).not.toBe('budget_active')
    })
  })

  // Contract assertion 4: remaining === 0, overage_permitted === true, overage_count === 0 → 'budget_available'
  describe('budget_available phase', () => {
    it('returns budget_available when remaining === 0, overagePermitted === true, overageCount === 0', () => {
      expect(
        detectBillingPhase({ remaining: 0, overagePermitted: true, overageCount: 0 })
      ).toBe('budget_available')
    })

    it('returns budget_available when overageCount is absent (treated as 0)', () => {
      expect(
        detectBillingPhase({ remaining: 0, overagePermitted: true })
      ).toBe('budget_available')
    })

    it('does NOT return budget_available when overagePermitted === false', () => {
      expect(
        detectBillingPhase({ remaining: 0, overagePermitted: false, overageCount: 0 })
      ).not.toBe('budget_available')
    })
  })

  // Contract assertion 5: has_quota === false (and unlimited !== true) → 'hard_stop'
  describe('hard_stop phase', () => {
    it('returns hard_stop when hasQuota === false and unlimited is absent', () => {
      expect(detectBillingPhase({ remaining: 0, hasQuota: false })).toBe('hard_stop')
    })

    it('returns hard_stop when hasQuota === false and unlimited === false', () => {
      expect(
        detectBillingPhase({ remaining: 0, hasQuota: false, unlimited: false })
      ).toBe('hard_stop')
    })

    it('does NOT return hard_stop when hasQuota === false but unlimited === true (unlimited wins)', () => {
      expect(
        detectBillingPhase({ remaining: 0, hasQuota: false, unlimited: true })
      ).toBe('unlimited')
    })
  })

  // Contract assertion 6: remaining === 0 && overage_permitted !== true → 'credits_exhausted'
  describe('credits_exhausted phase', () => {
    it('returns credits_exhausted when remaining === 0 and no overage fields present', () => {
      expect(detectBillingPhase({ remaining: 0 })).toBe('credits_exhausted')
    })

    it('returns credits_exhausted when remaining === 0 and overagePermitted === false', () => {
      expect(
        detectBillingPhase({ remaining: 0, overagePermitted: false })
      ).toBe('credits_exhausted')
    })

    it('returns credits_exhausted as the default fallback (no budget, no unlimited, no hard_stop)', () => {
      expect(
        detectBillingPhase({
          remaining: 0,
          overagePermitted: false,
          unlimited: false,
          hasQuota: true
        })
      ).toBe('credits_exhausted')
    })
  })
})

// ---------------------------------------------------------------------------
// Contract assertion 6 (backward-compat): normaliseUsage without new fields
// ---------------------------------------------------------------------------

describe('normaliseUsage — BillingPhase backward compatibility', () => {
  it('includes billingPhase credits_available when no overage fields are passed and remaining > 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 300,
      quota: 500,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'mock'
    })
    expect(result.billingPhase).toBe('credits_available')
    expect(result.overageCount).toBeUndefined()
    expect(result.overageEntitlement).toBeUndefined()
  })

  it('includes billingPhase credits_exhausted when no overage fields are passed and remaining === 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 500,
      quota: 500,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'mock'
    })
    expect(result.billingPhase).toBe('credits_exhausted')
  })

  it('carries overageCount and overageEntitlement through to Usage when provided', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7000,
      quota: 7000,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 120,
      overageEntitlement: 5000,
      overagePermitted: true
    })
    expect(result.billingPhase).toBe('budget_active')
    expect(result.overageCount).toBe(120)
    expect(result.overageEntitlement).toBe(5000)
  })

  it('does not include overageCount or overageEntitlement when not provided', () => {
    const result = normaliseUsage({
      mode: 'premium_requests',
      used: 0,
      quota: 0,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'unknown',
      source: 'unsupported'
    })
    expect('overageCount' in result).toBe(false)
    expect('overageEntitlement' in result).toBe(false)
  })
})
