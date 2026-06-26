import type { BillingPhase } from './billing-display';
import {
  CREDIT_COST_USD,
  clampNonNegative,
  creditsToUsd,
  formatUsd as formatUsdValue,
} from '../netlify/functions/lib/cost-metrics';

export { creditsToUsd };

type UsageMetricsUsage = {
  used: number;
  remaining: number;
  quota: number;
  billingPhase: BillingPhase;
  overageCount?: number;
  overageEntitlement?: number;
  derivedOverageCredits?: number;
  totalUsedCostUsd?: number;
  overageCostUsd?: number;
  overageBudgetCostUsd?: number;
  budgetRemainingCostUsd?: number;
  estimatedRemainingBudgetCostUsd?: number;
};

const FLAT_TREND_BAR_HEIGHT = 60;
const MIN_TREND_BAR_HEIGHT = 28;
const TREND_BAR_HEIGHT_RANGE = 72;

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function formatBurnRate(creditsPerHour: number | null | undefined): string | null {
  if (creditsPerHour === null || creditsPerHour === undefined) return null;
  if (creditsPerHour === 0) return '0/hr';
  return `${creditsPerHour.toFixed(1)}/hr`;
}

export function formatUsd(value: number | null | undefined): string {
  return formatUsdValue(value);
}

export function getOverageUsed(usage: UsageMetricsUsage): number {
  return usage.overageCount ?? usage.derivedOverageCredits ?? 0;
}

export function getBudgetRemaining(usage: UsageMetricsUsage): number | null {
  if (usage.overageEntitlement === undefined) return null;
  return clampNonNegative(usage.overageEntitlement - getOverageUsed(usage));
}

export function getBudgetRemainingCostUsd(usage: UsageMetricsUsage): number | null {
  if (usage.overageEntitlement === undefined) return null;
  if (usage.budgetRemainingCostUsd !== undefined) return usage.budgetRemainingCostUsd;
  const budgetRemaining = getBudgetRemaining(usage);
  return budgetRemaining === null ? null : creditsToUsd(budgetRemaining);
}

export function getTotalUsedCostUsd(usage: UsageMetricsUsage): number {
  if (usage.totalUsedCostUsd !== undefined) return usage.totalUsedCostUsd;
  return creditsToUsd(usage.used);
}

export function creditsCostRateToUsd(creditsPerHour: number | null | undefined): number | null {
  if (creditsPerHour === null || creditsPerHour === undefined) return null;
  return creditsPerHour * CREDIT_COST_USD;
}

export function computeEtaHours(usage: UsageMetricsUsage, burnRate: number | null | undefined): number | null {
  if (burnRate === null || burnRate === undefined || burnRate <= 0) return null;
  if (usage.billingPhase === 'budget_active') {
    const budgetRemaining = getBudgetRemaining(usage);
    if (budgetRemaining === null) return null;
    return budgetRemaining / burnRate;
  }
  if (usage.remaining > 0) return usage.remaining / burnRate;
  return 0;
}

export function formatEta(etaHours: number | null | undefined): string | null {
  if (etaHours === null || etaHours === undefined) return null;
  if (etaHours <= 0) return 'Exhausted';
  if (etaHours < 1) return `~${Math.round(etaHours * 60)}m`;
  if (etaHours < 24) return `~${etaHours.toFixed(1)}hr`;
  return `~${(etaHours / 24).toFixed(1)}d`;
}

export function getHeroValue(usage: UsageMetricsUsage): string {
  if (usage.billingPhase === 'budget_active') {
    return `+${formatNumber(getOverageUsed(usage))}`;
  }
  return formatNumber(usage.remaining);
}

export function getHeroCaption(usage: UsageMetricsUsage): string {
  const prefix = usage.billingPhase === 'budget_active' ? 'overage' : 'remaining';
  return `${prefix} of ${formatNumber(usage.quota)}`;
}

export function buildTrendBarHeights(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => FLAT_TREND_BAR_HEIGHT);
  return values.map((value) => MIN_TREND_BAR_HEIGHT + (((value - min) / (max - min)) * TREND_BAR_HEIGHT_RANGE));
}
