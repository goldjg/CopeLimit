import { describe, expect, it } from 'vitest'
import { detectBillingPhase, normaliseUsage } from '../copilot'

// ---------------------------------------------------------------------------
// Contract assertion tests for BillingPhase (all six states)
// ---------------------------------------------------------------------------

describe('detectBillingPhase', () => {
  // Contract assertion 1: unlimited === true → 'unlimited', regardless of other fields
  describe('unlimited phase', () => {
    it('returns unlimited when unlimited === true and rawRemaining > 0', () => {
      expect(detectBillingPhase({ rawRemaining: 500, unlimited: true })).toBe('unlimited')
    })

    it('returns unlimited when unlimited === true and rawRemaining === 0', () => {
      expect(detectBillingPhase({ rawRemaining: 0, unlimited: true })).toBe('unlimited')
    })

    it('returns unlimited when unlimited === true and overage fields are present', () => {
      expect(
        detectBillingPhase({
          rawRemaining: 0,
          unlimited: true,
          overageCount: 50,
          overagePermitted: true,
          hasQuota: false
        })
      ).toBe('unlimited')
    })
  })

  // Contract assertion 2: rawRemaining > 0 (and unlimited !== true) → 'credits_available'
  describe('credits_available phase', () => {
    it('returns credits_available when rawRemaining > 0 and unlimited is absent', () => {
      expect(detectBillingPhase({ rawRemaining: 100 })).toBe('credits_available')
    })

    it('returns credits_available when rawRemaining > 0 and unlimited === false', () => {
      expect(detectBillingPhase({ rawRemaining: 31, unlimited: false })).toBe('credits_available')
    })

    it('returns credits_available when rawRemaining > 0 even when overage fields are set', () => {
      expect(
        detectBillingPhase({
          rawRemaining: 1,
          overageCount: 0,
          overagePermitted: true,
          unlimited: false,
          hasQuota: true
        })
      ).toBe('credits_available')
    })
  })

  // Contract assertion 3: overageCount > 0 && overagePermitted === true (rawRemaining === 0) → 'budget_active'
  describe('budget_active phase', () => {
    it('returns budget_active when rawRemaining === 0 and overageCount > 0 and overagePermitted === true', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overageCount: 120, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('returns budget_active when overageCount is 1 (minimum spend)', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overageCount: 1, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('does NOT return budget_active when overagePermitted is false', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overageCount: 120, overagePermitted: false })
      ).not.toBe('budget_active')
    })

    it('does NOT return budget_active when overagePermitted is absent', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overageCount: 120 })
      ).not.toBe('budget_active')
    })

    // Contract assertion 4: settlement-lag — rawRemaining < 0 && overagePermitted === true → 'budget_active'
    it('returns budget_active when rawRemaining = -473, overageCount = 0, overagePermitted = true (settlement lag)', () => {
      expect(
        detectBillingPhase({ rawRemaining: -473, overageCount: 0, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('returns budget_active when rawRemaining < 0 and overagePermitted === true regardless of overageCount', () => {
      expect(
        detectBillingPhase({ rawRemaining: -1, overagePermitted: true })
      ).toBe('budget_active')
    })

    it('does NOT return budget_active when rawRemaining < 0 but overagePermitted is false', () => {
      expect(
        detectBillingPhase({ rawRemaining: -473, overageCount: 0, overagePermitted: false })
      ).not.toBe('budget_active')
    })

    it('does NOT return budget_active when rawRemaining < 0 but overagePermitted is absent', () => {
      expect(
        detectBillingPhase({ rawRemaining: -473, overageCount: 0 })
      ).not.toBe('budget_active')
    })
  })

  // Contract assertion 5: rawRemaining === 0, overagePermitted === true, overageCount === 0 → 'budget_available'
  describe('budget_available phase', () => {
    it('returns budget_available when rawRemaining === 0, overagePermitted === true, overageCount === 0', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overagePermitted: true, overageCount: 0 })
      ).toBe('budget_available')
    })

    it('returns budget_available when overageCount is absent (treated as 0)', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overagePermitted: true })
      ).toBe('budget_available')
    })

    it('does NOT return budget_available when overagePermitted === false', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overagePermitted: false, overageCount: 0 })
      ).not.toBe('budget_available')
    })
  })

  // Contract assertion 6: has_quota === false (and unlimited !== true) → 'hard_stop'
  describe('hard_stop phase', () => {
    it('returns hard_stop when hasQuota === false and unlimited is absent', () => {
      expect(detectBillingPhase({ rawRemaining: 0, hasQuota: false })).toBe('hard_stop')
    })

    it('returns hard_stop when hasQuota === false and unlimited === false', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, hasQuota: false, unlimited: false })
      ).toBe('hard_stop')
    })

    it('does NOT return hard_stop when hasQuota === false but unlimited === true (unlimited wins)', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, hasQuota: false, unlimited: true })
      ).toBe('unlimited')
    })
  })

  // Contract assertion 7: rawRemaining === 0 && overage_permitted !== true → 'credits_exhausted'
  describe('credits_exhausted phase', () => {
    it('returns credits_exhausted when rawRemaining === 0 and no overage fields present', () => {
      expect(detectBillingPhase({ rawRemaining: 0 })).toBe('credits_exhausted')
    })

    it('returns credits_exhausted when rawRemaining === 0 and overagePermitted === false', () => {
      expect(
        detectBillingPhase({ rawRemaining: 0, overagePermitted: false })
      ).toBe('credits_exhausted')
    })

    it('returns credits_exhausted as the default fallback (no budget, no unlimited, no hard_stop)', () => {
      expect(
        detectBillingPhase({
          rawRemaining: 0,
          overagePermitted: false,
          unlimited: false,
          hasQuota: true
        })
      ).toBe('credits_exhausted')
    })

    it('returns credits_exhausted when rawRemaining < 0 and overagePermitted is absent', () => {
      expect(
        detectBillingPhase({ rawRemaining: -473 })
      ).toBe('credits_exhausted')
    })
  })
})

