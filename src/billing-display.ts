/**
 * @file Pure display helpers for billing phase labels and source badges.
 *
 * Extracted from main.tsx so they can be tested without importing
 * browser-only React bootstrapping code.
 */

/** All possible billing phases returned by the usage API. */
export type BillingPhase =
  | 'credits_available'
  | 'credits_exhausted'
  | 'budget_available'
  | 'budget_active'
  | 'unlimited'
  | 'hard_stop';

/**
 * Returns a user-friendly label for a {@link BillingPhase} value.
 *
 * @param phase - The billing phase string from the usage API.
 * @returns A readable label suitable for display in the PWA.
 */
export function labelForBillingPhase(phase: BillingPhase): string {
  switch (phase) {
    case 'credits_available': return 'Credits available';
    case 'credits_exhausted': return 'Credits exhausted';
    case 'budget_available':  return 'Budget available';
    case 'budget_active':     return 'Budget in use';
    case 'unlimited':         return 'Unlimited';
    case 'hard_stop':         return 'Hard stop';
    default: return phase;
  }
}
