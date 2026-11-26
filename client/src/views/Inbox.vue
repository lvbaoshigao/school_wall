<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useWallStore } from '../stores/wall'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useToast } from '../composables/useToast'
import { useMarkdown } from '../composables/useMarkdown'
import SkeletonCard from '../components/SkeletonCard.vue'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import ConfessionDetail from '../components/ConfessionDetail.vue'
import { useConfessionContext } from '../composables/useConfessionContext'
import { identityStatusLabel } from '../utils/confessions'
import api, { getApiErrorMessage } from '../api'

const router = useRouter()
const wallStore = useWallStore()
const { timeAgo } = useTimeAgo()
const { truncateText, renderMarkdown } = useMarkdown()
const { contextKey, wallId, active, capture } = useConfessionContext()
const toast = useToast()

const activeTab = ref('inbox')
const activeFilter = ref('all')
const messages = ref([])
const sentMessages = ref([])
const unreadCounts = ref({ private: 0, confession: 0, system: 0, announcement: 0, interaction: 0 })
const totalUnread = ref(0)
const loading = ref(true)
const showDeleteAllConfirm = ref(false)
const showDeleteMsgConfirm = ref(false)
const deleteMsgTarget = ref(null)
const deleteAllFilter = ref('all')
const loadError = ref('')
const approvalsError = ref('')
const bulkBusy = ref(false)
const reading = new Set()
let listVersion = 0
let listController = null
let disposed = false
const expandedConfession = ref(null)
const identityRequests = ref([])
const identityLoading = ref(false)
const identityError = ref('')
const identityDecision = ref(null)
const showIdentityDecision = ref(false)
const identityBusy = ref(new Set())
let identityVersion = 0
let identityRequest = null
let approvalsVersion = 0
let approvalsRequest = null

async function loadIdentityRequests() {
  if (!active.value || !wallId.value) return
  identityRequest?.abort()
  const request = capture()
  identityRequest = request
  const version = ++identityVersion
  identityLoading.value = true
  identityError.value = ''
  try {
    const { data } = await api.get('/messages/confessions/identity-requests', { ...request.config, params: wallId.value ? { wall_id: wallId.value } : {} })
    if (request.current() && version === identityVersion) identityRequests.value = data.requests || []
  } catch (e) {
    if (request.current() && version === identityVersion) identityError.value = getApiErrorMessage(e, '身份申请加载失败，请重试')
  } finally {
    if (request.current() && version === identityVersion) identityLoading.value = false
    request.release()
  }
}
const authorIdentityRequests = computed(() => identityRequests.value.filter(item => item.is_author))
function prepareIdentityDecision(item, approve) {
  if (identityBusy.value.has(item.id)) return
  identityDecision.value = { item, approve }
  showIdentityDecision.value = true
}
async function decideIdentity() {
  const decision = identityDecision.value
  if (!decision || identityBusy.value.has(decision.item.id)) return
  const { item, approve } = decision
  const request = capture(item.wall_id)
  identityBusy.value = new Set([...identityBusy.value, item.id])
  identityError.value = ''
  try {
    const { data } = await api.put('/messages/confessions/identity-requests/' + item.id, { decision: approve ? 'approve' : 'reject' }, request.config)
    if (!request.current()) return
    identityRequests.value = identityRequests.value.map(entry => entry.id === item.id ? { ...entry, ...data.request } : entry)
    toast.success(approve ? '已同意，仅向这封信的收信人披露身份' : '已拒绝，身份不会披露')
  } catch (e) {
    if (!request.current()) return
    identityError.value = getApiErrorMessage(e, '处理失败，请重试')
    if (e.response?.status === 409) loadIdentityRequests()
  } finally {
    if (request.current()) { const next = new Set(identityBusy.value); next.delete(item.id); identityBusy.value = next; identityDecision.value = null }
    request.release()
  }
}
async function handleConfessionRead(ids) {
  const readIds = new Set(ids)
  messages.value.forEach(msg => {
    if (!readIds.has(msg.id) || msg.is_read) return
    msg.is_read = 1
    if (unreadCounts.value[msg.type] > 0) unreadCounts.value[msg.type]--
  })
  recountUnread()
  const request = capture()
  const version = listVersion
  try {
    // 线程可能包含收件箱前 500 条之外的旧回复，只刷新权威未读数，保留正在编辑的详情。
    const { data } = await api.get('/messages/inbox', { ...request.config, params: { type: 'confession', unread: '1' } })
    if (request.current() && version === listVersion) {
      unreadCounts.value = data.unreadCounts || {}
      totalUnread.value = Number(data.totalUnread) || 0
    }
  } catch { /* 本地已读状态已更新，后续刷新会再次同步计数。 */ }
  finally { request.release() }
}
function toggleConfession(msg) {
  if (activeTab.value === 'inbox') markRead(msg)
  expandedConfession.value = expandedConfession.value === msg.id ? null : msg.id
}

