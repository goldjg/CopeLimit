/**
 * @file Push Notification Settings React component.
 *
 * Renders the "Browser Notifications" card for authenticated users.
 * - Subscribe / unsubscribe
 * - Send test notification
 * - Configure per-user alert preferences with sensible defaults
 *
 * Constraints:
 * - Does NOT auto-prompt for notification permission on mount.
 * - Requests permission only from an explicit button click.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  detectPushSupport,
  getCurrentPermission,
  getActiveSubscription,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from './push-notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubscriptionStatus = {
  vapidPublicKey: string | null;
  subscriptionCount: number;
  hasSubscriptions: boolean;
};

type TestNotifFeedback =
  | null
  | { result: 'success' }
  | { result: 'error'; message: string };

type PushSectionState =
  | { phase: 'loading' }
  | { phase: 'unsupported' }
  | { phase: 'config_missing' }
  | { phase: 'permission_denied' }
  | { phase: 'subscribed'; subscriptionCount: number }
  | { phase: 'unsubscribed'; vapidPublicKey: string }
  | { phase: 'error'; message: string };

/** Per-user notification preferences stored by `/api/push/preferences`. */
type PushUserPreferences = {
  notifyOnStatusLevelChange: boolean;
  notifyWhenStatusBecomesHot: boolean;
  notifyWhenStatusBecomesOverage: boolean;
  notifyWhenStatusBecomesBlocked: boolean;
  notifyWhenProjectedExhaustionWithinHours: boolean;
  projectedExhaustionThresholdHours: number;
  notifyOnBurnRateIncrease: boolean;
  burnRateIncreasePercentThreshold: number;
  updatedAt: string;
};

const DEFAULT_PREFS: PushUserPreferences = {
  notifyOnStatusLevelChange: true,
  notifyWhenStatusBecomesHot: true,
  notifyWhenStatusBecomesOverage: true,
  notifyWhenStatusBecomesBlocked: true,
  notifyWhenProjectedExhaustionWithinHours: true,
  projectedExhaustionThresholdHours: 24,
  notifyOnBurnRateIncrease: true,
  burnRateIncreasePercentThreshold: 25,
  updatedAt: '',
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchStatus(): Promise<SubscriptionStatus> {
  const res = await fetch('/api/push/subscribe');
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return res.json() as Promise<SubscriptionStatus>;
}

async function registerSubscription(sub: PushSubscription): Promise<void> {
  const payload = sub.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status}`);
}

async function deregisterSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  if (!res.ok) throw new Error(`Unregister failed: ${res.status}`);
}

async function fetchPreferences(): Promise<PushUserPreferences> {
  const res = await fetch('/api/push/preferences', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Preferences ${res.status}`);
  return res.json() as Promise<PushUserPreferences>;
}

