/**
 * @file iOS widget onboarding state machine types and pure helper functions.
 *
 * This module is **platform-agnostic** (no DOM/React dependencies) so that
 * the onboarding logic can be unit-tested in a Node.js environment.
 *
 * ## Onboarding flow overview
 *
 * CopeLimit supports two modes for setting up the Scriptable iOS widget:
 *
 * ### Fast Setup (recommended, iOS + Standalone PWA only)
 * 1. PWA calls `POST /api/onboarding/session` to obtain a bootstrap token.
 * 2. The bootstrap token is serialised into a JSON payload and written to the
 *    clipboard.
 * 3. The `CopeLimitInstaller` iOS Shortcut is launched via the
 *    `shortcuts://run-shortcut?name=CopeLimitInstaller&input=Clipboard` URL.
 * 4. The Shortcut reads the clipboard, runs `CopeLimitInstall.js` in
 *    Scriptable, which calls `POST /api/onboarding/exchange` to obtain a
 *    long-lived widget token and stores it in the iOS Keychain.
 * 5. Scriptable/Shortcuts redirects back to the PWA callback URL
 *    (`/?shortcut=complete`).
 * 6. The PWA polls `GET /api/widget-token` to confirm the token is active.
 *
 * ### Manual Setup (fallback)
 * The user copies each script source (widget + installer) from the PWA to
 * Scriptable manually, then runs `CopeLimitInstall.js` via a deep link.
 *
 * ## State machine
 *
 * {@link OnboardingStep} is the granular UI step identifier.
 * {@link OnboardingPhase} is the higher-level semantic phase derived from the
 * step and whether the user has an active widget token.
 */

/** Terminal state of a shortcut/onboarding callback URL parameter. */
export type OnboardingCallbackStatus = 'complete' | 'error' | null;

/** Parsed result of the `?shortcut=` / `?onboarding=` query parameters. */
export type OnboardingCallback = {
  /** Whether setup completed, errored, or neither query param was present. */
  status: OnboardingCallbackStatus;
  /** Optional error reason string from `?reason=`. */
  reason: string | null;
  /** `true` when the callback came from the iOS Shortcut (`?shortcut=`). */
  fromShortcut: boolean;
};

/** Input required to build the JSON payload written to the clipboard for the Shortcut. */
export type ShortcutPayloadInput = {
  /** The PWA's origin (e.g. `https://copelimit.netlify.app`). */
  origin: string;
  /** The single-use bootstrap token from `POST /api/onboarding/session`. */
  bootstrapToken: string;
  /** URL the Shortcut should redirect to on completion (defaults to `/?shortcut=complete`). */
  callbackPath?: string;
};

/**
 * Progress indicators for the Fast Setup checklist shown in the UI.
 * Each flag becomes `true` when the corresponding step has been completed.
 */
export type FastSetupProgress = {
  /** Whether the CopeLimitInstaller Shortcut has been installed. */
  shortcutInstalled: boolean;
  /** Whether the widget script has been installed in Scriptable. */
  scriptsInstalled: boolean;
  /** Whether the widget token has been configured in the Keychain. */
  tokenConfigured: boolean;
  /** Whether the widget is fully configured and ready to use. */
  widgetReady: boolean;
};

/**
 * Granular onboarding step identifier used to drive UI state transitions.
 *
 * - `idle`                    – No onboarding in progress
 * - `manual-setup`            – User is following manual script copy steps
 * - `requesting`              – Fetching an onboarding session token
 * - `waiting`                 – Waiting for Scriptable to return (manual flow)
 * - `error`                   – Manual flow error
 * - `shortcut-prompt-install` – Prompting user to install the Shortcut
 * - `shortcut-ready`          – Shortcut installed; payload being prepared
 * - `shortcut-launching`      – About to open the Shortcuts app
 * - `shortcut-waiting`        – Waiting for the Shortcut to complete and return
 * - `shortcut-success`        – Shortcut returned and token was confirmed
 * - `shortcut-error`          – Shortcut flow failed
 */
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

/**
 * High-level semantic phase derived from the current {@link OnboardingStep}
 * and whether the user has an active widget token.
 */
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

/**
 * Returns `true` when the provided navigator-like object matches known iOS
 * or iPadOS user-agent / platform signatures.
 *
 * iPadOS in desktop-class browsing mode reports `MacIntel` but has
 * `maxTouchPoints > 1`, so both checks are applied.
 *
 * @param navigatorLike - A partial Navigator with the three relevant fields.
 * @returns Whether the navigator appears to be an iOS/iPadOS device.
 */
export function isLikelyIosNavigator(navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  // iPadOS can report itself as MacIntel in desktop-class browsing mode.
  return /iPad|iPhone|iPod/.test(navigatorLike.userAgent)
    || (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1);
}

function normaliseOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * Builds the JSON string written to the clipboard before launching the
 * `CopeLimitInstaller` iOS Shortcut.
 *
 * The payload contains the widget script URL, installer script URL,
 * the callback URL, and the single-use bootstrap token.
 *
 * @param input - {@link ShortcutPayloadInput} with origin and bootstrap token.
 * @returns A JSON string safe to write to the system clipboard.
 */
export function buildShortcutPayload({ origin, bootstrapToken, callbackPath = DEFAULT_CALLBACK_PATH }: ShortcutPayloadInput): string {
  const safeOrigin = normaliseOrigin(origin);
  return JSON.stringify({
    widgetUrl: `${safeOrigin}/scriptable/CopeLimitWidget.js`,
    installerUrl: `${safeOrigin}/scriptable/CopeLimitInstall.js`,
    callbackUrl: `${safeOrigin}${callbackPath}`,
    bootstrapToken
  });
}

/**
 * Parses the `?shortcut=` and `?onboarding=` query parameters that the iOS
 * Shortcut / Scriptable script appends when redirecting back to the PWA.
 *
 * @param search - `window.location.search` string (including the leading `?`).
 * @returns Parsed {@link OnboardingCallback} with status, reason, and origin.
 */
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

/**
 * Returns `true` when `raw` is a URL whose origin matches `expectedOrigin`.
 * Used to validate the `callbackUrl` in the Shortcut payload before redirecting.
 *
 * @param raw            - The URL string to validate (may be `null`/`undefined`).
 * @param expectedOrigin - The expected origin (e.g. `https://copelimit.netlify.app`).
 * @returns `true` when the URL is valid and the origin matches.
 */
export function isTrustedShortcutCallbackUrl(raw: string | null | undefined, expectedOrigin: string): boolean {
  if (!raw) return false;

  try {
    const parsed = new URL(raw);
    return normaliseOrigin(parsed.origin) === normaliseOrigin(expectedOrigin);
  } catch {
    return false;
  }
}

/**
 * Derives the high-level {@link OnboardingPhase} from the granular
 * {@link OnboardingStep} and contextual flags.
 *
 * @param step           - Current step in the onboarding state machine.
 * @param hasActiveToken - Whether the user has a confirmed active widget token.
 * @param verifyingSetup - `true` while a token status check is in flight.
 * @returns The corresponding semantic {@link OnboardingPhase}.
 */
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

/**
 * Computes the {@link FastSetupProgress} checklist from the current onboarding
 * state. Used to drive the step-by-step progress indicators in the UI.
 *
 * @param onboardingStep   - Current {@link OnboardingStep}.
 * @param shortcutInstalled - Whether the user has previously installed the Shortcut.
 * @param hasActiveToken   - Whether the user has a confirmed active widget token.
 * @returns A progress object with boolean flags for each setup step.
 */
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
