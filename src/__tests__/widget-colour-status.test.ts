/**
 * Contract tests for the widget colour and status-label derivation logic
 * implemented in `public/scriptable/CopeLimitWidget.js`.
 *
 * Because `CopeLimitWidget.js` is a self-contained Scriptable iOS script
 * (not an ES module), the pure helper functions are defined inline here so
 * they can be tested independently of the Scriptable runtime globals.
 *
 * These tests act as a living specification: if the contract changes,
 * both this file and the widget file must be updated together.
 *
 * ## Scenarios covered:
 *  1.  credits_available + comfortStatus safe → green (Comfortable)
 *  2.  credits_available + comfortStatus warm → yellow/warm, NOT green
 *  3.  credits_available + comfortStatus hot  → red/hot, NOT green
 *  4.  credits_available + exhaustion_before_reset projection (no comfortStatus) → yellow
 *  5.  budget_active + comfortStatus overage  → orange/overage
 *  6.  credits_exhausted + comfortStatus blocked → red/blocked
 *  7.  hard_stop + comfortStatus blocked       → red/blocked
 *  8.  reset_before_exhaustion → green/safe (Comfortable)
 *  9.  watch level → blue/watch
 * 10.  unknown comfortStatus + no projection  → fallback to billingPhase
 * 11.  unsupported source always amber
 * 12.  deriveStatusLabel: prefers comfortLevelLabel over billingPhaseLabel
 * 13.  deriveStatusLabel: falls back to billingPhaseLabel when comfortStatus absent/unknown
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Inline definitions — mirror the pure helpers in CopeLimitWidget.js
// ---------------------------------------------------------------------------

type ComfortLevel = 'safe' | 'watch' | 'warm' | 'hot' | 'overage' | 'blocked' | 'unknown';
type ProjectionStatus = 'unavailable' | 'exhaustion_before_reset' | 'exhausted' | 'reset_before_exhaustion';

interface WidgetUsage {
  source?: string;
  billingPhase?: string;
  warningLevel?: string;
  comfortStatus?: { level?: ComfortLevel };
  burnRateProjection?: { projectionStatus?: ProjectionStatus };
}

function colourHexFor(usage: WidgetUsage): string {
  if (usage.source === 'unsupported') return '#f59e0b';

  const level = usage.comfortStatus?.level;
  if (level && level !== 'unknown') {
    if (level === 'blocked') return '#ef4444';
    if (level === 'overage') return '#f97316';
    if (level === 'hot') return '#ef4444';
    if (level === 'warm') return '#f59e0b';
    if (level === 'watch') return '#60a5fa';
    if (level === 'safe') return '#22c55e';
  }

  const projStatus = usage.burnRateProjection?.projectionStatus;
  if (projStatus === 'exhaustion_before_reset') return '#f59e0b';
  if (projStatus === 'exhausted') return '#ef4444';

  if (usage.billingPhase === 'budget_active') return '#f97316';
  if (usage.warningLevel === 'over' || usage.warningLevel === 'hot') return '#ef4444';
  if (usage.warningLevel === 'warm') return '#f59e0b';
  if (usage.source === 'github-copilot-internal') return '#22c55e';
  return '#60a5fa';
}

function billingPhaseLabel(phase: string | undefined): string {
  const labels: Record<string, string> = {
    credits_available: 'Credits available',
    credits_exhausted: 'Credits exhausted',
    budget_available: 'Budget available',
    budget_active: 'Budget in use',
    unlimited: 'Unlimited',
    hard_stop: 'Hard stop',
  };
  return labels[phase ?? ''] ?? phase ?? '—';
}

function comfortLevelLabel(level: ComfortLevel | undefined): string | null {
  const labels: Partial<Record<ComfortLevel, string>> = {
    safe: 'Comfortable',
    watch: 'Watch',
    warm: 'Warm',
    hot: 'Hot',
    overage: 'Overage',
    blocked: 'Blocked',
    unknown: 'Unknown',
  };
  return (level && labels[level]) ?? null;
}

function deriveStatusLabel(usage: WidgetUsage): string {
  const level = usage.comfortStatus?.level;
  const label = comfortLevelLabel(level);
  if (label && level !== 'unknown') return label;
  return billingPhaseLabel(usage.billingPhase);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function liveUsage(
  billingPhase: string,
  comfortLevel?: ComfortLevel,
  projectionStatus?: ProjectionStatus,
): WidgetUsage {
  return {
    source: 'github-copilot-internal',
    billingPhase,
    warningLevel: 'normal',
    comfortStatus: comfortLevel ? { level: comfortLevel } : undefined,
    burnRateProjection: projectionStatus ? { projectionStatus } : undefined,
  };
}

// ---------------------------------------------------------------------------
// colourHexFor — canonical comfort level takes priority
// ---------------------------------------------------------------------------

describe('colourHexFor — canonical comfort level', () => {
  it('credits_available + comfortStatus safe → green', () => {
    const usage = liveUsage('credits_available', 'safe');
    expect(colourHexFor(usage)).toBe('#22c55e');
  });

  it('credits_available + comfortStatus warm → yellow, NOT green', () => {
    const usage = liveUsage('credits_available', 'warm');
    expect(colourHexFor(usage)).toBe('#f59e0b');
  });

  it('credits_available + comfortStatus hot → red, NOT green', () => {
    const usage = liveUsage('credits_available', 'hot');
    expect(colourHexFor(usage)).toBe('#ef4444');
  });

  it('credits_available + comfortStatus watch → blue', () => {
    const usage = liveUsage('credits_available', 'watch');
    expect(colourHexFor(usage)).toBe('#60a5fa');
  });

  it('budget_active + comfortStatus overage → orange', () => {
    const usage = liveUsage('budget_active', 'overage');
    expect(colourHexFor(usage)).toBe('#f97316');
  });

  it('credits_exhausted + comfortStatus blocked → red', () => {
    const usage = liveUsage('credits_exhausted', 'blocked');
    expect(colourHexFor(usage)).toBe('#ef4444');
  });

  it('hard_stop + comfortStatus blocked → red', () => {
    const usage = liveUsage('hard_stop', 'blocked');
    expect(colourHexFor(usage)).toBe('#ef4444');
  });

  it('reset_before_exhaustion + comfortStatus safe → green', () => {
    const usage = liveUsage('credits_available', 'safe', 'reset_before_exhaustion');
    expect(colourHexFor(usage)).toBe('#22c55e');
  });
});

// ---------------------------------------------------------------------------
// colourHexFor — burn-rate projection fallback (comfortStatus absent/unknown)
// ---------------------------------------------------------------------------

describe('colourHexFor — projection fallback', () => {
  it('exhaustion_before_reset projection (no comfortStatus) → yellow', () => {
    const usage = liveUsage('credits_available', undefined, 'exhaustion_before_reset');
    expect(colourHexFor(usage)).toBe('#f59e0b');
  });

  it('exhausted projection (no comfortStatus) → red', () => {
    const usage = liveUsage('credits_exhausted', undefined, 'exhausted');
    expect(colourHexFor(usage)).toBe('#ef4444');
  });

  it('unknown comfortStatus + exhaustion_before_reset projection → uses projection (yellow)', () => {
    const usage: WidgetUsage = {
      source: 'github-copilot-internal',
      billingPhase: 'credits_available',
      warningLevel: 'normal',
      comfortStatus: { level: 'unknown' },
      burnRateProjection: { projectionStatus: 'exhaustion_before_reset' },
    };
    expect(colourHexFor(usage)).toBe('#f59e0b');
  });
});

// ---------------------------------------------------------------------------
// colourHexFor — billing phase / warningLevel fallback (no comfortStatus, no projection)
// ---------------------------------------------------------------------------

describe('colourHexFor — billing phase fallback', () => {
  it('budget_active (no comfortStatus) → orange', () => {
    const usage = liveUsage('budget_active');
    expect(colourHexFor(usage)).toBe('#f97316');
  });

  it('warningLevel hot (no comfortStatus) → red', () => {
    const usage: WidgetUsage = {
      source: 'github-copilot-internal',
      billingPhase: 'credits_available',
      warningLevel: 'hot',
    };
    expect(colourHexFor(usage)).toBe('#ef4444');
  });

  it('warningLevel warm (no comfortStatus) → yellow', () => {
    const usage: WidgetUsage = {
      source: 'github-copilot-internal',
      billingPhase: 'credits_available',
      warningLevel: 'warm',
    };
    expect(colourHexFor(usage)).toBe('#f59e0b');
  });

  it('credits_available, normal warningLevel, live source, no comfortStatus → green', () => {
    const usage: WidgetUsage = {
      source: 'github-copilot-internal',
      billingPhase: 'credits_available',
      warningLevel: 'normal',
    };
    expect(colourHexFor(usage)).toBe('#22c55e');
  });

  it('unsupported source always → amber, ignoring comfort level', () => {
    const usage: WidgetUsage = {
      source: 'unsupported',
      billingPhase: 'credits_available',
      comfortStatus: { level: 'safe' },
    };
    expect(colourHexFor(usage)).toBe('#f59e0b');
  });
});

// ---------------------------------------------------------------------------
// deriveStatusLabel
// ---------------------------------------------------------------------------

describe('deriveStatusLabel — prefers comfort level', () => {
  it('credits_available + warm → "Warm" (not "Credits available")', () => {
    const usage = liveUsage('credits_available', 'warm');
    expect(deriveStatusLabel(usage)).toBe('Warm');
  });

  it('credits_available + hot → "Hot" (not "Credits available")', () => {
    const usage = liveUsage('credits_available', 'hot');
    expect(deriveStatusLabel(usage)).toBe('Hot');
  });

  it('credits_available + safe → "Comfortable"', () => {
    const usage = liveUsage('credits_available', 'safe');
    expect(deriveStatusLabel(usage)).toBe('Comfortable');
  });

  it('budget_active + overage → "Overage"', () => {
    const usage = liveUsage('budget_active', 'overage');
    expect(deriveStatusLabel(usage)).toBe('Overage');
  });

  it('credits_exhausted + blocked → "Blocked"', () => {
    const usage = liveUsage('credits_exhausted', 'blocked');
    expect(deriveStatusLabel(usage)).toBe('Blocked');
  });

  it('watch level → "Watch"', () => {
    const usage = liveUsage('credits_available', 'watch');
    expect(deriveStatusLabel(usage)).toBe('Watch');
  });
});

describe('deriveStatusLabel — fallback to billing phase', () => {
  it('no comfortStatus → billing phase label', () => {
    const usage = liveUsage('credits_available');
    expect(deriveStatusLabel(usage)).toBe('Credits available');
  });

  it('comfortStatus unknown → billing phase label', () => {
    const usage: WidgetUsage = {
      source: 'github-copilot-internal',
      billingPhase: 'budget_active',
      comfortStatus: { level: 'unknown' },
    };
    expect(deriveStatusLabel(usage)).toBe('Budget in use');
  });

  it('no comfortStatus, hard_stop → "Hard stop"', () => {
    const usage = liveUsage('hard_stop');
    expect(deriveStatusLabel(usage)).toBe('Hard stop');
  });
});

// ---------------------------------------------------------------------------
// comfortLevelLabel
// ---------------------------------------------------------------------------

describe('comfortLevelLabel', () => {
  it('maps safe → Comfortable', () => expect(comfortLevelLabel('safe')).toBe('Comfortable'));
  it('maps watch → Watch', () => expect(comfortLevelLabel('watch')).toBe('Watch'));
  it('maps warm → Warm', () => expect(comfortLevelLabel('warm')).toBe('Warm'));
  it('maps hot → Hot', () => expect(comfortLevelLabel('hot')).toBe('Hot'));
  it('maps overage → Overage', () => expect(comfortLevelLabel('overage')).toBe('Overage'));
  it('maps blocked → Blocked', () => expect(comfortLevelLabel('blocked')).toBe('Blocked'));
  it('maps unknown → Unknown', () => expect(comfortLevelLabel('unknown')).toBe('Unknown'));
  it('returns null for undefined', () => expect(comfortLevelLabel(undefined)).toBeNull());
});
