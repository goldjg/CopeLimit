/**
 * Contract tests for `normalizeCopilotInternalPayload` in copilot.ts.
 *
 * Covers the six scenarios required by the canonical AI credit usage model:
 *  1. Normal in-quota usage (ai_credits mode, credits available)
 *  2. Zero remaining (credits exhausted, no budget)
 *  3. Overage active (budget_active phase, overageCount > 0)
 *  4. Budget active (settlement-lag: rawRemaining < 0, overagePermitted)
 *  5. Missing provider fields (returns null → caller falls back to unsupported)
 *  6. Legacy premium_requests fallback (no token_based_billing marker)
 *
 * Additional assertions verify that every field in the "explicitly modelled"
 * canonical model is populated correctly:
 *  - included quota (quota)
 *  - used credits (used)
 *  - remaining credits (remaining)
 *  - overage credits (overageCount / derivedOverageCredits)
 *  - budget/overage enabled state (overagePermitted)
 *  - comfort status (warningLevel)
 *  - last updated timestamp (updatedAt)
 */

import { describe, expect, it } from 'vitest';
import { normalizeCopilotInternalPayload } from '../copilot';
import type { JsonObject } from '../copilot';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeAiCreditsPayload(overrides: JsonObject = {}): JsonObject {
  return {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: 7000,
        remaining: 4500,
        overage_permitted: false,
        overage_count: 0,
        overage_entitlement: 0,
        unlimited: false,
        has_quota: true,
        ...((overrides['quota_snapshots'] as JsonObject | undefined)?.['premium_interactions'] as JsonObject | undefined ?? {}),
      }
    },
    quota_reset_at: '2026-07-01T00:00:00Z',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Normal in-quota usage
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 1: normal in-quota usage', () => {
  const payload: JsonObject = {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: 7000,
        remaining: 4500,
        overage_permitted: false,
        overage_count: 0,
        unlimited: false,
        has_quota: true,
      }
    },
    quota_reset_at: '2026-07-01T00:00:00Z'
  };

  it('returns a non-null Usage', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage).not.toBeNull();
  });

  it('detects ai_credits mode from token_based_billing marker', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.mode).toBe('ai_credits');
  });

  it('sets billingPhase to credits_available', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.billingPhase).toBe('credits_available');
  });

  it('correctly computes included quota, used, remaining', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.quota).toBe(7000);
    expect(usage?.used).toBe(2500);   // 7000 - 4500
    expect(usage?.remaining).toBe(4500);
  });

  it('sets warningLevel to normal (< 75% used)', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    // percentUsed = round(2500 / 7000 * 100) = 36
    expect(usage?.warningLevel).toBe('normal');
  });

  it('sets updatedAt to a current ISO timestamp', () => {
    const before = new Date().toISOString();
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    const after = new Date().toISOString();
    expect(usage?.updatedAt).toBeDefined();
    expect(usage?.updatedAt! >= before).toBe(true);
    expect(usage?.updatedAt! <= after).toBe(true);
  });

  it('sets overagePermitted to false (budget/overage enabled state)', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overagePermitted).toBe(false);
  });

  it('does not set derivedOverageCredits when remaining is positive', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect('derivedOverageCredits' in (usage ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Zero remaining (credits exhausted, no budget)
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 2: zero remaining', () => {
  const payload: JsonObject = {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: 7000,
        remaining: 0,
        overage_permitted: false,
        overage_count: 0,
        unlimited: false,
        has_quota: true,
      }
    },
    quota_reset_at: '2026-07-01T00:00:00Z'
  };

  it('sets billingPhase to credits_exhausted', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.billingPhase).toBe('credits_exhausted');
  });

  it('sets remaining to 0 and used to full quota', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.remaining).toBe(0);
    expect(usage?.used).toBe(7000);
    expect(usage?.quota).toBe(7000);
  });

  it('sets warningLevel to over (100% used)', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.warningLevel).toBe('over');
  });

  it('sets overagePermitted to false', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overagePermitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Overage active (settled overage_count > 0)
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 3: overage active', () => {
  const payload: JsonObject = {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: 7000,
        remaining: 0,
        overage_permitted: true,
        overage_count: 473,
        overage_entitlement: 5000,
        unlimited: false,
        has_quota: true,
      }
    },
    quota_reset_at: '2026-07-01T00:00:00Z'
  };

  it('sets billingPhase to budget_active', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.billingPhase).toBe('budget_active');
  });

  it('carries overageCount through to the canonical model', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overageCount).toBe(473);
  });

  it('carries overageEntitlement through to the canonical model', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overageEntitlement).toBe(5000);
  });

  it('sets overagePermitted to true (budget/overage enabled state)', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overagePermitted).toBe(true);
  });

  it('sets mode to ai_credits', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.mode).toBe('ai_credits');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Budget active via settlement lag (rawRemaining < 0)
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 4: budget active via settlement lag', () => {
  const payload: JsonObject = {
    quota_snapshots: {
      premium_interactions: {
        token_based_billing: true,
        entitlement: 7000,
        remaining: -473,          // settlement-lag: credits consumed before overage_count updates
        overage_permitted: true,
        overage_count: 0,          // overage_count not yet settled
        overage_entitlement: 5000,
        unlimited: false,
        has_quota: true,
      }
    },
    quota_reset_at: '2026-07-01T00:00:00Z'
  };

  it('sets billingPhase to budget_active', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.billingPhase).toBe('budget_active');
  });

  it('clamps remaining to 0', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.remaining).toBe(0);
  });

  it('sets derivedOverageCredits to 473', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.derivedOverageCredits).toBe(473);
  });

  it('sets used above quota (7473 = 7000 + 473)', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.used).toBe(7473);
    expect(usage?.used).toBeGreaterThan(usage?.quota ?? 0);
  });

  it('sets overagePermitted to true', () => {
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.overagePermitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Missing provider fields → returns null
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 5: missing provider fields', () => {
  it('returns null usage when neither entitlement nor remaining are present', () => {
    const payload: JsonObject = {
      token_based_billing: true,
      quota_reset_at: '2026-07-01T00:00:00Z'
      // No quota_snapshots, no top-level entitlement/remaining
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage).toBeNull();
  });

  it('returns null usage for a completely empty payload', () => {
    const { usage } = normalizeCopilotInternalPayload({}, 'octocat', 'github-copilot-internal');
    expect(usage).toBeNull();
  });

  it('returns non-null usage when only entitlement is present', () => {
    const payload: JsonObject = {
      quota_snapshots: {
        premium_interactions: {
          entitlement: 7000
          // remaining absent: defaults to 0 → used = 7000
        }
      }
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage).not.toBeNull();
    expect(usage?.quota).toBe(7000);
    expect(usage?.used).toBe(7000);
    expect(usage?.remaining).toBe(0);
  });

  it('returns non-null usage when only remaining is present', () => {
    const payload: JsonObject = {
      quota_snapshots: {
        premium_interactions: {
          remaining: 300
          // entitlement absent: defaults to 0 → remaining becomes 0, used = 0
        }
      }
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage).not.toBeNull();
    expect(usage?.quota).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Legacy premium_requests fallback
// ---------------------------------------------------------------------------

describe('normalizeCopilotInternalPayload — scenario 6: legacy premium_requests fallback', () => {
  it('returns mode premium_requests when no token_based_billing marker is present', () => {
    const payload: JsonObject = {
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: 179,
          // token_based_billing absent
        }
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.mode).toBe('premium_requests');
  });

  it('returns mode premium_requests when token_based_billing is explicitly false', () => {
    const payload: JsonObject = {
      token_based_billing: false,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: 321,
        }
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.mode).toBe('premium_requests');
  });

  it('correctly maps legacy flat premium_requests paths', () => {
    const payload: JsonObject = {
      premium_requests: {
        entitlement: 500,
        remaining: 179,
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.mode).toBe('premium_requests');
    expect(usage?.quota).toBe(500);
    expect(usage?.used).toBe(321);   // 500 - 179
    expect(usage?.remaining).toBe(179);
  });

  it('correctly maps limited_user_quotas path (highest-priority legacy path)', () => {
    const payload: JsonObject = {
      limited_user_quotas: {
        premium_requests: {
          entitlement: 600,
          remaining: 400,
        }
      },
      premium_requests: {
        entitlement: 500,   // lower-priority path — should be ignored
        remaining: 179,
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    expect(usage?.quota).toBe(600);
    expect(usage?.remaining).toBe(400);
    expect(usage?.used).toBe(200);  // 600 - 400
  });

  it('sets all canonical model fields in legacy mode', () => {
    const payload: JsonObject = {
      premium_requests: {
        entitlement: 500,
        remaining: 321,
      },
      quota_reset_at: '2026-07-01T00:00:00Z'
    };
    const { usage } = normalizeCopilotInternalPayload(payload, 'octocat', 'github-copilot-internal');
    // Canonical model completeness assertions
    expect(usage?.quota).toBeDefined();          // included quota
    expect(usage?.used).toBeDefined();            // used credits
    expect(usage?.remaining).toBeDefined();       // remaining credits
    expect(usage?.warningLevel).toBeDefined();    // comfort status
    expect(usage?.updatedAt).toBeDefined();       // last updated timestamp
    expect(usage?.billingPhase).toBeDefined();
  });
});
