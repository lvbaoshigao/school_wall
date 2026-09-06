import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

// 请求拦截器 - 自动添加token与当前校园墙上下文
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  const wallId = localStorage.getItem('currentWallId')
  if (wallId) {
    config.headers['X-Wall-Id'] = wallId
  }
  return config
})

// 响应拦截器 - 处理错误
let isRedirecting = false

function redirectTo(path) {
  if (isRedirecting) return
  isRedirecting = true
  // 使用 setTimeout 避免在后台定时器中直接导航导致浏览器强制聚焦
  setTimeout(() => { window.location.href = path }, 100)
}

api.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status
    const data = err.response?.data

    if (status === 401) {
      localStorage.removeItem('token')
      redirectTo('/login')
    } else if (status === 403 && data?.code === 'BANNED') {
      // 只认后端显式标记的封禁 403，普通权限不足的 403 不动它
      sessionStorage.setItem('banInfo', JSON.stringify({
        scope: data.scope || 'global',
        reason: data.reason || '',
        permanent: !!data.permanent,
        until: data.until || '',
        remainingMinutes: data.remainingMinutes || 0,
        error: data.error || '',
      }))
      // 墙内封禁不影响其它墙，保留登录态；全局封禁则清 token
      if (data.scope !== 'wall') localStorage.removeItem('token')
      redirectTo('/banned')
    }
    return Promise.reject(err)
  }
)

export default api
