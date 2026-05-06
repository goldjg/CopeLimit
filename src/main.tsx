import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Usage = {
  mode: 'premium_requests' | 'ai_credits';
  used: number;
  quota: number;
  remaining: number;
  percentUsed: number;
  resetAt: string;
  billingEntity: string;
  source: string;
  warningLevel: 'normal' | 'warm' | 'hot' | 'over';
  updatedAt: string;
  notes: string[];
};

type User = {
  authenticated: boolean;
  login?: string;
  avatar_url?: string;
};

type WidgetTokenResult = {
  token: string;
  expiresAt: string;
  ttlDays: number;
  login: string;
  replacedExisting: boolean;
};

type WidgetTokenStatus = {
  ttlDays: number;
  hasActiveToken: boolean;
  expiresAt?: string;
};

type OnboardingStep =
  | 'idle'
  | 'checking'
  | 'scriptable-missing'
  | 'ready'
  | 'manual-setup'
  | 'requesting'
  | 'linking'
  | 'waiting'
  | 'error';

type OnboardingSessionResult = {
  bootstrapToken: string;
  expiresAt: string;
  ttlSeconds: number;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function isLikelyIos(): boolean {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function daysUntil(dateText: string): number {
  const target = new Date(dateText).getTime();
  const now = Date.now();
  return Math.max(0, Math.ceil((target - now) / 86_400_000));
}

function labelForMode(mode: Usage['mode']): string {
  return mode === 'ai_credits' ? 'AI credits' : 'Premium requests';
}

function sourceBadge(source: string): { label: string; className: string } {
  if (source === 'copilot-local') return { label: 'Live (local)', className: 'badge badge-live' };
  if (source === 'github-copilot-internal') return { label: 'Live (hosted)', className: 'badge badge-live' };
  if (source === 'unsupported' || source === 'github-placeholder') return { label: 'Unavailable', className: 'badge badge-unavailable' };
  return { label: 'Mock data', className: 'badge badge-mock' };
}

function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'auth_state_mismatch') return 'Login failed: security state mismatch. Please try again.';
  if (code === 'auth_unavailable') return 'GitHub login is not available. GITHUB_CLIENT_ID may not be configured.';
  if (code === 'auth_failed') return 'GitHub login failed. Please try again.';
  return 'An authentication error occurred. Please try again.';
}

