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
          <img src="/icons/icon.svg" alt="" />
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
          <button onClick={refresh}>Refresh</button>
        </div>
      </section>

      {authError && <section className="card error">{authError}</section>}
      {error && <section className="card error">Could not load usage: {error}</section>}

      {usage && isUnsupported && (
        <section className="card notice">
          <strong>Real quota unavailable in hosted mode.</strong>
          <p>
            {"GitHub's API does not expose personal Copilot quota. To see real data, run CopeLimit locally with the copilot-api proxy."}
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
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

