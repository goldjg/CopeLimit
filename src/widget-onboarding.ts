export type OnboardingCallbackStatus = 'complete' | 'error' | null;

export type OnboardingCallback = {
  status: OnboardingCallbackStatus;
  reason: string | null;
  fromShortcut: boolean;
};

export type ShortcutPayloadInput = {
  origin: string;
  bootstrapToken: string;
  callbackPath?: string;
};

export type FastSetupProgress = {
  shortcutInstalled: boolean;
  scriptsInstalled: boolean;
  tokenConfigured: boolean;
  widgetReady: boolean;
};

export type OnboardingStep =
  | 'idle'
  | 'manual-setup'
  | 'requesting'
  | 'waiting'
  | 'error'
  | 'shortcut-prompt-install'
  | 'shortcut-ready'
  | 'shortcut-launching'
  | 'shortcut-waiting'
  | 'shortcut-success'
  | 'shortcut-error';

export type OnboardingPhase =
  | 'IDLE'
  | 'SHORTCUT_INSTALL_REQUIRED'
  | 'SHORTCUT_READY'
  | 'SHORTCUT_LAUNCHED'
  | 'AWAITING_RETURN'
  | 'VERIFYING_SETUP'
  | 'SETUP_PARTIAL'
  | 'SETUP_COMPLETE'
  | 'SETUP_FAILED';

const DEFAULT_CALLBACK_PATH = '/?shortcut=complete';

export function isLikelyIosNavigator(navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  // iPadOS can report itself as MacIntel in desktop-class browsing mode.
  return /iPad|iPhone|iPod/.test(navigatorLike.userAgent)
    || (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1);
}

function normaliseOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

export function buildShortcutPayload({ origin, bootstrapToken, callbackPath = DEFAULT_CALLBACK_PATH }: ShortcutPayloadInput): string {
  const safeOrigin = normaliseOrigin(origin);
  return JSON.stringify({
    widgetUrl: `${safeOrigin}/scriptable/CopeLimitWidget.js`,
    installerUrl: `${safeOrigin}/scriptable/CopeLimitInstall.js`,
    callbackUrl: `${safeOrigin}${callbackPath}`,
    bootstrapToken
  });
}

export function parseOnboardingCallback(search: string): OnboardingCallback {
  const params = new URLSearchParams(search);
  const onboarding = params.get('onboarding');
  const shortcut = params.get('shortcut');
  const reason = params.get('reason');

  if (shortcut === 'complete') {
    return { status: 'complete', reason, fromShortcut: true };
  }

  if (onboarding === 'complete') {
    return { status: 'complete', reason, fromShortcut: false };
  }

  if (shortcut === 'error' || onboarding === 'error') {
    return { status: 'error', reason, fromShortcut: shortcut === 'error' };
  }

  return { status: null, reason, fromShortcut: false };
}

export function isTrustedShortcutCallbackUrl(raw: string | null | undefined, expectedOrigin: string): boolean {
  if (!raw) return false;

  try {
    const parsed = new URL(raw);
    return normaliseOrigin(parsed.origin) === normaliseOrigin(expectedOrigin);
  } catch {
    return false;
  }
}

export function deriveOnboardingPhase(
  step: OnboardingStep,
  hasActiveToken: boolean,
  verifyingSetup = false
): OnboardingPhase {
  if (verifyingSetup) return 'VERIFYING_SETUP';
  if (step === 'idle' || step === 'manual-setup' || step === 'requesting' || step === 'waiting' || step === 'error') {
    return 'IDLE';
  }
  if (step === 'shortcut-prompt-install') return 'SHORTCUT_INSTALL_REQUIRED';
  if (step === 'shortcut-ready') return 'SHORTCUT_READY';
  if (step === 'shortcut-launching') return 'SHORTCUT_LAUNCHED';
  if (step === 'shortcut-waiting') return hasActiveToken ? 'SETUP_COMPLETE' : 'AWAITING_RETURN';
  if (step === 'shortcut-success') return hasActiveToken ? 'SETUP_COMPLETE' : 'SETUP_PARTIAL';
  if (step === 'shortcut-error') return hasActiveToken ? 'SETUP_PARTIAL' : 'SETUP_FAILED';
  return 'IDLE';
}

export function getFastSetupProgress(
  onboardingStep: OnboardingStep,
  shortcutInstalled: boolean,
  hasActiveToken: boolean
): FastSetupProgress {
  const hasReachedShortcutFlow = shortcutInstalled || [
    'shortcut-ready',
    'shortcut-launching',
    'shortcut-waiting',
    'shortcut-success',
    'shortcut-error'
  ].includes(onboardingStep);

  const phase = deriveOnboardingPhase(onboardingStep, hasActiveToken);
  const verifiedSetup = hasActiveToken;
  const completedFastSetup = phase === 'SETUP_COMPLETE';

  return {
    shortcutInstalled: hasReachedShortcutFlow,
    scriptsInstalled: verifiedSetup,
    tokenConfigured: verifiedSetup,
    widgetReady: completedFastSetup
  };
}
