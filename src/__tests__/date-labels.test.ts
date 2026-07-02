import { describe, expect, it } from 'vitest'
import {
  formatProjectionLabel,
  formatRangeLabels,
  formatResetLabel,
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

  it('does not render Invalid Date for malformed values', () => {
    expect(formatRangeLabels('not-a-date', 'also-not-a-date')).toEqual({
      startLabel: 'unknown',
      endLabel: 'unknown',
    })
    expect(formatResetLabel('not-a-date')).toBeNull()
    expect(formatProjectionLabel('not-a-date')).toBeNull()
  })
})
