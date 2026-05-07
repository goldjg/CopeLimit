import { describe, expect, it } from 'vitest'
import { buildCaptureKey, buildIndexKey, isDateExpired, maybeCapture } from '../capture-store'

describe('capture-store key helpers', () => {
  it('builds capture keys by provider/user/day/timestamp', () => {
    const key = buildCaptureKey('github-copilot-internal', 123, '2026-05-07T04:06:21.390Z')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/2026-05-07T04:06:21.390Z.json')
  })

  it('builds daily index key', () => {
    const key = buildIndexKey('github-copilot-internal', 123, '2026-05-07')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/_index.json')
  })

  it('rejects unsafe provider path values', () => {
    expect(() => buildCaptureKey('../evil', 123, '2026-05-07T04:06:21.390Z')).toThrow('Invalid provider key')
    expect(() => buildIndexKey('../evil', 123, '2026-05-07')).toThrow('Invalid provider key')
  })

  it('expires keys older than retention cutoff', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-05-15', 30, now)).toBe(true)
    expect(isDateExpired('2026-05-16', 30, now)).toBe(false)
    expect(isDateExpired('2026-06-14', 30, now)).toBe(false)
  })
})

describe('maybeCapture guards', () => {
  it('skips capture when userId is missing', async () => {
    await expect(
      maybeCapture({
        config: {
          enabled: true,
          retentionDays: 30,
          maxPerDay: 10,
          includeNormalized: true
        },
        provider: 'github-copilot-internal',
        usage: {
          mode: 'premium_requests',
          used: 1,
          quota: 10,
          remaining: 9,
          percentUsed: 10,
          resetAt: '2026-06-01T00:00:00.000Z',
          billingEntity: 'x',
          source: 'github-copilot-internal',
          warningLevel: 'normal',
          updatedAt: '2026-05-07T00:00:00.000Z',
          notes: []
        },
        rawPayload: { quota: 10 }
      })
    ).resolves.toBeUndefined()
  })

  it('skips capture when userId is non-integer', async () => {
    await expect(
      maybeCapture({
        config: {
          enabled: true,
          retentionDays: 30,
          maxPerDay: 10,
          includeNormalized: true
        },
        provider: 'github-copilot-internal',
        userId: 1.5,
        usage: {
          mode: 'premium_requests',
          used: 1,
          quota: 10,
          remaining: 9,
          percentUsed: 10,
          resetAt: '2026-06-01T00:00:00.000Z',
          billingEntity: 'x',
          source: 'github-copilot-internal',
          warningLevel: 'normal',
          updatedAt: '2026-05-07T00:00:00.000Z',
          notes: []
        },
        rawPayload: { quota: 10 }
      })
    ).resolves.toBeUndefined()
  })
})
