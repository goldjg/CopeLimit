import { afterEach, describe, expect, it, vi } from 'vitest'
import { readUsageHistoryConfig } from '../usage-history-config'

describe('readUsageHistoryConfig', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('uses safe defaults when no env vars are set', () => {
    process.env = {}

    const config = readUsageHistoryConfig()

    expect(config).toEqual({
      enabled: false,
      retentionDays: 90,
      maxPerDay: 48,
    })
  })

  it('reads valid env config', () => {
    process.env = {
      USAGE_HISTORY_ENABLED: 'true',
      USAGE_HISTORY_RETENTION_DAYS: '30',
      USAGE_HISTORY_MAX_PER_DAY: '24',
    }

    const config = readUsageHistoryConfig()

    expect(config).toEqual({
      enabled: true,
      retentionDays: 30,
      maxPerDay: 24,
    })
  })

  it('falls back on invalid env values and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    process.env = {
      USAGE_HISTORY_ENABLED: 'yes',
      USAGE_HISTORY_RETENTION_DAYS: '5.5',
      USAGE_HISTORY_MAX_PER_DAY: 'nan',
    }

    const config = readUsageHistoryConfig()

    expect(config).toEqual({
      enabled: false,
      retentionDays: 90,
      maxPerDay: 48,
    })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('treats zero as invalid for integer fields', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    process.env = {
      USAGE_HISTORY_RETENTION_DAYS: '0',
      USAGE_HISTORY_MAX_PER_DAY: '0',
    }

    const config = readUsageHistoryConfig()

    expect(config.retentionDays).toBe(90)
    expect(config.maxPerDay).toBe(48)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('treats false string as disabled', () => {
    process.env = {
      USAGE_HISTORY_ENABLED: 'false',
    }

    const config = readUsageHistoryConfig()

    expect(config.enabled).toBe(false)
  })
})
