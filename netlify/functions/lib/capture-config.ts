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

export function readCaptureConfig(): CaptureConfig {
  return {
    enabled: readBoolean('CAPTURE_PROVIDER_RESPONSES', DEFAULT_CAPTURE_CONFIG.enabled),
    retentionDays: readPositiveInteger('PROVIDER_CAPTURE_RETENTION_DAYS', DEFAULT_CAPTURE_CONFIG.retentionDays),
    maxPerDay: readPositiveInteger('PROVIDER_CAPTURE_MAX_PER_DAY', DEFAULT_CAPTURE_CONFIG.maxPerDay),
    includeNormalized: readBoolean('PROVIDER_CAPTURE_INCLUDE_NORMALIZED', DEFAULT_CAPTURE_CONFIG.includeNormalized)
  }
}
