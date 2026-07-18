/**
 * @file Widget Token Section React component.
 *
 * Renders the "iOS Widget Token" card visible to authenticated users. This
 * component handles the complete widget token lifecycle:
 *
 * - Displays the current token status (active / inactive, expiry date).
 * - Issues a new token via `POST /api/widget-token` (replaces any existing one).
 * - Revokes the token via `DELETE /api/widget-token`.
 * - Copies the raw token to the clipboard (shown exactly once after generation).
 *
 * ## iOS Widget onboarding
 *
 * When the user is on iOS and has installed the PWA as a standalone app, the
 * component also drives the full widget onboarding flow (see
 * {@link widget-onboarding} for the state machine types and logic):
 *
 * ### Fast Setup
 * Uses the iOS Shortcuts app to install/update Scriptable scripts, then prompts
 * the user to explicitly run token configuration in Scriptable.
 * Requires the `CopeLimitInstaller` Shortcut to be installed on the device.
 *
 * ### Manual Setup
 * Guides the user to copy `CopeLimitWidget.js` and `CopeLimitInstall.js`
 * into Scriptable manually, then run the installer via a deep link.
 *
 * ## State persistence
 * Onboarding state is persisted across page reloads via `sessionStorage`
 * (step) and `localStorage` (mode, installed flag, recovery state) so that
 * the flow survives the round-trip through the Shortcuts app.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildShortcutPayload,
  deriveOnboardingPhase,
  getFastSetupProgress,
  OnboardingStep,
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

type SetupMode = 'fast' | 'manual';

type OnboardingSessionResult = {
  bootstrapToken: string;
  expiresAt: string;
  ttlSeconds: number;
  onboardingSessionId?: string;
};

type ScriptablePasteDialog = {
  title: string;
  intro: string;
  steps: string[];
  targetScriptName: string;
};

type ShortcutErrorReason = 'session_failed' | 'clipboard_denied' | 'timeout' | 'shortcut_error' | 'network' | 'unknown';

type PendingShortcutState = {
  phase: 'AWAITING_RETURN';
  origin: string;
  launchedAt: number;
};

const SHORTCUT_INSTALL_URL = 'https://www.icloud.com/shortcuts/d4993ae3c7ee4bf4aa966d724de2856b';
const SHORTCUT_RUN_URL = 'shortcuts://run-shortcut?name=CopeLimitInstaller&input=Clipboard';
const STEP_STORAGE_KEY = 'copelimit-onboarding-step';
const SETUP_MODE_STORAGE_KEY = 'copelimit-setup-mode';
const SHORTCUT_INSTALLED_STORAGE_KEY = 'copelimit-shortcut-installed';
const SHORTCUT_LAUNCHED_AT_KEY = 'copelimit-shortcut-launched-at';
const ONBOARDING_PHASE_STORAGE_KEY = 'copelimit-onboarding-phase';
const SHORTCUT_PAYLOAD_ORIGIN_KEY = 'copelimit-shortcut-origin';
const SHORTCUT_PENDING_STATE_KEY = 'copelimit-shortcut-pending-state';
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
  'shortcut-awaiting-token-config',
  'shortcut-token-requesting',
  'shortcut-token-waiting',
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

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clearLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
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

function readPendingShortcutState(): PendingShortcutState | null {
  const raw = readLocalStorage(SHORTCUT_PENDING_STATE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PendingShortcutState>;
    if (
      parsed.phase === 'AWAITING_RETURN'
      && typeof parsed.origin === 'string'
      && typeof parsed.launchedAt === 'number'
      && Number.isFinite(parsed.launchedAt)
    ) {
      return {
        phase: parsed.phase,
        origin: parsed.origin,
        launchedAt: parsed.launchedAt
      };
    }
  } catch {
    // non-fatal
  }

  return null;
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
  const [verifyingSetup, setVerifyingSetup] = useState(false);
  const [scriptableDialog, setScriptableDialog] = useState<ScriptablePasteDialog | null>(null);
  const [setupMode, setSetupMode] = useState<SetupMode>(() => readSetupMode());
  const [shortcutInstalled, setShortcutInstalled] = useState<boolean>(() => readStorageFlag(SHORTCUT_INSTALLED_STORAGE_KEY));
  const [shortcutErrorReason, setShortcutErrorReason] = useState<ShortcutErrorReason | null>(null);
  const [shortcutErrorDetails, setShortcutErrorDetails] = useState<string | null>(null);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [desiredRefreshMinutes, setDesiredRefreshMinutes] = useState<number | null>(null);
  const [savingCadence, setSavingCadence] = useState(false);
  const [cadenceSaveError, setCadenceSaveError] = useState<string | null>(null);
  const hasActiveToken = Boolean(status?.hasActiveToken);
  const onboardingPhase = deriveOnboardingPhase(onboardingStep, hasActiveToken, verifyingSetup);
  const isSetupComplete = onboardingPhase === 'SETUP_COMPLETE';
  const fastSetupProgress = getFastSetupProgress(onboardingStep, shortcutInstalled, hasActiveToken);
  const scriptsStateClass = fastSetupProgress.scriptsInstalled ? 'stateDone' : (onboardingPhase === 'AWAITING_RETURN' ? 'stateInProgress' : 'statePending');
  const tokenConfigurationInProgress = ['AWAITING_RETURN', 'AWAITING_TOKEN_CONFIGURATION', 'VERIFYING_SETUP'].includes(onboardingPhase);
  const tokenStateClass = fastSetupProgress.tokenConfigured
    ? 'stateDone'
    : (tokenConfigurationInProgress ? 'stateInProgress' : 'statePending');

  const openScriptableButtonRef = useRef<HTMLButtonElement | null>(null);
  const fastSetupActionRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasDialogOpenRef = useRef(false);
  const waitingTimeoutRef = useRef<number | null>(null);
  const slowHintTimeoutRef = useRef<number | null>(null);

  const storeOnboardingStep = useCallback((step: OnboardingStep) => {
    setOnboardingStep(step);
    writeSessionStorage(STEP_STORAGE_KEY, step);
  }, []);

  const clearFastSetupRecoveryState = useCallback(() => {
    clearSessionStorage(SHORTCUT_LAUNCHED_AT_KEY);
    clearLocalStorage(ONBOARDING_PHASE_STORAGE_KEY);
    clearLocalStorage(SHORTCUT_PAYLOAD_ORIGIN_KEY);
    clearLocalStorage(SHORTCUT_PENDING_STATE_KEY);
  }, []);

  const markAwaitingReturnRecoveryState = useCallback(() => {
    const launchedAt = Date.now();
    writeSessionStorage(SHORTCUT_LAUNCHED_AT_KEY, String(launchedAt));
    writeLocalStorage(ONBOARDING_PHASE_STORAGE_KEY, 'AWAITING_RETURN');
    writeLocalStorage(SHORTCUT_PAYLOAD_ORIGIN_KEY, window.location.origin);
    writeLocalStorage(SHORTCUT_PENDING_STATE_KEY, JSON.stringify({
      phase: 'AWAITING_RETURN',
      origin: window.location.origin,
      launchedAt
    } satisfies PendingShortcutState));
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
    clearFastSetupRecoveryState();
    setShortcutErrorReason(reason);
    setShortcutErrorDetails(details);
    setOnboardingNotice(null);
    setOnboardingError(shortcutErrorText(reason, details));
    storeOnboardingStep('shortcut-error');
    setStatusAnnouncement('Fast setup failed.');
  }, [clearFastSetupRecoveryState, storeOnboardingStep]);

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

  const refreshStatus = useCallback(async (): Promise<WidgetTokenStatus | null> => {
    const response = await fetch('/api/widget-token', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const nextStatus = await response.json() as WidgetTokenStatus;
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  useEffect(() => {
    refreshStatus().catch(() => setStatus(null));
  }, [refreshStatus]);

  useEffect(() => {
    const saved = readSessionStorage(STEP_STORAGE_KEY);
    if (isOnboardingStep(saved)) {
      setOnboardingStep(saved);
    }
    const savedPhase = readLocalStorage(ONBOARDING_PHASE_STORAGE_KEY);
    const savedOrigin = readLocalStorage(SHORTCUT_PAYLOAD_ORIGIN_KEY);
    const pendingState = readPendingShortcutState();
    const launchedAtRaw = readSessionStorage(SHORTCUT_LAUNCHED_AT_KEY);
    const sessionLaunchedAt = launchedAtRaw ? Number(launchedAtRaw) : NaN;
    const launchedAt = Number.isFinite(sessionLaunchedAt) ? sessionLaunchedAt : pendingState?.launchedAt ?? NaN;
    if (savedPhase !== 'AWAITING_RETURN' || Number.isNaN(launchedAt)) return;
    const expectedOrigin = pendingState?.origin ?? savedOrigin;
    if (expectedOrigin && expectedOrigin !== window.location.origin) {
      clearFastSetupRecoveryState();
      return;
    }

    const elapsed = Date.now() - launchedAt;
    if (elapsed >= SHORTCUT_WAIT_TIMEOUT_MS) {
      clearFastSetupRecoveryState();
      setShortcutError('timeout');
      return;
    }

    storeOnboardingStep('shortcut-waiting');
    const remaining = SHORTCUT_WAIT_TIMEOUT_MS - elapsed;
    startShortcutWaiting(remaining);
  }, [clearFastSetupRecoveryState, setShortcutError, storeOnboardingStep]);

  useEffect(() => {
    if (!isSetupComplete) return;
    clearFastSetupRecoveryState();
  }, [clearFastSetupRecoveryState, isSetupComplete]);

  const setTokenConfigurationFailureState = useCallback((message: string) => {
    setOnboardingError(message);
    if (setupMode === 'fast') {
      setOnboardingNotice(null);
      setShortcutErrorReason(null);
      setShortcutErrorDetails(null);
      storeOnboardingStep('shortcut-awaiting-token-config');
    } else {
      storeOnboardingStep('error');
    }
  }, [setupMode, storeOnboardingStep]);

  useEffect(() => {
    const callback = parseOnboardingCallback(window.location.search);
    if (!callback.status) return;
    const inFastFlow = callback.fromShortcut || isShortcutStep(onboardingStep) || setupMode === 'fast';
    cleanOnboardingQueryParams();
    clearShortcutTimers();
    setShowSlowHint(false);

    if (callback.status === 'error') {
      if (callback.fromShortcut && inFastFlow) {
        clearFastSetupRecoveryState();
        setShortcutError('shortcut_error', callback.reason);
      } else {
        setTokenConfigurationFailureState(callback.reason ? `Setup failed (${callback.reason}).` : 'Setup failed. Please try again.');
      }
      return;
    }

    if (callback.fromShortcut && inFastFlow) {
      clearFastSetupRecoveryState();
      setOnboardingError(null);
      setShortcutErrorReason(null);
      setShortcutErrorDetails(null);
      setOnboardingNotice('Scripts installed (or assumed). Next, configure your token in Scriptable.');
      setStatusAnnouncement('Shortcut finished. Configure token in Scriptable.');
      storeOnboardingStep('shortcut-awaiting-token-config');
      return;
    }

    setOnboardingError(null);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    setOnboardingNotice('Checking setup…');
    setStatusAnnouncement('Checking setup…');
    refreshStatus()
      .then((latest) => {
        if (latest?.hasActiveToken) {
          setOnboardingNotice('Widget token installed in Scriptable.');
          if (setupMode === 'fast') {
            storeOnboardingStep('shortcut-success');
            setStatusAnnouncement('Fast setup complete.');
          } else {
            storeOnboardingStep('idle');
          }
          return;
        }
        setTokenConfigurationFailureState('Setup returned, but token configuration could not be confirmed yet. Please try again.');
      })
      .catch(() => {
        setTokenConfigurationFailureState('Setup returned, but token configuration could not be confirmed yet. Please try again.');
      });
  }, [clearFastSetupRecoveryState, clearShortcutTimers, onboardingStep, refreshStatus, setShortcutError, setTokenConfigurationFailureState, storeOnboardingStep]);

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

  // On iOS the shortcut callback URL and the Scriptable callback URL are both
  // opened by Safari (not the standalone PWA). The standalone PWA therefore
  // never receives the ?shortcut=complete / ?onboarding=complete query params.
  //
  // To handle this we listen for the PWA regaining the foreground:
  //   • shortcut-waiting          → assume scripts installed; advance to token-config
  //   • shortcut-token-waiting /  → poll token status; advance on success
  //     waiting (manual)
  useEffect(() => {
    if (
      onboardingStep !== 'shortcut-waiting'
      && onboardingStep !== 'shortcut-token-waiting'
      && onboardingStep !== 'waiting'
    ) return;

    let cancelled = false;

    function handleVisible() {
      if (document.visibilityState !== 'visible') return;

      if (onboardingStep === 'shortcut-waiting') {
        // Shortcut completed (or user returned before it did). Assume scripts
        // are installed and proceed to token configuration.
        clearShortcutTimers();
        clearFastSetupRecoveryState();
        setShowSlowHint(false);
        setOnboardingError(null);
        setShortcutErrorReason(null);
        setShortcutErrorDetails(null);
        setOnboardingNotice('Scripts installed (or assumed). Next, configure your token in Scriptable.');
        setStatusAnnouncement('Shortcut finished. Configure token in Scriptable.');
        storeOnboardingStep('shortcut-awaiting-token-config');
        return;
      }

      // shortcut-token-waiting / waiting: Scriptable token exchange may have
      // completed – check whether the token is now active.
      const capturedStep = onboardingStep;
      setOnboardingNotice('Checking setup…');
      setStatusAnnouncement('Checking setup…');
      void refreshStatus()
        .then((latest) => {
          if (cancelled) return;
          if (latest?.hasActiveToken) {
            setOnboardingNotice('Widget token installed in Scriptable.');
            if (capturedStep === 'shortcut-token-waiting') {
              storeOnboardingStep('shortcut-success');
              setStatusAnnouncement('Fast setup complete.');
            } else {
              storeOnboardingStep('idle');
            }
          } else {
            setTokenConfigurationFailureState('Token configuration could not be confirmed yet. Please try again.');
          }
        })
        .catch(() => {
          if (cancelled) return;
          setTokenConfigurationFailureState('Network error checking token status. Please try again.');
        });
    }

    // pageshow fires when a page is restored from the bfcache (persisted: true).
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) handleVisible();
    }

    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [
    onboardingStep,
    clearFastSetupRecoveryState,
    clearShortcutTimers,
    refreshStatus,
    setTokenConfigurationFailureState,
    storeOnboardingStep
  ]);

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

  // Load the user's saved widget refresh cadence preference on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/widget-settings', { cache: 'no-store' });
        if (!cancelled && response.ok) {
          const body = await response.json() as { desiredRefreshMinutes: number | null };
          setDesiredRefreshMinutes(body.desiredRefreshMinutes ?? null);
        }
      } catch (err) {
        // Non-fatal: settings default to null (manual) when unavailable.
        console.error('[widget-settings] Failed to load refresh cadence preference:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const requestOnboardingSession = useCallback(async (): Promise<OnboardingSessionResult> => {
    const response = await fetch('/api/onboarding/session', { method: 'POST', cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
    }
    return response.json() as Promise<OnboardingSessionResult>;
  }, []);

  const createShortcutPayload = useCallback(() => buildShortcutPayload({
    origin: window.location.origin
  }), []);

  async function handleCadenceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value;
    // The select only emits known values ('manual' or one of the valid cadences).
    // Server-side parseWidgetRefreshCadence validates on PATCH; no need to
    // duplicate that logic here.
    const newCadence = raw === 'manual' ? null : Number(raw);
    setDesiredRefreshMinutes(newCadence as number | null);
    setSavingCadence(true);
    setCadenceSaveError(null);
    try {
      const response = await fetch('/api/widget-settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ desiredRefreshMinutes: newCadence }),
        cache: 'no-store'
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
      }
    } catch (err) {
      setCadenceSaveError(err instanceof Error ? err.message : 'Failed to save preference');
    } finally {
      setSavingCadence(false);
    }
  }

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

  async function launchScriptableTokenSetup(targetMode: SetupMode) {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setSetupModeAndPersist(targetMode);
    storeOnboardingStep(targetMode === 'fast' ? 'shortcut-token-requesting' : 'requesting');
    try {
      const session = await requestOnboardingSession();
      const runLink = `scriptable:///run?scriptName=CopeLimitInstall&bt=${encodeURIComponent(session.bootstrapToken)}`;
      window.location.href = runLink;
      storeOnboardingStep(targetMode === 'fast' ? 'shortcut-token-waiting' : 'waiting');
      setOnboardingNotice('Configuring token in Scriptable. You will be redirected back automatically.');
      setStatusAnnouncement(targetMode === 'fast' ? 'Fast setup token configuration started in Scriptable.' : 'Manual setup started in Scriptable.');
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : 'Failed to start onboarding');
      storeOnboardingStep(targetMode === 'fast' ? 'shortcut-awaiting-token-config' : 'error');
    }
  }

  function startShortcutWaiting(timeoutMs = SHORTCUT_WAIT_TIMEOUT_MS) {
    clearShortcutTimers();
    setShowSlowHint(false);
    const slowHintDelay = Math.min(SHORTCUT_SLOW_HINT_DELAY_MS, timeoutMs);
    slowHintTimeoutRef.current = window.setTimeout(() => {
      setShowSlowHint(true);
    }, slowHintDelay);

    waitingTimeoutRef.current = window.setTimeout(() => {
      setShortcutError('timeout');
      setShowSlowHint(false);
    }, timeoutMs);
  }

  async function launchShortcut() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setVerifyingSetup(false);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    storeOnboardingStep('shortcut-launching');

    try {
      const payload = createShortcutPayload();
      try {
        await navigator.clipboard.writeText(payload);
      } catch {
        setShortcutError('clipboard_denied');
        return;
      }

      storeOnboardingStep('shortcut-waiting');
      markAwaitingReturnRecoveryState();
      setOnboardingNotice('Switch to Shortcuts to complete setup. Return here after Shortcuts finishes.');
      setStatusAnnouncement('Fast setup started. Waiting for Shortcut callback.');
      startShortcutWaiting();
      window.location.href = SHORTCUT_RUN_URL;
    } catch (err) {
      setShortcutError('session_failed', err instanceof Error ? err.message : null);
    }
  }

  function chooseManualSetup() {
    clearShortcutTimers();
    setSetupModeAndPersist('manual');
    setOnboardingError(null);
    setOnboardingNotice('Manual setup enabled. Follow the steps below.');
    setVerifyingSetup(false);
    clearFastSetupRecoveryState();
    storeOnboardingStep('manual-setup');
    setStatusAnnouncement('Manual setup selected.');
  }

  function chooseFastSetup() {
    setSetupModeAndPersist('fast');
    setOnboardingError(null);
    setOnboardingNotice(null);
    setVerifyingSetup(false);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    clearFastSetupRecoveryState();
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
    setVerifyingSetup(false);
    setScriptableDialog(null);
    setShortcutErrorReason(null);
    setShortcutErrorDetails(null);
    setShowSlowHint(false);
    clearFastSetupRecoveryState();
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
                  <ul className="onboardingStateList" aria-label="Fast setup status">
                    <li className={fastSetupProgress.shortcutInstalled ? 'stateDone' : 'statePending'}>
                      <span className="stateDot" aria-hidden="true">{fastSetupProgress.shortcutInstalled ? '✓' : '•'}</span>
                      <span>Shortcut installed</span>
                    </li>
                    <li className={scriptsStateClass}>
                      <span className="stateDot" aria-hidden="true">{fastSetupProgress.scriptsInstalled ? '✓' : (scriptsStateClass === 'stateInProgress' ? '…' : '•')}</span>
                      <span>Scripts installed (or assumed)</span>
                    </li>
                    <li className={tokenStateClass}>
                      <span className="stateDot" aria-hidden="true">{fastSetupProgress.tokenConfigured ? '✓' : (tokenStateClass === 'stateInProgress' ? '…' : '•')}</span>
                      <span>Token configured (confirmed)</span>
                    </li>
                    <li className={fastSetupProgress.widgetReady ? 'stateDone' : 'statePending'}>
                      <span className="stateDot" aria-hidden="true">{fastSetupProgress.widgetReady ? '✓' : '•'}</span>
                      <span>Widget ready (final manual step)</span>
                    </li>
                  </ul>

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
                        <p className="widgetTokenMeta"><strong>Step 2 of 3</strong> — Install/update scripts.</p>
                        <div className="widgetTokenActions">
                        <button
                          type="button"
                          ref={fastSetupActionRef}
                          onClick={() => { void launchShortcut(); }}
                        >
                          Set Up Widget →
                        </button>
                        <button type="button" className="secondaryButton" onClick={() => storeOnboardingStep('shortcut-prompt-install')}>
                          Not installed yet?
                        </button>
                      </div>
                    </div>
                  )}

                  {(onboardingStep === 'shortcut-launching' || onboardingStep === 'shortcut-waiting') && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenMeta"><strong>Installing scripts via Shortcut…</strong></p>
                      <p className="widgetTokenMeta">Switch to Shortcuts to complete setup. Return here after Shortcuts finishes.</p>
                      {showSlowHint && <p className="widgetTokenMeta">Taking too long? The Shortcut may still be running in the background.</p>}
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

                  {(onboardingStep === 'shortcut-awaiting-token-config'
                    || onboardingStep === 'shortcut-token-requesting'
                    || onboardingStep === 'shortcut-token-waiting') && (
                    <div className="shortcutStateBlock">
                      <p className="widgetTokenMeta"><strong>Final step</strong> — Configure token in Scriptable.</p>
                      <p className="widgetTokenMeta">
                        The Shortcut installed the scripts. Now run <strong>CopeLimitInstall</strong> to store your widget token.
                      </p>
                      <div className="widgetTokenActions">
                        <button
                          type="button"
                          ref={fastSetupActionRef}
                          onClick={() => { void launchScriptableTokenSetup('fast'); }}
                          disabled={onboardingStep === 'shortcut-token-requesting'}
                        >
                          {onboardingStep === 'shortcut-token-requesting' ? 'Connecting…' : 'Configure token in Scriptable'}
                        </button>
                        <button type="button" className="secondaryButton" onClick={chooseFastSetup}>
                          Back
                        </button>
                      </div>
                      {onboardingStep === 'shortcut-token-waiting' && (
                        <p className="widgetTokenMeta">Scriptable opened. Complete token setup, then return here.</p>
                      )}
                    </div>
                  )}

                  {isSetupComplete && (
                    <div className="shortcutStateBlock finalReadyPanel">
                      <p className="widgetOnboardingSuccess">✅ Widget setup complete.</p>
                      <p className="widgetTokenMeta">
                        Scripts are installed and your token is configured. One last step remains and iOS requires this to be manual.
                      </p>
                      <ul className="widgetOnboardingSteps compact">
                        <li><strong>Long-press Home Screen, tap +, and search Scriptable</strong></li>
                        <li><strong>Add a Scriptable widget</strong></li>
                        <li><strong>Open widget settings and choose CopeLimit as the script</strong></li>
                        <li>Your widget should show live quota after its next refresh</li>
                      </ul>
                      <p className="widgetTokenMeta">
                        iOS does not allow web apps or shortcuts to place Home Screen widgets automatically.
                      </p>
                      {onboardingNotice && <p className="widgetTokenMeta">{onboardingNotice}</p>}
                    </div>
                  )}

                  {onboardingPhase === 'SETUP_PARTIAL' && (
                    <div className="shortcutStateBlock stateWarning">
                      <p className="widgetTokenMeta"><strong>⚠️ Setup may be incomplete.</strong></p>
                      <p className="widgetTokenMeta">
                        The Shortcut returned, but we could not confirm your token was saved yet. This can happen if Scriptable did not run or was interrupted.
                      </p>
                      <div className="widgetTokenActions">
                        <button type="button" ref={fastSetupActionRef} onClick={chooseFastSetup}>Try again</button>
                        <button type="button" className="secondaryButton" onClick={chooseManualSetup}>Set up manually</button>
                      </div>
                    </div>
                  )}

                  {onboardingPhase === 'SETUP_FAILED' && (
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

                  {setupMode === 'manual' && onboardingStep === 'idle' && !onboardingError && hasActiveToken && onboardingNotice && (
                    <p className="widgetOnboardingSuccess">{onboardingNotice}</p>
                  )}
                  {onboardingError && <p className="widgetTokenError">{onboardingError}</p>}
                  {!(setupMode === 'manual' && onboardingStep === 'idle' && !onboardingError && hasActiveToken && onboardingNotice) && onboardingNotice && (
                    <p className="widgetTokenMeta">{onboardingNotice}</p>
                  )}

                  <div className="widgetTokenActions">
                    <button type="button" onClick={() => { void copyScriptSource('CopeLimitWidget.js'); }}>
                      Copy widget script
                    </button>
                    <button type="button" onClick={() => { void copyScriptSource('CopeLimitInstall.js'); }}>
                      Copy token setup script
                    </button>
                    <button
                      type="button"
                      onClick={() => { void launchScriptableTokenSetup('manual'); }}
                      disabled={onboardingStep === 'requesting'}
                    >
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

      <div className="widgetRefreshSettings">
        <h3>Desired widget refresh</h3>
        <p>
          Set how often you'd like the widget to try refreshing. iOS controls actual
          refresh timing and may delay, coalesce, or throttle updates — this is a
          hint, not a guaranteed interval.
        </p>
        <div className="widgetRefreshRow">
          <label htmlFor="widgetRefreshCadence">Refresh cadence</label>
          <select
            id="widgetRefreshCadence"
            value={desiredRefreshMinutes === null ? 'manual' : String(desiredRefreshMinutes)}
            onChange={handleCadenceChange}
            disabled={savingCadence}
          >
            <option value="manual">Manual / let iOS decide</option>
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="120">Every 2 hours</option>
            <option value="240">Every 4 hours</option>
          </select>
          {savingCadence && <span aria-live="polite">Saving…</span>}
          {cadenceSaveError && (
            <span className="errorText" aria-live="polite">{cadenceSaveError}</span>
          )}
        </div>
      </div>

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
              {scriptableDialog.steps.map((step, index) => (
                <li key={index}>{step}</li>
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
