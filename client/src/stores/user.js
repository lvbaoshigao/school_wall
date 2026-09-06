import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '../api'

export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem('token') || '')
  const user = ref(null)
  // 有效权限，来自 GET /api/permissions/me：{ global: [...], walls: { '<wallId>': [...] } }
  // 只用于决定界面显示什么，真正的拦截一律在服务端 —— 改这里不等于放宽权限。
  const perms = ref({ global: [], walls: {} })

  const isLoggedIn = computed(() => !!token.value)
  const globalPerms = computed(() => new Set(perms.value.global || []))

  // 角色现在只是「名号」，仅用于展示与目标保护（比如「不能删除超级管理员」），
  // 不再作为能力判据 —— 能不能做某事一律问 can() / canInWall()。
  const roleLabel = computed(() => ({
    super_admin: '超级管理员', admin: '全局管理员', user: '普通用户',
  })[user.value?.role] || '')

  /** 全局作用域下是否拥有某权限 */
  function can(perm) {
    return globalPerms.value.has(perm)
  }

  /** 在某个校园墙里是否拥有某权限 */
  function canInWall(perm, wallId) {
    if (!wallId) return globalPerms.value.has(perm)
    const list = perms.value.walls?.[wallId]
    // walls 里只有「我是成员」的墙。不是成员时退回全局授予 ——
    // 全局管理员就是靠全局作用域持有 wall.* 才能跨墙审核的。
    if (list) return list.includes(perm)
    return globalPerms.value.has(perm)
  }

  async function fetchPermissions() {
    if (!token.value) return
    try {
      const res = await api.get('/permissions/me')
      perms.value = { global: res.data.global || [], walls: res.data.walls || {} }
    } catch {
      // 拉不到就当作没有任何额外权限，界面退化为普通用户视图
      perms.value = { global: [], walls: {} }
    }
  }

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password })
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('token', res.data.token)
    await fetchPermissions()
    return res.data
  }

  async function register(username, password, nickname, real_name) {
    const res = await api.post('/auth/register', { username, password, nickname, real_name })
    if (res.data.token) {
      token.value = res.data.token
      user.value = res.data.user
      localStorage.setItem('token', res.data.token)
      await fetchPermissions()
    }
    return res.data
  }

  async function fetchUser() {
    if (!token.value) return
    try {
      const res = await api.get('/auth/me')
      user.value = res.data
      await fetchPermissions()
    } catch {
      logout()
    }
  }

  async function updateProfile(data) {
    const res = await api.put('/auth/profile', data)
    user.value = res.data
    return res.data
  }

  async function updateAvatar(avatarBase64) {
    const res = await api.put('/auth/avatar', { avatar: avatarBase64 })
    user.value.avatar = res.data.avatar
    return res.data
  }

  async function changePassword(oldPassword, newPassword) {
    return await api.put('/auth/password', { oldPassword, newPassword })
  }

  function logout() {
    token.value = ''
    user.value = null
    perms.value = { global: [], walls: {} }
    localStorage.removeItem('token')
    localStorage.removeItem('currentWallId')
  }

  return {
    token, user, perms, isLoggedIn, roleLabel,
    can, canInWall, fetchPermissions,
    login, register, fetchUser, updateProfile, updateAvatar, changePassword, logout
  }
})
