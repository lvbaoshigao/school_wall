import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 10000 })
const sessionListeners = new Set()

export function readStorage(key, storage = 'localStorage') {
  try { return globalThis[storage]?.getItem(key) ?? null } catch { return null }
}

export function writeStorage(key, value, storage = 'localStorage') {
  try {
    if (value == null || value === '') globalThis[storage]?.removeItem(key)
    else globalThis[storage]?.setItem(key, String(value))
  } catch { /* 禁用存储时仍允许当前标签页使用内存会话。 */ }
}

let sessionToken = readStorage('token') || ''
let requestWallId = readStorage('currentWallId') || ''
export function setRequestWallId(value) {
  const id = Number(value)
  requestWallId = Number.isSafeInteger(id) && id > 0 ? String(id) : ''
  writeStorage('currentWallId', requestWallId)
}

export function getSessionToken() { return sessionToken }
export function subscribeSessionChange(listener) {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

// resetContext=false 仅用于同一账户改密后的 token 换发。
export function setSessionToken(value, { resetContext = true } = {}) {
  const nextToken = typeof value === 'string' ? value : ''
  const previousToken = sessionToken
  sessionToken = nextToken
  writeStorage('token', nextToken)
  if (resetContext) {
    setRequestWallId(null)
    writeStorage('banInfo', null, 'sessionStorage')
  }
  for (const listener of sessionListeners) listener({ token: nextToken, previousToken, resetContext })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== globalThis.localStorage) return
    if (event.key === 'token' || event.key === null) {
      const nextToken = event.key === null ? '' : (event.newValue || '')
      if (nextToken !== sessionToken) setSessionToken(nextToken)
    }
  })
}

export function getApiErrorMessage(error, fallback = '请求失败，请稍后重试') {
  const message = error?.response?.data?.error
  if (error?.response?.status === 404 && message === '接口不存在') {
    return '服务版本尚未更新，请重启后端服务后重试；刷新网页不能更新后端。'
  }
  if (typeof message === 'string' && message.trim()) return message.slice(0, 500)
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return '请求超时，请检查网络后重试'
  if (!error?.response && error?.request) return '网络连接失败，请检查网络后重试'
  if (error?.response?.status === 429) return '操作过于频繁，请稍后重试'
  if (error?.response?.status >= 500) return '服务暂时不可用，请稍后重试'
  return fallback
}

export function getUsernameError(value) {
  if (typeof value !== 'string' || !value.trim()) return '请输入用户名'
  if (value.trim().length < 3 || value.trim().length > 20) return '用户名需要 3–20 个字符'
  if ([...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return '用户名不能包含控制字符'
  return ''
}

export function getPasswordError(value, { login = false } = {}) {
  if (typeof value !== 'string' || !value) return '请输入密码'
  if (!login && value.length < 6) return '密码至少需要 6 个字符'
  if (new TextEncoder().encode(value).length > 1024) return '密码过长，请控制在 1024 字节以内'
  return ''
}

api.interceptors.request.use(config => {
  config.headers = config.headers || {}
  if (sessionToken && !config.headers.Authorization) config.headers.Authorization = 'Bearer ' + sessionToken
  const pathWallId = new RegExp('(?:^|/)walls/([0-9]+)(?:/|$)').exec(config.url || '')?.[1]
  const wallId = pathWallId || requestWallId
  // 帖子卡片等调用方可明确指定所属墙，禁止用当前墙覆盖。
  const explicitWall = Object.keys(config.headers).some(key => key.toLowerCase() === 'x-wall-id')
  if (!explicitWall && /^[1-9][0-9]*$/.test(wallId || '')) config.headers['X-Wall-Id'] = wallId
  return config
})

let redirectingTo = ''
function redirectTo(path) {
  if (typeof window === 'undefined' || window.location.pathname === path || redirectingTo === path) return
  redirectingTo = path
  window.location.replace(path)
}

api.interceptors.response.use(res => res, async error => {
  // blob 下载失败时也读取服务端的 JSON 错误，供原调用方兼容使用。
  if (typeof Blob !== 'undefined' && error.response?.data instanceof Blob) {
    try { error.response.data = JSON.parse(await error.response.data.text()) } catch {}
  }
  const status = error.response?.status
  const data = error.response?.data
  const requestToken = error.config?.headers?.Authorization?.replace(/^Bearer /, '')
  const isCurrentSession = !!requestToken && requestToken === sessionToken
  const publicAuth = new RegExp('^(?:/auth/(?:login|register)|/setup(?:/status)?)(?:[/?]|$)').test(error.config?.url || '')

  // 登录密码错误应留在表单；旧请求的401不能注销刚换发的新会话。
  if (status === 401 && !publicAuth && isCurrentSession) {
    setSessionToken('')
    redirectTo('/login')
  } else if (status === 403 && data?.code === 'BANNED' && (!requestToken || isCurrentSession)) {
    writeStorage('banInfo', JSON.stringify({
      scope: data.scope === 'wall' ? 'wall' : 'global', reason: data.reason || '',
      permanent: data.permanent === true, until: data.until || '',
      remainingMinutes: data.remainingMinutes || 0, error: data.error || '',
      banLevel: data.banLevel || 'login',
    }), 'sessionStorage')
    // 保留当前凭证以便提交申诉；其它受限操作仍由服务端拒绝。
    redirectTo('/banned')
  }
  return Promise.reject(error)
})

export default api
