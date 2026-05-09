import { describe, expect, it } from 'vitest';
import {
  buildShortcutPayload,
  deriveOnboardingPhase,
  getFastSetupProgress,
  isLikelyIosNavigator,
  isTrustedShortcutCallbackUrl,
  parseOnboardingCallback
} from '../widget-onboarding';

describe('buildShortcutPayload', () => {
  it('builds shortcut payload json with expected fields', () => {
    const payload = buildShortcutPayload({
      origin: 'https://copelimit.netlify.app',
      bootstrapToken: 'abc123token'
    });

    expect(JSON.parse(payload)).toEqual({
      widgetUrl: 'https://copelimit.netlify.app/scriptable/CopeLimitWidget.js',
      installerUrl: 'https://copelimit.netlify.app/scriptable/CopeLimitInstall.js',
      callbackUrl: 'https://copelimit.netlify.app/?shortcut=complete',
      bootstrapToken: 'abc123token'
    });
  });

  it('normalizes trailing slash in origin', () => {
    const payload = buildShortcutPayload({
      origin: 'https://copelimit.netlify.app/',
      bootstrapToken: 'abc123token'
    });

    const parsed = JSON.parse(payload) as { callbackUrl: string };
    expect(parsed.callbackUrl).toBe('https://copelimit.netlify.app/?shortcut=complete');
  });

  it('includes onboarding session id when provided', () => {
    const payload = buildShortcutPayload({
      origin: 'https://copelimit.netlify.app',
      bootstrapToken: 'abc123token',
      onboardingSessionId: 'onb_123'
    });

    const parsed = JSON.parse(payload) as { onboardingSessionId?: string };
    expect(parsed.onboardingSessionId).toBe('onb_123');
  });
});

describe('parseOnboardingCallback', () => {
  it('parses shortcut complete callback', () => {
    expect(parseOnboardingCallback('?shortcut=complete')).toEqual({
      status: 'complete',
      reason: null,
      fromShortcut: true
    });
  });

  it('parses onboarding error callback with reason', () => {
    expect(parseOnboardingCallback('?onboarding=error&reason=network')).toEqual({
      status: 'error',
      reason: 'network',
      fromShortcut: false
    });
  });
});

describe('isLikelyIosNavigator', () => {
  it('detects iPhone user agent', () => {
    expect(isLikelyIosNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5
    })).toBe(true);
  });

  it('detects iPad masquerading as MacIntel with touch support', () => {
    expect(isLikelyIosNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)',
      platform: 'MacIntel',
      maxTouchPoints: 5
    })).toBe(true);
  });

  it('does not mark Android as iOS', () => {
    expect(isLikelyIosNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)',
      platform: 'Linux armv8l',
      maxTouchPoints: 5
    })).toBe(false);
  });
});

describe('isTrustedShortcutCallbackUrl', () => {
  it('accepts callback urls on expected origin', () => {
    expect(isTrustedShortcutCallbackUrl('https://copelimit.netlify.app/?shortcut=complete', 'https://copelimit.netlify.app')).toBe(true);
  });

  it('rejects callback urls on other origins', () => {
    expect(isTrustedShortcutCallbackUrl('https://example.com/?shortcut=complete', 'https://copelimit.netlify.app')).toBe(false);
  });
});

describe('getFastSetupProgress', () => {
  it('shows only shortcut installed after shortcut confirmation', () => {
    expect(getFastSetupProgress('shortcut-ready', true, false)).toEqual({
      shortcutInstalled: true,
      scriptsInstalled: false,
      tokenConfigured: false,
      widgetReady: false
    });
  });

  it('shows all states complete after successful fast setup callback', () => {
    expect(getFastSetupProgress('shortcut-success', true, true)).toEqual({
      shortcutInstalled: true,
      scriptsInstalled: true,
      tokenConfigured: true,
      widgetReady: true
    });
  });

  it('keeps widget readiness pending until shortcut flow reaches complete phase', () => {
    expect(getFastSetupProgress('shortcut-waiting', true, true)).toEqual({
      shortcutInstalled: true,
      scriptsInstalled: true,
      tokenConfigured: true,
      widgetReady: true
    });
    expect(getFastSetupProgress('shortcut-ready', true, true)).toEqual({
      shortcutInstalled: true,
      scriptsInstalled: true,
      tokenConfigured: true,
      widgetReady: false
    });
  });
});

describe('deriveOnboardingPhase', () => {
  it('maps waiting without token to awaiting return', () => {
    expect(deriveOnboardingPhase('shortcut-waiting', false)).toBe('AWAITING_RETURN');
  });

  it('maps waiting with token to complete', () => {
    expect(deriveOnboardingPhase('shortcut-waiting', true)).toBe('SETUP_COMPLETE');
  });

  it('maps shortcut success with token to complete', () => {
    expect(deriveOnboardingPhase('shortcut-success', true)).toBe('SETUP_COMPLETE');
  });

  it('maps shortcut success without token to partial', () => {
    expect(deriveOnboardingPhase('shortcut-success', false)).toBe('SETUP_PARTIAL');
  });

  it('maps shortcut error without token to failed', () => {
    expect(deriveOnboardingPhase('shortcut-error', false)).toBe('SETUP_FAILED');
  });

  it('maps shortcut error with token to partial', () => {
    expect(deriveOnboardingPhase('shortcut-error', true)).toBe('SETUP_PARTIAL');
  });

  it('maps idle to idle phase', () => {
    expect(deriveOnboardingPhase('idle', false)).toBe('IDLE');
  });

  it('supports transient verifying phase override', () => {
    expect(deriveOnboardingPhase('shortcut-waiting', false, true)).toBe('VERIFYING_SETUP');
  });
});
