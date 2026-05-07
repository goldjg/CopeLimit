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
    return parsed.origin === normaliseOrigin(expectedOrigin);
  } catch {
    return false;
  }
}
