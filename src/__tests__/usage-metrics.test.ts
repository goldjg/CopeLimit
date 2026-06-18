import { describe, expect, it } from 'vitest';
import {
  buildTrendBarHeights,
  computeEtaHours,
  formatBurnRate,
  formatEta,
  getBudgetRemaining,
  getHeroCaption,
  getHeroValue,
} from '../usage-metrics';

describe('usage-metrics helpers', () => {
  it('formats burn rate consistently with the widget', () => {
    expect(formatBurnRate(null)).toBeNull();
    expect(formatBurnRate(0)).toBe('0/hr');
    expect(formatBurnRate(12.34)).toBe('12.3/hr');
  });

  it('computes ETA from remaining credits outside budget mode', () => {
    const etaHours = computeEtaHours({
      remaining: 480,
      quota: 7000,
      billingPhase: 'credits_available',
    }, 120);
    expect(etaHours).toBe(4);
    expect(formatEta(etaHours)).toBe('~4.0hr');
  });

  it('computes ETA from remaining budget during budget mode', () => {
    const etaHours = computeEtaHours({
      remaining: 0,
      quota: 7000,
      billingPhase: 'budget_active',
      overageCount: 150,
      overageEntitlement: 450,
    }, 100);
    expect(etaHours).toBe(3);
    expect(formatEta(etaHours)).toBe('~3.0hr');
  });

  it('returns budget-active hero strings using overage values', () => {
    const usage = {
      remaining: 0,
      quota: 7000,
      billingPhase: 'budget_active' as const,
      derivedOverageCredits: 473,
      overageEntitlement: 5000,
    };
    expect(getHeroValue(usage)).toBe('+473');
    expect(getHeroCaption(usage)).toBe('overage of 7,000');
    expect(getBudgetRemaining(usage)).toBe(4527);
  });

  it('formats exhausted and day-scale ETA labels', () => {
    expect(formatEta(0)).toBe('Exhausted');
    expect(formatEta(0.5)).toBe('~30m');
    expect(formatEta(36)).toBe('~1.5d');
  });

  it('builds stable trend bars for flat and rising histories', () => {
    expect(buildTrendBarHeights([100, 100, 100])).toEqual([60, 60, 60]);
    const bars = buildTrendBarHeights([100, 200, 300]);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toBeLessThan(bars[1]);
    expect(bars[1]).toBeLessThan(bars[2]);
  });
});
