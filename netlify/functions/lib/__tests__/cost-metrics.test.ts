import { describe, expect, it } from 'vitest';
import {
  CREDIT_COST_USD,
  clampNonNegative,
  creditsToUsd,
  formatUsd,
  toSafeFiniteNumber
} from '../cost-metrics';

describe('cost-metrics helpers', () => {
  it('uses the expected credit-to-usd conversion constant', () => {
    expect(CREDIT_COST_USD).toBe(0.01);
    expect(creditsToUsd(473)).toBeCloseTo(4.73, 8);
  });

  it('guards invalid numbers safely', () => {
    expect(toSafeFiniteNumber(undefined)).toBeUndefined();
    expect(toSafeFiniteNumber(Number.NaN)).toBeUndefined();
    expect(toSafeFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toSafeFiniteNumber('12.5')).toBe(12.5);
  });

  it('clamps non-negative values for remaining budgets', () => {
    expect(clampNonNegative(10)).toBe(10);
    expect(clampNonNegative(-10)).toBe(0);
    expect(clampNonNegative(Number.NaN)).toBe(0);
  });

  it('formats usd values and invalid inputs consistently', () => {
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});
