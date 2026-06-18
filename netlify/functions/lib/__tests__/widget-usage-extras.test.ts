/**
 * Contract tests for the `computeWidgetExtras` pure helper in widget-usage.ts.
 *
 * Tests verify:
 * 1. Returns `undefined` when fewer than 2 snapshots are provided.
 * 2. Burn rate is `null` when identical `used` values produce a zero delta.
 * 3. Sparkline is ordered oldest-first and capped at 14 points.
 * 4. Burn rate matches expected credits/hour for a simple linear history.
 * 5. Behaves correctly at the 14-point sparkline boundary.
 */

import { describe, expect, it } from 'vitest';
import { computeWidgetExtras } from '../../widget-usage';
import type { UsageHistorySnapshot } from '../usage-history-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(capturedAt: string, used: number, quota = 7000): UsageHistorySnapshot {
  return {
    capturedAt,
    used,
    quota,
    remaining: Math.max(0, quota - used),
    billingPhase: 'credits_available',
  };
}

/**
 * Builds N snapshots starting at `baseIso`, spaced `intervalHours` apart,
 * with `used` increasing by `usedStep` per snapshot.
 * Returns newest-first (as getHistory would).
 */
function makeLinearHistory(
  n: number,
  baseIso: string,
  intervalHours: number,
  usedStart: number,
  usedStep: number,
  quota = 7000
): UsageHistorySnapshot[] {
  const snapshots: UsageHistorySnapshot[] = [];
  const baseMs = new Date(baseIso).getTime();
  for (let i = 0; i < n; i++) {
    const capturedAt = new Date(baseMs + i * intervalHours * 3_600_000).toISOString();
    snapshots.push(makeSnapshot(capturedAt, usedStart + i * usedStep, quota));
  }
  // newest-first (reverse chronological), matching getHistory order
  return snapshots.reverse();
}

// ---------------------------------------------------------------------------
// Contract assertion 1: insufficient snapshots
// ---------------------------------------------------------------------------

describe('computeWidgetExtras — insufficient snapshots', () => {
  it('returns undefined for empty snapshot list', () => {
    expect(computeWidgetExtras([])).toBeUndefined();
  });

  it('returns undefined for a single snapshot', () => {
    const snapshots = [makeSnapshot('2026-06-15T10:00:00.000Z', 1000)];
    expect(computeWidgetExtras(snapshots)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 2: burn rate zero when delta is zero
// ---------------------------------------------------------------------------

describe('computeWidgetExtras — zero consumption', () => {
  it('returns 0 burnRate when all used values are identical (no consumption)', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T12:00:00.000Z', 1000),
      makeSnapshot('2026-06-15T10:00:00.000Z', 1000),
    ];
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    // deltaUsed = 0, totalHours = 2 → creditsPerHour = 0/2 = 0
    expect(result!.burnRate).toBe(0);
  });

  it('returns null burnRate only when timestamps are identical (zero-duration window)', () => {
    const iso = '2026-06-15T10:00:00.000Z';
    const snapshots = [
      makeSnapshot(iso, 2000),
      makeSnapshot(iso, 1000),
    ];
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    // totalHours = 0 → creditsPerHour = null
    expect(result!.burnRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 3: burn rate accuracy
// ---------------------------------------------------------------------------

describe('computeWidgetExtras — burn rate', () => {
  it('computes correct creditsPerHour for linear consumption', () => {
    // 2 snapshots, 2 hours apart, 200 credits consumed → 100 credits/hour
    const snapshots = makeLinearHistory(2, '2026-06-15T08:00:00.000Z', 2, 1000, 200);
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.burnRate).toBeCloseTo(100, 5);
  });

  it('computes burn rate across multiple intervals', () => {
    // 5 snapshots, 1 hour apart, 100 credits/interval → 100 credits/hour overall
    const snapshots = makeLinearHistory(5, '2026-06-15T08:00:00.000Z', 1, 1000, 100);
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.burnRate).toBeCloseTo(100, 5);
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 4: sparkline ordering and cap
// ---------------------------------------------------------------------------

describe('computeWidgetExtras — sparkline', () => {
  it('returns sparkline values oldest-first', () => {
    // 3 snapshots, newest-first from getHistory: used 3000, 2000, 1000
    const snapshots = [
      makeSnapshot('2026-06-15T12:00:00.000Z', 3000),
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ];
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    // Reversed to oldest-first: [1000, 2000, 3000]
    expect(result!.sparkline).toEqual([1000, 2000, 3000]);
  });

  it('caps sparkline at 14 points when more than 14 snapshots are provided', () => {
    // 20 snapshots, newest-first; sparkline should use the 14 newest, oldest-first
    const snapshots = makeLinearHistory(20, '2026-06-10T00:00:00.000Z', 1, 0, 100);
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.sparkline).toHaveLength(14);
    // The 14 newest snapshots are snapshots[0..13] (newest-first).
    // Reversed to oldest-first: snapshots[13].used comes first.
    const expected = snapshots.slice(0, 14).reverse().map(s => s.used);
    expect(result!.sparkline).toEqual(expected);
  });

  it('includes all points when exactly 14 snapshots are provided', () => {
    const snapshots = makeLinearHistory(14, '2026-06-14T00:00:00.000Z', 1, 500, 50);
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.sparkline).toHaveLength(14);
  });

  it('includes all points when fewer than 14 snapshots are provided', () => {
    const snapshots = makeLinearHistory(5, '2026-06-15T08:00:00.000Z', 2, 1000, 200);
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.sparkline).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Contract assertion 5: sparkline boundary — exactly 2 snapshots
// ---------------------------------------------------------------------------

describe('computeWidgetExtras — minimum viable input', () => {
  it('returns extras with 2-element sparkline for exactly 2 snapshots', () => {
    const snapshots = [
      makeSnapshot('2026-06-15T10:00:00.000Z', 2000),
      makeSnapshot('2026-06-15T08:00:00.000Z', 1000),
    ];
    const result = computeWidgetExtras(snapshots);
    expect(result).toBeDefined();
    expect(result!.sparkline).toHaveLength(2);
    expect(result!.sparkline).toEqual([1000, 2000]);
  });
});
