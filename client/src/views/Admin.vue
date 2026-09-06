<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useMarkdown } from '../composables/useMarkdown'

marked.setOptions({ breaks: true, gfm: true })

const userStore = useUserStore()
const wallStore = useWallStore()
const route = useRoute()
const toast = useToast()
const { truncateText } = useMarkdown()
const errorMsg = ref('')

// 面板可见性。一律按具体权限判断，不再看名号 ——
// 这样单独授予/收回某一项权限时，界面会跟着变。
const can = (perm) => userStore.can(perm)
const canHere = (perm) => wallStore.canHere(perm)

const currentWall = computed(() => wallStore.currentWall)
// 社区管理区：持有任一全局管理能力即可进入
const hasGlobalPanel = computed(() =>
  can('global.moderate') || can('global.user.manage') || can('global.report.handle') ||
  can('global.wall.approve') || can('global.wall.manage') || can('global.bug.handle') ||
  can('global.permission.manage'))
// 本墙管理区：在当前墙持有任一管理能力即可
const hasWallContext = computed(() => !!wallStore.currentWallId && (
  canHere('wall.stats.view') || canHere('wall.member.view') || canHere('wall.announcement') ||
  canHere('wall.category') || canHere('wall.post.report') || canHere('wall.safety.report') ||
  canHere('wall.edit')))

// 默认面板：有墙管理权限则墙后台，否则全局
const activePanel = ref('wallStats')

// ===== 墙后台数据 =====
const wallStats = ref(null)
const wallMembers = ref([])
const pendingMembers = ref([])
const announcements = ref([])
const annForm = ref({ title: '', content: '', is_pinned: false, delete_at: '', is_markdown: true, scope: 'wall' })
const annLoading = ref(false)
const showMdPreview = ref(false)
const mdTextarea = ref(null)
const categories = ref([])
const postReports = ref([])
const postReportStatusFilter = ref('')

// ===== 全局后台数据 =====
const gStats = ref(null)
const users = ref([])
const userFilter = ref({ role: '', status: '', q: '' })
const wallApps = ref([])
const allWalls = ref([])
const userReports = ref([])
const userReportStatusFilter = ref('')
const safetyReports = ref([])
const safetyStatusFilter = ref('')

// 用户设置弹窗
const showSettings = ref(false)
const settingsUser = ref(null)
const settingsForm = ref({ role: 'user', ban_duration: 0, ban_reason: '', ban_level: 'login' })

// 页面内弹窗替代 confirm/prompt
const showRemoveConfirm = ref(false)
const showTransferConfirm = ref(false)
const showDeleteAnnConfirm = ref(false)
const showDeleteCategoryConfirm = ref(false)
const showDeleteUserConfirm = ref(false)
const showBanWallConfirm = ref(false)
const showUnbanConfirm = ref(false)
const confirmTarget = ref(null)
const banDuration = ref('1440')
const banReason = ref('')
const safetyNote = ref('')
const reportFeedback = ref('')
const showSafetyNote = ref(false)
const showReportFeedback = ref(false)
const showWarnConfirm = ref(false)
const warnText = ref('')
const showBanReportConfirm = ref(false)
const banReportDuration = ref('1440')

// Bug 反馈
const bugReports = ref([])
const bugReportsLoading = ref(false)

async function loadBugReports() {
  bugReportsLoading.value = true
  try {
    bugReports.value = (await api.get('/bug-reports/admin')).data
  } catch { errorMsg.value = '加载 Bug 反馈失败' }
  bugReportsLoading.value = false
}