async function patchPreferences(
  patch: Partial<PushUserPreferences>,
): Promise<PushUserPreferences> {
  const res = await fetch('/api/push/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Preferences save failed: ${res.status}`);
  return res.json() as Promise<PushUserPreferences>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PushNotificationSection(): React.ReactElement | null {
  const [state, setState] = useState<PushSectionState>({ phase: 'loading' });
  const [busyOp, setBusyOp] = useState<null | 'subscribe' | 'test' | 'unsubscribe'>(null);
  const [testFeedback, setTestFeedback] = useState<TestNotifFeedback>(null);
  const [prefs, setPrefs] = useState<PushUserPreferences>(DEFAULT_PREFS);
  const [prefsSaveState, setPrefsSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const busy = busyOp !== null;

  // Load subscription status on mount.
  const loadStatus = useCallback(async () => {
    try {
      const status = await fetchStatus();
      const supportResult = detectPushSupport(status.vapidPublicKey);

      if (supportResult === 'unsupported') {
        setState({ phase: 'unsupported' });
        return;
      }
      if (supportResult === 'config_missing') {
        setState({ phase: 'config_missing' });
        return;
      }

      const permission = getCurrentPermission();
      if (permission === 'denied') {
        const existing = await getActiveSubscription();
        if (existing) {
          setState({ phase: 'subscribed', subscriptionCount: status.subscriptionCount });
        } else {
          setState({ phase: 'permission_denied' });
        }
        return;
      }

      if (status.hasSubscriptions) {
        setState({ phase: 'subscribed', subscriptionCount: status.subscriptionCount });
      } else {
        setState({ phase: 'unsubscribed', vapidPublicKey: status.vapidPublicKey ?? '' });
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[PushNotificationSection] failed to load status:', err);
      }
      setState({ phase: 'unsupported' });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Load preferences once the user can interact with the section.
  useEffect(() => {
    const canShowPrefs = state.phase === 'subscribed' || state.phase === 'unsubscribed';
    if (!canShowPrefs) return;

    let cancelled = false;
    void fetchPreferences()
      .then((value) => { if (!cancelled) setPrefs(value); })
      .catch(() => { if (!cancelled) setPrefs(DEFAULT_PREFS); });
    return () => { cancelled = true; };
  }, [state.phase]);

  // Persist a partial preferences change.
  const savePatch = useCallback(async (patch: Partial<PushUserPreferences>) => {
    setPrefsSaveState('saving');
    try {
      const updated = await patchPreferences(patch);
      setPrefs(updated);
      setPrefsSaveState('saved');
      setTimeout(() => setPrefsSaveState('idle'), 1400);
    } catch {
      setPrefsSaveState('error');
    }
  }, []);

  const handleToggle = useCallback(
    (key: keyof PushUserPreferences, value: boolean | number) => {
      setPrefs((prev) => ({ ...prev, [key]: value }));
      void savePatch({ [key]: value } as Partial<PushUserPreferences>);
    },
    [savePatch],
  );

  // Subscribe / unsubscribe / test handlers.
  const handleSubscribe = useCallback(async () => {
    if (state.phase !== 'unsubscribed') return;
    setBusyOp('subscribe');
    try {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') { setState({ phase: 'permission_denied' }); return; }
      const sub = await subscribeToPush(state.vapidPublicKey);
      if (!sub) { setState({ phase: 'error', message: 'Could not subscribe. Try again.' }); return; }
      await registerSubscription(sub);
      await loadStatus();
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Subscribe failed.' });
    } finally {
      setBusyOp(null);
    }
  }, [state, loadStatus]);

  const handleSendTest = useCallback(async () => {
    if (state.phase !== 'subscribed') return;
    setBusyOp('test');
    setTestFeedback(null);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      if (res.ok) {
        setTestFeedback({ result: 'success' });
      } else {
        const body = await res.json() as { error?: string };
        setTestFeedback({ result: 'error', message: body.error ?? `Request failed (${res.status}).` });
      }
    } catch (err) {
      setTestFeedback({ result: 'error', message: err instanceof Error ? err.message : 'Could not reach the server.' });
    } finally {
      setBusyOp(null);
    }
  }, [state]);

  const handleUnsubscribe = useCallback(async () => {
    if (state.phase !== 'subscribed') return;
    setBusyOp('unsubscribe');
    setTestFeedback(null);
    try {
      const sub = await getActiveSubscription();
      if (sub) { await deregisterSubscription(sub); await unsubscribeFromPush(); }
      await loadStatus();
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Unsubscribe failed.' });
    } finally {
      setBusyOp(null);
    }
  }, [state, loadStatus]);

  if (state.phase === 'loading' || state.phase === 'unsupported') return null;

  const showPrefs = state.phase === 'subscribed' || state.phase === 'unsubscribed';

  return (
    <section className="card pushNotificationCard" aria-label="Browser notification settings">
      <h2 className="pushNotificationHeading">Browser Notifications</h2>

      {state.phase === 'config_missing' && (
        <p className="pushNotificationNote">
          Push notifications are not configured for this environment.
        </p>
      )}

      {state.phase === 'permission_denied' && (
        <p className="pushNotificationNote">
          Notification permission was denied. Enable it in your browser settings to subscribe.
        </p>
      )}

      {state.phase === 'subscribed' && (
        <>
          <p className="pushNotificationNote">
            ✓ Browser notifications active
            {state.subscriptionCount > 1 ? ` (${state.subscriptionCount} devices)` : ''}.
          </p>
          {testFeedback?.result === 'success' && (
            <p className="pushNotificationSuccess">✓ Test notification sent.</p>
          )}
          {testFeedback?.result === 'error' && (
            <p className="pushNotificationError">{testFeedback.message}</p>
          )}
          <div className="pushNotificationActions">
            <button onClick={() => void handleSendTest()} disabled={busy} className="pushNotificationBtn">
              {busyOp === 'test' ? 'Sending…' : 'Send test notification'}
            </button>
            <button
              onClick={() => void handleUnsubscribe()}
              disabled={busy}
              className="pushNotificationBtn pushNotificationBtnSecondary"
            >
              {busyOp === 'unsubscribe' ? 'Removing…' : 'Unsubscribe'}
            </button>
          </div>
        </>
      )}

      {state.phase === 'unsubscribed' && (
        <>
          <p className="pushNotificationNote">
            Get notified in this browser when your AI credit usage hits alert thresholds.
          </p>
          <div className="pushNotificationActions">
            <button onClick={() => void handleSubscribe()} disabled={busy} className="pushNotificationBtn">
              {busyOp === 'subscribe' ? 'Enabling…' : 'Enable notifications'}
            </button>
          </div>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <p className="pushNotificationError">{state.message}</p>
          <div className="pushNotificationActions">
            <button onClick={() => void loadStatus()} className="pushNotificationBtn pushNotificationBtnSecondary">
              Retry
            </button>
          </div>
        </>
      )}

      {showPrefs && (
        <section className="pushNotificationPreferences" aria-label="Alert thresholds">
          <h3 className="pushNotificationSubheading">Alert thresholds</h3>
          <p className="pushNotificationNote pushNotificationNoteSmall">
            Defaults alert on critical events only — adjust below.
          </p>

          <fieldset className="pushPrefFieldset">
            <legend className="pushPrefLegend">Status transitions</legend>

            <label className="pushPrefRow">
              <input
                type="checkbox"
                checked={prefs.notifyWhenStatusBecomesHot}
                onChange={(e) => handleToggle('notifyWhenStatusBecomesHot', e.target.checked)}
              />
              <span>Hot — credits running low or imminent exhaustion</span>
            </label>

            <label className="pushPrefRow">
              <input
                type="checkbox"
                checked={prefs.notifyWhenStatusBecomesOverage}
                onChange={(e) => handleToggle('notifyWhenStatusBecomesOverage', e.target.checked)}
              />
              <span>Overage — spending from configured budget</span>
            </label>

            <label className="pushPrefRow">
              <input
                type="checkbox"
                checked={prefs.notifyWhenStatusBecomesBlocked}
                onChange={(e) => handleToggle('notifyWhenStatusBecomesBlocked', e.target.checked)}
              />
              <span>Blocked — credits exhausted or hard stop</span>
            </label>
          </fieldset>

          <fieldset className="pushPrefFieldset">
            <legend className="pushPrefLegend">Projected exhaustion</legend>

            <label className="pushPrefRow">
              <input
                type="checkbox"
                checked={prefs.notifyWhenProjectedExhaustionWithinHours}
                onChange={(e) =>
                  handleToggle('notifyWhenProjectedExhaustionWithinHours', e.target.checked)
                }
              />
              <span>Notify when projected exhaustion enters threshold window</span>
            </label>

            <label className="pushPrefField">
              <span>Threshold (hours)</span>
              <input
                type="number"
                min={1}
                max={168}
                value={prefs.projectedExhaustionThresholdHours}
                disabled={!prefs.notifyWhenProjectedExhaustionWithinHours}
                onChange={(e) =>
                  handleToggle(
                    'projectedExhaustionThresholdHours',
                    Math.min(168, Math.max(1, Number(e.target.value) || 24)),
                  )
                }
              />
            </label>
          </fieldset>

          <fieldset className="pushPrefFieldset">
            <legend className="pushPrefLegend">Burn rate</legend>

            <label className="pushPrefRow">
              <input
                type="checkbox"
                checked={prefs.notifyOnBurnRateIncrease}
                onChange={(e) => handleToggle('notifyOnBurnRateIncrease', e.target.checked)}
              />
              <span>Notify when burn rate increases significantly</span>
            </label>

            <label className="pushPrefField">
              <span>Threshold (%)</span>
              <input
                type="number"
                min={1}
                max={500}
                value={prefs.burnRateIncreasePercentThreshold}
                disabled={!prefs.notifyOnBurnRateIncrease}
                onChange={(e) =>
                  handleToggle(
                    'burnRateIncreasePercentThreshold',
                    Math.min(500, Math.max(1, Number(e.target.value) || 25)),
                  )
                }
              />
            </label>
          </fieldset>

          {prefsSaveState === 'saving' && (
            <p className="pushNotificationNote pushNotificationNoteSmall">Saving…</p>
          )}
          {prefsSaveState === 'saved' && (
            <p className="pushNotificationSuccess pushNotificationNoteSmall">Preferences saved.</p>
          )}
          {prefsSaveState === 'error' && (
            <p className="pushNotificationError">Could not save preferences. Try again.</p>
          )}
        </section>
      )}
    </section>
  );
}