// ===== 待处理申请 =====
const approvals = ref({ friend: [], wall_join: [], wall_create: [] })
const approvalsLoading = ref(true)
// 正在提交的条目 key，防止重复点击
const busy = ref(new Set())

// 每种申请：标题、图标、以及「前往处理」对应的页面
const APPROVAL_GROUPS = [
  { key: 'friend', label: '好友请求', icon: 'user-plus', page: '/chat', pageLabel: '去聊天页处理' },
  { key: 'wall_join', label: '进墙申请', icon: 'school', page: '/admin', pageLabel: '去管理后台处理' },
  { key: 'wall_create', label: '建墙申请', icon: 'plus', page: '/admin', pageLabel: '去管理后台处理' },
]

const visibleGroups = computed(() =>
  APPROVAL_GROUPS.filter(g => (approvals.value[g.key] || []).length > 0)
)
const approvalTotal = computed(() =>
  APPROVAL_GROUPS.reduce((n, g) => n + (approvals.value[g.key] || []).length, 0)
)

function itemName(it) {
  return it.nickname || it.username || `用户 ${it.user_id}`
}

function itemDesc(groupKey, it) {
  if (groupKey === 'friend') return '请求添加你为好友'
  if (groupKey === 'wall_join') return `申请加入「${it.wall_name}」`
  return `申请创建校园墙「${it.wall_name}」${it.description ? ' · ' + it.description : ''}`
}

async function loadApprovals() {
  if (!active.value) return
  approvalsRequest?.abort()
  const request = capture()
  approvalsRequest = request
  const version = ++approvalsVersion
  approvalsLoading.value = true
  approvalsError.value = ''
  try {
    const res = await api.get('/messages/approvals', request.config)
    if (!request.current() || version !== approvalsVersion) return
    approvals.value = {
      friend: res.data.friend || [],
      wall_join: res.data.wall_join || [],
      wall_create: res.data.wall_create || [],
    }
  } catch (e) {
    if (request.current() && version === approvalsVersion) approvalsError.value = '待处理申请加载失败，可重试'
  } finally {
    if (request.current() && version === approvalsVersion) approvalsLoading.value = false
    request.release()
  }
}

// 每种申请的落库端点不同，但对用户来说都只是「同意 / 拒绝」
async function decide(groupKey, item, accept) {
  const key = `${groupKey}:${item.id}`
  if (busy.value.has(key)) return
  const request = capture(item.wall_id)
  busy.value = new Set([...busy.value, key])
  try {
    if (groupKey === 'friend') {
      await api.put(`/friends/${item.id}/respond`, { action: accept ? 'accept' : 'reject' }, request.config)
    } else if (groupKey === 'wall_join') {
      // 该申请属于哪个墙就带哪个墙的上下文，不受当前所在墙影响
      await api.post(
        `/walls/${item.wall_id}/members/${item.user_id}/${accept ? 'approve' : 'reject'}`,
        {},
        { ...request.config, headers: { 'X-Wall-Id': item.wall_id } }
      )
    } else {
      await api.put(`/walls/admin/applications/${item.id}/review`, { action: accept ? 'approve' : 'reject' }, request.config)
    }
    if (!request.current()) return
    approvals.value = {
      ...approvals.value,
      [groupKey]: approvals.value[groupKey].filter(x => x.id !== item.id),
    }
    toast.success(accept ? '已同意' : '已拒绝')
  } catch (e) {
    if (!request.current()) return
    toast.error(e.response?.data?.error || '操作失败')
    // 失败多半是别处已处理过，重新拉一次以免留下失效按钮
    loadApprovals()
  } finally {
    request.release()
    if (!request.current()) return
    const next = new Set(busy.value)
    next.delete(key)
    busy.value = next
  }
}

// ===== 消息 =====
const filters = [
  { key: 'all', label: '全部' },
  { key: 'interaction', label: '互动' },
  { key: 'announcement', label: '公告' },
  { key: 'confession', label: '表白信' },
  { key: 'private', label: '私信' },
  { key: 'tree_hole', label: '树洞' },
  { key: 'system', label: '系统' },
  { key: 'role_application', label: '角色申请' },
  { key: 'report_notification', label: '举报' },
]

