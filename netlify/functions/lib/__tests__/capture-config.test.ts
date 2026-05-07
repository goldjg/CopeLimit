import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCaptureConfig } from '../capture-config'

describe('readCaptureConfig', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('uses safe defaults', () => {
    process.env = {}

    const config = readCaptureConfig()

    expect(config).toEqual({
      enabled: false,
      retentionDays: 30,
      maxPerDay: 10,
      includeNormalized: true
    })
  })

  it('reads valid env config', () => {
    process.env = {
      CAPTURE_PROVIDER_RESPONSES: 'true',
      PROVIDER_CAPTURE_RETENTION_DAYS: '14',
      PROVIDER_CAPTURE_MAX_PER_DAY: '5',
      PROVIDER_CAPTURE_INCLUDE_NORMALIZED: 'false'
    }

    const config = readCaptureConfig()

    expect(config).toEqual({
      enabled: true,
      retentionDays: 14,
      maxPerDay: 5,
      includeNormalized: false
    })
  })

  it('falls back on invalid env values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    process.env = {
      CAPTURE_PROVIDER_RESPONSES: 'yes',
      PROVIDER_CAPTURE_RETENTION_DAYS: '0',
      PROVIDER_CAPTURE_MAX_PER_DAY: 'nan',
      PROVIDER_CAPTURE_INCLUDE_NORMALIZED: 'sure'
    }

    const config = readCaptureConfig()

    expect(config).toEqual({
      enabled: false,
      retentionDays: 30,
      maxPerDay: 10,
      includeNormalized: true
    })
    expect(warnSpy).toHaveBeenCalled()
  })
})
