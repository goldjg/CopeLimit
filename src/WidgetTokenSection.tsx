import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildShortcutPayload,
  parseOnboardingCallback
} from './widget-onboarding';

type WidgetTokenResult = {
  token: string;
  expiresAt: string;
  ttlDays: number;
};

type WidgetTokenStatus = {
  ttlDays: number;
  hasActiveToken: boolean;
  expiresAt?: string;
};

type ManualOnboardingStep = 'manual-setup' | 'requesting' | 'waiting' | 'error';
type ShortcutOnboardingStep =
  | 'shortcut-prompt-install'
  | 'shortcut-ready'
  | 'shortcut-launching'
  | 'shortcut-waiting'
  | 'shortcut-success'
  | 'shortcut-error';

type OnboardingStep = 'idle' | ManualOnboardingStep | ShortcutOnboardingStep;
type SetupMode = 'fast' | 'manual';

type OnboardingSessionResult = {
  bootstrapToken: string;
  expiresAt: string;
  ttlSeconds: number;
};

type ScriptablePasteDialog = {
  title: string;
  intro: string;
  steps: string[];
  targetScriptName: string;
};

type ShortcutErrorReason = 'session_failed' | 'clipboard_denied' | 'timeout' | 'shortcut_error' | 'network' | 'unknown';

const SHORTCUT_INSTALL_URL = 'https://www.icloud.com/shortcuts/d4993ae3c7ee4bf4aa966d724de2856b';
const SHORTCUT_RUN_URL = 'shortcuts://run-shortcut?name=CopeLimitInstaller&input=Clipboard';
const STEP_STORAGE_KEY = 'copelimit-onboarding-step';
const SETUP_MODE_STORAGE_KEY = 'copelimit-setup-mode';
const SHORTCUT_INSTALLED_STORAGE_KEY = 'copelimit-shortcut-installed';
const SHORTCUT_LAUNCHED_AT_KEY = 'copelimit-shortcut-launched-at';
const BOOTSTRAP_TOKEN_CACHE_MAX_AGE_MINUTES = 14;
const BOOTSTRAP_TOKEN_CACHE_MAX_AGE_MS = BOOTSTRAP_TOKEN_CACHE_MAX_AGE_MINUTES * 60 * 1000;
const SHORTCUT_WAIT_TIMEOUT_MS = 90 * 1000;
const SHORTCUT_SLOW_HINT_DELAY_MS = 15 * 1000;

const ALL_STEPS: readonly OnboardingStep[] = [
  'idle',
  'manual-setup',
  'requesting',
  'waiting',
  'error',
  'shortcut-prompt-install',
  'shortcut-ready',
  'shortcut-launching',
  'shortcut-waiting',
  'shortcut-success',
  'shortcut-error'
] as const;

function isOnboardingStep(value: string | null): value is OnboardingStep {
  return typeof value === 'string' && (ALL_STEPS as readonly string[]).includes(value);
}

function isShortcutStep(step: OnboardingStep): boolean {
  return step.startsWith('shortcut-');
}

function daysUntil(dateText: string): number {
  const target = new Date(dateText).getTime();
  const now = Date.now();
  return Math.max(0, Math.ceil((target - now) / 86_400_000));
}

function readStorageFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readSetupMode(): SetupMode {
  try {
    return window.localStorage.getItem(SETUP_MODE_STORAGE_KEY) === 'manual' ? 'manual' : 'fast';
  } catch {
    return 'fast';
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // non-fatal in private mode
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // non-fatal in private mode
  }
}

function clearSessionStorage(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // non-fatal in private mode
  }
}

function readSessionStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function buildScriptablePasteDialog(scriptFriendlyName: string, targetScriptName: string): ScriptablePasteDialog {
  return {
    title: `${scriptFriendlyName} has been copied.`,
    intro: 'Scriptable will open a blank script.',
    steps: [
      'Double tap inside the empty script.',
      'Choose Paste.',
      `Tap 'Untitled Script', rename it to ${targetScriptName}, then tap Done.`
    ],
    targetScriptName
  };
}