async function loadList(tab) {
  if (disposed || !active.value) return
  const version = ++listVersion
  listController?.abort()
  const request = capture()
  const controller = { signal: request.config.signal, abort: request.abort }
  listController = controller
  const filter = activeFilter.value
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.get(tab === 'inbox' ? '/messages/inbox' : '/messages/sent', {
      ...request.config,
      params: tab === 'inbox' && filter !== 'all' ? { type: filter } : {},
    })
    if (!request.current() || disposed || version !== listVersion) return
    if (tab === 'inbox') {
      messages.value = res.data.messages || []
      unreadCounts.value = res.data.unreadCounts || {}
      totalUnread.value = Number(res.data.totalUnread) || 0
    } else sentMessages.value = res.data || []
  } catch (e) {
    if (request.current() && version === listVersion && !controller.signal.aborted) loadError.value = '消息加载失败，请重试'
  } finally {
    if (request.current() && version === listVersion) loading.value = false
    request.release()
  }
}
function loadInbox() { return loadList('inbox') }
function loadSent() { return loadList('sent') }
function recountUnread() {
  totalUnread.value = Object.values(unreadCounts.value).reduce((sum, n) => sum + (Number(n) || 0), 0)
}

async function markRead(msg) {
  if (msg.is_read || reading.has(msg.id) || bulkBusy.value) return
  reading.add(msg.id)
  const version = listVersion
  const request = capture(msg.wall_id)
  try {
    await api.put(`/messages/${msg.id}/read`, {}, request.config)
    if (!request.current()) return
    if (version !== listVersion) {
      if (activeTab.value === 'inbox') await loadInbox()
      return
    }
    if (msg.is_read) return
    msg.is_read = 1
    if (unreadCounts.value[msg.type] > 0) unreadCounts.value[msg.type]--
    recountUnread()
  } catch (e) { if (request.current()) toast.error('标记已读失败，请重试') }
  finally { if (request.current()) reading.delete(msg.id); request.release() }
}

async function markAllRead() {
  if (bulkBusy.value || loading.value || activeTab.value !== 'inbox') return
  const type = activeFilter.value !== 'all' ? activeFilter.value : undefined
  const request = capture()
  const version = listVersion
  bulkBusy.value = true
  try {
    await api.put('/messages/read-all', { type }, request.config)
    if (!request.current()) return
    if (version !== listVersion) { await loadList(activeTab.value); return }
    messages.value.filter(m => !type || m.type === type).forEach(m => { m.is_read = 1 })
    if (type) unreadCounts.value[type] = 0
    else unreadCounts.value = Object.fromEntries(Object.keys(unreadCounts.value).map(key => [key, 0]))
    recountUnread()
    toast.success(type ? '该分类已标记为已读' : '已全部标记为已读')
    if (activeTab.value === 'inbox') await loadInbox()
  } catch (e) { if (request.current()) toast.error('操作失败，请重试') }
  finally { if (request.current()) bulkBusy.value = false; request.release() }
}
function deleteAll() {
  deleteAllFilter.value = activeFilter.value
  showDeleteAllConfirm.value = true
}
async function doDeleteAll() {
  if (bulkBusy.value) return
  const request = capture()
  bulkBusy.value = true
  try {
    const res = await api.delete('/messages/inbox/all', { ...request.config, params: { type: deleteAllFilter.value } })
    if (!request.current()) return
    expandedConfession.value = null
    toast.success(res.data.message)
    loadIdentityRequests()
    if (activeTab.value === 'inbox') await loadInbox()
  } catch (e) { if (request.current()) toast.error('删除失败，请重试') }
  finally { if (request.current()) bulkBusy.value = false; request.release() }
}
function deleteMsg(msg) {
  deleteMsgTarget.value = { msg, tab: activeTab.value }
  showDeleteMsgConfirm.value = true
}
async function doDeleteMsg() {
  const target = deleteMsgTarget.value
  if (!target || bulkBusy.value) return
  const request = capture(target.msg.wall_id)
  const version = listVersion
  bulkBusy.value = true
  try {
    const { msg, tab } = target
    await api.delete('/messages/' + msg.id, request.config)
    if (!request.current()) return
    if (expandedConfession.value === msg.id) expandedConfession.value = null
    if (msg.type === 'confession') loadIdentityRequests()
    if (version !== listVersion) { await loadList(activeTab.value); return }
    const list = tab === 'inbox' ? messages : sentMessages
    list.value = list.value.filter(item => item.id !== msg.id)
    if (tab === 'inbox' && !msg.is_read) {
      if (unreadCounts.value[msg.type] > 0) unreadCounts.value[msg.type]--
      recountUnread()
    }
  } catch (e) { if (request.current()) toast.error('删除失败，请重试') }
  finally { if (request.current()) { bulkBusy.value = false; deleteMsgTarget.value = null }; request.release() }
}

