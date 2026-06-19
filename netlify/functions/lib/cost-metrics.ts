export const CREDIT_COST_USD = 0.01;

export function toSafeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function clampNonNegative(value: number | null | undefined): number {
  const safeValue = toSafeFiniteNumber(value);
  if (safeValue === undefined) return 0;
  return Math.max(0, safeValue);
}

export function creditsToUsd(credits: number | null | undefined): number {
  const safeCredits = toSafeFiniteNumber(credits);
  if (safeCredits === undefined) return 0;
  return safeCredits * CREDIT_COST_USD;
}

export function formatUsd(value: number | null | undefined): string {
  const safeValue = toSafeFiniteNumber(value);
  if (safeValue === undefined) return '$0.00';
  return `$${safeValue.toFixed(2)}`;
}
