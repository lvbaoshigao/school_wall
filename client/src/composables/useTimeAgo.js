/**
 * 时间格式化 composable
 * 统一各组件中重复的 timeAgo 逻辑
 */
import { useSettingsStore } from '../stores/settings'

function parseDate(value) {
  if (value == null || value === '' || !['string', 'number'].includes(typeof value) && !(value instanceof Date)) return null
  // 服务端 SQLite 使用 localtime；不额外添加 Z，保留已有时区语义。
  const date = new Date(typeof value === 'string' ? value.replace(' ', 'T') : value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function useTimeAgo() {
  // 用户可在设置里改成显示具体时间；store 尚未初始化时（如登录页）回落到相对时间
  let settings = null
  try { settings = useSettingsStore() } catch {}

  function timeAgo(date) {
    const d = parseDate(date)
    if (!d) return ''
    if (settings?.prefs?.time_format === 'absolute') {
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 0) return '刚刚'
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return `${mins}分钟前`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}天前`
    return d.toLocaleDateString()
  }

  /** 完整日期时间 */
  function fullTime(date) {
    const d = parseDate(date)
    if (!d) return ''
    return d.toLocaleString('zh-CN')
  }

  return { timeAgo, fullTime }
}
