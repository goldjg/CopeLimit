/**
 * @file Netlify Blobs storage layer for per-user push alert preferences/state.
 *
 * Store: `push-subscriptions` (Tier 2 metadata).
 *
 * Key layout:
 * - `settings/<userId>.json` — user-configurable push alert preferences
 * - `state/<userId>.json`    — last observed/sent telemetry state for dedupe
 */

import { getBlobStore } from './blob-store'
import type { ComfortLevel } from './comfort-status'

const PUSH_STORE = 'push-subscriptions'

function getPushStore() {
  return getBlobStore(PUSH_STORE)
}

function settingsKey(userId: number): string {
  return `settings/${userId}.json`
}

function stateKey(userId: number): string {
  return `state/${userId}.json`
}

function isValidUserId(userId: number | undefined): userId is number {
  return typeof userId === 'number' && Number.isInteger(userId) && Number.isFinite(userId) && userId > 0
}

export type PushUserPreferences = {
  /** Master toggle for comfort-level transition notifications. */
  notifyOnStatusLevelChange: boolean;
  /** Notify when status becomes hot. */
  notifyWhenStatusBecomesHot: boolean;
  /** Notify when status becomes overage. */
  notifyWhenStatusBecomesOverage: boolean;
  /** Notify when status becomes blocked (hard stop / exhausted). */
  notifyWhenStatusBecomesBlocked: boolean;
  /** Notify when projected exhaustion moves inside the threshold window. */
  notifyWhenProjectedExhaustionWithinHours: boolean;
  /** Imminent exhaustion threshold window in hours. */
  projectedExhaustionThresholdHours: number;
  /** Notify when burn rate increases by threshold percent. */
  notifyOnBurnRateIncrease: boolean;
  /** Burn-rate increase percent threshold. */
  burnRateIncreasePercentThreshold: number;
  updatedAt: string;
}

export type PushUserNotificationState = {
  lastComfortLevel: ComfortLevel | null;
  lastBurnRatePerHour: number | null;
  lastAlertDedupeKey: string | null;
  lastExhaustionWithinThreshold: boolean;
  lastCustomDedupeKey: string | null;
  updatedAt: string;
}

export const DEFAULT_PUSH_USER_PREFERENCES: PushUserPreferences = {
  notifyOnStatusLevelChange: true,
  notifyWhenStatusBecomesHot: true,
  notifyWhenStatusBecomesOverage: true,
  notifyWhenStatusBecomesBlocked: true,
  notifyWhenProjectedExhaustionWithinHours: true,
  projectedExhaustionThresholdHours: 24,
  notifyOnBurnRateIncrease: true,
  burnRateIncreasePercentThreshold: 25,
  updatedAt: new Date(0).toISOString(),
}

function clampThreshold(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(500, Math.max(1, Math.round(n)))
}

function clampExhaustionWindowHours(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(168, Math.max(1, Math.round(n)))
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizePreferences(value: unknown): PushUserPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_PUSH_USER_PREFERENCES }
  }

  const obj = value as Record<string, unknown>
  return {
    notifyOnStatusLevelChange: boolOrDefault(
      obj.notifyOnStatusLevelChange,
      DEFAULT_PUSH_USER_PREFERENCES.notifyOnStatusLevelChange,
    ),
    notifyWhenStatusBecomesHot: boolOrDefault(
      obj.notifyWhenStatusBecomesHot,
      DEFAULT_PUSH_USER_PREFERENCES.notifyWhenStatusBecomesHot,
    ),
    notifyWhenStatusBecomesOverage: boolOrDefault(
      obj.notifyWhenStatusBecomesOverage,
      DEFAULT_PUSH_USER_PREFERENCES.notifyWhenStatusBecomesOverage,
    ),
    notifyWhenStatusBecomesBlocked: boolOrDefault(
      obj.notifyWhenStatusBecomesBlocked,
      DEFAULT_PUSH_USER_PREFERENCES.notifyWhenStatusBecomesBlocked,
    ),
    notifyWhenProjectedExhaustionWithinHours: boolOrDefault(
      obj.notifyWhenProjectedExhaustionWithinHours,
      DEFAULT_PUSH_USER_PREFERENCES.notifyWhenProjectedExhaustionWithinHours,
    ),
    projectedExhaustionThresholdHours: clampExhaustionWindowHours(
      obj.projectedExhaustionThresholdHours,
      DEFAULT_PUSH_USER_PREFERENCES.projectedExhaustionThresholdHours,
    ),
    notifyOnBurnRateIncrease: boolOrDefault(
      obj.notifyOnBurnRateIncrease,
      DEFAULT_PUSH_USER_PREFERENCES.notifyOnBurnRateIncrease,
    ),
    burnRateIncreasePercentThreshold: clampThreshold(
      obj.burnRateIncreasePercentThreshold,
      DEFAULT_PUSH_USER_PREFERENCES.burnRateIncreasePercentThreshold,
    ),
    updatedAt:
      typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0
        ? obj.updatedAt
        : new Date().toISOString(),
  }
}

