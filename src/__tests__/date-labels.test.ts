import { describe, expect, it } from 'vitest'
import {
  formatDateRange,
  formatProjectionLabel,
  formatRangeLabels,
  formatResetLabel,
  formatWindowText,
} from '../date-labels'

describe('date labels', () => {
  it('formats same-day snapshots with a compact time for the latest point', () => {
    expect(formatRangeLabels('2026-07-02T08:15:00.000Z', '2026-07-02T20:28:00.000Z')).toEqual({
      startLabel: '2 Jul',
      endLabel: '2 Jul 20:28',
    })
  })

  it('formats multi-day ranges with short day/month labels', () => {
    expect(formatRangeLabels('2026-07-02T08:15:00.000Z', '2026-07-04T20:28:00.000Z')).toEqual({
      startLabel: '2 Jul',
      endLabel: '4 Jul',
    })
  })

  it('formats reset and projection labels for billing boundaries', () => {
    expect(formatResetLabel('2026-08-01T00:00:00.000Z')).toBe('Reset 1 Aug')
    expect(formatProjectionLabel('2026-07-19T00:00:00.000Z')).toBe('Runs out 19 Jul')
  })

  it('returns null instead of visible unknown labels for malformed values', () => {
    expect(formatRangeLabels('not-a-date', 'also-not-a-date')).toEqual({
      startLabel: null,
      endLabel: null,
    })
    expect(formatResetLabel('not-a-date')).toBeNull()
    expect(formatProjectionLabel('not-a-date')).toBeNull()
  })
})

describe('formatWindowText', () => {
  it('produces compact Window: label with arrow separator and snapshot count', () => {
    const result = formatWindowText('2026-07-01T03:53:00.000Z', '2026-07-02T21:05:00.000Z', 12)
    // Positive assertion: matches the documented example format
    expect(result).toMatch(/^Window: \d{1,2} \w{3} \d{2}:\d{2} → \d{1,2} \w{3} \d{2}:\d{2} · \d+ snapshots?$/)
    expect(result).toContain('12 snapshots')
    expect(result).not.toMatch(/:\d{2}:\d{2}/) // no seconds
  })

  it('uses singular "snapshot" when count is 1', () => {
    const result = formatWindowText('2026-07-01T03:53:00.000Z', '2026-07-01T21:05:00.000Z', 1)
    expect(result).toContain('1 snapshot')
    expect(result).not.toContain('1 snapshots')
  })

  it('returns null for invalid dates', () => {
    expect(formatWindowText('bad', '2026-07-02T21:05:00.000Z', 5)).toBeNull()
    expect(formatWindowText('2026-07-01T03:53:00.000Z', 'bad', 5)).toBeNull()
    expect(formatWindowText(null, null, 5)).toBeNull()
  })

  it('returns null when snapshotCount is less than 1', () => {
    expect(formatWindowText('2026-07-01T03:53:00.000Z', '2026-07-02T21:05:00.000Z', 0)).toBeNull()
  })
})

describe('formatDateRange', () => {
  it('produces compact start → end date range', () => {
    const result = formatDateRange('2026-07-01T00:00:00.000Z', '2026-07-31T23:59:00.000Z')
    expect(result).toContain('→')
    expect(result).toMatch(/1 Jul/)
    expect(result).toMatch(/31 Jul/)
  })

  it('returns null when either date is invalid', () => {
    expect(formatDateRange('bad', '2026-07-31T00:00:00.000Z')).toBeNull()
    expect(formatDateRange('2026-07-01T00:00:00.000Z', null)).toBeNull()
  })
})
