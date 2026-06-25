/**
 * @file Push Notification Settings React component.
 *
 * Renders a small "Browser Notifications" card visible to authenticated users.
 * Allows users to subscribe or unsubscribe from browser push notifications for
 * future AI credit usage alerts.
 *
 * ## Constraints
 * - Does NOT auto-prompt for notification permission on mount or import.
 * - Requests permission only from an explicit button click.
 * - Shows clear states: unsupported, config_missing, subscribed, unsubscribed.
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

type SubscriptionStatus = {
  vapidPublicKey: string | null;
  subscriptionCount: number;
  hasSubscriptions: boolean;
};

type PushSectionState =
  | { phase: 'loading' }
  | { phase: 'unsupported' }
  | { phase: 'config_missing' }
  | { phase: 'permission_denied' }
  | { phase: 'subscribed'; subscriptionCount: number }
  | { phase: 'unsubscribed'; vapidPublicKey: string }
  | { phase: 'error'; message: string };

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

export default function PushNotificationSection(): React.ReactElement | null {
  const [state, setState] = useState<PushSectionState>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);

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

      // Browser is supported and config is present
      const permission = getCurrentPermission();
      if (permission === 'denied') {
        // Check if there's an active service worker subscription before concluding
        const existing = await getActiveSubscription();
        if (existing) {
          setState({ phase: 'subscribed', subscriptionCount: status.subscriptionCount });
        } else {
          // Permission denied — can't subscribe
          setState({ phase: 'permission_denied' });
        }
        return;
      }

      if (status.hasSubscriptions) {
        setState({ phase: 'subscribed', subscriptionCount: status.subscriptionCount });
      } else {
        // vapidPublicKey is guaranteed non-null here: detectPushSupport returned
        // 'supported' above, which requires a non-empty key.
        setState({ phase: 'unsubscribed', vapidPublicKey: status.vapidPublicKey ?? '' });
      }
    } catch (err) {
      // Log in development to aid diagnosis; fall back to 'unsupported' so the
      // card is hidden rather than showing a confusing error on page load.
      if (typeof console !== 'undefined') console.warn('[PushNotificationSection] failed to load status:', err);
      setState({ phase: 'unsupported' });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSubscribe = useCallback(async () => {
    if (state.phase !== 'unsubscribed') return;
    setBusy(true);
    try {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') {
        setState({ phase: 'permission_denied' });
        return;
      }
      const sub = await subscribeToPush(state.vapidPublicKey);
      if (!sub) {
        setState({ phase: 'error', message: 'Could not subscribe. Try again.' });
        return;
      }
      await registerSubscription(sub);
      await loadStatus();
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Subscribe failed.' });
    } finally {
      setBusy(false);
    }
  }, [state, loadStatus]);

  const handleUnsubscribe = useCallback(async () => {
    if (state.phase !== 'subscribed') return;
    setBusy(true);
    try {
      const sub = await getActiveSubscription();
      if (sub) {
        await deregisterSubscription(sub);
        await unsubscribeFromPush();
      }
      await loadStatus();
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Unsubscribe failed.' });
    } finally {
      setBusy(false);
    }
  }, [state, loadStatus]);

  // Do not render anything while loading or if unsupported
  if (state.phase === 'loading' || state.phase === 'unsupported') {
    return null;
  }

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
          <div className="pushNotificationActions">
            <button
              onClick={() => void handleUnsubscribe()}
              disabled={busy}
              className="pushNotificationBtn pushNotificationBtnSecondary"
            >
              {busy ? 'Removing…' : 'Unsubscribe'}
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
            <button
              onClick={() => void handleSubscribe()}
              disabled={busy}
              className="pushNotificationBtn"
            >
              {busy ? 'Enabling…' : 'Enable notifications'}
            </button>
          </div>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <p className="pushNotificationError">{state.message}</p>
          <div className="pushNotificationActions">
            <button
              onClick={() => void loadStatus()}
              className="pushNotificationBtn pushNotificationBtnSecondary"
            >
              Retry
            </button>
          </div>
        </>
      )}
    </section>
  );
}