function switchTab(tab) { expandedConfession.value = null; activeTab.value = tab; tab === 'inbox' ? loadInbox() : loadSent() }
function switchFilter(key) { expandedConfession.value = null; activeFilter.value = key; loadInbox() }

const typeLabel = (type) => ({ private:'私信', confession:'表白信', system:'系统通知', announcement:'公告', interaction:'互动', tree_hole:'树洞', role_application:'角色申请', report_notification:'举报通知' })[type] || type

const typeClass = (type) => ({ confession:'type-confession', system:'type-system', private:'type-private', announcement:'type-announcement', interaction:'type-interaction', tree_hole:'type-tree-hole', role_application:'type-system', report_notification:'type-interaction' })[type] || ''

// ===== 消息跳转 =====

// 只接受本站绝对路径。后端写入的 link 全部是拼死的常量+整数，
// 这里再挡一道是为了防住 //evil.com 这种协议相对地址被当成站内路径 push 出去。
const safePath = (p) => (typeof p === 'string' && /^\/[^/]/.test(p) ? p : '')

// 新消息的跳转目标由后端写在 link 字段里；
// 加这个字段之前的存量消息 link 为空，按类型降级推导，让老消息也能点。
function msgLink(msg) {
  if (msg.type === 'confession') return ''
  const stored = safePath(msg.link)
  if (stored) return stored
  if (msg.type === 'tree_hole' && msg.conversation_id) return `/tree-hole/chat/${msg.conversation_id}`
  // 匿名私信/表白信的 sender_id 已被后端抹掉，这里自然也拼不出链接
  if (msg.type === 'private' && msg.sender_id) return `/chat/${msg.sender_id}`
  const code = /追踪码[:：]\s*(RPT-[A-Za-z0-9]+)/.exec(msg.content || '')
  if (code) return `/report/status/${code[1]}`
  return ''
}

// 已发送列表里存的 link 是给收件人用的（指向我自己），这里要反过来指向收件人
const sentLink = (msg) => (msg.type === 'private' && msg.receiver_id ? `/chat/${msg.receiver_id}` : '')

