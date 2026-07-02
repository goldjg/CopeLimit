function parseDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatShortDate(value: string | Date | null | undefined, fallback = 'unknown'): string {
  const date = parseDate(value)
  if (!date) return fallback
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function formatDateTime(value: string | Date | null | undefined, fallback = 'unknown'): string {
  const date = parseDate(value)
  if (!date) return fallback
  const dayMonth = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${dayMonth} ${time}`
}

export function formatRangeLabels(
  startValue: string | Date | null | undefined,
  endValue: string | Date | null | undefined,
  fallback = 'unknown',
): { startLabel: string; endLabel: string } {
  const start = parseDate(startValue)
  const end = parseDate(endValue)
  if (!start || !end) {
    return { startLabel: fallback, endLabel: fallback }
  }

  const sameDay = start.toDateString() === end.toDateString()
  return {
    startLabel: formatShortDate(start, fallback),
    endLabel: sameDay ? formatDateTime(end, fallback) : formatShortDate(end, fallback),
  }
}

export function formatResetLabel(value: string | Date | null | undefined): string | null {
  const date = formatShortDate(value)
  return date === 'unknown' ? null : `Reset ${date}`
}

export function formatProjectionLabel(value: string | Date | null | undefined): string | null {
  const date = formatShortDate(value)
  return date === 'unknown' ? null : `Runs out ${date}`
}