async function updateBugReportStatus(id, status, reply) {
  try {
    const body = { status }
    if (reply) body.reply = reply
    await api.put(`/bug-reports/${id}/status`, body)
    loadBugReports()
    toast.success('已更新')
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}

const wallRoleLabel = (r) => ({ owner: '墙主', admin: '校园墙管理员', tree_hole: '树洞志愿者', member: '成员' })[r] || r
const globalRoleLabel = (r) => ({ super_admin: '超级管理员', admin: '全局管理员', user: '普通用户' })[r] || r
const reportStatusLabel = (s) => ({ pending: '待处理', processing: '处理中', resolved: '已处理', rejected: '已驳回' })[s] || s

// ========== 墙后台 ==========
async function loadWallStats() {
  try { wallStats.value = (await api.get('/admin/wall/stats')).data }
  catch (e) { errorMsg.value = '加载墙统计失败: ' + (e.response?.data?.error || e.message) }
}
async function loadMembers() {
  try {
    const all = (await api.get('/walls/' + wallStore.currentWallId + '/members')).data
    // 被墙内封禁的成员仍要留在列表里，否则管理员无从解封
    wallMembers.value = all.filter(m => m.status === 'active' || m.status === 'banned')
    pendingMembers.value = all.filter(m => m.status === 'pending')
  } catch (e) { errorMsg.value = '加载成员失败: ' + (e.response?.data?.error || e.message) }
}
async function approveMember(uid, ok) {
  try {
    await api.post(`/walls/${wallStore.currentWallId}/members/${uid}/${ok ? 'approve' : 'reject'}`)
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function setMemberRole(uid, wall_role) {
  try {
    await api.put(`/walls/${wallStore.currentWallId}/members/${uid}/role`, { wall_role })
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function removeMember(uid) {
  confirmTarget.value = uid
  showRemoveConfirm.value = true
}

async function doRemoveMember() {
  try {
    await api.post(`/walls/${wallStore.currentWallId}/members/${confirmTarget.value}/remove`)
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

// 墙内封禁：只影响当前校园墙，对方在其它墙不受影响
async function banMember(m) {
  const name = m.nickname || m.username
  confirmTarget.value = m
  banDuration.value = '1440'
  banReason.value = ''
  showBanWallConfirm.value = true
}

async function doBanMember() {
  const m = confirmTarget.value
  if (!m) return
  const duration = parseInt(banDuration.value)
  if (Number.isNaN(duration) || duration < 0) { toast.error('时长必须是 0 或正整数分钟'); return }
  if (!banReason.value.trim()) { toast.error('请填写封禁原因'); return }
  try {
    const res = await api.post(`/walls/${wallStore.currentWallId}/members/${m.user_id}/ban`, {
      duration, reason: banReason.value.trim(),
    })
    toast.success(res.data.message || '已封禁')
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

async function unbanMember(m) {
  confirmTarget.value = m
  showUnbanConfirm.value = true
}

async function doUnbanMember() {
  const m = confirmTarget.value
  if (!m) return
  try {
    const res = await api.post(`/walls/${wallStore.currentWallId}/members/${m.user_id}/unban`)
    toast.success(res.data.message || '已解除封禁')
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

// ===== 封禁日志 =====
const banLogs = ref([])
const banLogsLoading = ref(false)
async function loadBanLogs() {
  banLogsLoading.value = true
  try {
    banLogs.value = (await api.get('/admin/ban-logs')).data
  } catch (e) {
    errorMsg.value = '加载封禁日志失败: ' + (e.response?.data?.error || e.message)
  } finally {
    banLogsLoading.value = false
  }
}
async function transferOwner(uid) {
  confirmTarget.value = uid
  showTransferConfirm.value = true
}

async function doTransferOwner() {
  try {
    await api.put(`/walls/${wallStore.currentWallId}/transfer-owner`, { new_owner_id: confirmTarget.value })
    await wallStore.fetchMyWalls()
    loadMembers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

async function loadAnnouncements() {
  try { announcements.value = (await api.get('/admin/wall/announcements')).data }
  catch (e) { errorMsg.value = '加载公告失败' }
}
async function publishAnnouncement() {
  if (!annForm.value.title || !annForm.value.content) { toast.success('请填写标题和内容'); return }
  annLoading.value = true
  try {
    const res = await api.post('/admin/wall/announcements', annForm.value)
    toast.success(res.data?.message || '公告已发布')
    // 保留作用域选择，连发多条时不用每次重选
    annForm.value = { title: '', content: '', is_pinned: false, delete_at: '', is_markdown: true, scope: annForm.value.scope }
    loadAnnouncements()
  } catch (e) { toast.error(e.response?.data?.error || '发布失败') }
  finally { annLoading.value = false }
}
async function deleteAnnouncement(id) {
  confirmTarget.value = id
  showDeleteAnnConfirm.value = true
}

async function doDeleteAnnouncement() {
  try { await api.delete(`/admin/wall/announcements/${confirmTarget.value}`); loadAnnouncements() }
  catch { toast.error('删除失败') }
  confirmTarget.value = null
}
function insertMd(before, after) {
  const el = mdTextarea.value
  if (!el) { annForm.value.content += before + after; return }
  const start = el.selectionStart, end = el.selectionEnd
  const selected = annForm.value.content.substring(start, end)
  annForm.value.content = annForm.value.content.substring(0, start) + before + selected + after + annForm.value.content.substring(end)
  nextTick(() => { el.focus(); el.selectionStart = start + before.length; el.selectionEnd = start + before.length + selected.length })
}
function renderAnn(content) { return DOMPurify.sanitize(marked.parse(content || '')) }
const renderedAnnPreview = computed(() => DOMPurify.sanitize(marked.parse(annForm.value.content || '*暂无内容*')))

async function loadCategories() {
  try { categories.value = (await api.get('/admin/wall/categories')).data }
  catch { categories.value = [] }
}
async function deleteCategory(name) {
  confirmTarget.value = name
  showDeleteCategoryConfirm.value = true
}

async function doDeleteCategory() {
  const name = confirmTarget.value
  try { const r = await api.delete('/admin/wall/categories/' + encodeURIComponent(name)); toast.success(r.data.message); loadCategories() }
  catch (e) { toast.error(e.response?.data?.error || '删除失败') }
  confirmTarget.value = null
}

async function loadPostReports() {
  try {
    const params = postReportStatusFilter.value ? `?status=${postReportStatusFilter.value}` : ''
    postReports.value = (await api.get('/admin/wall/post-reports' + params)).data
  } catch { errorMsg.value = '加载帖子举报失败' }
}
async function reviewPostReport(id, action) {
  try { const r = await api.put(`/admin/wall/post-reports/${id}/review`, { action }); toast.success(r.data.message); loadPostReports() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}

// 本墙安全举报（校园霸凌等）
async function loadSafetyReports() {
  try {
    const params = new URLSearchParams({ wall_id: wallStore.currentWallId })
    if (safetyStatusFilter.value) params.set('status', safetyStatusFilter.value)
    safetyReports.value = (await api.get('/reports?' + params.toString())).data.reports
  } catch { errorMsg.value = '加载举报失败' }
}
async function updateSafetyStatus(report, status) {
  // 终态不允许再操作
  if (['resolved', 'rejected'].includes(report.status)) return
  safetyNote.value = ''
  showSafetyNote.value = true
  confirmTarget.value = { report, status }
}

async function doUpdateSafetyStatus() {
  const { report, status } = confirmTarget.value
  try { await api.put(`/reports/${report.id}/status`, { status, status_note: safetyNote.value }); loadSafetyReports() }
  catch (e) { toast.error(e.response?.data?.error || '更新失败') }
  confirmTarget.value = null
}

// ========== 全局后台 ==========
async function loadGlobalStats() {
  try { gStats.value = (await api.get('/admin/stats')).data }
  catch (e) { errorMsg.value = '加载统计失败: ' + (e.response?.data?.error || e.message) }
}
async function loadUsers() {
  try {
    const p = new URLSearchParams()
    if (userFilter.value.role) p.set('role', userFilter.value.role)
    if (userFilter.value.status) p.set('status', userFilter.value.status)
    if (userFilter.value.q) p.set('q', userFilter.value.q)
    users.value = (await api.get('/admin/users?' + p.toString())).data.users
  } catch (e) { errorMsg.value = '加载用户失败: ' + (e.response?.data?.error || e.message) }
}
function openSettings(u) { settingsUser.value = u; settingsForm.value = { role: u.role, ban_duration: 0, ban_reason: '', ban_level: 'login' }; showSettings.value = true }
async function saveSettings() {
  try {
    await api.put(`/admin/users/${settingsUser.value.id}/assign-role`, { role: settingsForm.value.role })
    showSettings.value = false; loadUsers()
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function banFromModal() {
  const reason = (settingsForm.value.ban_reason || '').trim()
  if (!reason) { toast.error('请填写封禁原因，它会通过站内信告知对方'); return }
  try {
    const res = await api.put(`/admin/users/${settingsUser.value.id}/ban`, {
      banned: true,
      duration: parseInt(settingsForm.value.ban_duration) || 0,
      reason,
      ban_level: settingsForm.value.ban_level || 'login',
    })
    showSettings.value = false; loadUsers(); toast.success(res.data.message || '已封禁')
  } catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function unbanUser(id) {
  try { await api.put(`/admin/users/${id}/ban`, { banned: false }); loadUsers() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function deleteUser(id) {
  confirmTarget.value = id
  showDeleteUserConfirm.value = true
}

async function doDeleteUser() {
  try { await api.delete(`/admin/users/${confirmTarget.value}`); loadUsers() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

async function loadWallApps() {
  try { wallApps.value = (await api.get('/walls/admin/applications')).data }
  catch { errorMsg.value = '加载建墙申请失败' }
}
async function reviewWallApp(id, action) {
  try { const r = await api.put(`/walls/admin/applications/${id}/review`, { action }); toast.success(r.data.message); loadWallApps() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}
async function loadAllWalls() {
  try { allWalls.value = (await api.get('/walls/admin/all')).data }
  catch { errorMsg.value = '加载墙列表失败' }
}
async function toggleWallStatus(w) {
  const status = w.status === 'active' ? 'disabled' : 'active'
  try { await api.put(`/walls/admin/${w.id}/status`, { status }); loadAllWalls() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
}

async function loadUserReports() {
  try {
    const params = userReportStatusFilter.value ? `?status=${userReportStatusFilter.value}` : ''
    userReports.value = (await api.get('/admin/user-reports' + params)).data
  } catch { errorMsg.value = '加载用户举报失败' }
}
async function reviewUserReport(id, action) {
  if (action === 'warn') {
    confirmTarget.value = id
    warnText.value = ''
    showWarnConfirm.value = true
    return
  }
  if (action === 'ban') {
    confirmTarget.value = id
    banReportDuration.value = '1440'
    showBanReportConfirm.value = true
    return
  }
  let body = { action }
  body.feedback = ''
  reportFeedback.value = ''
  showReportFeedback.value = true
  confirmTarget.value = { id, action }
}

async function doReviewUserReport() {
  const { id, action } = confirmTarget.value
  let body = { action }
  if (action === 'warn') {
    if (!warnText.value.trim()) { toast.error('请输入警告内容'); return }
    body.warning_text = warnText.value.trim()
  }
  if (action === 'ban') {
    body.duration = parseInt(banReportDuration.value) || 1440
  }
  body.feedback = reportFeedback.value
  try { const r = await api.put(`/admin/user-reports/${id}/review`, body); toast.success(r.data.message); loadUserReports() }
  catch (e) { toast.error(e.response?.data?.error || '操作失败') }
  confirmTarget.value = null
}

// 面板 → 数据加载器。提到外面是为了让 ?panel= 深链能校验面板名，
// 免得白名单和这里的键各写一份、以后加面板时漏改。

// ===== 权限编辑 =====
//
// 名号（角色）只带出一组默认权限，这里可以在其上逐条加减：
//   继承   —— 跟着名号走，不写任何覆盖
//   强制授予 —— 写一条 grant
//   强制拒绝 —— 写一条 deny
// 保存时只提交与「继承」不同的项，因此以后调整名号的默认集会自动对所有人生效。
const showPerms = ref(false)
const permUser = ref(null)
const permCatalog = ref(null)       // { permissions, globalRolePerms, wallRolePerms }
const permScope = ref(0)            // 0 = 全局；>0 = 指定墙
const permData = ref(null)          // { effective, inherited, overrides, wall_role }
const permChoice = ref({})          // perm -> 'inherit' | 'grant' | 'deny'
const permLoading = ref(false)
const permSaving = ref(false)

const permFilter = ref('')
const permOnlyChanged = ref(false)
const permExpanded = ref({})       // group -> 是否展开，默认全收起

// 当前作用域下应当出现的全部权限（不受搜索/筛选影响）。
// 保存时必须用这个而不是过滤后的列表 —— 否则筛选状态下点保存，
// 被隐藏但已经改过的项不会被提交，用户会以为改了其实没改。
const permsInScope = computed(() => {
  const cat = permCatalog.value?.permissions || {}
  return Object.entries(cat)
    .filter(([, meta]) => permScope.value === 0 || meta.scope === 'wall')
    .map(([key, meta]) => ({ key, ...meta }))
})

const changedCount = computed(() =>
  permsInScope.value.filter(i => choiceOf(i.key) !== 'inherit').length)

// 分组 + 搜索 + 「只看已修改」筛选后的展示结构
const permGroups = computed(() => {
  const kw = permFilter.value.trim().toLowerCase()
  const map = new Map()
  for (const item of permsInScope.value) {
    const changed = choiceOf(item.key) !== 'inherit'
    if (permOnlyChanged.value && !changed) continue
    if (kw && !item.label.toLowerCase().includes(kw) && !item.key.toLowerCase().includes(kw)) continue
    if (!map.has(item.group)) map.set(item.group, { name: item.group, items: [], changed: 0 })
    const g = map.get(item.group)
    g.items.push(item)
    if (changed) g.changed++
  }
  return [...map.values()]
})

const toggleGroup = (name) => { permExpanded.value = { ...permExpanded.value, [name]: !permExpanded.value[name] } }
// 搜索/只看已修改时自动展开，否则筛出来的东西藏在收起的分组里等于没筛
const isGroupOpen = (name) => !!permExpanded.value[name] || !!permFilter.value.trim() || permOnlyChanged.value

function resetAllPerms() {
  permChoice.value = {}
}

// 某条权限在「不加任何覆盖」时是否成立 —— 用来给「继承」标注实际效果
const isInherited = (perm) => !!permData.value?.inherited?.includes(perm)

async function openPerms(u) {
  permUser.value = u
  permScope.value = 0
  permFilter.value = ''
  permOnlyChanged.value = false
  permExpanded.value = {}
  showPerms.value = true
  if (!permCatalog.value) {
    try { permCatalog.value = (await api.get('/permissions/catalog')).data } catch { toast.error('加载权限目录失败') }
  }
  await loadPermData()
}

async function loadPermData() {
  if (!permUser.value) return
  permLoading.value = true
  try {
    const res = await api.get(`/permissions/user/${permUser.value.id}`, { params: { wall_id: permScope.value } })
    permData.value = res.data
    // 用已有的覆盖项还原三态，其余为「继承」
    const choice = {}
    for (const o of res.data.overrides || []) choice[o.perm] = o.effect
    permChoice.value = choice
  } catch (e) {
    toast.error(e.response?.data?.error || '加载权限失败')
    permData.value = null
  } finally { permLoading.value = false }
}

function setPermChoice(perm, value) {
  const next = { ...permChoice.value }
  if (value === 'inherit') delete next[perm]
  else next[perm] = value
  permChoice.value = next
}
const choiceOf = (perm) => permChoice.value[perm] || 'inherit'

async function savePerms() {
  if (!permUser.value) return
  permSaving.value = true
  try {
    // 提交本作用域下的全部权限：现在选了什么就是什么，
    // 没选的显式发 'inherit'，这样取消勾选也能把旧覆盖删掉。
    const changes = {}
    for (const item of permsInScope.value) changes[item.key] = choiceOf(item.key)
    const res = await api.put(`/permissions/user/${permUser.value.id}`, { wall_id: permScope.value, changes })
    if (res.data.rejected?.length) {
      toast.warning(`${res.data.rejected.length} 条未生效：${res.data.rejected[0].reason}`)
    } else {
      toast.success('权限已更新')
    }
    // 改的是自己就要刷新本地权限，否则界面还停在旧的可见性上
    if (permUser.value.id === userStore.user?.id) await userStore.fetchPermissions()
    await loadPermData()
  } catch (e) { toast.error(e.response?.data?.error || '保存失败') }
  finally { permSaving.value = false }
}

// ===== 墙资料编辑 =====
const wallForm = ref({ description: '', require_join_approval: true })
const wallFormSaving = ref(false)

// 没改动就禁用保存/重置，避免误点出一次无意义的写请求
const wallFormDirty = computed(() => {
  const w = currentWall.value
  if (!w) return false
  return (wallForm.value.description || '') !== (w.description || '')
    || wallForm.value.require_join_approval !== (w.require_join_approval !== 0)
})

function resetWallForm() {
  wallForm.value = {
    description: currentWall.value?.description || '',
    require_join_approval: currentWall.value?.require_join_approval !== 0,
  }
}

async function saveWallInfo() {
  wallFormSaving.value = true
  try {
    await api.put(`/walls/${wallStore.currentWallId}`, {
      description: wallForm.value.description,
      require_join_approval: wallForm.value.require_join_approval,
    })
    await wallStore.fetchMyWalls()
    toast.success('校园墙资料已更新')
  } catch (e) { toast.error(e.response?.data?.error || '保存失败') }
  finally { wallFormSaving.value = false }
}

const PANEL_LOADERS = {
  wallStats: () => { loadWallStats(); resetWallForm() },
  members: loadMembers,
  announcements: loadAnnouncements,
  categories: loadCategories,
  postReports: loadPostReports,
  safetyReports: loadSafetyReports,
  gStats: loadGlobalStats,
  users: loadUsers,
  wallApps: loadWallApps,
  allWalls: loadAllWalls,
  userReports: loadUserReports,
  banLogs: loadBanLogs,
  bugReports: loadBugReports,
}

function switchPanel(panel) {
  activePanel.value = panel
  errorMsg.value = ''
  PANEL_LOADERS[panel]?.()
}

onMounted(() => {
  // 收件箱里的通知带 ?panel=xxx 过来，直接打开对应面板。
  // 用 hasOwn 而不是真值判断：?panel=constructor 也能在原型链上取到函数。
  const wanted = String(route.query.panel || '')
  if (Object.prototype.hasOwnProperty.call(PANEL_LOADERS, wanted)) return switchPanel(wanted)
  if (hasWallContext.value) switchPanel('wallStats')
  else if (hasGlobalPanel.value) switchPanel('gStats')
})
</script>

<template>
  <div class="admin-page">
    <h2>管理后台</h2>
    <div v-if="errorMsg" class="error-banner" role="alert"><Icon name="alert" :size="16" />{{ errorMsg }}</div>

    <div v-if="hasWallContext || hasGlobalPanel" class="admin-layout">
      <!-- 左侧栏 -->
      <aside class="admin-sidebar glass">
        <template v-if="hasWallContext">
          <div class="side-group">
            <div class="side-group-title">本墙管理</div>
            <button v-if="canHere('wall.stats.view')" class="side-item" :class="{ active: activePanel === 'wallStats' }" @click="switchPanel('wallStats')">本墙概况</button>
            <button v-if="canHere('wall.member.view')" class="side-item" :class="{ active: activePanel === 'members' }" @click="switchPanel('members')">
              成员管理 <span v-if="pendingMembers.length" class="badge">{{ pendingMembers.length }}</span>
            </button>
            <button v-if="canHere('wall.announcement')" class="side-item" :class="{ active: activePanel === 'announcements' }" @click="switchPanel('announcements')">公告管理</button>
            <button v-if="canHere('wall.category')" class="side-item" :class="{ active: activePanel === 'categories' }" @click="switchPanel('categories')">分类管理</button>
            <button v-if="canHere('wall.post.report')" class="side-item" :class="{ active: activePanel === 'postReports' }" @click="switchPanel('postReports')">帖子举报</button>
            <button v-if="canHere('wall.safety.report') || can('global.safety.handle')" class="side-item" :class="{ active: activePanel === 'safetyReports' }" @click="switchPanel('safetyReports')">安全举报</button>
          </div>
        </template>
        <template v-if="hasGlobalPanel">
          <div class="side-group">
            <div class="side-group-title">社区管理</div>
            <button v-if="can('global.moderate')" class="side-item" :class="{ active: activePanel === 'gStats' }" @click="switchPanel('gStats')">全局统计</button>
            <button v-if="can('global.user.manage')" class="side-item" :class="{ active: activePanel === 'users' }" @click="switchPanel('users')">全局用户</button>
            <button v-if="can('global.report.handle')" class="side-item" :class="{ active: activePanel === 'userReports' }" @click="switchPanel('userReports')">用户举报</button>
            <button v-if="can('global.moderate')" class="side-item" :class="{ active: activePanel === 'banLogs' }" @click="switchPanel('banLogs')">封禁日志</button>
            <button v-if="can('global.wall.approve')" class="side-item" :class="{ active: activePanel === 'wallApps' }" @click="switchPanel('wallApps')">建墙申请</button>
            <button v-if="can('global.bug.handle')" class="side-item" :class="{ active: activePanel === 'bugReports' }" @click="switchPanel('bugReports')">Bug 反馈</button>
            <button v-if="can('global.wall.manage')" class="side-item" :class="{ active: activePanel === 'allWalls' }" @click="switchPanel('allWalls')">校园墙管理</button>
          </div>
        </template>
      </aside>

      <!-- 右侧内容面板 -->
    <div class="admin-panel" style="flex:1;min-width:0">
    <!-- ============ 墙概况 ============ -->
    <div v-if="activePanel === 'wallStats' && wallStats">
      <div class="stats-grid">
        <div class="stat-card glass stat-blue">
          <div class="stat-head"><span class="stat-icon"><Icon name="users" :size="20" /></span></div>
          <div class="stat-value">{{ wallStats.members.total }}</div>
          <div class="stat-label">成员总数</div>
          <div class="stat-chips">
            <span class="chip chip-warn">待审 {{ wallStats.members.pending }}</span>
            <span class="chip chip-blue">管理员 {{ wallStats.members.admins }}</span>
          </div>
        </div>
        <div class="stat-card glass stat-purple">
          <div class="stat-head"><span class="stat-icon"><Icon name="file" :size="20" /></span></div>
          <div class="stat-value">{{ wallStats.posts.total }}</div>
          <div class="stat-label">帖子总数</div>
          <div class="stat-chips">
            <span class="chip chip-purple">今日 +{{ wallStats.posts.today }}</span>
          </div>
        </div>
        <div class="stat-card glass stat-green">
          <div class="stat-head"><span class="stat-icon"><Icon name="chart" :size="20" /></span></div>
          <div class="stat-value">{{ wallStats.votes }}</div>
          <div class="stat-label">进行中投票</div>
          <div class="stat-chips"><span class="chip chip-green">活动进行时</span></div>
        </div>
        <div class="stat-card glass stat-red">
          <div class="stat-head"><span class="stat-icon"><Icon name="flag" :size="20" /></span></div>
          <div class="stat-value">{{ wallStats.pendingPostReports }}</div>
          <div class="stat-label">待处理举报</div>
          <div class="stat-chips">
            <span class="chip chip-red" :class="{ pulse: wallStats.pendingPostReports > 0 }">需关注</span>
          </div>
        </div>
      </div>

      <!-- 墙资料编辑。按 wall.edit 权限显示 —— 默认只有墙主与超管有，也可以单独授予。
           放在统计之后：这个面板叫「本墙概况」，概况是主体，设置是次要动作。 -->
      <div v-if="canHere('wall.edit')" class="glass wall-edit">
        <div class="wall-edit-head">
          <h3>校园墙资料</h3>
          <div class="wall-edit-actions">
            <button class="btn btn-sm btn-secondary" :disabled="!wallFormDirty || wallFormSaving" @click="resetWallForm">重置</button>
            <button class="btn btn-sm btn-primary" :disabled="!wallFormDirty || wallFormSaving" @click="saveWallInfo">
              {{ wallFormSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>

        <div class="wall-edit-body">
          <label class="wf-field">
            <span class="wf-label">墙介绍</span>
            <textarea v-model="wallForm.description" rows="4" maxlength="500"
                      placeholder="向成员介绍这个校园墙，会显示在首页右栏"></textarea>
            <span class="wf-count" :class="{ near: (wallForm.description || '').length > 450 }">
              {{ (wallForm.description || '').length }} / 500
            </span>
          </label>

          <label class="wf-check">
            <input type="checkbox" v-model="wallForm.require_join_approval" />
            <span>
              <span class="wf-check-title">加入需要审批</span>
              <span class="wf-check-hint">关闭后任何人都能直接成为本墙成员，不再经过审批队列</span>
            </span>
          </label>
        </div>
      </div>

    </div>

    <!-- ============ 成员管理 ============ -->
    <div v-if="activePanel === 'members'">
      <div v-if="pendingMembers.length" class="section">
        <h2>待审批进墙 ({{ pendingMembers.length }})</h2>
        <div v-for="m in pendingMembers" :key="m.id" class="pending-card">
          <div><strong>{{ m.nickname || m.username }}</strong> <span class="text-muted">@{{ m.username }}</span></div>
          <div class="actions">
            <button class="btn btn-sm btn-success" @click="approveMember(m.user_id, true)">通过</button>
            <button class="btn btn-sm btn-danger" @click="approveMember(m.user_id, false)">拒绝</button>
          </div>
        </div>
      </div>
      <div class="section">
        <h2>成员 ({{ wallMembers.length }})</h2>
        <div class="user-list">
          <div v-for="m in wallMembers" :key="m.id" class="user-card glass">
            <div class="user-info">
              <strong>{{ m.nickname || m.username }}</strong>
              <span class="text-muted">@{{ m.username }}</span>
              <span class="role-tag" :class="m.wall_role">{{ wallRoleLabel(m.wall_role) }}</span>
              <span v-if="m.status === 'banned'" class="banned-tag">
                墙内封禁{{ m.wall_ban_until ? `至 ${new Date(m.wall_ban_until).toLocaleString('zh-CN')}` : '（永久）' }}
              </span>
            </div>
            <div class="actions" v-if="m.wall_role !== 'owner' && canHere('wall.member.role')">
              <select :value="m.wall_role" :aria-label="`设置 ${m.nickname || m.username} 的墙内角色`"
                      @change="setMemberRole(m.user_id, $event.target.value)">
                <option value="member">成员</option>
                <option value="tree_hole">树洞志愿者</option>
                <option value="admin">校园墙管理员</option>
              </select>
              <button class="btn btn-sm btn-primary" @click="transferOwner(m.user_id)">设为墙主</button>
              <button v-if="m.status !== 'banned'" class="btn btn-sm btn-danger" @click="banMember(m)">禁入本墙</button>
              <button v-else class="btn btn-sm btn-success" @click="unbanMember(m)">解除封禁</button>
              <button class="btn btn-sm btn-danger" @click="removeMember(m.user_id)">移除</button>
            </div>
            <div class="actions" v-else-if="m.wall_role === 'owner'"><span class="text-muted">墙主</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 公告 ============ -->
    <div v-if="activePanel === 'announcements'">
      <div class="ann-form glass">
        <h3>发布公告（{{ currentWall?.name }}）</h3>
        <input v-model="annForm.title" placeholder="公告标题" />
        <div class="md-editor">
          <div class="md-toolbar">
            <button class="md-btn" @click="insertMd('**','**')">B</button>
            <button class="md-btn" @click="insertMd('*','*')">I</button>
            <button class="md-btn" @click="insertMd('## ','')">H</button>
            <button class="md-btn" @click="insertMd('[',' ](url)')" title="链接" aria-label="链接"><Icon name="link" :size="14" /></button>
            <div class="md-spacer"></div>
            <button class="md-btn" :class="{ active: showMdPreview }" @click="showMdPreview = !showMdPreview">预览</button>
          </div>
          <div class="md-body">
            <textarea ref="mdTextarea" v-model="annForm.content" placeholder="公告内容（支持 Markdown）..."></textarea>
            <div v-if="showMdPreview" class="md-preview markdown-body" v-html="renderedAnnPreview"></div>
          </div>
        </div>
        <div class="ann-options">
          <!-- 作用域。只有持有 global.announcement 的人能选「全站」；
               其余人这里根本不出现，发出去的一律是本墙公告。 -->
          <label v-if="can('global.announcement')" class="ann-scope">
            范围：
            <select v-model="annForm.scope">
              <option value="wall">本墙</option>
              <option value="global">全站（所有校园墙）</option>
            </select>
          </label>
          <label><input type="checkbox" v-model="annForm.is_pinned" /> 置顶</label>
          <label><input type="checkbox" v-model="annForm.is_markdown" /> Markdown</label>
          <div class="ann-delete-at">定时删除: <input type="datetime-local" v-model="annForm.delete_at" /></div>
          <button class="btn btn-primary" :disabled="annLoading" @click="publishAnnouncement">发布</button>
        </div>
      </div>
      <div v-for="a in announcements" :key="a.id" class="ann-card glass">
        <div class="ann-header">
          <strong><Icon v-if="a.is_pinned" name="pin" :size="13" label="置顶" />{{ a.title }}</strong>
          <button class="btn btn-sm btn-danger" @click="deleteAnnouncement(a.id)">删除</button>
        </div>
        <div class="ann-body markdown-body" v-html="renderAnn(a.content)"></div>
      </div>
    </div>

    <!-- ============ 分类 ============ -->
    <div v-if="activePanel === 'categories'">
      <div v-if="categories.length === 0" class="empty-state"><div class="icon"><Icon name="tag" :size="34" /></div><p>还没有自定义分类</p><p class="text-muted" style="font-size:13px">用户发帖时会自动沿用默认分类</p></div>
      <div class="user-list">
        <div v-for="c in categories" :key="c.category" class="user-card glass">
          <div class="user-info"><strong>{{ c.category }}</strong> <span class="text-muted">{{ c.count }} 帖</span></div>
          <div class="actions">
            <span v-if="['吐槽','分享','求助','讨论','其他'].includes(c.category)" class="text-muted">默认分类</span>
            <button v-else class="btn btn-sm btn-danger" @click="deleteCategory(c.category)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 帖子举报 ============ -->
    <div v-if="activePanel === 'postReports'">
      <div class="filter-row">
        <select v-model="postReportStatusFilter" @change="loadPostReports">
          <option value="">全部</option><option value="pending">待处理</option><option value="resolved">已处理</option><option value="rejected">已驳回</option>
        </select>
      </div>
      <div v-if="postReports.length === 0" class="empty-state"><div class="icon"><Icon name="flag" :size="34" /></div><p>没有待处理的帖子举报</p><p class="text-muted" style="font-size:13px">本墙内容目前没有被举报的记录</p></div>
      <div class="report-list">
        <div v-for="r in postReports" :key="r.id" class="report-card glass">
          <div class="report-header-row">
            <span>举报人: {{ r.reporter_name }}</span>
            <span class="report-status-badge" :class="r.status">{{ reportStatusLabel(r.status) }}</span>
          </div>
          <div class="report-body">
            原因: {{ r.reason }}<br>
            帖子<span v-if="r.post_category" class="post-cat-tag">{{ r.post_category }}</span>:
            {{ r.post_content === null ? '(已删除)' : truncateText(r.post_content, 140) }}
          </div>
          <!-- 「查看帖子」刻意放在 status 判断之外：已处理 / 已驳回的举报也要能回看原帖复查。
               用 post_content 而非 post_id 判断原帖是否还在 —— 查询是 LEFT JOIN posts，
               帖子删掉后 post_id 仍有值，只有 post_content 会变成 null。 -->
          <div class="report-footer-row">
            <a v-if="r.post_content !== null" class="btn btn-sm btn-secondary"
               :href="`/post/${r.post_id}`" target="_blank" rel="noopener">查看帖子</a>
            <span v-else class="text-muted">原帖已删除</span>
            <div class="actions" v-if="r.status === 'pending'">
              <button class="btn btn-sm btn-danger" @click="reviewPostReport(r.id, 'delete_post')">删帖</button>
              <button class="btn btn-sm btn-success" @click="reviewPostReport(r.id, 'resolve')">标记处理</button>
              <button class="btn btn-sm btn-secondary" @click="reviewPostReport(r.id, 'reject')">驳回</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 安全举报 ============ -->
    <div v-if="activePanel === 'safetyReports'">
      <div class="filter-row">
        <select v-model="safetyStatusFilter" @change="loadSafetyReports">
          <option value="">全部</option><option value="pending">待处理</option><option value="processing">处理中</option><option value="resolved">已处理</option><option value="rejected">已驳回</option>
        </select>
      </div>
      <div v-if="safetyReports.length === 0" class="empty-state"><div class="icon"><Icon name="alert" :size="34" /></div><p>没有安全举报</p><p class="text-muted" style="font-size:13px">校园霸凌等安全举报会优先出现在这里</p></div>
      <div class="report-list">
        <div v-for="r in safetyReports" :key="r.id" class="report-card glass">
          <div class="report-header-row">
            <span><span class="report-code">{{ r.tracking_code }}</span><span class="report-type-tag">{{ r.report_types }}</span></span>
            <span class="report-status-badge" :class="r.status">{{ reportStatusLabel(r.status) }}</span>
          </div>
          <div class="report-body">{{ r.content }}</div>
          <div v-if="r.status_note" class="status-note-display">
            <span class="text-muted">备注: {{ r.status_note }}</span>
          </div>
          <div class="report-footer-row">
            <span class="text-muted">举报人: {{ r.reporter_name || '匿名' }}</span>
            <div class="actions" v-if="r.status === 'pending'">
              <button class="btn btn-sm btn-primary" @click="updateSafetyStatus(r, 'processing')">处理中</button>
              <button class="btn btn-sm btn-secondary" @click="updateSafetyStatus(r, 'rejected')">驳回</button>
            </div>
            <div class="actions" v-else-if="r.status === 'processing'">
              <button class="btn btn-sm btn-primary" @click="updateSafetyStatus(r, 'processing')">跟进进度</button>
              <button class="btn btn-sm btn-success" @click="updateSafetyStatus(r, 'resolved')">完结</button>
              <button class="btn btn-sm btn-secondary" @click="updateSafetyStatus(r, 'rejected')">驳回</button>
            </div>
            <div class="actions" v-else>
              <span class="text-muted" style="font-size:12px">已完结，不可操作</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 全局统计 ============ -->
    <div v-if="activePanel === 'gStats' && gStats">
      <div class="stats-grid">
        <div class="stat-card glass stat-blue">
          <div class="stat-head"><span class="stat-icon"><Icon name="users" :size="20" /></span></div>
          <div class="stat-value">{{ gStats.users.total }}</div>
          <div class="stat-label">总用户</div>
          <div class="stat-chips">
            <span class="chip chip-green">活跃 {{ gStats.users.active }}</span>
            <span class="chip chip-red">封禁 {{ gStats.users.banned }}</span>
          </div>
        </div>
        <div class="stat-card glass stat-purple">
          <div class="stat-head"><span class="stat-icon"><Icon name="school" :size="20" /></span></div>
          <div class="stat-value">{{ gStats.walls.total }}</div>
          <div class="stat-label">校园墙</div>
          <div class="stat-chips">
            <span class="chip chip-warn">待审批 {{ gStats.walls.pendingApps }}</span>
          </div>
        </div>
        <div class="stat-card glass stat-green">
          <div class="stat-head"><span class="stat-icon"><Icon name="file" :size="20" /></span></div>
          <div class="stat-value">{{ gStats.posts.total }}</div>
          <div class="stat-label">总帖子</div>
          <div class="stat-chips"><span class="chip chip-green">今日 +{{ gStats.posts.today }}</span></div>
        </div>
        <div class="stat-card glass stat-cyan">
          <div class="stat-head"><span class="stat-icon"><Icon name="message" :size="20" /></span></div>
          <div class="stat-value">{{ gStats.comments }}</div>
          <div class="stat-label">总评论</div>
          <div class="stat-chips"><span class="chip chip-cyan">社区互动中</span></div>
        </div>
        <div class="stat-card glass stat-orange">
          <div class="stat-head"><span class="stat-icon">🆕</span></div>
          <div class="stat-value">{{ gStats.todayNewUsers }}</div>
          <div class="stat-label">今日新用户</div>
          <div class="stat-chips"><span class="chip chip-orange">注册趋势上升</span></div>
        </div>
      </div>
    </div>

    <!-- ============ 全局用户 ============ -->
    <div v-if="activePanel === 'users'">
      <div class="filter-row">
        <input v-model="userFilter.q" placeholder="搜索用户名/昵称/真名" @keyup.enter="loadUsers" />
        <select v-model="userFilter.role"><option value="">全部角色</option><option value="user">普通用户</option><option value="admin">全局管理员</option><option value="super_admin">超级管理员</option></select>
        <select v-model="userFilter.status"><option value="">全部状态</option><option value="active">正常</option><option value="banned">封禁</option></select>
        <button class="btn btn-sm btn-primary" @click="loadUsers">搜索</button>
      </div>
      <div class="user-list">
        <div v-for="u in users" :key="u.id" class="user-card glass">
          <div class="user-info">
            <strong>{{ u.nickname || u.username }}</strong>
            <span class="text-muted">@{{ u.username }}</span>
            <span class="role-tag" :class="u.role">{{ globalRoleLabel(u.role) }}</span>
            <span v-if="u.status === 'banned'" class="banned-tag">封禁({{ {login:'禁登录',post:'禁发帖',chat:'禁聊天',all:'全禁'}[u.ban_level] || '禁登录' }})</span>
          </div>
          <div class="actions" v-if="u.role !== 'super_admin' || can('global.user.role')">
            <button v-if="can('global.user.role') || can('global.user.ban')" class="btn btn-sm btn-primary" @click="openSettings(u)">角色 / 封禁</button>
            <button v-if="can('global.permission.manage')" class="btn btn-sm btn-secondary" @click="openPerms(u)">权限</button>
            <button v-if="u.status === 'banned'" class="btn btn-sm btn-success" @click="unbanUser(u.id)">解封</button>
            <button v-if="can('global.user.delete') && u.role !== 'super_admin'" class="btn btn-sm btn-danger" @click="deleteUser(u.id)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 建墙申请 ============ -->
    <div v-if="activePanel === 'wallApps'">
      <div v-if="wallApps.length === 0" class="empty-state"><div class="icon"><Icon name="school" :size="34" /></div><p>没有待审批的建墙申请</p><p class="text-muted" style="font-size:13px">用户提交申请后会显示在这里</p></div>
      <div class="report-list">
        <div v-for="a in wallApps" :key="a.id" class="report-card glass">
          <div class="report-header-row">
            <strong>{{ a.wall_name }}</strong>
            <span class="text-muted">申请人: {{ a.applicant_name }} (@{{ a.applicant_username }})</span>
          </div>
          <div class="report-body">{{ a.description || '(无简介)' }}</div>
          <div class="report-footer-row">
            <span></span>
            <div class="actions">
              <button class="btn btn-sm btn-success" @click="reviewWallApp(a.id, 'approve')">通过并建墙</button>
              <button class="btn btn-sm btn-danger" @click="reviewWallApp(a.id, 'reject')">拒绝</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 所有校园墙 ============ -->
    <div v-if="activePanel === 'allWalls'">
      <div class="user-list">
        <div v-for="w in allWalls" :key="w.id" class="user-card glass">
          <div class="user-info">
            <strong>{{ w.name }}</strong>
            <span class="text-muted">墙主: {{ w.owner_name || '(无)' }} · {{ w.member_count }}人 · {{ w.post_count }}帖</span>
            <span v-if="w.status !== 'active'" class="banned-tag">已停用</span>
          </div>
          <div class="actions">
            <button class="btn btn-sm" :class="w.status === 'active' ? 'btn-danger' : 'btn-success'" @click="toggleWallStatus(w)">
              {{ w.status === 'active' ? '停用' : '启用' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 用户举报（全局） ============ -->
    <div v-if="activePanel === 'userReports'">
      <div class="filter-row">
        <select v-model="userReportStatusFilter" @change="loadUserReports">
          <option value="">全部</option><option value="pending">待处理</option><option value="resolved">已处理</option>
        </select>
      </div>
      <div v-if="userReports.length === 0" class="empty-state"><div class="icon"><Icon name="flag" :size="34" /></div><p>没有用户举报</p><p class="text-muted" style="font-size:13px">被举报的用户会连同累计次数显示在这里</p></div>
      <div class="report-list">
        <div v-for="r in userReports" :key="r.id" class="report-card glass">
          <div class="report-header-row">
            <span>被举报: {{ r.reported_name }} (@{{ r.reported_username }})<span class="ur-count-badge">累计{{ r.total_reports_count }}次</span></span>
            <span class="report-status-badge" :class="r.status">{{ r.status === 'pending' ? '待处理' : '已处理' }}</span>
          </div>
          <div class="report-body">举报人: {{ r.reporter_name }}<br>原因: {{ r.reason }}<span v-if="r.wall_name"> · 来自「{{ r.wall_name }}」</span></div>
          <div v-if="r.evidence_messages" class="evidence-box"><pre class="evidence-pre">{{ r.evidence_messages }}</pre></div>
          <div class="report-footer-row" v-if="r.status === 'pending'">
            <span></span>
            <div class="actions">
              <button class="btn btn-sm btn-danger" @click="reviewUserReport(r.id, 'ban')">封号</button>
              <button class="btn btn-sm btn-danger" @click="reviewUserReport(r.id, 'permanent_ban')">永久封号</button>
              <button class="btn btn-sm btn-primary" @click="reviewUserReport(r.id, 'warn')">警告</button>
              <button class="btn btn-sm btn-secondary" @click="reviewUserReport(r.id, 'reject')">驳回</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 封禁日志 ============ -->
    <div v-if="activePanel === 'banLogs'">
      <div class="section">
        <h2>封禁日志</h2>
        <p class="text-muted" style="font-size:13px;margin-bottom:12px">
          全局与墙内的每一次封禁 / 解封都会记录在此，最多显示最近 200 条。
        </p>

        <div v-if="banLogsLoading" class="loading">加载中</div>

        <div v-else-if="banLogs.length === 0" class="empty-state">
          <div class="icon"><Icon name="file" :size="34" /></div>
          <p>还没有任何封禁记录</p>
          <p class="text-muted" style="font-size:13px">这是好事 —— 说明社区暂时没有需要处置的情况</p>
        </div>

        <div v-else class="ban-log-list">
          <div v-for="log in banLogs" :key="log.id" class="ban-log-card glass">
            <div class="ban-log-head">
              <span class="ban-log-action" :class="log.action">
                {{ log.action === 'ban' ? '封禁' : '解封' }}
              </span>
              <span class="ban-log-scope">
                {{ log.scope === 'wall' ? `墙内 · ${log.wall_name || '已删除的墙'}` : '全站' }}
              </span>
              <span class="text-muted ban-log-time">{{ new Date(log.created_at).toLocaleString('zh-CN') }}</span>
            </div>
            <div class="ban-log-body">
              <span>对象：<strong>{{ log.target_nickname || log.target_username || `#${log.target_user_id}` }}</strong></span>
              <span>操作人：{{ log.operator_nickname || log.operator_username || '系统' }}</span>
              <span v-if="log.action === 'ban'">
                时长：{{ log.duration_minutes > 0 ? `${log.duration_minutes} 分钟` : '永久' }}
              </span>
            </div>
            <div v-if="log.reason" class="ban-log-reason">原因：{{ log.reason }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bug 反馈面板 -->
    <div v-if="activePanel === 'bugReports'" class="section">
      <h2>Bug 反馈</h2>
      <p class="text-muted" style="font-size:13px;margin-bottom:12px">用户提交的 Bug 反馈，可查看并回复。</p>

      <div v-if="bugReportsLoading" class="loading">加载中</div>
      <div v-else-if="bugReports.length === 0" class="empty-state">
        <div class="icon"><Icon name="check-circle" :size="34" /></div>
        <p>暂无 Bug 反馈</p>
      </div>
      <div v-else class="bug-report-list">
        <div v-for="r in bugReports" :key="r.id" class="bug-report-card glass">
          <div class="bug-report-head">
            <span class="report-status-badge" :class="r.status">{{ reportStatusLabel(r.status) }}</span>
            <span class="bug-report-reporter text-muted">{{ r.reporter_name || r.reporter_username }}</span>
            <span class="text-muted bug-report-time">{{ new Date(r.created_at).toLocaleString('zh-CN') }}</span>
          </div>
          <div class="bug-report-title"><strong>{{ r.title }}</strong></div>
          <div class="bug-report-content">{{ r.content }}</div>
          <div v-if="r.images" class="bug-report-images">
            <img v-for="(img, i) in JSON.parse(r.images || '[]')" :key="i" :src="img" alt="截图" class="bug-thumb"
                 @click="window.open(img, '_blank')" />
          </div>
          <div v-if="r.reply" class="bug-report-reply">
            <span class="text-muted">管理员回复：</span>{{ r.reply }}
          </div>
          <div class="bug-report-actions">
            <select class="pref-select" v-model="r._status" @change="updateBugReportStatus(r.id, r._status)">
              <option value="pending">待处理</option>
              <option value="processing">处理中</option>
              <option value="resolved">已处理</option>
              <option value="rejected">已驳回</option>
            </select>
            <input v-model="r._reply" type="text" placeholder="回复内容（可选）" class="reply-input" />
            <button class="btn btn-primary btn-sm" @click="updateBugReportStatus(r.id, r._status || r.status, r._reply)">回复</button>
          </div>
        </div>
      </div>
    </div>

    </div>
    </div>
    <!-- /admin-layout -->
    <!-- 用户设置弹窗 -->
    <!-- 权限编辑：名号带出默认权限，在其上逐条加减 -->
    <div v-if="showPerms" class="modal-overlay" @click.self="showPerms = false">
      <div class="modal glass-strong perm-modal">
        <div class="modal-header">
          <h3>权限 · {{ permUser?.nickname || permUser?.username }}</h3>
          <button class="close-btn" aria-label="关闭" @click="showPerms = false"><Icon name="close" :size="17" /></button>
        </div>
        <div class="modal-body">
          <div class="perm-scope-row">
            <label>
              作用域：
              <select v-model.number="permScope" @change="loadPermData">
                <option :value="0">全局（墙级权限在此授予时对所有墙生效）</option>
                <option v-for="w in wallStore.myWalls" :key="w.id" :value="w.id">仅「{{ w.name }}」</option>
              </select>
            </label>
            <span class="text-muted perm-role-hint">
              名号：{{ globalRoleLabel(permUser?.role) }}
              <template v-if="permScope > 0 && permData?.wall_role"> · 墙内 {{ wallRoleLabel(permData.wall_role) }}</template>
              　·　「继承」跟着名号走，括号里是它当前的实际效果
            </span>
          </div>

          <div class="perm-toolbar">
            <input v-model="permFilter" class="perm-search" type="search" placeholder="搜索权限名或 key…" />
            <label class="perm-toggle">
              <input type="checkbox" v-model="permOnlyChanged" /> 只看已修改
            </label>
            <span class="perm-summary" :class="{ dirty: changedCount > 0 }">
              {{ changedCount > 0 ? `已改 ${changedCount} 项` : '全部继承' }}
            </span>
            <button v-if="changedCount > 0" class="perm-reset" @click="resetAllPerms">全部改回继承</button>
          </div>

          <div v-if="permLoading" class="text-muted">加载中…</div>
          <template v-else-if="permData">
            <p v-if="!permGroups.length" class="text-muted perm-empty">没有匹配的权限</p>
            <div v-for="g in permGroups" :key="g.name" class="perm-group">
              <button class="perm-group-head" :aria-expanded="isGroupOpen(g.name)" @click="toggleGroup(g.name)">
                <Icon class="perm-caret" :class="{ open: isGroupOpen(g.name) }" name="chevron-right" :size="14" />
                <span class="perm-group-name">{{ g.name }}</span>
                <span class="perm-group-count">{{ g.items.length }}</span>
                <span v-if="g.changed" class="perm-group-changed">{{ g.changed }} 项已改</span>
              </button>
              <div v-show="isGroupOpen(g.name)" class="perm-group-body">
                <div v-for="item in g.items" :key="item.key" class="perm-row">
                  <div class="perm-name">
                    <span class="perm-label">{{ item.label }}</span>
                    <code class="perm-key">{{ item.key }}</code>
                  </div>
                  <div class="seg" role="group" :aria-label="item.label">
                    <button type="button" class="seg-btn" :class="{ active: choiceOf(item.key) === 'inherit' }"
                            @click="setPermChoice(item.key, 'inherit')">
                      继承<small>{{ isInherited(item.key) ? '有' : '无' }}</small>
                    </button>
                    <button type="button" class="seg-btn seg-grant" :class="{ active: choiceOf(item.key) === 'grant' }"
                            @click="setPermChoice(item.key, 'grant')">授予</button>
                    <button type="button" class="seg-btn seg-deny" :class="{ active: choiceOf(item.key) === 'deny' }"
                            @click="setPermChoice(item.key, 'deny')">拒绝</button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showPerms = false">取消</button>
          <button class="btn btn-primary" :disabled="permSaving || permLoading" @click="savePerms">
            {{ permSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
      <div class="modal glass-strong">
        <h3>用户设置 · {{ settingsUser?.username }}</h3>
        <div class="form-group">
          <label>全局角色</label>
          <select v-model="settingsForm.role">
            <option value="user">普通用户</option>
            <option value="admin">全局管理员</option>
            <option value="super_admin">超级管理员</option>
          </select>
        </div>
        <div class="form-group">
          <label for="ban-duration">封禁时长 (分钟, 0=永久, 最长 525600)</label>
          <input id="ban-duration" type="number" v-model="settingsForm.ban_duration" min="0" max="525600" />
        </div>
        <div class="form-group">
          <label for="ban-level">封禁级别</label>
          <select id="ban-level" v-model="settingsForm.ban_level">
            <option value="login">禁止登录</option>
            <option value="post">禁止发帖</option>
            <option value="chat">禁止聊天</option>
            <option value="all">全部禁止</option>
          </select>
        </div>
        <div class="form-group">
          <label for="ban-reason">封禁原因 <span class="req">*</span></label>
          <input id="ban-reason" type="text" v-model="settingsForm.ban_reason"
                 maxlength="200" placeholder="会通过站内信告知对方，并记入封禁日志" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-success" @click="saveSettings">保存角色</button>
          <button class="btn btn-danger" @click="banFromModal">封禁</button>
          <button class="btn btn-secondary" @click="showSettings = false">取消</button>
        </div>
      </div>
    </div>

    <!-- ===== 确认弹窗 ===== -->

    <!-- 移除成员 -->
    <ConfirmModal
      :show="showRemoveConfirm" title="移除成员"
      message="确定移除该成员？"
      confirm-text="移除" cancel-text="取消" :danger="true"
      @confirm="doRemoveMember"
      @update:show="showRemoveConfirm = $event"
    />

    <!-- 转让墙主 -->
    <ConfirmModal
      :show="showTransferConfirm" title="转让墙主"
      message="确定将墙主转让给该成员？此操作需超级管理员或当前墙主权限。"
      confirm-text="确定转让" cancel-text="取消" :danger="false"
      @confirm="doTransferOwner"
      @update:show="showTransferConfirm = $event"
    />

    <!-- 删除公告 -->
    <ConfirmModal
      :show="showDeleteAnnConfirm" title="删除公告"
      message="确定删除?"
      confirm-text="删除" cancel-text="取消" :danger="true"
      @confirm="doDeleteAnnouncement"
      @update:show="showDeleteAnnConfirm = $event"
    />

    <!-- 删除分类 -->
    <ConfirmModal
      :show="showDeleteCategoryConfirm" title="删除分类"
      :message="`确定删除分类「${confirmTarget}」？该分类下的帖子将移至「其他」`"
      confirm-text="删除" cancel-text="取消" :danger="true"
      @confirm="doDeleteCategory"
      @update:show="showDeleteCategoryConfirm = $event"
    />

    <!-- 删除账号 -->
    <ConfirmModal
      :show="showDeleteUserConfirm" title="删除账号"
      message="确定删除该账号? 此操作不可恢复!"
      confirm-text="删除" cancel-text="取消" :danger="true"
      @confirm="doDeleteUser"
      @update:show="showDeleteUserConfirm = $event"
    />

    <!-- 墙内封禁 -->
    <ConfirmModal
      :show="showBanWallConfirm"
      title="禁入本墙"
      :message="confirmTarget ? `禁止「${confirmTarget.nickname || confirmTarget.username}」进入本墙` : ''"
      confirm-text="封禁" cancel-text="取消" :danger="true"
      :prompt="false"
      @confirm="doBanMember"
      @update:show="showBanWallConfirm = $event"
    >
    </ConfirmModal>

    <!-- 解除封禁 -->
    <ConfirmModal
      :show="showUnbanConfirm" title="解除封禁"
      message="确定解除该成员的封禁？"
      confirm-text="解封" cancel-text="取消" :danger="false"
      @confirm="doUnbanMember"
      @update:show="showUnbanConfirm = $event"
    />

    <!-- 安全举报处理备注 -->
    <ConfirmModal
      :show="showSafetyNote" title="处理备注"
      message="输入处理备注（可选）"
      confirm-text="确定" cancel-text="取消" :danger="false"
      :prompt="true" v-model:prompt-value="safetyNote" prompt-placeholder="备注..."
      @confirm="doUpdateSafetyStatus"
      @update:show="showSafetyNote = $event"
    />

    <!-- 用户举报警告 -->
    <ConfirmModal
      :show="showWarnConfirm" title="警告用户"
      message="请输入警告内容（将发送给被举报用户）："
      confirm-text="发送警告" cancel-text="取消" :danger="false"
      :prompt="true" v-model:prompt-value="warnText" prompt-placeholder="警告内容..."
      @confirm="doReviewUserReport"
      @update:show="showWarnConfirm = $event"
    />

    <!-- 用户举报封号 -->
    <ConfirmModal
      :show="showBanReportConfirm" title="封号"
      message="封号时长（分钟，如 1440 = 1天）："
      confirm-text="封号" cancel-text="取消" :danger="true"
      :prompt="true" v-model:prompt-value="banReportDuration" prompt-placeholder="1440"
      @confirm="doReviewUserReport"
      @update:show="showBanReportConfirm = $event"
    />

    <!-- 用户举报处理反馈 -->
    <ConfirmModal
      :show="showReportFeedback" title="处理反馈"
      message="反馈给举报人的处理结果说明（可选）："
      confirm-text="确定" cancel-text="取消" :danger="false"
      :prompt="true" v-model:prompt-value="reportFeedback" prompt-placeholder="反馈说明..."
      @confirm="doReviewUserReport"
      @update:show="showReportFeedback = $event"
    />
  </div>
</template>

<style scoped>
.admin-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
h2 { font-size: 24px; margin-bottom: 16px; }

.error-banner { display: flex; align-items: center; gap: 8px; background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3); color: #ffb8b8; padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 16px; }

/* ===== 左侧栏 + 内容面板布局 ===== */
.admin-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.admin-sidebar {
  width: 224px;
  flex-shrink: 0;
  position: sticky;
  top: 76px;
  padding: 12px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
}

.side-group { display: flex; flex-direction: column; gap: 2px; }

.side-group-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 10px 6px;
}

.side-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 9px 12px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.side-item:hover {
  background: var(--bg-card-hover);
  color: var(--text-primary);
}

.side-item.active {
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent-1) 28%, transparent), rgba(118,75,162,0.22));
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--primary);
}

body.light-theme .side-item.active {
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent-1) 16%, transparent), rgba(118,75,162,0.12));
}

.admin-panel { flex: 1; min-width: 0; animation: fadeIn 0.3s ease; }

.badge { background: #ff6b6b; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: var(--radius-md); }

@media (max-width: 768px) {
  .admin-layout { flex-direction: column; }
  .admin-sidebar {
    position: static;
    width: 100%;
    max-height: none;
    flex-direction: row;
    overflow-x: auto;
    gap: 8px;
    padding: 8px;
  }
  .side-group { flex-direction: row; flex-wrap: nowrap; }
  .side-group-title { display: none; }
  .side-item { white-space: nowrap; }
}

.section { margin-bottom: 20px; }
.section h2 { font-size: 18px; margin-bottom: 12px; }

.pending-card { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(255,200,0,0.08); border: 1px solid rgba(255,200,0,0.2); border-radius: var(--radius-md); margin-bottom: 8px; }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }

.stat-card {
  padding: 18px 20px;
  border-radius: var(--radius-md);
  position: relative;
  overflow: hidden;
  border-top: 3px solid transparent;
}

.stat-card::before {
  content: '';
  position: absolute;
  top: -30px;
  right: -30px;
  width: 90px;
  height: 90px;
  border-radius: 50%;
  opacity: 0.12;
  pointer-events: none;
}

.stat-blue::before { background: #667eea; }
.stat-purple::before { background: #764ba2; }
.stat-green::before { background: #2ed573; }
.stat-red::before { background: #ff6b6b; }
.stat-cyan::before { background: #17c3b2; }
.stat-orange::before { background: #ffa502; }

.stat-blue { border-top-color: #667eea; }
.stat-purple { border-top-color: #a855f7; }
.stat-green { border-top-color: #2ed573; }
.stat-red { border-top-color: #ff6b6b; }
.stat-cyan { border-top-color: #17c3b2; }
.stat-orange { border-top-color: #ffa502; }

.stat-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.stat-icon {
  color: var(--text-secondary);
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--bg-input);
}
.stat-value { font-size: 30px; font-weight: 800; line-height: 1.1; color: var(--text-primary); }
.stat-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }

.stat-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: var(--radius-xl);
  font-weight: 600;
}
.chip-blue { background: color-mix(in srgb, var(--accent-1) 18%, transparent); color: #a8b8ff; }
.chip-purple { background: rgba(168,85,247,0.18); color: #d8b4fe; }
.chip-green { background: rgba(46,213,115,0.18); color: #b8ffb8; }
.chip-red { background: rgba(255,107,107,0.18); color: #ffb8b8; }
.chip-cyan { background: rgba(23,195,178,0.18); color: #9ef0e6; }
.chip-orange { background: rgba(255,165,2,0.18); color: #ffeaa7; }
.chip-warn { background: rgba(255,200,0,0.18); color: #ffeaa7; }

.chip.pulse { animation: chipPulse 1.6s ease-in-out infinite; }
@keyframes chipPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.user-list { display: flex; flex-direction: column; gap: 10px; }
.user-card { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-radius: var(--radius-md); flex-wrap: wrap; gap: 8px; }
.user-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; align-items: center; }

.role-tag { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-xs); }
.role-tag.super_admin, .role-tag.owner { background: rgba(255,215,0,0.2); color: #ffd700; }
.role-tag.admin { background: color-mix(in srgb, var(--accent-1) 20%, transparent); color: #a8b8ff; }
.role-tag.tree_hole { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.role-tag.member, .role-tag.user { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.banned-tag { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-xs); background: rgba(255,107,107,0.2); color: #ffb8b8; }

/* 封禁日志 */
.ban-log-list { display: flex; flex-direction: column; gap: var(--space-2); }
.ban-log-card { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); }
.ban-log-head {
  display: flex; align-items: center; gap: var(--space-2);
  flex-wrap: wrap; margin-bottom: var(--space-2);
}
.ban-log-action { font-size: 13px; font-weight: 600; }
.ban-log-action.ban { color: var(--danger-light); }
.ban-log-action.unban { color: var(--success-light); }
.ban-log-scope {
  font-size: 11px; padding: 2px 8px; border-radius: var(--radius-pill);
  background: var(--bg-input); color: var(--text-secondary);
}
.ban-log-time { margin-left: auto; font-size: 12px; }
.ban-log-body {
  display: flex; flex-wrap: wrap; gap: var(--space-4);
  font-size: 13px; color: var(--text-secondary);
}
.ban-log-reason {
  margin-top: var(--space-2); padding-top: var(--space-2);
  border-top: 1px solid var(--border);
  font-size: 13px; color: var(--text-muted); word-break: break-word;
}
.req { color: var(--danger); }

.filter-row { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.filter-row input, .filter-row select { flex: 1; min-width: 100px; }

select { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 6px 10px; border-radius: var(--radius-sm); font-size: 13px; }
select option { background: #333; color: #fff; }

/* 成员管理按钮统一大小 */
/* 成员管理的一排操作控件。原来 select 完全没样式（浏览器默认外观，高度与字号
   都和 .btn-sm 对不上），按钮又只有 min-width:68px —— 「移除」两字撑不满、
   四字标签又超出，于是宽高都不齐。这里统一高度与最小宽度。 */
.actions .btn,
.actions select {
  min-height: 30px;
  box-sizing: border-box;
  font-size: 12px;
  line-height: 1.4;
  border-radius: var(--radius-sm);
}
.actions .btn {
  min-width: 78px;                 /* 容得下「解除封禁」这类四字标签 */
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.actions select {
  min-width: 112px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
  /* 去掉系统外观，自己画一个小箭头，否则不同平台高度差异很大 */
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: right 13px center, right 8px center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.actions select:focus { outline: none; border-color: var(--accent-1); box-shadow: 0 0 0 3px var(--focus-ring); }

@media (max-width: 640px) {
  .actions { flex-wrap: wrap; }
  .actions .btn, .actions select { flex: 1 1 auto; }
}

.ann-form { padding: 20px; border-radius: var(--radius-md); margin-bottom: 16px; }
.ann-form h3 { margin-bottom: 12px; }
.ann-form input, .ann-form textarea { margin-bottom: 10px; }
.ann-options { display: flex; gap: 16px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
.ann-delete-at { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
.ann-card { padding: 16px; border-radius: var(--radius-md); margin-bottom: 10px; }
.ann-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.ann-body { font-size: 14px; line-height: 1.6; margin-bottom: 8px; }

.empty { text-align: center; padding: 32px; color: var(--text-muted); }

.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center; z-index: 2000; }
.modal { padding: 24px; border-radius: var(--radius-lg); width: 90%; max-width: 400px; }
.modal h3 { margin-bottom: 16px; }
.modal .form-group { margin-bottom: 12px; }
.modal .form-group label { display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary); }
.modal .form-group input, .modal .form-group select { width: 100%; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; }

.report-list { display: flex; flex-direction: column; gap: 10px; }
.report-card { padding: 16px; border-radius: var(--radius-md); }
.report-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
.report-code { font-family: monospace; font-weight: 700; color: #c9b99a; letter-spacing: 1px; margin-right: 8px; }
.report-type-tag { font-size: 12px; padding: 2px 8px; border-radius: var(--radius-xs); background: rgba(255,107,107,0.15); color: #ffb8b8; }
.report-status-badge { font-size: 12px; padding: 3px 10px; border-radius: var(--radius-md); font-weight: 600; }
.report-status-badge.pending { background: rgba(255,200,0,0.2); color: #ffeaa7; }
.report-status-badge.processing { background: color-mix(in srgb, var(--accent-1) 20%, transparent); color: #a8b8ff; }
.report-status-badge.resolved { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.report-status-badge.rejected { background: rgba(255,107,107,0.2); color: #ffb8b8; }
.report-body { font-size: 14px; line-height: 1.5; color: var(--text-secondary); margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; }
/* 帖子分类是中性信息，不能套用红底的 .report-type-tag（那个表示举报类型） */
.post-cat-tag { font-size: 12px; padding: 2px 8px; margin: 0 4px; border-radius: var(--radius-xs); background: var(--bg-input); color: var(--text-secondary); }
.status-note-display { font-size: 13px; padding: 6px 10px; background: rgba(255,255,255,0.05); border-radius: var(--radius-sm); margin-bottom: 8px; }
.report-footer-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.ur-count-badge { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-md); background: rgba(255,107,107,0.2); color: #ffb8b8; margin-left: 8px; }
.evidence-box { background: rgba(0,0,0,0.2); border-radius: var(--radius-sm); padding: 10px 12px; margin-top: 6px; }
.evidence-pre { font-size: 12px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; max-height: 200px; overflow-y: auto; }

.md-editor { margin: 10px 0; border: 1px solid rgba(255,255,255,0.15); border-radius: var(--radius-md); overflow: hidden; }
.md-toolbar { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 8px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.1); }
.md-btn { background: none; border: none; color: var(--text-secondary); padding: 5px 9px; font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); font-weight: 600; }
.md-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
.md-btn.active { background: color-mix(in srgb, var(--accent-1) 30%, transparent); color: #a8b8ff; }
.md-spacer { flex: 1; }
.md-body { display: flex; }
.md-body textarea { flex: 1; border: none; background: rgba(255,255,255,0.05); color: #fff; padding: 12px; font-size: 14px; line-height: 1.6; resize: vertical; min-height: 150px; font-family: 'SF Mono', monospace; }
.md-preview { flex: 1; padding: 12px; border-left: 1px solid rgba(255,255,255,0.1); overflow-y: auto; max-height: 300px; min-height: 150px; }

.markdown-body { font-size: 15px; line-height: 1.7; color: var(--text-primary); }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 10px 0 6px; color: #fff; }
.markdown-body code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: var(--radius-xs); font-size: 13px; }
.markdown-body pre { background: rgba(0,0,0,0.3); padding: 12px; border-radius: var(--radius-sm); overflow-x: auto; }
.markdown-body a { color: #a8b8ff; text-decoration: underline; }
.markdown-body strong { color: #fff; }

/* 墙资料编辑。
   注意 .section 只有 margin-bottom、没有 padding —— 直接套 .glass 会让内容贴住
   卡片边缘，所以这里不用 .section，自己给足内边距。 */
.wall-edit {
  max-width: 720px;              /* 面板本身很宽，卡片限宽才不会左右各留一大片空白 */
  margin-top: 20px;
  padding: 18px 20px 20px;
  border-radius: var(--radius-lg);
}
.wall-edit-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  padding-bottom: 12px; margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.wall-edit-head h3 { font-size: 16px; margin: 0; }
.wall-edit-actions { display: flex; gap: 10px; flex-shrink: 0; }

.wall-edit-body { display: flex; flex-direction: column; gap: 16px; }

.wf-field { display: block; position: relative; }
.wf-label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }
.wf-field textarea {
  display: block; width: 100%; padding: 10px 12px;
  border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--bg-input); color: var(--text-primary);
  font-size: 14px; line-height: 1.7; font-family: inherit;
  resize: vertical; min-height: 90px;
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}
.wf-field textarea:focus {
  outline: none; border-color: var(--accent-1);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.wf-count {
  display: block; text-align: right; margin-top: 5px;
  font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums;
}
.wf-count.near { color: var(--accent-1); }

/* 复选框配一行说明。原来只有「加入需要审批」六个字，
   关掉它到底会发生什么全靠猜。 */
.wf-check {
  display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
  padding: 12px 14px; border-radius: var(--radius-sm);
  background: var(--bg-input); border: 1px solid var(--border);
}
.wf-check:hover { border-color: var(--border-strong); }
.wf-check input { margin-top: 3px; flex-shrink: 0; }
.wf-check-title { display: block; font-size: 14px; }
.wf-check-hint { display: block; font-size: 12px; color: var(--text-muted); line-height: 1.6; margin-top: 3px; }

@media (max-width: 640px) {
  .wall-edit { padding: 14px 14px 16px; }
  .wall-edit-actions { width: 100%; }
  .wall-edit-actions .btn { flex: 1; }
}

/* 公告作用域 */
.ann-scope select {
  padding: 4px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-primary);
}

/* 弹窗头部与关闭按钮。
   这三个类之前只在模板里用了却没定义 —— 裸 <button> 会套用浏览器默认的
   ButtonFace（浅灰近白方块），而且 header 没有 flex 布局，关闭按钮也就不靠右。 */
.modal-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border);
}
.modal-header h3 { font-size: 17px; margin: 0; flex: 1; min-width: 0; }
.close-btn {
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; cursor: pointer;
  background: transparent; border: none; border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.close-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.modal-body { padding: 0; }

/* 权限编辑 */
.perm-modal { max-width: 820px; width: 94vw; }
.perm-modal .modal-body { max-height: 68vh; overflow-y: auto; }
.perm-scope-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.perm-scope-row select {
  padding: 5px 9px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-primary);
}
.perm-role-hint { font-size: 12px; line-height: 1.6; }

/* 工具条：搜索 + 只看已修改 + 计数 + 一键还原 */
/* 刻意不做 position: sticky —— 弹窗本体是半透明玻璃，且亮暗主题各有一套
   .glass-strong 覆盖，粘性工具条无论填什么底色都会在某个主题下透出下方内容。
   分组默认收起后工具条本来就在首屏，不需要跟随滚动。 */
.perm-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 2px 0 10px; margin-bottom: 6px; border-bottom: 1px solid var(--border);
}
.perm-search {
  flex: 1; min-width: 160px; padding: 6px 10px; font-size: 13px;
  border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--bg-input); color: var(--text-primary);
}
.perm-toggle { font-size: 12px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
.perm-summary { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.perm-summary.dirty { color: var(--accent-1); font-weight: 600; }
.perm-reset {
  font-size: 12px; padding: 4px 9px; cursor: pointer; white-space: nowrap;
  border-radius: var(--radius-pill); border: 1px solid var(--border-strong);
  background: transparent; color: var(--text-secondary);
}
.perm-reset:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.perm-empty { padding: 20px 0; text-align: center; font-size: 13px; }

/* 分组：默认收起，点标题展开 */
.perm-group { margin-bottom: 6px; }
.perm-group-head {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; cursor: pointer; text-align: left;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-input); color: var(--text-primary);
  font-size: 14px; font-weight: 600;
  transition: background 0.2s var(--ease), border-color 0.2s var(--ease);
}
.perm-group-head:hover { background: var(--bg-card-hover); border-color: var(--border-strong); }
.perm-caret { flex-shrink: 0; transition: transform 0.2s var(--ease); }
.perm-caret.open { transform: rotate(90deg); }
.perm-group-name { flex: 1; }
.perm-group-count {
  font-size: 11px; font-weight: 500; color: var(--text-muted);
  padding: 1px 7px; border-radius: var(--radius-pill); background: var(--bg-card-hover);
}
.perm-group-changed {
  font-size: 11px; font-weight: 600; color: #fff;
  padding: 1px 7px; border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent-1) 70%, transparent);
}
.perm-group-body { padding: 2px 4px 6px; }

.perm-row {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; padding: 8px 6px;
}
.perm-row + .perm-row { border-top: 1px solid var(--border); }
.perm-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.perm-label { font-size: 14px; }
.perm-key { font-size: 11px; color: var(--text-muted); background: var(--bg-input); padding: 1px 5px; border-radius: 3px; }

/* 三态分段控件。比三个 radio 紧凑，选中态用填充色而不是描边，
   授予/拒绝各自带语义色，扫一眼就能看出哪些被改过。 */
.seg {
  display: inline-flex; flex-shrink: 0; overflow: hidden;
  border-radius: var(--radius-pill); border: 1px solid var(--border-strong);
  background: var(--bg-input);
}
.seg-btn {
  border: none; background: transparent; cursor: pointer;
  padding: 5px 12px; font-size: 12px; line-height: 1.3;
  color: var(--text-secondary); white-space: nowrap;
  display: inline-flex; align-items: baseline; gap: 3px;
  transition: background 0.15s var(--ease), color 0.15s var(--ease);
}
.seg-btn + .seg-btn { border-left: 1px solid var(--border); }
.seg-btn small { font-size: 10px; opacity: 0.65; }
.seg-btn:hover:not(.active) { background: var(--bg-card-hover); color: var(--text-primary); }
.seg-btn.active { color: #fff; font-weight: 600; background: rgba(140, 140, 160, 0.55); }
.seg-btn.seg-grant.active { background: var(--success-fill); }
.seg-btn.seg-deny.active { background: var(--danger-fill); }

@media (max-width: 640px) {
  .perm-row { align-items: flex-start; flex-direction: column; gap: 8px; }
  .seg { width: 100%; }
  .seg-btn { flex: 1; justify-content: center; }
  .perm-toolbar { gap: 8px; }
}
</style>
