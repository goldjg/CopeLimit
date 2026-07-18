/**
 * Unit tests for alert decision display helpers in src/alert-display.ts.
 *
 * We import only the exported pure helpers so tests are independent of the
 * React rendering lifecycle and browser globals.
 */

import { describe, expect, it } from 'vitest';
import {
  classForAlertSeverity,
  labelForAlertSeverity,
  labelForAlertType,
  type AlertDecision,
} from '../alert-display';

describe('labelForAlertSeverity', () => {
  it('returns "Info" for info', () => {
    expect(labelForAlertSeverity('info')).toBe('Info');
  });

  it('returns "Warning" for warning', () => {
    expect(labelForAlertSeverity('warning')).toBe('Warning');
  });

  it('returns "Critical" for critical', () => {
    expect(labelForAlertSeverity('critical')).toBe('Critical');
  });

  it('returns "Alert" for undefined', () => {
    expect(labelForAlertSeverity(undefined)).toBe('Alert');
  });
});

describe('classForAlertSeverity', () => {
  it('returns "severity-info" for info', () => {
    expect(classForAlertSeverity('info')).toBe('severity-info');
  });

  it('returns "severity-warning" for warning', () => {
    expect(classForAlertSeverity('warning')).toBe('severity-warning');
  });

  it('returns "severity-critical" for critical', () => {
    expect(classForAlertSeverity('critical')).toBe('severity-critical');
  });

  it('returns "severity-unknown" for undefined', () => {
    expect(classForAlertSeverity(undefined)).toBe('severity-unknown');
  });
});

describe('labelForAlertType', () => {
  it('returns a label for each alert type', () => {
    expect(labelForAlertType('approaching_exhaustion')).toBe('Running out soon');
    expect(labelForAlertType('exhausted')).toBe('Credits exhausted');
    expect(labelForAlertType('overage_active')).toBe('Overage active');
    expect(labelForAlertType('hard_stop')).toBe('Hard stop');
    expect(labelForAlertType('budget_risk')).toBe('Budget at risk');
    expect(labelForAlertType('unknown_risk')).toBe('Unknown risk');
  });

  it('returns "Alert" for undefined', () => {
    expect(labelForAlertType(undefined)).toBe('Alert');
  });
});

describe('AlertDecision type — rendering contract', () => {
  it('no alert — shouldAlert false with only reason required', () => {
    const decision: AlertDecision = {
      shouldAlert: false,
      reason: 'Comfort level is safe: no alert needed.',
    };
    expect(decision.shouldAlert).toBe(false);
    expect(decision.alertType).toBeUndefined();
    expect(decision.severity).toBeUndefined();
    expect(decision.title).toBeUndefined();
    expect(decision.message).toBeUndefined();
  });

  it('warning alert — shouldAlert true with all required fields', () => {
    const decision: AlertDecision = {
      shouldAlert: true,
      alertType: 'overage_active',
      severity: 'warning',
      title: 'Overage budget active',
      message: 'Included credits are exhausted. Spending is now drawing from your configured overage budget.',
      reason: 'Comfort level is overage (budget_active phase).',
      dedupeKey: 'overage_active:warning:budget_active:2026-06-25',
    };
    expect(decision.shouldAlert).toBe(true);
    expect(decision.severity).toBe('warning');
    expect(labelForAlertSeverity(decision.severity)).toBe('Warning');
    expect(classForAlertSeverity(decision.severity)).toBe('severity-warning');
    expect(labelForAlertType(decision.alertType)).toBe('Overage active');
  });

  it('critical alert — shouldAlert true with critical severity', () => {
    const decision: AlertDecision = {
      shouldAlert: true,
      alertType: 'exhausted',
      severity: 'critical',
      title: 'AI credits exhausted',
      message: 'Included credits are exhausted and no overage budget is configured.',
      reason: 'Comfort level is blocked (credits_exhausted).',
      dedupeKey: 'exhausted:critical:credits_exhausted:2026-06-25',
    };
    expect(decision.shouldAlert).toBe(true);
    expect(decision.severity).toBe('critical');
    expect(labelForAlertSeverity(decision.severity)).toBe('Critical');
    expect(classForAlertSeverity(decision.severity)).toBe('severity-critical');
    expect(labelForAlertType(decision.alertType)).toBe('Credits exhausted');
  });

  it('missing alertDecision fallback — undefined value renders nothing', () => {
    const alertDecision: AlertDecision | undefined = undefined;
    // When alertDecision is absent the UI should not render the block.
    expect(alertDecision).toBeUndefined();
  });

  it('unknown/unsupported provider — shouldAlert false, reason present', () => {
    // An unsupported provider sets source='unsupported' and returns zeroed usage.
    // The alert decision engine returns shouldAlert=false with a reason string.
    const decision: AlertDecision = {
      shouldAlert: false,
      reason: 'No actionable signal detected from usage or projection alone.',
    };
    expect(decision.shouldAlert).toBe(false);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.severity).toBeUndefined();
    expect(decision.alertType).toBeUndefined();
  });
});
