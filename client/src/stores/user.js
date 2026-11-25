import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import api, { getSessionToken, setSessionToken, subscribeSessionChange, getApiErrorMessage } from '../api'
import { postDrafts } from '../utils/postDrafts.js'

export const useUserStore = defineStore('user', () => {
  const token = ref(getSessionToken())
  const user = ref(null)
  const perms = ref({ global: [], walls: {} })
  const sessionRevision = ref(0)
  const restoreError = ref('')
  let restorePromise = null
  let authRequest = 0
  const isLoggedIn = computed(() => !!token.value)
  const globalPerms = computed(() => new Set(perms.value.global || []))
  const roleLabel = computed(() => ({ super_admin: '超级管理员', admin: '全局管理员', user: '普通用户' })[user.value?.role] || '')

  onScopeDispose(subscribeSessionChange(event => {
    token.value = event.token
    if (event.resetContext) {
      authRequest++
      if (user.value?.id) postDrafts.clearUser(user.value.id)
      else postDrafts.clearAll() // 刷新恢复身份前退出时也清除本标签页的残留草稿。
      user.value = null
      perms.value = { global: [], walls: {} }
      restoreError.value = ''
      restorePromise = null
      sessionRevision.value++
    }
  }))

  // 权限仅控制界面，服务端仍是所有操作的唯一授权方。
  function can(perm) { return globalPerms.value.has(perm) }
  function canInWall(perm, wallId) {
    if (!wallId) return globalPerms.value.has(perm)
    const list = perms.value.walls?.[wallId]
    return Array.isArray(list) ? list.includes(perm) : globalPerms.value.has(perm)
  }

  async function fetchPermissions() {
    const requestedToken = token.value
    if (!requestedToken) return
    try {
      const res = await api.get('/permissions/me')
      if (token.value !== requestedToken) return
      perms.value = { global: Array.isArray(res.data?.global) ? res.data.global : [], walls: res.data?.walls || {} }
    } catch {
      if (token.value === requestedToken) perms.value = { global: [], walls: {} }
    }
  }

  function acceptSession(data) {
    if (!data?.token || !data.user?.id) throw new Error('登录响应不完整，请重试')
    setSessionToken(data.token)
    user.value = data.user
  }

  function requireCurrentAuth(request) {
    // 同 token 重新登录、退出及跨标签页换号也会使旧认证意图失效。
    if (request !== authRequest) throw Object.assign(new Error('会话已变化，请重新操作'), { code: 'ERR_CANCELED' })
  }

  async function completeAuth(data, request) {
    requireCurrentAuth(request)
    acceptSession(data)
    // acceptSession 自身会推进序号；权限加载期间也不能覆盖更新的认证意图。
    const acceptedRequest = authRequest
    await fetchPermissions()
    requireCurrentAuth(acceptedRequest)
    return data
  }

  async function login(username, password) {
    const request = ++authRequest
    const res = await api.post('/auth/login', { username: username.trim(), password })
    return completeAuth(res.data, request)
  }

  async function register(username, password, nickname, real_name) {
    const request = ++authRequest
    const res = await api.post('/auth/register', { username: username.trim(), password, nickname: nickname.trim(), real_name: real_name.trim() })
    requireCurrentAuth(request)
    if (res.data?.token) return completeAuth(res.data, request)
    return res.data
  }

  async function fetchUser() {
    if (!token.value) return null
    if (restorePromise) return restorePromise
    const requestedToken = token.value
    const request = (async () => {
      restoreError.value = ''
      try {
        const res = await api.get('/auth/me')
        if (token.value !== requestedToken) return null
        user.value = res.data
        await fetchPermissions()
        return user.value
      } catch (error) {
        if (token.value !== requestedToken) return null
        if (error.response?.status === 401) logout()
        else restoreError.value = getApiErrorMessage(error, '无法恢复账户信息，请重试')
        return null
      }
    })()
    restorePromise = request
    try { return await request } finally { if (restorePromise === request) restorePromise = null }
  }

  async function updateProfile(data) {
    const requestedToken = token.value
    const res = await api.put('/auth/profile', data)
    if (token.value === requestedToken) user.value = { ...user.value, ...res.data }
    return res.data
  }

  async function updateAvatar(avatarBase64) {
    const requestedToken = token.value
    const res = await api.put('/auth/avatar', { avatar: avatarBase64 })
    if (token.value === requestedToken && user.value) user.value = { ...user.value, avatar: res.data.avatar }
    return res.data
  }

  async function changePassword(oldPassword, newPassword) {
    const requestedToken = token.value
    const res = await api.put('/auth/password', { oldPassword, newPassword })
    if (res.data?.token && token.value === requestedToken) setSessionToken(res.data.token, { resetContext: false })
    return res
  }

  function logout() { setSessionToken('') }

  return {
    token, user, perms, isLoggedIn, roleLabel, sessionRevision, restoreError,
    can, canInWall, fetchPermissions, acceptSession,
    login, register, fetchUser, updateProfile, updateAvatar, changePassword, logout,
  }
})