// 按目标路径给按钮起名，而不是按消息类型 —— 降级推导出来的链接也能得到正确文案
const LINK_LABELS = [
  [/^\/post\//, '查看帖子'],
  [/^\/chat\/\d+/, '去私聊'],
  [/^\/chat$/, '去好友页'],
  [/^\/tree-hole\/chat\//, '进入对话'],
  [/^\/report\/status\//, '查看进度'],
  [/^\/admin/, '去管理后台'],
  [/^\/bug-report/, '查看反馈'],
  [/^\/walls/, '查看校园墙'],
]
const linkLabel = (to) => (LINK_LABELS.find(([re]) => re.test(to))?.[1]) || '查看详情'

// 这些页面的数据按「当前校园墙」加载（api 会带上 X-Wall-Id），
// 消息属于别的墙时必须先切过去，否则点进去只会看到「不存在」。
const WALL_SCOPED = /^\/(post|admin)\b/

async function openMsg(msg, to) {
  const request = capture(msg.wall_id)
  request.release()
  // 已发送列表里的 is_read 是对方的阅读状态，标已读的接口也只认收件人，别去动它
  if (activeTab.value === 'inbox') markRead(msg)
  // 在卡片上拖选文字，松开鼠标同样会触发 click，这时不该跳走
  if (window.getSelection && String(window.getSelection()).length > 0) return
  if (!to) return

  const wallId = Number(msg.wall_id) || 0
  if (wallId && wallId !== wallStore.currentWallId && WALL_SCOPED.test(to)) {
    if (!wallStore.loaded) { try { await wallStore.fetchMyWalls() } catch {} }
    if (!request.current()) return
    const target = wallStore.myWalls.find(w => w.id === wallId)
    if (!target) return toast.error('这条消息属于你已经退出的校园墙')
    wallStore.switchWall(wallId)
    toast.info(`已切换到「${target.name}」`)
  }
  router.push(to)
}

const getSenderDisplay = (msg) => {
  if (msg.type === 'announcement') return '管理员'
  if (msg.type === 'system') return '系统'
  if (msg.type === 'interaction') return msg.sender_nickname || '用户'
  if (msg.type === 'tree_hole') return '树洞'
  if (msg.type === 'role_application') return msg.sender_nickname || '用户'
  if (msg.type === 'report_notification') return '系统'
  if (msg.revealed_sender) return msg.revealed_sender.nickname || '写信人'
  if (msg.is_anonymous || !msg.sender_id) return '匿名'
  return msg.sender_nickname || '未知用户'
}

// 跳转目标随列表算一次，模板里不必对同一条消息反复推导
const inboxItems = computed(() => messages.value.map(msg => ({ msg, to: msgLink(msg) })))
const sentItems = computed(() => sentMessages.value.map(msg => ({ msg, to: sentLink(msg) })))

watch(contextKey, () => {
  listVersion++
  approvalsVersion++
  identityVersion++
  listController?.abort()
  approvalsRequest?.abort()
  identityRequest?.abort()
  messages.value = []
  sentMessages.value = []
  approvals.value = { friend: [], wall_join: [], wall_create: [] }
  identityRequests.value = []
  unreadCounts.value = {}
  totalUnread.value = 0
  expandedConfession.value = null
  identityDecision.value = null
  showIdentityDecision.value = false
  showDeleteAllConfirm.value = false
  showDeleteMsgConfirm.value = false
  deleteMsgTarget.value = null
  busy.value = new Set()
  identityBusy.value = new Set()
  reading.clear()
  bulkBusy.value = false
  loading.value = false
  approvalsLoading.value = false
  identityLoading.value = false
  loadError.value = ''
  approvalsError.value = ''
  identityError.value = ''
  if (active.value) { loadList(activeTab.value); loadApprovals(); loadIdentityRequests() }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; listVersion++; listController?.abort(); approvalsRequest?.abort(); identityRequest?.abort() })
</script>

<template>
  <div class="inbox-page">
    <div class="page-header">
      <h2 class="page-title">收件箱</h2>
      <div class="header-actions" v-if="activeTab === 'inbox'">
        <button class="btn btn-sm btn-secondary" @click="markAllRead" :disabled="loading || bulkBusy || totalUnread === 0">全部已读</button>
        <button class="btn btn-sm btn-danger" @click="deleteAll" :disabled="loading || bulkBusy || messages.length === 0">全部删除</button>
      </div>
    </div>

    <p v-if="approvalsError" class="state-error" role="alert">{{ approvalsError }} <button class="btn btn-secondary btn-sm" @click="loadApprovals">重试</button></p>
    <!-- 待处理申请：按类型分组，可在此直接同意/拒绝，也可跳到对应页面处理 -->
    <section v-if="approvalsLoading || approvalTotal > 0" class="approvals" aria-labelledby="approvals-title">
      <div class="approvals-head">
        <h3 id="approvals-title">待处理申请</h3>
        <span v-if="approvalTotal > 0" class="approvals-count">{{ approvalTotal }}</span>
      </div>

      <div v-if="approvalsLoading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载待处理申请">
        <SkeletonCard :lines="2" />
      </div>

      <div v-for="g in visibleGroups" :key="g.key" class="approval-group glass">
        <div class="group-head">
          <span class="group-title">
            <Icon :name="g.icon" :size="16" />
            {{ g.label }}
            <span class="group-count">{{ approvals[g.key].length }}</span>
          </span>
          <button class="group-link" @click="router.push(g.page)">
            {{ g.pageLabel }}
            <Icon name="chevron-right" :size="14" />
          </button>
        </div>

        <div v-for="it in approvals[g.key]" :key="it.id" class="approval-item">
          <div class="approval-avatar">
            <img v-if="it.avatar" :src="it.avatar" alt="" class="avatar-img" />
            <span v-else>{{ itemName(it)[0] }}</span>
          </div>
          <div class="approval-meta">
            <span class="approval-name">{{ itemName(it) }}</span>
            <span class="approval-desc text-muted">{{ itemDesc(g.key, it) }}</span>
          </div>
          <span class="approval-time text-muted">{{ timeAgo(it.created_at) }}</span>
          <div class="approval-actions">
            <button class="btn btn-sm btn-primary" :disabled="busy.has(`${g.key}:${it.id}`)"
                    @click="decide(g.key, it, true)">同意</button>
            <button class="btn btn-sm btn-secondary" :disabled="busy.has(`${g.key}:${it.id}`)"
                    @click="decide(g.key, it, false)">拒绝</button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="identityLoading || identityError || authorIdentityRequests.length" class="approvals" aria-labelledby="identity-requests-title">
      <div class="approvals-head"><h3 id="identity-requests-title">匿名表白身份申请</h3><button class="btn btn-sm btn-secondary" :disabled="identityLoading" @click="loadIdentityRequests">刷新</button></div>
      <p v-if="identityLoading" class="text-muted" role="status">正在加载身份申请…</p>
      <p v-if="identityError" class="state-error" role="alert">{{ identityError }} <button class="btn btn-sm btn-secondary" @click="loadIdentityRequests">重试</button></p>
      <article v-for="request in authorIdentityRequests" :key="request.id" class="identity-request glass">
        <div class="identity-request-heading"><strong>{{ request.requester?.nickname || '收信人' }} 申请查看你的身份</strong><span class="text-muted">{{ timeAgo(request.created_at) }}</span></div>
        <p class="text-muted">对应表白信 #{{ request.message_id }} · {{ request.status === 'pending' ? '只有你同意后，才会向这封信的收信人披露身份。' : identityStatusLabel(request.status) }}</p>
        <div v-if="request.message" class="markdown-body identity-request-message" v-html="renderMarkdown(request.message)"></div>
        <p v-else class="text-muted">对方没有填写附言。</p>
        <div v-if="request.status === 'pending'" class="approval-actions">
          <button class="btn btn-sm btn-primary" :disabled="identityBusy.has(request.id)" @click="prepareIdentityDecision(request, true)">{{ identityBusy.has(request.id) ? '处理中…' : '同意披露身份' }}</button>
          <button class="btn btn-sm btn-secondary" :disabled="identityBusy.has(request.id)" @click="prepareIdentityDecision(request, false)">拒绝</button>
        </div>
      </article>
    </section>

    <div class="tabs glass">
      <button class="tab" :class="{ active: activeTab === 'inbox' }" @click="switchTab('inbox')">
        收件箱 <span v-if="totalUnread > 0" class="badge">{{ totalUnread }}</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'sent' }" @click="switchTab('sent')">已发送</button>
    </div>

    <div v-if="activeTab === 'inbox'" class="filter-bar">
      <button v-for="f in filters" :key="f.key" class="filter-btn" :aria-pressed="activeFilter === f.key" :class="{ active: activeFilter === f.key }" @click="switchFilter(f.key)">
        {{ f.label }}
        <span v-if="f.key !== 'all' && unreadCounts[f.key] > 0" class="filter-badge">{{ unreadCounts[f.key] }}</span>
      </button>
    </div>

    <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载消息">
      <SkeletonCard v-for="i in 4" :key="i" :lines="2" />
    </div>

    <p v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="activeTab === 'inbox' ? loadInbox() : loadSent()">重试</button></p>
    <template v-else-if="activeTab === 'inbox'">
      <div v-if="messages.length === 0" class="empty-state">
        <div class="icon"><Icon name="inbox" :size="34" /></div>
        <p>{{ activeFilter !== 'all' ? '该分类暂无消息' : '暂无消息' }}</p>
      </div>

      <div v-for="{ msg, to } in inboxItems" :key="msg.id" class="msg-card glass" :class="{ unread: !msg.is_read, clickable: !!to, [typeClass(msg.type)]: true }" @click="openMsg(msg, to)">
        <div class="msg-header">
          <div class="msg-meta"><span class="msg-type">{{ msg.confession_kind === 'direct' ? '实名直接表白' : msg.confession_kind === 'reply' ? '表白信回复' : typeLabel(msg.type) }}</span><span v-if="!msg.is_read" class="unread-dot" aria-label="未读"></span></div>
          <span class="text-muted">{{ timeAgo(msg.created_at) }}</span>
        </div>
        <div v-if="msg.title" class="msg-title">{{ msg.title }}</div>
        <!-- 公告在收件箱里只作预览：用 truncateText 剥掉 Markdown 语法输出纯文本，
             和 Navbar 公告列表的预览方式一致。想看全文去顶栏的公告入口。 -->
        <div v-if="msg.type === 'announcement'" class="msg-content msg-preview">{{ truncateText(msg.content, 80) }}</div>
        <div v-else-if="msg.type === 'confession' && msg.confession_kind !== 'direct'" class="msg-content markdown-body confession-preview" v-html="renderMarkdown(msg.content)"></div>
        <div v-else class="msg-content">{{ msg.content }}</div>
        <div class="msg-footer">
          <span class="text-muted">来自: {{ getSenderDisplay(msg) }}</span>
          <div class="msg-actions">
            <button v-if="msg.type === 'confession'" class="btn btn-sm btn-primary" :aria-expanded="expandedConfession === msg.id" @click.stop="toggleConfession(msg)">{{ expandedConfession === msg.id ? '收起表白' : '查看表白' }}</button>
            <button v-if="to" class="btn btn-sm btn-primary go-btn" @click.stop="openMsg(msg, to)">
              {{ linkLabel(to) }}<Icon name="chevron-right" :size="14" />
            </button>
            <button v-if="!msg.is_read" class="btn btn-sm btn-secondary" :disabled="bulkBusy" @click.stop="markRead(msg)">标为已读</button>
            <button class="btn btn-sm btn-secondary" :disabled="bulkBusy" @click.stop="deleteMsg(msg)">删除</button>
          </div>
        </div>
        <ConfessionDetail v-if="msg.type === 'confession' && expandedConfession === msg.id" :message="msg" @changed="loadIdentityRequests" @read="handleConfessionRead" />
      </div>
    </template>

    <template v-else>
      <div v-if="sentMessages.length === 0" class="empty-state">
        <div class="icon"><Icon name="send" :size="34" /></div><p>暂无已发送消息</p>
      </div>
      <div v-for="{ msg, to } in sentItems" :key="msg.id" class="msg-card glass" :class="[typeClass(msg.type), { clickable: !!to }]" @click="openMsg(msg, to)">
        <div class="msg-header"><span class="msg-type">{{ msg.confession_kind === 'direct' ? '实名直接表白' : msg.confession_kind === 'reply' ? '表白信回复' : typeLabel(msg.type) }}</span><span class="text-muted">{{ timeAgo(msg.created_at) }}</span></div>
        <div v-if="msg.title" class="msg-title">{{ msg.title }}</div>
        <div v-if="msg.type === 'confession' && msg.confession_kind !== 'direct'" class="msg-content markdown-body confession-preview" v-html="renderMarkdown(msg.content)"></div>
        <div v-else class="msg-content">{{ msg.content }}</div>
        <div class="msg-footer">
          <span class="text-muted">发送给: {{ msg.receiver_nickname }}</span>
          <div class="msg-actions">
            <button v-if="msg.type === 'confession'" class="btn btn-sm btn-primary" :aria-expanded="expandedConfession === msg.id" @click.stop="toggleConfession(msg)">{{ expandedConfession === msg.id ? '收起表白' : '查看表白' }}</button>
            <button v-if="to" class="btn btn-sm btn-primary go-btn" @click.stop="openMsg(msg, to)">
              {{ linkLabel(to) }}<Icon name="chevron-right" :size="14" />
            </button>
            <button class="btn btn-sm btn-secondary" :disabled="bulkBusy" @click.stop="deleteMsg(msg)">删除</button>
          </div>
        </div>
        <ConfessionDetail v-if="msg.type === 'confession' && expandedConfession === msg.id" :message="msg" @changed="loadIdentityRequests" @read="handleConfessionRead" />
      </div>
    </template>

    <ConfirmModal :show="showIdentityDecision" :title="identityDecision?.approve ? '同意披露身份' : '拒绝身份申请'" :message="identityDecision?.approve ? '确认后，只有这封匿名表白信的收信人会看到你的昵称和个人主页。确定同意吗？' : '确认拒绝后，你的身份不会披露；这封信的申请将结束。'" :confirm-text="identityDecision?.approve ? '同意披露' : '确认拒绝'" @confirm="decideIdentity" @update:show="showIdentityDecision = $event" />

    <!-- 删除全部确认 -->
    <ConfirmModal
      :show="showDeleteAllConfirm"
      title="删除消息"
      :message="`确定删除${deleteAllFilter !== 'all' ? filters.find(f => f.key === deleteAllFilter)?.label : '全部'}消息吗？`"
      confirm-text="删除"
      cancel-text="取消"
      :danger="true"
      @confirm="doDeleteAll"
      @update:show="showDeleteAllConfirm = $event"
    />

    <!-- 删除单条确认 -->
    <ConfirmModal
      :show="showDeleteMsgConfirm"
      title="删除消息"
      message="确定删除此消息？"
      confirm-text="删除"
      cancel-text="取消"
      :danger="true"
      @confirm="doDeleteMsg"
      @update:show="showDeleteMsgConfirm = $event"
    />
  </div>
</template>

<style scoped>
.identity-request { padding: var(--space-4); margin-bottom: var(--space-3); }
.identity-request-heading { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.identity-request p { font-size: 0.8125rem; margin-bottom: 10px; }
.identity-request-message { margin: 12px 0; overflow-wrap: anywhere; overflow-x: auto; }
.confession-preview { white-space: normal; overflow-wrap: anywhere; overflow-x: auto; }
@media (prefers-reduced-motion: reduce) { .inbox-page { animation: none; } }

.skeleton-wrap { display: flex; flex-direction: column; gap: var(--space-3); }
.inbox-page { animation: fadeIn 0.5s ease; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.page-title { font-size: 1.5rem; }
.header-actions { display: flex; gap: 8px; }

/* 待处理申请 */
.approvals { margin-bottom: var(--space-5); }
.approvals-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
.approvals-head h3 { font-size: 1rem; }
.approvals-count {
  min-width: 20px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--accent-1) 25%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-1) 45%, transparent);
  font-size: 0.75rem;
  font-weight: 700;
  text-align: center;
}

.approval-group { padding: var(--space-3); border-radius: var(--radius-md); margin-bottom: var(--space-3); }
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-2);
}
.group-title { display: inline-flex; align-items: center; gap: 6px; font-size: 0.875rem; font-weight: 600; }
.group-count { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; }
.group-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.group-link:hover { background: var(--bg-card-hover); color: var(--text-primary); }

