import { describe, expect, it } from 'vitest'
import { buildCaptureKey, buildIndexKey, isDateExpired } from '../capture-store'

describe('capture-store key helpers', () => {
  it('builds capture keys by provider/user/day/timestamp', () => {
    const key = buildCaptureKey('github-copilot-internal', 123, '2026-05-07T04:06:21.390Z')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/2026-05-07T04:06:21.390Z.json')
  })

  it('builds daily index key', () => {
    const key = buildIndexKey('github-copilot-internal', 123, '2026-05-07')
    expect(key).toBe('github-copilot-internal/123/2026-05-07/_index.json')
  })

  it('expires keys older than retention cutoff', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    expect(isDateExpired('2026-05-15', 30, now)).toBe(true)
    expect(isDateExpired('2026-05-16', 30, now)).toBe(false)
    expect(isDateExpired('2026-06-14', 30, now)).toBe(false)
  })
})
