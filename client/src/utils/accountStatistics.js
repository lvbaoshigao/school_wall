const COUNT_FIELDS = ['walls_joined', 'friends', 'named_posts', 'comments', 'bookmarks', 'votes_participated']
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/

/** Parse SQLite local datetime values without silently changing their timezone. */
export function parseRegisteredAt(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const input = value.trim()
  const local = LOCAL_DATE_TIME.exec(input)
  if (!local) {
    const parsed = new Date(input)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }

  const [, yearText, monthText, dayText, hourText = '0', minuteText = '0', secondText = '0', fraction = '0'] = local
  const year = Number(yearText), month = Number(monthText), day = Number(dayText)
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, second, Number(fraction.padEnd(3, '0')))
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null
  return date
}

export function formatRegisteredAt(value) {
  const date = parseRegisteredAt(value)
  if (!date) return value == null || value === '' ? '暂无记录' : '日期暂不可用'
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** Registration day counts as day one; invalid/future dates have no day count. */
export function joinedDays(value, now = Date.now()) {
  const date = parseRegisteredAt(value)
  if (!date || !Number.isFinite(now) || date.getTime() > now) return null
  return Math.floor((now - date.getTime()) / 86400000) + 1
}

/** Reject incomplete or malformed responses rather than presenting missing data as zero. */
export function normalizeAccountOverview(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (!(data.registered_at === null || typeof data.registered_at === 'string')) return null
  if (!data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) return null
  const counts = {}
  for (const field of COUNT_FIELDS) {
    const value = data.counts[field]
    if (!Number.isSafeInteger(value) || value < 0) return null
    counts[field] = value
  }
  return { registered_at: data.registered_at, counts }
}
