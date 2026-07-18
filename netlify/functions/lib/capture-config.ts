/**
 * @file Reads the provider capture subsystem configuration from environment variables.
 *
 * All capture behaviour is off by default. Individual options are controlled
 * by the environment variables documented in {@link readCaptureConfig}.
 */
import type { CaptureConfig } from './capture-types'

const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  enabled: false,
  retentionDays: 30,
  maxPerDay: 10,
  includeNormalized: true
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  console.warn(`[capture-config] Invalid boolean for ${name}; using default`, { value, fallback })
  return fallback
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback

  if (!/^[0-9]+$/.test(value)) {
    console.warn(`[capture-config] Invalid integer for ${name}; using default`, { value, fallback })
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed

  console.warn(`[capture-config] Invalid integer for ${name}; using default`, { value, fallback })
  return fallback
}

/**
 * Reads the capture subsystem configuration from environment variables.
 *
 * | Variable                           | Type    | Default | Description                              |
 * |------------------------------------|---------|---------|------------------------------------------|
 * | `CAPTURE_PROVIDER_RESPONSES`       | boolean | `false` | Enable/disable capture                   |
 * | `PROVIDER_CAPTURE_RETENTION_DAYS`  | integer | `30`    | Days to retain capture records           |
 * | `PROVIDER_CAPTURE_MAX_PER_DAY`     | integer | `10`    | Max captures stored per user per day     |
 * | `PROVIDER_CAPTURE_INCLUDE_NORMALIZED` | boolean | `true` | Include normalised usage in captures  |
 *
 * Invalid values are ignored and the documented defaults are used instead; a
 * console warning is emitted for each invalid value.
 *
 * @returns A validated {@link CaptureConfig} ready for use by {@link maybeCapture}.
 */
export function readCaptureConfig(): CaptureConfig {
  return {
    enabled: readBoolean('CAPTURE_PROVIDER_RESPONSES', DEFAULT_CAPTURE_CONFIG.enabled),
    retentionDays: readPositiveInteger('PROVIDER_CAPTURE_RETENTION_DAYS', DEFAULT_CAPTURE_CONFIG.retentionDays),
    maxPerDay: readPositiveInteger('PROVIDER_CAPTURE_MAX_PER_DAY', DEFAULT_CAPTURE_CONFIG.maxPerDay),
    includeNormalized: readBoolean('PROVIDER_CAPTURE_INCLUDE_NORMALIZED', DEFAULT_CAPTURE_CONFIG.includeNormalized)
  }
}
