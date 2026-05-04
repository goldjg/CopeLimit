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

function daysUntil(dateText: string): number {
  const target = new Date(dateText).getTime();
  const now = Date.now();
  return Math.max(0, Math.ceil((target - now) / 86_400_000));
}

function labelForMode(mode: Usage['mode']): string {
  return mode === 'ai_credits' ? 'AI credits' : 'Premium requests';
}

function App() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    refresh();
  }, []);

  const statusText = useMemo(() => {
    if (!usage) return 'Loading';
    if (usage.warningLevel === 'over') return 'Quota exceeded';
    if (usage.warningLevel === 'hot') return 'Nearly cooked';
    if (usage.warningLevel === 'warm') return 'Getting spicy';
    return 'Comfortable';
  }, [usage]);

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
        <button onClick={refresh}>Refresh</button>
      </section>

      {error && <section className="card error">Could not load usage: {error}</section>}

      {usage && (
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

            <div className="card">
              <span className="label">Billing entity</span>
              <strong>{usage.billingEntity}</strong>
              <p>Source: {usage.source}. Updated {new Date(usage.updatedAt).toLocaleString()}.</p>
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
