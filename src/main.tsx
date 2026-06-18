/**
 * @file Main React application entry point for the CopeLimit PWA.
 *
 * Renders the root `App` component which:
 * - Fetches Copilot usage from `/api/usage` and the authenticated user from `/api/me`.
 * - Displays a colour-coded quota meter with reset date, billing entity, and data-source badge.
 * - Handles GitHub OAuth sign-in / sign-out.
 * - Shows PWA install prompts for Android (`beforeinstallprompt`) and iOS (Add to Home Screen hint).
 * - Registers the service worker (`/sw.js`) for offline-capable app-shell caching.
 * - Renders the {@link WidgetTokenSection} for authenticated users to manage their iOS widget token.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WidgetTokenSection } from './WidgetTokenSection';
import { isLikelyIosNavigator } from './widget-onboarding';
import { labelForBillingPhase } from './billing-display';
import type { BillingPhase } from './billing-display';
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
  billingPhase: BillingPhase;
  overageCount?: number;
  overageEntitlement?: number;
  derivedOverageCredits?: number;
};

type HistorySummary = {
  deltaUsed: number;
  creditsPerHour: number | null;
  averageBurnRate: number | null;
  oldestAt: string | null;
  newestAt: string | null;
  snapshotCount: number;
};

type User = {
  authenticated: boolean;
  login?: string;
  avatar_url?: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function isLikelyIos(): boolean {
  return isLikelyIosNavigator(window.navigator);
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

function App() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [historySummary, setHistorySummary] = useState<HistorySummary | null>(null);
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

  async function fetchHistorySummary() {
    try {
      const response = await fetch('/api/history?summary=true&limit=50', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json() as { summary?: HistorySummary };
        setHistorySummary(data.summary ?? null);
      }
    } catch {
      // History is optional — silently ignore failures
    }
  }

  async function fetchUser() {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (response.ok) {
        setUser(await response.json());
      }
    } catch {
      setUser({ authenticated: false });
    }
  }

  useEffect(() => {
    void refresh();
    void fetchUser();
    void fetchHistorySummary();
  }, []);

  useEffect(() => {
    const iosNavigator = window.navigator as Navigator & { standalone?: boolean };
    const inStandaloneMode = window.matchMedia('(display-mode: standalone)').matches
      || iosNavigator.standalone === true;
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
    } catch {
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
            <button type="button" className="installButton" onClick={() => { void installApp(); }}>
              Install app
            </button>
          )}
          <button onClick={() => { void refresh(); }}>Refresh</button>
        </div>
      </section>

      {isOffline && <section className="card notice">You are offline. Attempting to use cached app content.</section>}
      {showIosInstallHint && (
        <section className="card notice iosHint">
          <span>
            On iPhone or iPad: tap Safari&apos;s <strong>Share</strong> button, then
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
            GitHub&apos;s API does not expose personal Copilot quota. To see real data, run CopeLimit locally with the copilot-api proxy.
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
              <div className="billingMeta">
                <span className={`badge billingPhaseBadge phase-${usage.billingPhase}`}>
                  {labelForBillingPhase(usage.billingPhase)}
                </span>
                <span className={sourceBadge(usage.source).className}>
                  {sourceBadge(usage.source).label}
                </span>
              </div>
            </div>
          </section>

          {usage.billingPhase === 'budget_active' && (
            <section className="card budgetInfo">
              <span className="label">Budget usage</span>
              <div className="budgetGrid">
                <div>
                  <span>Included quota used</span>
                  <strong>{usage.used}</strong>
                </div>
                {usage.overageCount !== undefined && (
                  <div>
                    <span>Overage credits used</span>
                    <strong>{usage.overageCount}</strong>
                  </div>
                )}
                {usage.overageEntitlement !== undefined && (
                  <div>
                    <span>Overage budget</span>
                    <strong>{usage.overageEntitlement}</strong>
                  </div>
                )}
                {usage.derivedOverageCredits !== undefined &&
                  usage.overageCount !== undefined &&
                  usage.derivedOverageCredits !== usage.overageCount && (
                  <div>
                    <span>Derived overage (est.)</span>
                    <strong>{usage.derivedOverageCredits}</strong>
                  </div>
                )}
              </div>
            </section>
          )}

          {usage.notes.length > 0 && (
            <section className="card notes">
              <span className="label">Notes</span>
              {usage.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </section>
          )}

          {historySummary && historySummary.snapshotCount >= 2 && (
            <section className="card historySummary">
              <span className="label">Usage history</span>
              <div className="historyGrid">
                <div>
                  <span>Consumed (window)</span>
                  <strong>{historySummary.deltaUsed}</strong>
                </div>
                {historySummary.creditsPerHour !== null && (
                  <div>
                    <span>Credits / hour</span>
                    <strong>{historySummary.creditsPerHour.toFixed(1)}</strong>
                  </div>
                )}
                {historySummary.averageBurnRate !== null && (
                  <div>
                    <span>Avg burn rate</span>
                    <strong>{historySummary.averageBurnRate.toFixed(1)}/hr</strong>
                  </div>
                )}
              </div>
              {historySummary.oldestAt && historySummary.newestAt && (
                <p className="historyWindow">
                  {new Date(historySummary.oldestAt).toLocaleString()} –{' '}
                  {new Date(historySummary.newestAt).toLocaleString()}
                  {' '}({historySummary.snapshotCount} snapshots)
                </p>
              )}
            </section>
          )}
        </>
      )}

      {user?.authenticated && <WidgetTokenSection isIos={isIosDevice} isStandalone={isInstalled} />}
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
