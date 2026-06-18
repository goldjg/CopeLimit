/**
 * Unit tests for billing-display helper functions in src/main.tsx.
 *
 * We import only the exported pure helpers to keep tests
 * independent of the React rendering lifecycle.
 */

import { describe, expect, it } from 'vitest';
import { labelForBillingPhase } from '../billing-display';

describe('labelForBillingPhase', () => {
  it('returns readable label for credits_available', () => {
    expect(labelForBillingPhase('credits_available')).toBe('Credits available');
  });

  it('returns readable label for credits_exhausted', () => {
    expect(labelForBillingPhase('credits_exhausted')).toBe('Credits exhausted');
  });

  it('returns readable label for budget_available', () => {
    expect(labelForBillingPhase('budget_available')).toBe('Budget available');
  });

  it('returns readable label for budget_active', () => {
    expect(labelForBillingPhase('budget_active')).toBe('Budget in use');
  });

  it('returns readable label for unlimited', () => {
    expect(labelForBillingPhase('unlimited')).toBe('Unlimited');
  });

  it('returns readable label for hard_stop', () => {
    expect(labelForBillingPhase('hard_stop')).toBe('Hard stop');
  });
});