function shortcutErrorText(reason: ShortcutErrorReason, details: string | null): string {
  if (reason === 'session_failed') return 'Could not start setup. Please try again.';
  if (reason === 'clipboard_denied') return 'Clipboard access is required for Fast Setup. Tap “Set Up Widget →” again.';
  if (reason === 'timeout') return 'The Shortcut did not return in time. Confirm it is installed, then try again.';
  if (reason === 'network') return 'Network error during setup. Check your connection and try again.';
  if (reason === 'shortcut_error') return details ? `Setup failed (${details}).` : 'The Shortcut reported an error.';
  return 'Setup failed. Please try again or switch to manual setup.';
}

function cleanOnboardingQueryParams() {
  const params = new URLSearchParams(window.location.search);
  params.delete('onboarding');
  params.delete('shortcut');
  params.delete('reason');
  const nextQuery = params.toString();
  window.history.replaceState({}, '', nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname);
}

export function WidgetTokenSection({ isIos, isStandalone }: { isIos: boolean; isStandalone: boolean }) {
  const [result, setResult] = useState<WidgetTokenResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<WidgetTokenStatus | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('idle');
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingNotice, setOnboardingNotice] = useState<string | null>(null);
  const [onboardingSuccess, setOnboardingSuccess] = useState(false);
  const [scriptableDialog, setScriptableDialog] = useState<ScriptablePasteDialog | null>(null);
  const [setupMode, setSetupMode] = useState<SetupMode>(() => readSetupMode());
  const [shortcutInstalled, setShortcutInstalled] = useState<boolean>(() => readStorageFlag(SHORTCUT_INSTALLED_STORAGE_KEY));
  const [shortcutErrorReason, setShortcutErrorReason] = useState<ShortcutErrorReason | null>(null);
  const [shortcutErrorDetails, setShortcutErrorDetails] = useState<string | null>(null);
  const [shortcutPayload, setShortcutPayload] = useState<string | null>(null);
  const [shortcutPayloadFetchedAt, setShortcutPayloadFetchedAt] = useState<number | null>(null);
  const [shortcutPreparing, setShortcutPreparing] = useState(false);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');

  const openScriptableButtonRef = useRef<HTMLButtonElement | null>(null);
  const fastSetupActionRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasDialogOpenRef = useRef(false);
  const waitingTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const slowHintTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const storeOnboardingStep = useCallback((step: OnboardingStep) => {
    setOnboardingStep(step);
    writeSessionStorage(STEP_STORAGE_KEY, step);
  }, []);

  const clearShortcutTimers = useCallback(() => {
    if (waitingTimeoutRef.current) {
      window.clearTimeout(waitingTimeoutRef.current);
      waitingTimeoutRef.current = null;
    }
    if (slowHintTimeoutRef.current) {
      window.clearTimeout(slowHintTimeoutRef.current);
      slowHintTimeoutRef.current = null;
    }
  }, []);

  const setShortcutError = useCallback((reason: ShortcutErrorReason, details: string | null = null) => {
    setShortcutErrorReason(reason);
    setShortcutErrorDetails(details);
    setOnboardingSuccess(false);
    setOnboardingNotice(null);
    setOnboardingError(shortcutErrorText(reason, details));
    storeOnboardingStep('shortcut-error');
    setStatusAnnouncement('Fast setup failed.');
  }, [storeOnboardingStep]);

  const setSetupModeAndPersist = useCallback((mode: SetupMode) => {
    setSetupMode(mode);
    writeLocalStorage(SETUP_MODE_STORAGE_KEY, mode);
  }, []);

  const closeScriptableDialog = useCallback(() => {
    setScriptableDialog((current) => {
      if (current) {
        setOnboardingNotice(`Script copied. When ready, manually open Scriptable and create ${current.targetScriptName}.`);
      }
      return null;
    });
  }, []);

  const openScriptableForPasting = useCallback(() => {
    setScriptableDialog(null);
    window.location.href = 'scriptable:///add';
  }, []);

  const refreshStatus = useCallback(async () => {
    const response = await fetch('/api/widget-token', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    setStatus(await response.json() as WidgetTokenStatus);
  }, []);

  useEffect(() => {
    refreshStatus().catch(() => setStatus(null));
  }, [refreshStatus]);

  useEffect(() => {
    const saved = readSessionStorage(STEP_STORAGE_KEY);
    if (isOnboardingStep(saved)) {
      setOnboardingStep(saved);
    }
  }, []);

  useEffect(() => {
    const callback = parseOnboardingCallback(window.location.search);
    if (!callback.status) return;

    clearShortcutTimers();
    setShowSlowHint(false);

    if (callback.status === 'complete') {
      setOnboardingSuccess(true);
      setOnboardingError(null);
      setOnboardingNotice('Widget token installed in Scriptable. Add the Scriptable widget and select CopeLimit.');
      setShortcutErrorReason(null);
      setShortcutErrorDetails(null);
      setStatusAnnouncement('Fast setup complete.');
      if (callback.fromShortcut || isShortcutStep(onboardingStep) || setupMode === 'fast') {
        storeOnboardingStep('shortcut-success');
      } else {
        storeOnboardingStep('idle');
      }
      refreshStatus().catch(() => undefined);
    } else {
      if (callback.fromShortcut || isShortcutStep(onboardingStep) || setupMode === 'fast') {
        setShortcutError('shortcut_error', callback.reason);
      } else {
        setOnboardingSuccess(false);
        setOnboardingError(callback.reason ? `Setup failed (${callback.reason}).` : 'Setup failed. Please try again.');
        storeOnboardingStep('error');
      }
    }

    cleanOnboardingQueryParams();
  }, [clearShortcutTimers, onboardingStep, refreshStatus, setShortcutError, setupMode, storeOnboardingStep]);

  useEffect(() => {
    const isOpen = Boolean(scriptableDialog);
    if (isOpen && !wasDialogOpenRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.setTimeout(() => openScriptableButtonRef.current?.focus(), 0);
    }
    if (!isOpen && wasDialogOpenRef.current) {
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeScriptableDialog();
      }
    }

    let listenerAdded = false;
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
      listenerAdded = true;
    }

    wasDialogOpenRef.current = isOpen;

    return () => {
      if (listenerAdded) {
        window.removeEventListener('keydown', handleEscape);
      }
    };
  }, [scriptableDialog, closeScriptableDialog]);

  useEffect(() => () => clearShortcutTimers(), [clearShortcutTimers]);

  useEffect(() => {
    if (!isIos || !isStandalone) return;
    if (setupMode !== 'fast') return;
    if (onboardingStep !== 'idle') return;

    if (shortcutInstalled) {
      storeOnboardingStep('shortcut-ready');
    } else {
      storeOnboardingStep('shortcut-prompt-install');
    }
  }, [isIos, isStandalone, onboardingStep, setupMode, shortcutInstalled, storeOnboardingStep]);

  useEffect(() => {
    if (!isShortcutStep(onboardingStep)) return;
    window.setTimeout(() => fastSetupActionRef.current?.focus(), 0);
  }, [onboardingStep]);

  const requestOnboardingSession = useCallback(async (): Promise<OnboardingSessionResult> => {
    const response = await fetch('/api/onboarding/session', { method: 'POST', cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
    }
    return response.json() as Promise<OnboardingSessionResult>;
  }, []);

  const ensureShortcutPayload = useCallback(async (forceRefresh = false): Promise<string> => {
    const isPayloadFresh = shortcutPayload && shortcutPayloadFetchedAt && (Date.now() - shortcutPayloadFetchedAt) < BOOTSTRAP_TOKEN_CACHE_MAX_AGE_MS;
    if (!forceRefresh && isPayloadFresh) {
      return shortcutPayload;
    }

    setShortcutPreparing(true);
    try {
      const session = await requestOnboardingSession();
      const payload = buildShortcutPayload({
        origin: window.location.origin,
        bootstrapToken: session.bootstrapToken
      });
      setShortcutPayload(payload);
      setShortcutPayloadFetchedAt(Date.now());
      return payload;
    } finally {
      setShortcutPreparing(false);
    }
  }, [requestOnboardingSession, shortcutPayload, shortcutPayloadFetchedAt]);

  useEffect(() => {
    if (onboardingStep !== 'shortcut-ready') return;

    ensureShortcutPayload().catch((err) => {
      setShortcutPayload(null);
      setShortcutPayloadFetchedAt(null);
      setShortcutError('session_failed', err instanceof Error ? err.message : null);
    });
  }, [ensureShortcutPayload, onboardingStep, setShortcutError]);

  async function generate() {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/widget-token', { method: 'POST', cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
      }
      const generated = await response.json() as WidgetTokenResult;
      setResult(generated);
      setStatus({
        ttlDays: generated.ttlDays,
        hasActiveToken: true,
        expiresAt: generated.expiresAt
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }

  async function revoke() {
    setRevoking(true);
    setError(null);
    try {
      const response = await fetch('/api/widget-token', { method: 'DELETE', cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
      }
      setResult(null);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setRevoking(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed — user can still select and copy manually
    }
  }

  function scriptSourceUrl(scriptName: 'CopeLimitInstall.js' | 'CopeLimitWidget.js') {
    return `${window.location.origin}/scriptable/${scriptName}`;
  }

  async function copyScriptSource(scriptName: 'CopeLimitInstall.js' | 'CopeLimitWidget.js') {
    setOnboardingError(null);
    setSetupModeAndPersist('manual');
    try {
      const response = await fetch(scriptSourceUrl(scriptName));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      storeOnboardingStep('manual-setup');
      setOnboardingSuccess(false);
      const isWidgetScript = scriptName === 'CopeLimitWidget.js';
      const scriptLabels = isWidgetScript
        ? { modalName: 'The CopeLimit widget script', noticeName: 'Widget script', targetName: 'CopeLimit' }
        : { modalName: 'The token setup script', noticeName: 'Token setup script', targetName: 'CopeLimitInstall' };
      setOnboardingNotice(`${scriptLabels.noticeName} copied to clipboard.`);
      setScriptableDialog(buildScriptablePasteDialog(scriptLabels.modalName, scriptLabels.targetName));
      setStatusAnnouncement(`${scriptLabels.noticeName} copied.`);
    } catch (err) {
      if (err instanceof TypeError) {
        setOnboardingError('Failed to copy script: network error or script source unavailable.');
      } else if (err instanceof Error) {
        setOnboardingError(`Failed to copy script: ${err.message}`);
      } else {
        setOnboardingError('Failed to copy script.');
      }
    }
  }

  async function connectScriptableManually() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    setSetupModeAndPersist('manual');
    storeOnboardingStep('requesting');
    try {
      const session = await requestOnboardingSession();
      const runLink = `scriptable:///run?scriptName=CopeLimitInstall&bt=${encodeURIComponent(session.bootstrapToken)}`;
      window.location.href = runLink;
      storeOnboardingStep('waiting');
      setOnboardingNotice('Configuring token in Scriptable. You will be redirected back automatically.');
      setStatusAnnouncement('Manual setup started in Scriptable.');
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : 'Failed to start onboarding');
      storeOnboardingStep('error');
    }
  }

  function startShortcutWaiting() {
    clearShortcutTimers();
    setShowSlowHint(false);
    writeSessionStorage(SHORTCUT_LAUNCHED_AT_KEY, String(Date.now()));

    slowHintTimeoutRef.current = window.setTimeout(() => {
      setShowSlowHint(true);
    }, SHORTCUT_SLOW_HINT_DELAY_MS);

    waitingTimeoutRef.current = window.setTimeout(() => {
      setShortcutError('timeout');
      setShowSlowHint(false);
    }, SHORTCUT_WAIT_TIMEOUT_MS);
  }

  async function launchShortcut() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    storeOnboardingStep('shortcut-launching');

    try {
      const payload = await ensureShortcutPayload();
      try {
        await navigator.clipboard.writeText(payload);
      } catch {
        setShortcutError('clipboard_denied');
        return;
      }

      window.location.href = SHORTCUT_RUN_URL;
      storeOnboardingStep('shortcut-waiting');
      setOnboardingNotice('Setting up your widget. The Shortcut is running and should return you here automatically.');
      setStatusAnnouncement('Fast setup started. Waiting for Shortcut callback.');
      startShortcutWaiting();
    } catch (err) {
      if (err instanceof Error && /network|fetch|HTTP/i.test(err.message)) {
        setShortcutError('network', err.message);
        return;
      }
      setShortcutError('session_failed', err instanceof Error ? err.message : null);
    }
  }

  function chooseManualSetup() {
    clearShortcutTimers();
    setSetupModeAndPersist('manual');
    setOnboardingError(null);
    setOnboardingNotice('Manual setup enabled. Follow the steps below.');
    setOnboardingSuccess(false);
    storeOnboardingStep('manual-setup');
    setStatusAnnouncement('Manual setup selected.');
  }

  function chooseFastSetup() {
    setSetupModeAndPersist('fast');
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    if (shortcutInstalled) {
      storeOnboardingStep('shortcut-ready');
    } else {
      storeOnboardingStep('shortcut-prompt-install');
    }
    setStatusAnnouncement('Fast setup selected.');
  }

  function markShortcutInstalled() {
    writeLocalStorage(SHORTCUT_INSTALLED_STORAGE_KEY, '1');
    setShortcutInstalled(true);
    setSetupModeAndPersist('fast');
    storeOnboardingStep('shortcut-ready');
    setStatusAnnouncement('Shortcut marked as installed.');
  }

  function openShortcutInstallPage() {
    setOnboardingNotice('Install the Shortcut, then return here and tap “I have installed it”.');
  }

  function resetOnboarding() {
    clearShortcutTimers();
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    setScriptableDialog(null);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    setShowSlowHint(false);
    clearSessionStorage(SHORTCUT_LAUNCHED_AT_KEY);
    storeOnboardingStep('idle');
  }

  return (
    <section className="card widgetTokenCard">
      <span className="label">iOS Widget Token</span>
      <p>
        Generate a personal token to use with the Scriptable iOS widget. The token is tied
        to your GitHub session and expires after {result?.ttlDays ?? status?.ttlDays ?? '…'} days.
      </p>
      {status?.hasActiveToken && !result && (
        <p className="widgetTokenMeta">
          You already have an active token
          {status.expiresAt ? ` (expires ${new Date(status.expiresAt).toLocaleDateString()})` : ''}.
          {' '}
          The token value is not stored client-side and cannot be shown again. Generate a new token to rotate it.
        </p>
      )}
      {error && <p className="widgetTokenError">{error}</p>}
      {statusAnnouncement && <p className="srOnly" role="status" aria-live="polite">{statusAnnouncement}</p>}

      {isIos && (
        <div className="widgetOnboarding">
          <span className="label">iPhone Widget Setup</span>
          {!isStandalone ? (
            <p className="widgetTokenMeta">
              Install CopeLimit to your Home Screen first, then open it as an app to set up the iPhone widget.
            </p>
          ) : (
            <>
              {setupMode === 'fast' && (
                <div className="setupModeCard">
                  <strong>⚡ Fast Setup (recommended)</strong>
                  <p className="widgetTokenMeta">
                    Set up your widget in under a minute using the CopeLimitInstaller Shortcut.
                  </p>

                  {onboardingStep === 'shortcut-prompt-install' && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenMeta"><strong>Step 1 of 2</strong> — Install the Shortcut.</p>
                      <div className="widgetTokenActions">
                        <a
                          className="actionLinkButton"
                          href={SHORTCUT_INSTALL_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={openShortcutInstallPage}
                          aria-label="Install CopeLimitInstaller Shortcut (opens in new tab)"
                        >
                          Install CopeLimitInstaller Shortcut ↗
                        </a>
                        <button type="button" ref={fastSetupActionRef} onClick={markShortcutInstalled}>
                          I&apos;ve installed the Shortcut →
                        </button>
                      </div>
                    </div>
                  )}

                  {onboardingStep === 'shortcut-ready' && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenMeta"><strong>Step 2 of 2</strong> — Configure widget.</p>
                      <div className="widgetTokenActions">
                        <button
                          type="button"
                          ref={fastSetupActionRef}
                          onClick={() => { void launchShortcut(); }}
                          disabled={shortcutPreparing}
                          aria-disabled={shortcutPreparing}
                        >
                          {shortcutPreparing ? 'Preparing setup…' : 'Set Up Widget →'}
                        </button>
                        <button type="button" className="secondaryButton" onClick={() => storeOnboardingStep('shortcut-prompt-install')}>
                          Not installed yet?
                        </button>
                      </div>
                    </div>
                  )}

                  {(onboardingStep === 'shortcut-launching' || onboardingStep === 'shortcut-waiting') && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenMeta"><strong>Setting up your widget…</strong></p>
                      <p className="widgetTokenMeta">The Shortcut is running. You&apos;ll be redirected back when it&apos;s done.</p>
                      {showSlowHint && <p className="widgetTokenMeta">Taking too long? You can try again or switch to manual setup.</p>}
                      <div className="widgetTokenActions">
                        {showSlowHint && (
                          <>
                            <button type="button" onClick={chooseFastSetup}>Try again</button>
                            <button type="button" className="secondaryButton" onClick={chooseManualSetup}>Set up manually</button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {onboardingStep === 'shortcut-success' && onboardingSuccess && onboardingNotice && (
                    <p className="widgetOnboardingSuccess">✓ {onboardingNotice}</p>
                  )}

                  {onboardingStep === 'shortcut-error' && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenError">{shortcutErrorText(shortcutErrorReason ?? 'unknown', shortcutErrorDetails)}</p>
                      <div className="widgetTokenActions">
                        <button type="button" ref={fastSetupActionRef} onClick={chooseFastSetup}>Try again</button>
                        <button type="button" className="secondaryButton" onClick={chooseManualSetup}>Set up manually</button>
                      </div>
                    </div>
                  )}

                  <div className="setupChoiceDivider" aria-hidden="true">or</div>
                  <button type="button" className="secondaryButton" onClick={chooseManualSetup}>Manual Setup (fallback)</button>
                </div>
              )}

              {setupMode === 'manual' && (
                <>
                  <div className="setupModeCard">
                    <strong>Manual Setup (fallback)</strong>
                    <p className="widgetTokenMeta">Use this if Fast Setup fails or if you prefer advanced Scriptable setup.</p>
                    <button type="button" className="secondaryButton" onClick={chooseFastSetup}>Back to Fast Setup</button>
                  </div>

                  <ol className="widgetOnboardingSteps">
                    <li>
                      Copy widget script, paste in Scriptable, rename to <strong>CopeLimit</strong>, and save.
                    </li>
                    <li>
                      Copy token setup script, paste in Scriptable, rename to <strong>CopeLimitInstall</strong>, and save.
                    </li>
                    <li>Run token configuration.</li>
                  </ol>

                  {onboardingSuccess && <p className="widgetOnboardingSuccess">{onboardingNotice}</p>}
                  {onboardingError && <p className="widgetTokenError">{onboardingError}</p>}
                  {!onboardingSuccess && onboardingNotice && <p className="widgetTokenMeta">{onboardingNotice}</p>}

                  <div className="widgetTokenActions">
                    <button type="button" onClick={() => { void copyScriptSource('CopeLimitWidget.js'); }}>
                      Copy widget script
                    </button>
                    <button type="button" onClick={() => { void copyScriptSource('CopeLimitInstall.js'); }}>
                      Copy token setup script
                    </button>
                    <button type="button" onClick={() => { void connectScriptableManually(); }} disabled={onboardingStep === 'requesting'}>
                      {onboardingStep === 'requesting' ? 'Connecting…' : 'Configure token in Scriptable'}
                    </button>
                    <button type="button" onClick={resetOnboarding}>
                      Reset
                    </button>
                  </div>

                  <p className="widgetTokenMeta">
                    Automatic token handoff requires CopeLimitInstall to be created first using the options above. Final iOS home screen
                    widget creation and script assignment remain manual.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}

      {result ? (
        <div className="widgetTokenResult">
          <div className="tokenDisplay">
            <code className="tokenValue">{result.token}</code>
            <button type="button" className="copyButton" onClick={copy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="widgetTokenMeta">
            Expires {new Date(result.expiresAt).toLocaleDateString()} ({daysUntil(result.expiresAt)} days).
            This token is shown only once. Save it now in your widget configuration.
          </p>
          <div className="widgetTokenActions">
            <button type="button" onClick={generate} disabled={generating}>
              Regenerate
            </button>
            <button type="button" onClick={revoke} disabled={revoking}>
              {revoking ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        </div>
      ) : (
        <div className="widgetTokenActions">
          <button type="button" onClick={generate} disabled={generating}>
            {generating ? 'Generating…' : status?.hasActiveToken ? 'Regenerate widget token' : 'Generate widget token'}
          </button>
          {status?.hasActiveToken && (
            <button type="button" onClick={revoke} disabled={revoking}>
              {revoking ? 'Revoking…' : 'Revoke token'}
            </button>
          )}
        </div>
      )}

      {scriptableDialog && (
        <div className="modalOverlay">
          <div
            className="modalCard"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scriptable-dialog-title"
            aria-describedby="scriptable-dialog-description"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="scriptable-dialog-title">{scriptableDialog.title}</h2>
            <p id="scriptable-dialog-description">{scriptableDialog.intro}</p>
            <ol className="scriptableDialogSteps">
              {scriptableDialog.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="widgetTokenActions">
              <button type="button" className="secondaryButton" onClick={closeScriptableDialog}>
                Cancel
              </button>
              <button type="button" ref={openScriptableButtonRef} onClick={openScriptableForPasting}>
                Open Scriptable
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