.approval-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-1);
  flex-wrap: wrap;
}
.approval-item + .approval-item { border-top: 1px solid var(--border); }
.approval-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  overflow: hidden;
}
.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.approval-meta { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 2px; }
.approval-name { font-size: 0.875rem; font-weight: 600; }
.approval-desc { font-size: 0.75rem; word-break: break-word; }
.approval-time { font-size: 0.75rem; flex-shrink: 0; }
.approval-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

.tabs { display: flex; padding: 4px; margin-bottom: 12px; gap: 4px; }
.tab { flex: 1; background: none; border: none; color: var(--text-secondary); padding: 10px 16px; font-size: 0.875rem; font-weight: 600; cursor: pointer; border-radius: var(--radius-md); transition: all 0.3s; display: flex; align-items: center; justify-content: center; gap: 6px; }
.tab.active { background: rgba(255,255,255,0.2); color: #fff; }
.badge { background: var(--danger); color: #fff; font-size: 0.6875rem; padding: 2px 6px; border-radius: var(--radius-md); min-width: 18px; text-align: center; }
.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto; padding-bottom: 4px; }
.filter-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); color: var(--text-secondary); padding: 6px 14px; border-radius: var(--radius-pill); font-size: 0.8125rem; cursor: pointer; transition: all 0.2s; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
.filter-btn.active { background: rgba(169,155,134,0.25); border-color: rgba(201,185,154,0.4); color: var(--text-link); }
.filter-btn:hover { background: rgba(255,255,255,0.2); }
.filter-badge { background: var(--danger); color: #fff; font-size: 0.625rem; padding: 1px 5px; border-radius: var(--radius-sm); }
.msg-card { padding: 16px; margin-bottom: 12px; cursor: pointer; transition: all 0.3s; border-left: 3px solid transparent; }
.msg-card:hover { transform: translateY(-2px); }
.msg-card.unread { border-left-color: var(--text-link); }
.msg-card.type-confession.unread { border-left-color: #e8a87c; }
.msg-card.type-system.unread { border-left-color: #95afc0; }
.msg-card.type-private.unread { border-left-color: #a29bfe; }
.msg-card.type-interaction.unread { border-left-color: var(--danger); }
.msg-card.type-tree-hole.unread { border-left-color: #2ed573; }
.msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.msg-meta { display: flex; align-items: center; gap: 8px; }
.msg-type { font-size: 0.8125rem; font-weight: 600; }
.unread-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-link); }
.msg-title { font-size: 1rem; font-weight: 600; margin-bottom: 8px; }
.msg-content { font-size: 0.875rem; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
/* 公告预览已经被 truncateText 抹平成单行纯文本，不需要保留换行 */
.msg-content.msg-preview { white-space: normal; }
.msg-footer { display: flex; justify-content: space-between; align-items: center; }
.msg-actions { display: flex; align-items: center; gap: 8px; }
.go-btn { display: inline-flex; align-items: center; gap: 2px; }
.msg-card.clickable:hover { background: var(--bg-card-hover); }

@media (max-width: 560px) {
  .approval-time { display: none; }
  .approval-actions { width: 100%; justify-content: flex-end; }
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.msg-content { overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.65; }
.msg-footer, .msg-actions { flex-wrap: wrap; gap: 8px; }
.msg-meta, .approval-meta { min-width: 0; overflow-wrap: anywhere; }
.filter-btn[aria-pressed="true"] { border-color: var(--accent-line); color: var(--text-primary); }
@media (max-width: 480px) { .msg-card { padding: 16px; } .msg-actions { width: 100%; justify-content: flex-end; } .approval-item { flex-wrap: wrap; } .approval-actions { margin-left: auto; } }
</style>