function WidgetTokenSection({ isIos }: { isIos: boolean }) {
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

  function storeOnboardingStep(step: OnboardingStep) {
    setOnboardingStep(step);
    sessionStorage.setItem('copelimit-onboarding-step', step);
  }

  async function refreshStatus() {
    const response = await fetch('/api/widget-token', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    setStatus(await response.json() as WidgetTokenStatus);
  }

  useEffect(() => {
    refreshStatus().catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem('copelimit-onboarding-step');
    if (
      saved === 'checking'
      || saved === 'scriptable-missing'
      || saved === 'ready'
      || saved === 'manual-setup'
      || saved === 'requesting'
      || saved === 'linking'
      || saved === 'waiting'
      || saved === 'error'
    ) {
      setOnboardingStep(saved);
    } else if (saved === 'import-installer') {
      setOnboardingStep('manual-setup');
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const onboarding = params.get('onboarding');
    const reason = params.get('reason');
    if (onboarding === 'complete') {
      setOnboardingSuccess(true);
      setOnboardingError(null);
      setOnboardingNotice('Widget token installed in Scriptable. Add the Scriptable widget and select CopeLimitWidget.');
      storeOnboardingStep('idle');
      refreshStatus().catch(() => undefined);
      params.delete('onboarding');
      params.delete('reason');
      const nextQuery = params.toString();
      window.history.replaceState({}, '', nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname);
    } else if (onboarding === 'error') {
      setOnboardingSuccess(false);
      setOnboardingError(reason ? `Setup failed (${reason}).` : 'Setup failed. Please try again.');
      storeOnboardingStep('error');
      params.delete('onboarding');
      params.delete('reason');
      const nextQuery = params.toString();
      window.history.replaceState({}, '', nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname);
    }
  }, []);

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

  function appStoreLink() {
    window.location.href = 'https://apps.apple.com/app/scriptable/id1405459188';
  }

  function scriptSourceUrl(scriptName: 'CopeLimitInstall.js' | 'CopeLimitWidget.js') {
    return `${window.location.origin}/scriptable/${scriptName}`;
  }

  function openScriptSource(scriptName: 'CopeLimitInstall.js' | 'CopeLimitWidget.js') {
    storeOnboardingStep('manual-setup');
    window.open(scriptSourceUrl(scriptName), '_blank', 'noopener,noreferrer');
  }

  async function copyScriptSource(
    scriptName: 'CopeLimitInstall.js' | 'CopeLimitWidget.js',
    scriptTargetName: 'CopeLimitInstall' | 'CopeLimitWidget',
    label: string
  ) {
    setOnboardingError(null);
    try {
      const response = await fetch(scriptSourceUrl(scriptName));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      storeOnboardingStep('manual-setup');
      setOnboardingNotice(`${label} copied to clipboard. Create or edit “${scriptTargetName}” in Scriptable and paste the script text.`);
      setOnboardingSuccess(false);
    } catch (err) {
      if (err instanceof TypeError) {
        setOnboardingError('Failed to copy script: could not load script source (network or browser policy issue).');
      } else if (err instanceof Error) {
        setOnboardingError(`Failed to copy script: ${err.message}`);
      } else {
        setOnboardingError('Failed to copy script.');
      }
    }
  }

  async function detectScriptableApp(): Promise<boolean> {
    return new Promise((resolve) => {
      let hidden = false;
      function handleVisibilityChange() {
        if (document.hidden) {
          hidden = true;
        }
      }

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.location.href = 'scriptable:///';
      window.setTimeout(() => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        resolve(hidden);
      }, 2300);
    });
  }

  function openScriptableApp() {
    window.location.href = 'scriptable:///';
  }

  async function checkScriptable() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    storeOnboardingStep('checking');
    const installed = await detectScriptableApp();
    if (installed) {
      storeOnboardingStep('ready');
    } else {
      storeOnboardingStep('scriptable-missing');
    }
  }

  async function requestOnboardingSession(): Promise<OnboardingSessionResult> {
    const response = await fetch('/api/onboarding/session', { method: 'POST', cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`);
    }
    return response.json() as Promise<OnboardingSessionResult>;
  }

  async function connectScriptable() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
    storeOnboardingStep('requesting');
    try {
      const session = await requestOnboardingSession();
      // Bootstrap token is short-lived and single-use by design; URL exposure is accepted for iOS deep-link handoff.
      const runLink = `scriptable:///run?scriptName=CopeLimitInstall&bt=${encodeURIComponent(session.bootstrapToken)}`;
      storeOnboardingStep('linking');
      window.location.href = runLink;
      storeOnboardingStep('waiting');
      setOnboardingNotice('Configuring token in Scriptable. Ensure you already created “CopeLimitInstall” in Scriptable using the options above.');
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : 'Failed to start onboarding');
      storeOnboardingStep('error');
    }
  }

  function resetOnboarding() {
    setOnboardingError(null);
    setOnboardingNotice(null);
    setOnboardingSuccess(false);
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
      {isIos && (
        <div className="widgetOnboarding">
          <span className="label">iPhone Widget Setup</span>
          <p>
            Scriptable script creation/import is manual in iOS. Open or copy each script source below, create scripts in Scriptable,
            then run token configuration for automatic token handoff.
          </p>
          {onboardingSuccess && <p className="widgetOnboardingSuccess">{onboardingNotice}</p>}
          {onboardingError && <p className="widgetTokenError">{onboardingError}</p>}
          {!onboardingSuccess && onboardingNotice && <p className="widgetTokenMeta">{onboardingNotice}</p>}
          <div className="widgetTokenActions">
            <button type="button" onClick={checkScriptable} disabled={onboardingStep === 'checking' || onboardingStep === 'requesting'}>
              {onboardingStep === 'checking' ? 'Checking…' : 'Setup iPhone widget'}
            </button>
            {(onboardingStep === 'scriptable-missing') && (
              <button type="button" onClick={appStoreLink}>
                Install Scriptable
              </button>
            )}
            {(onboardingStep === 'ready' || onboardingStep === 'manual-setup' || onboardingStep === 'waiting' || onboardingStep === 'error') && (
              <>
                <button type="button" onClick={() => { openScriptSource('CopeLimitWidget.js'); }}>
                  Open widget script source
                </button>
                <button type="button" onClick={() => { void copyScriptSource('CopeLimitWidget.js', 'CopeLimitWidget', 'Widget script'); }}>
                  Copy widget script
                </button>
                <button type="button" onClick={() => { openScriptSource('CopeLimitInstall.js'); }}>
                  Open token configuration script source
                </button>
                <button type="button" onClick={() => { void copyScriptSource('CopeLimitInstall.js', 'CopeLimitInstall', 'Token configuration script'); }}>
                  Copy token configuration script
                </button>
                <button type="button" onClick={openScriptableApp}>
                  Open Scriptable
                </button>
                <button type="button" onClick={connectScriptable} disabled={onboardingStep === 'requesting'}>
                  {onboardingStep === 'requesting' ? 'Connecting…' : 'Configure token in Scriptable'}
                </button>
                <button type="button" onClick={resetOnboarding}>
                  Reset
                </button>
              </>
            )}
          </div>
          <p className="widgetTokenMeta">
            Automatic token handoff works after CopeLimitInstall exists in Scriptable. Final iOS home screen widget creation and
            script assignment remain manual.
          </p>
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
    </section>
  );
}

function App() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const [isIosDevice, setIsIosDevice] = useState(false);

  const authError = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return authErrorMessage(params.get('error'));
  }, []);

  async function refresh() {
    setError(null);
    try {
      const response = await fetch('/api/usage', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Usage API returned HTTP ${response.status}`);
      }
      setUsage(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  async function fetchUser() {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (response.ok) {
        setUser(await response.json());
      }
    } catch {
      // non-fatal — show anonymous state
      setUser({ authenticated: false });
    }
  }

  useEffect(() => {
    refresh();
    fetchUser();
  }, []);

  useEffect(() => {
    const iosNavigator = window.navigator as Navigator & { standalone?: boolean };
    const inStandaloneMode = window.matchMedia('(display-mode: standalone)').matches
      || iosNavigator.standalone === true;
    // UA/platform checks are used here because iOS Safari lacks a standard install-prompt API.
    const isIos = isLikelyIos();
    const dismissedIosHint = sessionStorage.getItem('copelimit-ios-install-hint-dismissed') === '1';
    setIsInstalled(inStandaloneMode);
    setIsIosDevice(isIos);
    setShowIosInstallHint(isIos && !inStandaloneMode && !dismissedIosHint);

    const updateOnlineStatus = () => setIsOffline(!navigator.onLine);
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setIsInstalled(true);
    };

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPrompt(null);
      }
    } catch (error) {
      console.warn('Install prompt failed');
    }
  }

  function dismissIosInstallHint() {
    sessionStorage.setItem('copelimit-ios-install-hint-dismissed', '1');
    setShowIosInstallHint(false);
  }

  const statusText = useMemo(() => {
    if (!usage) return 'Loading';
    if (usage.warningLevel === 'over') return 'Quota exceeded';
    if (usage.warningLevel === 'hot') return 'Nearly cooked';
    if (usage.warningLevel === 'warm') return 'Getting spicy';
    return 'Comfortable';
  }, [usage]);

  const isUnsupported = usage?.source === 'unsupported' || usage?.source === 'github-placeholder';

  return (
    <main className="shell">
      <section className="hero">
        <div className="brand">
          <img src="/icons/icon-192.png" alt="CopeLimit logo" />
          <div>
            <h1>CopeLimit</h1>
            <p>Your Copilot usage panic meter.</p>
          </div>
        </div>
        <div className="heroActions">
          {user?.authenticated ? (
            <div className="userChip">
              {user.avatar_url && (
                <img src={user.avatar_url} alt={user.login} width={24} height={24} />
              )}
              <span>{user.login}</span>
              <a href="/api/auth/logout">Sign out</a>
            </div>
          ) : (
            <a
              className="loginButton"
              href="/api/auth/start"
            >
              Sign in with GitHub
            </a>
          )}
          {!isInstalled && installPrompt && (
            <button type="button" className="installButton" onClick={installApp}>
              Install app
            </button>
          )}
          <button onClick={refresh}>Refresh</button>
        </div>
      </section>

      {isOffline && <section className="card notice">You are offline. Attempting to use cached app content.</section>}
      {showIosInstallHint && (
        <section className="card notice iosHint">
          <span>
            On iPhone or iPad: tap Safari's <strong>Share</strong> button, then
            {' '}
            <strong>Add to Home Screen</strong>.
          </span>
          <button type="button" className="iosHintDismiss" onClick={dismissIosInstallHint}>
            Dismiss
          </button>
        </section>
      )}
      {authError && <section className="card error">{authError}</section>}
      {error && <section className="card error">Could not load usage: {error}</section>}

      {usage && isUnsupported && (
        <section className="card notice">
          <strong>Real quota unavailable in hosted mode.</strong>
          <p>
            GitHub's API does not expose personal Copilot quota. To see real data, run CopeLimit locally with the copilot-api proxy.
          </p>
        </section>
      )}

      {usage && !isUnsupported && (
        <>
          <section className={`card meter ${usage.warningLevel}`}>
            <div className="meterHeader">
              <span>{labelForMode(usage.mode)}</span>
              <strong>{statusText}</strong>
            </div>

            <div className="bigNumber">{usage.remaining}</div>
            <div className="subtle">remaining of {usage.quota}</div>

            <div className="bar" aria-label={`${usage.percentUsed}% used`}>
              <div style={{ width: `${Math.min(100, usage.percentUsed)}%` }} />
            </div>

            <div className="stats">
              <div>
                <span>Used</span>
                <strong>{usage.used}</strong>
              </div>
              <div>
                <span>Quota</span>
                <strong>{usage.quota}</strong>
              </div>
              <div>
                <span>Used</span>
                <strong>{usage.percentUsed}%</strong>
              </div>
            </div>
          </section>

          <section className="grid">
            <div className="card">
              <span className="label">Reset</span>
              <strong>{new Date(usage.resetAt).toLocaleDateString()}</strong>
              <p>{daysUntil(usage.resetAt)} days remaining in this quota window.</p>
            </div>

            <div className="card billingCard">
              <span className="label">Billing entity</span>
              <strong>{usage.billingEntity}</strong>
              <p>Updated {new Date(usage.updatedAt).toLocaleString()}.</p>
              <span className={sourceBadge(usage.source).className}>
                {sourceBadge(usage.source).label}
              </span>
            </div>
          </section>

          {usage.notes.length > 0 && (
            <section className="card notes">
              <span className="label">Notes</span>
              {usage.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </section>
          )}
        </>
      )}

      {user?.authenticated && <WidgetTokenSection isIos={isIosDevice} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      console.warn('Service worker registration failed');
    });
  });
}
