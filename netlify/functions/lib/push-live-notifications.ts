/**
 * @file Live per-user push dispatch from `/api/usage`.
 *
 * Scope:
 * - Uses only subscriptions stored for the current authenticated user.
 * - Applies per-user notification preferences with conservative defaults.
 * - Uses alertDecision.dedupeKey when available, with a small custom dedupe
 *   layer for non-alertDecision triggers.
 */

import type { AlertDecision } from './alert-decision'
import type { BurnRateProjection } from './burn-rate-projection'
import type { ComfortStatus } from './comfort-status'
import { readPushConfig } from './push-config'
import { sendPushNotification } from './push-sender'
import { getSubscriptions } from './push-subscription-store'
import {
  getPushUserNotificationState,
  getPushUserPreferences,
  setPushUserNotificationState,
} from './push-preferences-store'

type LivePushInput = {
  userId: number;
  comfortStatus: ComfortStatus;
  burnRateProjection?: BurnRateProjection;
  alertDecision?: AlertDecision;
}

type NotificationPayload = { title: string; body: string }

function toOneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

function deriveBurnRatePerHour(projection?: BurnRateProjection): number | null {
  if (!projection) return null
  if (!Number.isFinite(projection.averageCreditsPerDay)) return null
  const perHour = projection.averageCreditsPerDay / 24
  return Number.isFinite(perHour) && perHour >= 0 ? perHour : null
}

function hoursUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / 3_600_000
}

function shouldNotifyStatusTransition(
  previous: string | null,
  current: string,
  prefs: Awaited<ReturnType<typeof getPushUserPreferences>>,
): boolean {
  if (!prefs.notifyOnStatusLevelChange) return false
  if (previous === null || previous === current) return false
  if (current === 'hot') return prefs.notifyWhenStatusBecomesHot
  if (current === 'overage') return prefs.notifyWhenStatusBecomesOverage
  if (current === 'blocked') return prefs.notifyWhenStatusBecomesBlocked
  return false
}

function shouldAllowAlertDecisionType(
  alertDecision: AlertDecision,
  prefs: Awaited<ReturnType<typeof getPushUserPreferences>>,
): boolean {
  if (!alertDecision.shouldAlert || !alertDecision.alertType) return false
  switch (alertDecision.alertType) {
    case 'overage_active':
      return prefs.notifyWhenStatusBecomesOverage
    case 'hard_stop':
    case 'exhausted':
      return prefs.notifyWhenStatusBecomesBlocked
    case 'approaching_exhaustion':
      return prefs.notifyWhenProjectedExhaustionWithinHours
    default:
      return false
  }
}

function burnRateIncreasePercent(previous: number, current: number): number {
  if (previous <= 0 || current <= previous) return 0
  return ((current - previous) / previous) * 100
}

function customDedupeKey(kind: string): string {
  const day = new Date().toISOString().slice(0, 10)
  return `${kind}:${day}`
}

async function sendToCurrentUserSubscriptions(
  userId: number,
  payload: NotificationPayload,
): Promise<boolean> {
  const config = readPushConfig()
  if (!config.isConfigured) return false

  const subscriptions = await getSubscriptions(userId)
  if (subscriptions.length === 0) return false

  const results = await Promise.all(
    subscriptions.map((record) => sendPushNotification(record, config, payload)),
  )
  return results.some(r => r.ok)
}

