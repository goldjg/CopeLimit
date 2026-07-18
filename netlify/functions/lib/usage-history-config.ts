/**
 * @file Reads the usage history subsystem configuration from environment variables.
 *
 * All history persistence is off by default. Individual options are controlled
 * by the environment variables documented in {@link readUsageHistoryConfig}.
 */
import type { UsageHistoryConfig } from './usage-history-types'

const DEFAULT_USAGE_HISTORY_CONFIG: UsageHistoryConfig = {
  enabled: false,
  retentionDays: 90,
  maxPerDay: 48,
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  console.warn(`[usage-history-config] Invalid boolean for ${name}; using default`, { value, fallback })
  return fallback
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback

  if (!/^[0-9]+$/.test(value)) {
    console.warn(`[usage-history-config] Invalid integer for ${name}; using default`, { value, fallback })
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed

  console.warn(`[usage-history-config] Invalid integer for ${name}; using default`, { value, fallback })
  return fallback
}

/**
 * Reads the usage history subsystem configuration from environment variables.
 *
 * | Variable                        | Type    | Default | Description                                          |
 * |---------------------------------|---------|---------|------------------------------------------------------|
 * | `USAGE_HISTORY_ENABLED`         | boolean | `false` | Enable/disable snapshot persistence                  |
 * | `USAGE_HISTORY_RETENTION_DAYS`  | integer | `90`    | Days to retain history entries (lazy cleanup)        |
 * | `USAGE_HISTORY_MAX_PER_DAY`     | integer | `48`    | Max snapshots stored per user per UTC day            |
 *
 * Invalid values are ignored and the documented defaults are used instead; a
 * console warning is emitted for each invalid value.
 *
 * @returns A validated {@link UsageHistoryConfig} ready for use by {@link appendSnapshot}.
 */
export function readUsageHistoryConfig(): UsageHistoryConfig {
  return {
    enabled: readBoolean('USAGE_HISTORY_ENABLED', DEFAULT_USAGE_HISTORY_CONFIG.enabled),
    retentionDays: readPositiveInteger('USAGE_HISTORY_RETENTION_DAYS', DEFAULT_USAGE_HISTORY_CONFIG.retentionDays),
    maxPerDay: readPositiveInteger('USAGE_HISTORY_MAX_PER_DAY', DEFAULT_USAGE_HISTORY_CONFIG.maxPerDay),
  }
}