function normalizeState(value: unknown): PushUserNotificationState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      lastComfortLevel: null,
      lastBurnRatePerHour: null,
      lastAlertDedupeKey: null,
      lastExhaustionWithinThreshold: false,
      lastCustomDedupeKey: null,
      updatedAt: new Date().toISOString(),
    }
  }
  const obj = value as Record<string, unknown>
  return {
    lastComfortLevel: typeof obj.lastComfortLevel === 'string'
      ? (obj.lastComfortLevel as ComfortLevel)
      : null,
    lastBurnRatePerHour: Number.isFinite(Number(obj.lastBurnRatePerHour))
      ? Number(obj.lastBurnRatePerHour)
      : null,
    lastAlertDedupeKey: typeof obj.lastAlertDedupeKey === 'string' ? obj.lastAlertDedupeKey : null,
    lastExhaustionWithinThreshold: obj.lastExhaustionWithinThreshold === true,
    lastCustomDedupeKey: typeof obj.lastCustomDedupeKey === 'string' ? obj.lastCustomDedupeKey : null,
    updatedAt:
      typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0
        ? obj.updatedAt
        : new Date().toISOString(),
  }
}

export async function getPushUserPreferences(userId: number): Promise<PushUserPreferences> {
  if (!isValidUserId(userId)) {
    return { ...DEFAULT_PUSH_USER_PREFERENCES }
  }
  const raw = await getPushStore().get(settingsKey(userId), { type: 'json' })
  return normalizePreferences(raw)
}

export type PushUserPreferencesPatch = {
  notifyOnStatusLevelChange?: boolean;
  notifyWhenStatusBecomesHot?: boolean;
  notifyWhenStatusBecomesOverage?: boolean;
  notifyWhenStatusBecomesBlocked?: boolean;
  notifyWhenProjectedExhaustionWithinHours?: boolean;
  projectedExhaustionThresholdHours?: number;
  notifyOnBurnRateIncrease?: boolean;
  burnRateIncreasePercentThreshold?: number;
}

export async function setPushUserPreferences(
  userId: number,
  partial: PushUserPreferencesPatch,
): Promise<PushUserPreferences | null> {
  if (!isValidUserId(userId)) return null
  const current = await getPushUserPreferences(userId)
  const merged = normalizePreferences({
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  })
  await getPushStore().setJSON(settingsKey(userId), merged)
  return merged
}

export async function getPushUserNotificationState(userId: number): Promise<PushUserNotificationState> {
  if (!isValidUserId(userId)) {
    return {
      lastComfortLevel: null,
      lastBurnRatePerHour: null,
      lastAlertDedupeKey: null,
      lastExhaustionWithinThreshold: false,
      lastCustomDedupeKey: null,
      updatedAt: new Date(0).toISOString(),
    }
  }
  const raw = await getPushStore().get(stateKey(userId), { type: 'json' })
  return normalizeState(raw)
}

export async function setPushUserNotificationState(
  userId: number,
  state: PushUserNotificationState,
): Promise<boolean> {
  if (!isValidUserId(userId)) return false
  await getPushStore().setJSON(stateKey(userId), {
    ...state,
    updatedAt: new Date().toISOString(),
  })
  return true
}
