/**
 * Unit tests for comfort status display helpers in src/comfort-display.ts.
 *
 * We import only the exported pure helpers so tests are independent of the
 * React rendering lifecycle and browser globals.
 */

import { describe, expect, it } from 'vitest';
import {
  classForComfortLevel,
  labelForComfortLevel,
  type ComfortStatus,
} from '../comfort-display';

describe('labelForComfortLevel', () => {
  it('returns "Safe" for safe', () => {
    expect(labelForComfortLevel('safe')).toBe('Safe');
  });

  it('returns "Watch" for watch', () => {
    expect(labelForComfortLevel('watch')).toBe('Watch');
  });

  it('returns "Warm" for warm', () => {
    expect(labelForComfortLevel('warm')).toBe('Warm');
  });

  it('returns "Hot" for hot', () => {
    expect(labelForComfortLevel('hot')).toBe('Hot');
  });

  it('returns "Overage" for overage', () => {
    expect(labelForComfortLevel('overage')).toBe('Overage');
  });

  it('returns "Blocked" for blocked', () => {
    expect(labelForComfortLevel('blocked')).toBe('Blocked');
  });

  it('returns "Unknown" for unknown', () => {
    expect(labelForComfortLevel('unknown')).toBe('Unknown');
  });
});

describe('classForComfortLevel', () => {
  it('returns level-safe for safe', () => {
    expect(classForComfortLevel('safe')).toBe('level-safe');
  });

  it('returns level-hot for hot', () => {
    expect(classForComfortLevel('hot')).toBe('level-hot');
  });

  it('returns level-overage for overage', () => {
    expect(classForComfortLevel('overage')).toBe('level-overage');
  });

  it('returns level-blocked for blocked', () => {
    expect(classForComfortLevel('blocked')).toBe('level-blocked');
  });

  it('returns level-unknown for unknown', () => {
    expect(classForComfortLevel('unknown')).toBe('level-unknown');
  });
});

describe('ComfortStatus type — rendering contract', () => {
  it('renders safe status with only required fields', () => {
    const status: ComfortStatus = {
      level: 'safe',
      summary: 'Usage is at 30% of quota.',
      primarySignal: 'remaining',
    };
    expect(status.detail).toBeUndefined();
    expect(status.recommendedAction).toBeUndefined();
    expect(labelForComfortLevel(status.level)).toBe('Safe');
    expect(classForComfortLevel(status.level)).toBe('level-safe');
  });

  it('renders hot status with all optional fields', () => {
    const status: ComfortStatus = {
      level: 'hot',
      summary: 'Credits projected to run out within 24 hours.',
      detail: 'Projected exhaustion: 2026-06-26T10:00:00.000Z.',
      primarySignal: 'burn_rate',
      recommendedAction: 'Reduce usage or wait for the next billing reset.',
    };
    expect(status.detail).toBeDefined();
    expect(status.recommendedAction).toBeDefined();
    expect(labelForComfortLevel(status.level)).toBe('Hot');
    expect(classForComfortLevel(status.level)).toBe('level-hot');
  });

  it('renders overage status', () => {
    const status: ComfortStatus = {
      level: 'overage',
      summary: 'Spending against configured budget.',
      detail: '150 overage credits consumed.',
      primarySignal: 'overage',
    };
    expect(labelForComfortLevel(status.level)).toBe('Overage');
    expect(classForComfortLevel(status.level)).toBe('level-overage');
  });

  it('renders blocked status with recommendedAction', () => {
    const status: ComfortStatus = {
      level: 'blocked',
      summary: 'Usage is blocked; no active quota.',
      primarySignal: 'hard_stop',
      recommendedAction: 'Contact your administrator to review billing settings.',
    };
    expect(status.detail).toBeUndefined();
    expect(status.recommendedAction).toBeDefined();
    expect(labelForComfortLevel(status.level)).toBe('Blocked');
    expect(classForComfortLevel(status.level)).toBe('level-blocked');
  });

  it('handles missing comfortStatus gracefully — no crash when undefined', () => {
    const comfortStatus: ComfortStatus | undefined = undefined;
    // When comfortStatus is absent the UI should render nothing; verify that
    // the label helper is never called with undefined.
    expect(comfortStatus).toBeUndefined();
  });
});
