// 管理统计中 null 表示未授权或不可用，不能当成 0。
export function overviewCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function formatOverviewCount(value) {
  const count = overviewCount(value)
  return count == null ? '—' : count.toLocaleString('zh-CN')
}

export function normalizeAdminOverview(data) {
  if (data?.schema_version !== 1 || !['global', 'wall'].includes(data.scope?.kind)
    || !data.totals || !data.pending || !data.range || !Array.isArray(data.daily)
    || !Array.isArray(data.walls) || !Array.isArray(data.todos)) return null
  const counts = (value, keys) => Object.fromEntries(keys.map(key => [key, overviewCount(value?.[key])]))
  const pendingKeys = ['members', 'wall_applications', 'post_reports', 'safety_reports', 'user_reports', 'bug_reports', 'total']
  return {
    ...data,
    totals: counts(data.totals, ['users', 'active_users', 'banned_users', 'walls', 'active_walls', 'members', 'posts', 'anonymous_posts', 'comments', 'votes', 'likes', 'announcements', 'pending']),
    today: counts(data.today, ['users', 'posts', 'comments', 'votes', 'members']),
    pending: counts(data.pending, pendingKeys),
    daily: data.daily.filter(row => row && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(row.date)).map(row => ({
      date: row.date, ...counts(row, ['users', 'posts', 'comments', 'votes', 'members']),
    })),
    walls: data.walls.filter(wall => Number.isSafeInteger(wall?.id) && wall.id > 0).map(wall => ({
      ...wall, ...counts(wall, ['members', 'pending_members', 'posts', 'comments', 'votes', 'posts_in_range', 'pending_post_reports', 'pending_safety_reports']),
    })),
    todos: data.todos.filter(todo => todo && typeof todo.key === 'string' && typeof todo.title === 'string' && overviewCount(todo.count) != null),
  }
}

// SVG 坐标保留真实零点；空值断开折线，不虚构缺失统计。
export function buildOverviewTrend(rows, key) {
  const width = 640, height = 220, left = 48, right = 20, top = 20, bottom = 36
  const values = rows.map(row => overviewCount(row[key]))
  const maximum = Math.max(1, ...values.filter(value => value != null))
  const step = Math.max(1, Math.ceil(maximum / 4))
  const ceiling = step * 4
  const plotWidth = width - left - right, plotHeight = height - top - bottom
  const points = rows.map((row, index) => ({
    date: row.date, value: values[index],
    x: rows.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / Math.max(1, rows.length - 1),
    y: values[index] == null ? null : top + plotHeight * (1 - values[index] / ceiling),
  }))
  let connected = false
  const path = points.map(point => {
    if (point.y == null) { connected = false; return '' }
    const command = connected ? 'L' : 'M'
    connected = true
    return command + point.x.toFixed(2) + ',' + point.y.toFixed(2)
  }).filter(Boolean).join(' ')
  const labelEvery = Math.max(1, Math.ceil((points.length - 1) / 6))
  return {
    width, height, left, right, top, bottom, path, points,
    ticks: Array.from({ length: 5 }, (_, index) => ({ value: step * index, y: top + plotHeight * (1 - index / 4) })),
    labels: points.filter((_point, index) => index % labelEvery === 0 || index === points.length - 1),
    total: values.some(value => value != null) ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null,
  }
}

export function formatOverviewTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

export function formatOverviewUptime(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const minutes = Math.floor(value / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes % 1440 / 60)
  return (days ? days + ' 天 ' : '') + hours + ' 小时 ' + minutes % 60 + ' 分钟'
}
