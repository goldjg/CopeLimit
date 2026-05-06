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

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

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

function WidgetTokenSection() {
  const [result, setResult] = useState<WidgetTokenResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<WidgetTokenStatus | null>(null);

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
          <img src="https://github.com/user-attachments/assets/044544f3-9cf1-4c08-990d-c28927be0eb5" alt="CopeLimit logo" />
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

      {user?.authenticated && <WidgetTokenSection />}
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
