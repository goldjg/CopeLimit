/**
 * @file Push Notification Settings React component.
 *
 * Renders the "Browser Notifications" card for authenticated users.
 * - Subscribe / unsubscribe
 * - Send test notification
 * - Configure per-user alert preferences with sensible defaults
 * - Explain iOS Home Screen requirements and current capability state
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  NotificationCapability,
  NotificationCapabilityReason,
  detectPushSupport,
  getActiveSubscription,
  getCurrentPermission,
  inspectNotificationCapability,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from './push-notifications'

type SubscriptionStatus = {
  vapidPublicKey: string | null
  subscriptionCount: number
  hasSubscriptions: boolean
}

type TestNotifFeedback =
  | null
  | { result: 'success' }
  | { result: 'error'; message: string }

type PushSectionState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: SubscriptionStatus; capability: NotificationCapability }
  | { phase: 'error'; message: string }

type PushUserPreferences = {
  notifyOnStatusLevelChange: boolean
  notifyWhenStatusBecomesHot: boolean
  notifyWhenStatusBecomesOverage: boolean
  notifyWhenStatusBecomesBlocked: boolean
  notifyWhenProjectedExhaustionWithinHours: boolean
  projectedExhaustionThresholdHours: number
  notifyOnBurnRateIncrease: boolean
  burnRateIncreasePercentThreshold: number
  updatedAt: string
}

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
}

const CAPABILITY_REASON_LABELS: Record<NotificationCapabilityReason, string> = {
  supported: 'ready_to_subscribe',
  subscription_active: 'subscription_active',
  not_installed_on_ios: 'not_installed_on_ios',
  notification_unavailable: 'notification_unavailable',
  service_worker_unavailable: 'service_worker_unavailable',
  push_manager_unavailable: 'push_manager_unavailable',
  notification_permission_denied: 'notification_permission_denied',
  vapid_public_key_missing: 'vapid_public_key_missing',
  service_worker_registration_unavailable: 'service_worker_registration_unavailable',
}

async function fetchStatus(): Promise<SubscriptionStatus> {
  const res = await fetch('/api/push/subscribe')
  if (!res.ok) throw new Error(`Status ${res.status}`)
  return res.json() as Promise<SubscriptionStatus>
}

async function registerSubscription(sub: PushSubscription): Promise<void> {
  const payload = sub.toJSON()
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Register failed: ${res.status}`)
}

async function deregisterSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
  if (!res.ok) throw new Error(`Unregister failed: ${res.status}`)
}

async function fetchPreferences(): Promise<PushUserPreferences> {
  const res = await fetch('/api/push/preferences', { cache: 'no-store' })
  if (!res.ok) throw new Error(`Preferences ${res.status}`)
  return res.json() as Promise<PushUserPreferences>
}

async function patchPreferences(
  patch: Partial<PushUserPreferences>,
): Promise<PushUserPreferences> {
  const res = await fetch('/api/push/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Preferences save failed: ${res.status}`)
  return res.json() as Promise<PushUserPreferences>
}

function describePrimaryState(capability: NotificationCapability): string {
  switch (capability.primaryReason) {
    case 'subscription_active':
      return 'This device is subscribed for browser notifications.'
    case 'not_installed_on_ios':
      return 'Install CopeLimit to your Home Screen to enable notifications on iOS.'
    case 'notification_permission_denied':
      return 'Notification permission was denied. Re-enable it in browser or system settings to subscribe.'
    case 'vapid_public_key_missing':
      return 'Push notifications are not configured for this environment.'
    case 'notification_unavailable':
      return 'This browser does not expose the Notifications API needed for Web Push.'
    case 'service_worker_unavailable':
      return 'This browser does not expose service workers, so notifications are unavailable.'
    case 'push_manager_unavailable':
      return 'This browser does not expose the Push API needed for Web Push.'
    case 'service_worker_registration_unavailable':
      return 'The app has not finished preparing its service worker yet. Try again in a moment.'
    case 'supported':
    default:
      return 'Get notified in this browser when your AI credit usage hits alert thresholds.'
  }
}

function capabilityStatusRows(capability: NotificationCapability): Array<{ label: string; value: string }> {
  return [
    { label: 'Platform', value: capability.isIos ? 'iOS/iPadOS' : 'Non-iOS browser' },
    { label: 'Display mode', value: capability.isStandalone ? 'Standalone app' : 'Browser tab' },
    { label: 'Notifications API', value: capability.hasNotificationApi ? 'Available' : 'Unavailable' },
    { label: 'Service worker', value: capability.hasServiceWorker ? 'Available' : 'Unavailable' },
    { label: 'PushManager', value: capability.hasPushManager ? 'Available' : 'Unavailable' },
    {
      label: 'Permission',
      value: capability.permission === 'unsupported' ? 'Unavailable' : capability.permission,
    },
    { label: 'VAPID public key', value: capability.hasVapidPublicKey ? 'Present' : 'Missing' },
    {
      label: 'Service worker registration',
      value: capability.hasServiceWorkerRegistration ? 'Active' : 'Not ready yet',
    },
    { label: 'Current device subscription', value: capability.hasActiveSubscription ? 'Active' : 'Inactive' },
  ]
}

export default function PushNotificationSection(): React.ReactElement {
  const [state, setState] = useState<PushSectionState>({ phase: 'loading' })
  const [busyOp, setBusyOp] = useState<null | 'subscribe' | 'test' | 'unsubscribe'>(null)
  const [testFeedback, setTestFeedback] = useState<TestNotifFeedback>(null)
  const [prefs, setPrefs] = useState<PushUserPreferences>(DEFAULT_PREFS)
  const [prefsSaveState, setPrefsSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const busy = busyOp !== null

  const loadStatus = useCallback(async () => {
    try {
      const status = await fetchStatus()
      const supportResult = detectPushSupport(status.vapidPublicKey)
      const capability = await inspectNotificationCapability(
        supportResult === 'unsupported' ? null : status.vapidPublicKey,
      )

      setState({ phase: 'ready', status, capability })
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[PushNotificationSection] failed to load status:', err)
      }
      setState({ phase: 'error', message: 'Could not load notification settings. Try again.' })
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (state.phase !== 'ready') return
    if (!state.capability.hasActiveSubscription && !state.capability.canSubscribe) return

    let cancelled = false
    void fetchPreferences()
      .then((value) => {
        if (!cancelled) setPrefs(value)
      })
      .catch(() => {
        if (!cancelled) setPrefs(DEFAULT_PREFS)
      })

    return () => {
      cancelled = true
    }
  }, [state])

  const savePatch = useCallback(async (patch: Partial<PushUserPreferences>) => {
    setPrefsSaveState('saving')
    try {
      const updated = await patchPreferences(patch)
      setPrefs(updated)
      setPrefsSaveState('saved')
      setTimeout(() => setPrefsSaveState('idle'), 1400)
    } catch {
      setPrefsSaveState('error')
    }
  }, [])

  const handleToggle = useCallback(
    (key: keyof PushUserPreferences, value: boolean | number) => {
      setPrefs((prev) => ({ ...prev, [key]: value }))
      void savePatch({ [key]: value } as Partial<PushUserPreferences>)
    },
    [savePatch],
  )

  const handleSubscribe = useCallback(async () => {
    if (state.phase !== 'ready' || !state.capability.canSubscribe) return

    setBusyOp('subscribe')
    setTestFeedback(null)

    try {
      const currentPermission = getCurrentPermission()
      const permission = currentPermission === 'granted'
        ? 'granted'
        : await requestNotificationPermission()

      if (permission !== 'granted') {
        await loadStatus()
        return
      }

      const sub = await subscribeToPush(state.status.vapidPublicKey ?? '')
      if (!sub) {
        setState({ phase: 'error', message: 'Could not subscribe. Try again.' })
        return
      }

      await registerSubscription(sub)
      await loadStatus()
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Subscribe failed.',
      })
    } finally {
      setBusyOp(null)
    }
  }, [loadStatus, state])

  const handleSendTest = useCallback(async () => {
    if (state.phase !== 'ready' || !state.capability.hasActiveSubscription) return

    setBusyOp('test')
    setTestFeedback(null)

    try {
      const res = await fetch('/api/push/test', { method: 'POST' })
      if (res.ok) {
        setTestFeedback({ result: 'success' })
      } else {
        const body = await res.json() as { error?: string }
        setTestFeedback({ result: 'error', message: body.error ?? `Request failed (${res.status}).` })
      }
    } catch (err) {
      setTestFeedback({
        result: 'error',
        message: err instanceof Error ? err.message : 'Could not reach the server.',
      })
    } finally {
      setBusyOp(null)
    }
  }, [state])

  const handleUnsubscribe = useCallback(async () => {
    if (state.phase !== 'ready' || !state.capability.hasActiveSubscription) return

    setBusyOp('unsubscribe')
    setTestFeedback(null)

    try {
      const sub = await getActiveSubscription()
      if (sub) {
        await deregisterSubscription(sub)
        await unsubscribeFromPush()
      }
      await loadStatus()
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Unsubscribe failed.',
      })
    } finally {
      setBusyOp(null)
    }
  }, [loadStatus, state])

  const readyState = state.phase === 'ready' ? state : null
  const capability = readyState?.capability ?? null
  const status = readyState?.status ?? null
  const capabilityRows = useMemo(
    () => (capability ? capabilityStatusRows(capability) : []),
    [capability],
  )
  const reasonTags = capability
    ? capability.reasons.map((reason) => CAPABILITY_REASON_LABELS[reason])
    : []
  const showPrefs = Boolean(capability && (capability.hasActiveSubscription || capability.canSubscribe))

  return (
    <section className="card pushNotificationCard" aria-label="Browser notification settings">
      <h2 className="pushNotificationHeading">Browser Notifications</h2>

      {state.phase === 'loading' && (
        <p className="pushNotificationNote">Checking notification capability…</p>
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

      {readyState && (
        <>
          <p className="pushNotificationNote">{describePrimaryState(capability)}</p>

          {capability.isIos && !capability.isStandalone && (
            <p className="pushNotificationInstallHint">
              Install CopeLimit to your Home Screen to enable notifications on iOS.
            </p>
          )}

          {capability.hasActiveSubscription && (
            <>
              <p className="pushNotificationSuccess">
                ✓ Browser notifications active
                {status && status.subscriptionCount > 1 ? ` (${status.subscriptionCount} devices)` : ''}.
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

          {!capability.hasActiveSubscription && capability.canSubscribe && (
            <>
              {status && status.hasSubscriptions && status.subscriptionCount > 0 && (
                <p className="pushNotificationNote pushNotificationNoteSmall">
                  This account already has {status.subscriptionCount} notification subscription
                  {status.subscriptionCount === 1 ? '' : 's'} on other device{status.subscriptionCount === 1 ? '' : 's'}.
                </p>
              )}
              <div className="pushNotificationActions">
                <button onClick={() => void handleSubscribe()} disabled={busy} className="pushNotificationBtn">
                  {busyOp === 'subscribe' ? 'Enabling…' : 'Enable notifications'}
                </button>
              </div>
            </>
          )}

          <section className="pushNotificationDiagnostics" aria-label="Notification capability diagnostics">
            <h3 className="pushNotificationSubheading">Notification capability</h3>
            <div className="pushCapabilityGrid">
              {capabilityRows.map((row) => (
                <div key={row.label} className="pushCapabilityItem">
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>

            {reasonTags.length > 0 && (
              <div className="pushCapabilityReasons" aria-label="Notification capability reasons">
                {reasonTags.map((reason) => (
                  <span key={reason} className="pushCapabilityReason">
                    {reason}
                  </span>
                ))}
              </div>
            )}
          </section>
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
  )
}