// ---------------------------------------------------------------------------
// Contract assertion tests for normaliseUsage (backward compat + rawRemaining)
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

// ---------------------------------------------------------------------------
// Contract assertion tests for rawRemaining < 0 (settlement-lag window)
// ---------------------------------------------------------------------------

describe('normaliseUsage — settlement-lag (rawRemaining < 0)', () => {
  // Contract assertion 4 (end-to-end): remaining = -473, overageCount = 0,
  // overagePermitted = true → budget_active
  it('returns budget_active when rawRemaining = -473, overageCount = 0, overagePermitted = true', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7473,
      quota: 7000,
      rawRemaining: -473,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 0,
      overagePermitted: true
    })
    expect(result.billingPhase).toBe('budget_active')
  })

  // Contract assertion 8: derivedOverageCredits = Math.max(0, -rawRemaining) when rawRemaining < 0
  it('sets derivedOverageCredits = 473 when rawRemaining = -473', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7473,
      quota: 7000,
      rawRemaining: -473,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 0,
      overagePermitted: true
    })
    expect(result.derivedOverageCredits).toBe(473)
  })

  // Contract assertion 9: used can exceed quota when rawRemaining < 0
  it('allows used to exceed quota when rawRemaining < 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7473,
      quota: 7000,
      rawRemaining: -473,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 0,
      overagePermitted: true
    })
    expect(result.used).toBe(7473)
    expect(result.used).toBeGreaterThan(result.quota)
  })

  it('clamps remaining to 0 when rawRemaining < 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7473,
      quota: 7000,
      rawRemaining: -473,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 0,
      overagePermitted: true
    })
    expect(result.remaining).toBe(0)
  })

  it('does not set derivedOverageCredits when rawRemaining is absent and remaining > 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 300,
      quota: 500,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'mock'
    })
    expect('derivedOverageCredits' in result).toBe(false)
  })

  it('does not set derivedOverageCredits when rawRemaining === 0', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7000,
      quota: 7000,
      rawRemaining: 0,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 120,
      overagePermitted: true
    })
    expect('derivedOverageCredits' in result).toBe(false)
  })
})

describe('normaliseUsage — derived USD fields', () => {
  it('derives usd totals from credit fields', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 7473,
      quota: 7000,
      rawRemaining: -473,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 473,
      overageEntitlement: 5000,
      overagePermitted: true
    })

    expect(result.includedQuotaCostUsd).toBeCloseTo(70, 6)
    expect(result.totalUsedCostUsd).toBeCloseTo(74.73, 6)
    expect(result.overageCostUsd).toBeCloseTo(4.73, 6)
    expect(result.overageBudgetCostUsd).toBeCloseTo(50, 6)
    expect(result.budgetRemainingCostUsd).toBeCloseTo(45.27, 6)
    expect(result.estimatedRemainingBudgetCostUsd).toBeCloseTo(45.27, 6)
  })

  it('clamps budget remaining costs to zero in over-budget scenarios', () => {
    const result = normaliseUsage({
      mode: 'ai_credits',
      used: 9000,
      quota: 7000,
      rawRemaining: -2000,
      resetAt: '2026-07-01T00:00:00Z',
      billingEntity: 'octocat',
      source: 'github-copilot-internal',
      overageCount: 2200,
      overageEntitlement: 2000,
      overagePermitted: true
    })

    expect(result.budgetRemainingCostUsd).toBe(0)
    expect(result.estimatedRemainingBudgetCostUsd).toBe(0)
  })
})