export async function maybeSendLivePushNotification(input: LivePushInput): Promise<void> {
  if (!Number.isFinite(input.userId) || input.userId <= 0) return

  const [prefs, state] = await Promise.all([
    getPushUserPreferences(input.userId),
    getPushUserNotificationState(input.userId),
  ])

  const currentBurnRatePerHour = deriveBurnRatePerHour(input.burnRateProjection)
  const currentLevel = input.comfortStatus.level

  // 1) alertDecision-based delivery (quiet duplicates using dedupeKey).
  if (
    input.alertDecision?.shouldAlert &&
    input.alertDecision.dedupeKey &&
    input.alertDecision.dedupeKey !== state.lastAlertDedupeKey &&
    shouldAllowAlertDecisionType(input.alertDecision, prefs)
  ) {
    const sent = await sendToCurrentUserSubscriptions(input.userId, {
      title: input.alertDecision.title ?? 'CopeLimit alert',
      body: input.alertDecision.message ?? input.alertDecision.reason,
    })
    if (sent) {
      await setPushUserNotificationState(input.userId, {
        lastComfortLevel: currentLevel,
        lastBurnRatePerHour: currentBurnRatePerHour,
        lastAlertDedupeKey: input.alertDecision.dedupeKey,
        lastExhaustionWithinThreshold: state.lastExhaustionWithinThreshold,
        lastCustomDedupeKey: state.lastCustomDedupeKey,
        updatedAt: new Date().toISOString(),
      })
      return
    }
  }

  // 2) status-level transition (hot/overage/blocked only by preference).
  if (shouldNotifyStatusTransition(state.lastComfortLevel, currentLevel, prefs)) {
    const dedupe = customDedupeKey(`status:${currentLevel}`)
    if (dedupe !== state.lastCustomDedupeKey) {
      const sent = await sendToCurrentUserSubscriptions(input.userId, {
        title: `CopeLimit status changed to ${currentLevel}`,
        body: input.comfortStatus.summary,
      })
      if (sent) {
        await setPushUserNotificationState(input.userId, {
          lastComfortLevel: currentLevel,
          lastBurnRatePerHour: currentBurnRatePerHour,
          lastAlertDedupeKey: input.alertDecision?.shouldAlert ? input.alertDecision.dedupeKey ?? null : null,
          lastExhaustionWithinThreshold: state.lastExhaustionWithinThreshold,
          lastCustomDedupeKey: dedupe,
          updatedAt: new Date().toISOString(),
        })
        return
      }
    }
  }

  // 3) projected exhaustion crosses into configured threshold window.
  if (
    prefs.notifyWhenProjectedExhaustionWithinHours &&
    input.burnRateProjection?.projectedExhaustionAt
  ) {
    const exhaustionHours = hoursUntil(input.burnRateProjection.projectedExhaustionAt)
    const withinThreshold = exhaustionHours <= prefs.projectedExhaustionThresholdHours
    const crossedIntoThreshold = withinThreshold && !state.lastExhaustionWithinThreshold

    if (crossedIntoThreshold) {
      const dedupe = customDedupeKey('projected-exhaustion')
      if (dedupe !== state.lastCustomDedupeKey) {
        const sent = await sendToCurrentUserSubscriptions(input.userId, {
          title: 'CopeLimit projected exhaustion is approaching',
          body: `Projected exhaustion is now within ${prefs.projectedExhaustionThresholdHours} hours.`,
        })
        if (sent) {
          await setPushUserNotificationState(input.userId, {
            lastComfortLevel: currentLevel,
            lastBurnRatePerHour: currentBurnRatePerHour,
            lastAlertDedupeKey: input.alertDecision?.shouldAlert ? input.alertDecision.dedupeKey ?? null : null,
            lastExhaustionWithinThreshold: true,
            lastCustomDedupeKey: dedupe,
            updatedAt: new Date().toISOString(),
          })
          return
        }
      }
    }
  }

  // 4) burn rate increases by configured threshold.
  if (
    prefs.notifyOnBurnRateIncrease &&
    state.lastBurnRatePerHour !== null &&
    currentBurnRatePerHour !== null
  ) {
    const increase = burnRateIncreasePercent(state.lastBurnRatePerHour, currentBurnRatePerHour)
    if (increase >= prefs.burnRateIncreasePercentThreshold) {
      const dedupe = customDedupeKey('burn-rate-increase')
      if (dedupe !== state.lastCustomDedupeKey) {
        const sent = await sendToCurrentUserSubscriptions(input.userId, {
          title: 'CopeLimit burn rate increased',
          body: `Burn rate rose from ${toOneDecimal(state.lastBurnRatePerHour)}/hr to ${toOneDecimal(currentBurnRatePerHour)}/hr (+${toOneDecimal(increase)}%).`,
        })
        if (sent) {
          await setPushUserNotificationState(input.userId, {
            lastComfortLevel: currentLevel,
            lastBurnRatePerHour: currentBurnRatePerHour,
            lastAlertDedupeKey: input.alertDecision?.shouldAlert ? input.alertDecision.dedupeKey ?? null : null,
            lastExhaustionWithinThreshold: state.lastExhaustionWithinThreshold,
            lastCustomDedupeKey: dedupe,
            updatedAt: new Date().toISOString(),
          })
          return
        }
      }
    }
  }

  // Always refresh baseline state when no push was delivered.
  const projectedAt = input.burnRateProjection?.projectedExhaustionAt
  const withinThresholdNow =
    prefs.notifyWhenProjectedExhaustionWithinHours &&
    typeof projectedAt === 'string' &&
    hoursUntil(projectedAt) <= prefs.projectedExhaustionThresholdHours

  await setPushUserNotificationState(input.userId, {
    lastComfortLevel: currentLevel,
    lastBurnRatePerHour: currentBurnRatePerHour,
    lastAlertDedupeKey: input.alertDecision?.shouldAlert ? input.alertDecision.dedupeKey ?? null : null,
    lastExhaustionWithinThreshold: withinThresholdNow,
    lastCustomDedupeKey: state.lastCustomDedupeKey,
    updatedAt: new Date().toISOString(),
  })
}

