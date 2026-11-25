<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useSettingsStore } from '../stores/settings'
import { useToast } from '../composables/useToast'
import api from '../api'
import { useFocusTrap } from '../composables/useFocusTrap'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import PrivateChatComposer from '../components/chat-private/PrivateChatComposer.vue'
import '../composables/usePrivateChatDraftCleanup'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const settingsStore = useSettingsStore()
const toast = useToast()
const messages = ref([])
const newMessage = ref('')
const loading = ref(true)
const sending = ref(false)
const chatUser = ref(null)
const showEmoji = ref(false)
const replyTo = ref(null)
const contextMenu = ref({ show: false, x: 0, y: 0, msg: null })
const showReportModal = ref(false)
const reportReason = ref('')
const selectedMsgIds = ref(new Set())
const reportSubmitting = ref(false)
const showClearChatConfirm = ref(false)
const showRevokeConfirm = ref(false)
const revokeTarget = ref(null)
const showDeleteConfirm = ref(false)
const deleteTarget = ref(null)
const loadError = ref('')
const historyError = ref('')
const historyDirection = ref('before')
const messagesArea = ref(null)
const chatRoot = ref(null)
const composer = ref(null)
const reportModal = ref(null)
const menuRef = ref(null)
const clearing = ref(false)
const revoking = ref(false)
const deleting = ref(false)
const hasMore = ref(false)
const hasMoreAfter = ref(false)
const historyLoading = ref(false)
const contextLoading = ref(false)
const viewingContext = ref(false)
const nearBottom = ref(true)
const newMessagesCount = ref(0)
const highlightedId = ref(null)
const outbox = ref([])
const announcement = ref('')
const showSearch = ref(false)
const searchQuery = ref('')
const searchResults = ref([])
const searchLoading = ref(false)
const searchError = ref('')
const searchHasMore = ref(false)
const searchPerformed = ref(false)
const replyUnavailable = computed(() => !!replyTo.value && (!!replyTo.value.unavailable || !!messages.value.find(msg => Number(msg.id) === Number(replyTo.value.id))?.is_revoked))
const chatName = computed(() => chatUser.value?.nickname || chatUser.value?.username || '对方')
const density = computed(() => settingsStore.prefs?.chat_density === 'compact' ? 'compact' : 'comfortable')
const showTimestamps = computed(() => settingsStore.prefs?.chat_show_timestamps !== false)
const sendShortcut = computed(() => settingsStore.prefs?.chat_send_shortcut === 'modifier' ? 'modifier' : 'enter')
const pollMs = computed(() => ['10', '20', '30', '60'].includes(String(settingsStore.prefs?.chat_poll_interval)) ? Number(settingsStore.prefs.chat_poll_interval) * 1000 : 20000)
const reportableMessages = computed(() => messages.value.filter(m => !m.is_revoked))
const emojis = ['😀', '😂', '😊', '😍', '🥰', '😎', '🤔', '😅', '😢', '😭', '🥺', '😴', '👍', '👏', '🙏', '💪', '❤️', '💕', '🎉', '🌟', '🔥', '💯', '🙂', '🤗']
const PAGE_SIZE = 40
let disposed = false
let loadVersion = 0
let loadController = null
let historyVersion = 0
let historyController = null
let searchVersion = 0
let searchController = null
let conversationEpoch = 0
let accountEpoch = 0
let refreshTimer = null
let longPressTimer = null
let highlightTimer = null
let latestKnownId = 0
let oldestCursor = null
let searchCursor = null
let draftOwner = null
let activeSendId = null
let restoringDraft = false
useFocusTrap(() => showReportModal.value, reportModal, () => { showReportModal.value = false })
useFocusTrap(() => contextMenu.value.show, menuRef, hideContextMenu)

function isMine(msg) { return Number(msg?.sender_id) === Number(userStore.user?.id) }
function authorName(msg) { return isMine(msg) ? '我' : (msg?.sender_nickname || chatName.value) }
function formatTime(date) {
  const parsed = new Date(String(date || '').replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function mergeMessages(previous, incoming) {
  const byId = new Map(previous.map(msg => [Number(msg.id), msg]))
  incoming.forEach(msg => { if (Number(msg.id) > 0) byId.set(Number(msg.id), msg) })
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
}
function rowsOf(data) { return Array.isArray(data?.messages) ? data.messages : [] }
function pagination(data, rows) {
  return { before: data.next_before_id ?? data.next_before ?? rows[0]?.id ?? null,
    more: !!(data.hasMoreBefore ?? data.hasMore), after: !!data.hasMoreAfter }
}
function sessionMatches(accountId, peerId, epoch = accountEpoch) {
  return !disposed && epoch === accountEpoch && String(userStore.user?.id || '') === String(accountId) && String(route.params.id) === String(peerId)
}
function storage() { try { return window.sessionStorage || null } catch { return null } }
function draftKey(owner) { return 'school_wall:private-draft:v1:' + owner.accountId + ':' + owner.peerId }
function saveDraft() {
  if (restoringDraft || !draftOwner || !sessionMatches(draftOwner.accountId, draftOwner.peerId)) return
  try {
    const pending = outbox.value.slice(-10).map(record => ({ ...record, status: 'failed', error: record.error || '发送结果未确认，请重试以确认送达' }))
    if (!newMessage.value && !replyTo.value && !pending.length) storage()?.removeItem(draftKey(draftOwner))
    else storage()?.setItem(draftKey(draftOwner), JSON.stringify({ text: newMessage.value, reply: replyTo.value, outbox: pending }))
  } catch { /* 私密模式或空间不足时保留当前页的内存草稿。 */ }
}
function restoreDraft() {
  try {
    const saved = JSON.parse(storage()?.getItem(draftKey(draftOwner)) || 'null')
    if (!saved) return
    newMessage.value = typeof saved.text === 'string' ? saved.text.slice(0, 2000) : ''
    replyTo.value = saved.reply && Number(saved.reply.id) > 0 ? saved.reply : null
    outbox.value = Array.isArray(saved.outbox) ? saved.outbox.filter(record => record.accountId === draftOwner.accountId && record.receiverId === draftOwner.peerId && typeof record.client_message_id === 'string' && typeof record.content === 'string').slice(-10).map(record => ({ ...record, status: 'failed' })) : []
  } catch { /* 损坏的草稿不影响打开会话。 */ }
}
function reconcileStoredRecord(record) {
  if (String(userStore.user?.id || '') !== record.accountId) return
  try {
    const key = draftKey({ accountId: record.accountId, peerId: record.receiverId })
    const saved = JSON.parse(storage()?.getItem(key) || 'null')
    if (saved?.outbox) { saved.outbox = saved.outbox.filter(item => item.client_message_id !== record.client_message_id); storage()?.setItem(key, JSON.stringify(saved)) }
  } catch {}
}
function reconcileOutbox(rows) {
  const confirmed = new Set(rows.filter(isMine).map(msg => msg.client_message_id).filter(Boolean))
  if (!confirmed.size) return
  outbox.value = outbox.value.filter(record => !confirmed.has(record.client_message_id))
  saveDraft()
}
function clearAccountDrafts(id) {
  if (!id) return
  try {
    const store = storage()
    const prefix = 'school_wall:private-draft:v1:' + id + ':'
    for (let i = (store?.length || 0) - 1; i >= 0; i--) { const key = store.key(i); if (key?.startsWith(prefix)) store.removeItem(key) }
  } catch {}
}

function cancelHistoryLoads() {
  historyVersion++
  historyController?.abort()
  historyController = null
  historyLoading.value = false
  contextLoading.value = false
}

// Legacy callers retain loadMessages(silent); request versions also guard servers that ignore abort.
async function loadMessages(silent = false) {
  if (disposed) return
  if (!silent) cancelHistoryLoads()
  const userId = String(route.params.id)
  const version = ++loadVersion
  const epoch = conversationEpoch
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  if (!silent) loading.value = true
  try {
    if (!chatUser.value) {
      try {
        const profile = await api.get('/auth/user/' + userId, { signal: controller.signal })
        if (disposed || version !== loadVersion || epoch !== conversationEpoch) return
        chatUser.value = profile.data
      } catch { if (controller.signal.aborted) return }
    }
    const markRead = !silent || (!viewingContext.value && nearBottom.value) ? 1 : 0
    const res = await api.get('/messages/conversation/' + userId, { params: { limit: PAGE_SIZE, mark_read: markRead }, signal: controller.signal })
    if (disposed || version !== loadVersion || epoch !== conversationEpoch) return
    let next = rowsOf(res.data)
    const previousLatest = latestKnownId
    // 若离开页面期间消息超过一页，以 after 逐页补齐，避免拼出有缺口的时间线。
    if (silent && previousLatest && Number(next[0]?.id) > previousLatest && next.length >= PAGE_SIZE) {
      let cursor = previousLatest
      let additions = []
      let more = true
      for (let page = 0; page < 4 && more; page++) {
        const delta = await api.get('/messages/conversation/' + userId, { params: { after: cursor, limit: 100, mark_read: markRead }, signal: controller.signal })
        if (disposed || version !== loadVersion || epoch !== conversationEpoch) return
        const rows = rowsOf(delta.data)
        additions = mergeMessages(additions, rows)
        const nextCursor = Number(delta.data.next_after_id ?? rows.at(-1)?.id)
        more = !!(delta.data.hasMoreAfter ?? delta.data.hasMore) && nextCursor > cursor
        if (!(nextCursor > cursor)) break
        cursor = nextCursor
      }
      next = more ? additions : mergeMessages(additions, next)
    }
    reconcileOutbox(next)
    if (!silent) {
      messages.value = next
      viewingContext.value = false
      const info = pagination(res.data, next)
      oldestCursor = info.before
      hasMore.value = info.more
      hasMoreAfter.value = false
      newMessagesCount.value = 0
    } else {
      const incoming = next.filter(msg => Number(msg.id) > previousLatest && !isMine(msg))
      if (viewingContext.value || !nearBottom.value) newMessagesCount.value += incoming.length
      if (!viewingContext.value) messages.value = mergeMessages(messages.value, next)
      else if (next.some(msg => Number(msg.id) > Number(messages.value.at(-1)?.id || 0))) hasMoreAfter.value = true
    }
    latestKnownId = Math.max(previousLatest, ...next.map(msg => Number(msg.id) || 0))
    loadError.value = ''
    if (silent && nearBottom.value && !viewingContext.value) { await nextTick(); if (!disposed && epoch === conversationEpoch) scrollToBottom() }
  } catch (e) {
    if (!disposed && version === loadVersion && epoch === conversationEpoch && !controller.signal.aborted) loadError.value = e.response?.data?.error || '消息加载失败，请重试'
  } finally {
    if (!disposed && version === loadVersion && epoch === conversationEpoch) {
      loading.value = false
      if (!silent) startPolling()
    }
  }
}
async function loadHistory(direction = 'before') {
  if (historyLoading.value || contextLoading.value || disposed) return
  const cursor = direction === 'before' ? oldestCursor ?? messages.value[0]?.id : messages.value.at(-1)?.id
  if (!cursor) return
  const epoch = conversationEpoch
  const version = ++historyVersion
  historyController?.abort()
  const controller = new AbortController()
  historyController = controller
  historyLoading.value = true
  historyDirection.value = direction
  historyError.value = ''
  stopPolling()
  try {
    const res = await api.get('/messages/conversation/' + route.params.id, { params: { [direction]: cursor, limit: PAGE_SIZE, mark_read: 0 }, signal: controller.signal })
    if (disposed || epoch !== conversationEpoch || version !== historyVersion) return
    const area = messagesArea.value
    const oldHeight = area?.scrollHeight || 0
    const oldTop = area?.scrollTop || 0
    const rows = rowsOf(res.data)
    messages.value = mergeMessages(messages.value, rows)
    const info = pagination(res.data, rows)
    if (direction === 'before') { oldestCursor = info.before; hasMore.value = info.more }
    else hasMoreAfter.value = !!(res.data.hasMoreAfter ?? res.data.hasMore)
    await nextTick()
    if (!disposed && epoch === conversationEpoch && version === historyVersion && area) area.scrollTop = direction === 'before' ? oldTop + area.scrollHeight - oldHeight : oldTop
  } catch (e) {
    if (!controller.signal.aborted && epoch === conversationEpoch) historyError.value = e.response?.data?.error || '历史消息加载失败，可重试'
  } finally {
    if (!disposed && epoch === conversationEpoch && version === historyVersion) { historyLoading.value = false; startPolling() }
  }
}
function scrollToBottom() {
  const area = messagesArea.value
  if (area) area.scrollTop = area.scrollHeight
  nearBottom.value = true
  newMessagesCount.value = 0
}
function onMessagesScroll() {
  const area = messagesArea.value
  if (!area) return
  nearBottom.value = area.scrollHeight - area.scrollTop - area.clientHeight < 64
  if (nearBottom.value && !viewingContext.value) newMessagesCount.value = 0
}
async function returnToLatest() {
  const epoch = conversationEpoch
  await loadMessages(false)
  if (disposed || epoch !== conversationEpoch) return
  await nextTick()
  scrollToBottom()
}
function replyInfo(msg) {
  if (!msg?.reply_to_id && !msg?.reply_to?.id) return null
  const visibleSource = messages.value.find(item => Number(item.id) === Number(msg.reply_to?.id || msg.reply_to_id))
  if (visibleSource?.is_revoked) return { id: visibleSource.id, available: false, text: '原消息已撤回', author: authorName(visibleSource) }
  if (msg.reply_to) return { id: msg.reply_to.id, available: msg.reply_to.available !== false && !msg.reply_to.is_revoked,
    text: msg.reply_to.available === false || msg.reply_to.is_revoked ? (msg.reply_to.is_revoked ? '原消息已撤回' : '原消息已删除或不可见') : msg.reply_to.content,
    author: msg.reply_to.is_mine ? '我' : (msg.reply_to.sender_nickname || chatName.value) }
  const original = messages.value.find(item => Number(item.id) === Number(msg.reply_to_id))
  const revoked = !!(msg.reply_to_revoked || original?.is_revoked)
  const missing = !!msg.reply_to_missing
  return { id: msg.reply_to_id, available: !revoked && !missing,
    text: revoked ? '原消息已撤回' : missing ? '原消息已删除或不可见' : (original?.content || msg.reply_to_content || '查看原消息'),
    author: original ? authorName(original) : Number(msg.reply_to_sender_id) === Number(userStore.user?.id) ? '我' : (msg.reply_to_sender_name || chatName.value) }
}
async function jumpToMessage(id) {
  if (contextLoading.value || !(Number(id) > 0)) return
  const epoch = conversationEpoch
  if (!messages.value.some(msg => Number(msg.id) === Number(id))) {
    cancelHistoryLoads()
    historyError.value = ''
    contextLoading.value = true
    const version = historyVersion
    const controller = new AbortController()
    historyController = controller
    stopPolling()
    try {
      const res = await api.get('/messages/conversation/' + route.params.id, { params: { around_id: id, limit: PAGE_SIZE, mark_read: 0 }, signal: controller.signal })
      if (disposed || epoch !== conversationEpoch || version !== historyVersion) return
      const rows = rowsOf(res.data)
      if (!rows.some(msg => Number(msg.id) === Number(id))) { toast.info('原消息已删除或不可见'); return }
      messages.value = rows
      const info = pagination(res.data, rows)
      oldestCursor = info.before
      hasMore.value = info.more
      hasMoreAfter.value = info.after
      viewingContext.value = true
    } catch (e) {
      if (!controller.signal.aborted && epoch === conversationEpoch) toast.error(e.response?.status === 404 ? '原消息已删除或不可见' : '定位失败，请重试')
      return
    } finally { if (!disposed && epoch === conversationEpoch && version === historyVersion) { contextLoading.value = false; startPolling() } }
  }
  await nextTick()
  if (disposed || epoch !== conversationEpoch) return
  highlightedId.value = Number(id)
  clearTimeout(highlightTimer)
  const area = messagesArea.value
  const element = area?.querySelector?.('[data-message-id="' + Number(id) + '"]')
  if (element && area) {
    area.scrollTop += element.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientHeight / 3
    element.focus({ preventScroll: true })
    onMessagesScroll()
  }
  announcement.value = '已定位原消息'
  highlightTimer = setTimeout(() => { highlightedId.value = null }, 2400)
}
async function searchMessages(append = false) {
  const query = searchQuery.value.trim()
  if (!query) { searchResults.value = []; searchHasMore.value = false; searchError.value = ''; searchPerformed.value = false; return }
  if (query.length > 100) { searchError.value = '搜索词不能超过100字'; return }
  const epoch = conversationEpoch
  const version = ++searchVersion
  searchController?.abort()
  const controller = new AbortController()
  searchController = controller
  searchLoading.value = true
  searchPerformed.value = true
  searchError.value = ''
  if (!append) searchResults.value = []
  try {
    const params = { q: query, limit: 20, mark_read: 0 }
    if (append && searchCursor) params.before = searchCursor
    const res = await api.get('/messages/conversation/' + route.params.id, { params, signal: controller.signal })
    if (disposed || epoch !== conversationEpoch || version !== searchVersion) return
    const rows = rowsOf(res.data)
    searchResults.value = mergeMessages(append ? searchResults.value : [], rows).reverse()
    searchCursor = res.data.next_before_id ?? res.data.next_before ?? rows[0]?.id ?? null
    searchHasMore.value = !!(res.data.hasMoreBefore ?? res.data.hasMore)
  } catch (e) {
    if (!controller.signal.aborted && epoch === conversationEpoch && version === searchVersion) searchError.value = e.response?.data?.error || '搜索失败，请重试'
  } finally { if (version === searchVersion) searchLoading.value = false }
}
function closeSearch() { showSearch.value = false; searchController?.abort(); searchVersion++; searchLoading.value = false }

function newClientId() { return globalThis.crypto?.randomUUID?.() || ('private-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)) }
async function sendMessage() {
  if (disposed || loading.value || !newMessage.value.trim() || sending.value) return
  const content = newMessage.value.trim()
  if (content.length > 2000) { toast.error('消息不能超过2000字'); return }
  if (replyUnavailable.value) { toast.info('原消息已失效，请取消引用后发送'); return }
  const record = { client_message_id: newClientId(), accountId: String(userStore.user?.id || ''), receiverId: String(route.params.id), content,
    reply_to_id: replyTo.value?.id || 0, reply: replyTo.value, created_at: new Date().toISOString(), status: 'sending', retryable: true, error: '' }
  if (!record.accountId || !Number(record.receiverId)) return
  outbox.value.push(record)
  newMessage.value = ''
  replyTo.value = null
  showEmoji.value = false
  saveDraft()
  await transmitRecord(record)
}
async function transmitRecord(record) {
  if (sending.value || !sessionMatches(record.accountId, record.receiverId)) return
  const epoch = accountEpoch
  sending.value = true
  activeSendId = record.client_message_id
  record.status = 'sending'
  record.error = ''
  try {
    const res = await api.post('/messages', { receiver_id: Number(record.receiverId), type: 'private', content: record.content,
      is_anonymous: false, reply_to_id: record.reply_to_id, client_message_id: record.client_message_id })
    if (!sessionMatches(record.accountId, record.receiverId, epoch)) { reconcileStoredRecord(record); return }
    outbox.value = outbox.value.filter(item => item.client_message_id !== record.client_message_id)
    const item = res.data.message_item || (res.data.id ? { id: res.data.id, sender_id: Number(record.accountId), receiver_id: Number(record.receiverId), content: record.content,
      reply_to_id: record.reply_to_id, reply_to_content: record.reply?.content || '', created_at: record.created_at, client_message_id: record.client_message_id } : null)
    if (item && !viewingContext.value) messages.value = mergeMessages(messages.value, [item])
    announcement.value = '消息已发送'
    saveDraft()
    await loadMessages(true)
  } catch (e) {
    record.status = 'failed'
    const status = e.response?.status
    record.retryable = !status || status >= 500 || [408, 429].includes(status)
    record.error = e.response?.data?.error || '发送结果未确认，请重试以确认送达'
    if (sessionMatches(record.accountId, record.receiverId, epoch)) { saveDraft(); announcement.value = '消息发送失败，可在消息下方重试' }
  } finally { if (epoch === accountEpoch && activeSendId === record.client_message_id) { sending.value = false; activeSendId = null } }
}
async function retryMessage(record) {
  if (record.status !== 'failed' || !record.retryable || sending.value) return
  await transmitRecord(record)
}
function editFailedMessage(record) {
  if (record.retryable || newMessage.value.trim()) { toast.info('请先保留当前草稿；发送结果未确认时请直接重试'); return }
  newMessage.value = record.content
  replyTo.value = record.reply
  outbox.value = outbox.value.filter(item => item.client_message_id !== record.client_message_id)
  saveDraft()
  nextTick(() => composer.value?.focus())
}
function dismissFailed(record) { outbox.value = outbox.value.filter(item => item.client_message_id !== record.client_message_id); saveDraft() }
function addEmoji(emoji) { if (composer.value) composer.value.insertText(emoji); else newMessage.value += emoji }
function setReply(msg) {
  if (!msg || msg.is_revoked) return
  replyTo.value = { id: msg.id, sender_id: msg.sender_id, sender_nickname: authorName(msg), content: msg.content }
  hideContextMenu()
  nextTick(() => composer.value?.focus())
}
async function validateDraftReply() {
  const reply = replyTo.value
  if (!reply || messages.value.some(msg => Number(msg.id) === Number(reply.id))) return
  const epoch = conversationEpoch
  try {
    const res = await api.get('/messages/conversation/' + route.params.id, { params: { around_id: reply.id, limit: 1, mark_read: 0 } })
    if (disposed || epoch !== conversationEpoch || replyTo.value !== reply) return
    const source = rowsOf(res.data).find(msg => Number(msg.id) === Number(reply.id))
    if (!source || source.is_revoked) replyTo.value = { ...reply, unavailable: true }
    else replyTo.value = { ...reply, content: source.content, sender_nickname: authorName(source) }
  } catch (e) {
    if (!disposed && epoch === conversationEpoch && replyTo.value === reply && e.response?.status === 404) replyTo.value = { ...reply, unavailable: true }
  }
}
function clearChat() { showClearChatConfirm.value = true }
async function doClearChat() {
  if (clearing.value) return
  clearing.value = true
  const epoch = conversationEpoch
  try {
    const res = await api.delete('/messages/chat/' + route.params.id)
    if (epoch !== conversationEpoch || disposed) return
    toast.success(res.data.message)
    replyTo.value = null
    await loadMessages(false)
  } catch (e) { toast.error(e.response?.data?.error || '清空失败') }
  finally { clearing.value = false }
}
function showContextMenu(event, msg) {
  event.preventDefault()
  const rect = event.currentTarget?.getBoundingClientRect()
  contextMenu.value = { show: true, x: Math.max(8, Math.min(event.clientX || rect?.left || 16, window.innerWidth - 190)), y: Math.max(8, Math.min(event.clientY || rect?.bottom || 80, window.innerHeight - 220)), msg }
}
function handleLongPress(msg) { contextMenu.value = { show: true, x: Math.max(8, window.innerWidth / 2 - 90), y: Math.max(8, window.innerHeight / 2 - 100), msg } }
function hideContextMenu() { contextMenu.value = { show: false, x: 0, y: 0, msg: null } }
function revokeMessage(msg) { revokeTarget.value = msg; showRevokeConfirm.value = true; hideContextMenu() }
async function doRevokeMessage() {
  const msg = revokeTarget.value
  if (!msg || revoking.value) return
  const epoch = conversationEpoch
  revoking.value = true
  try {
    await api.put('/messages/' + msg.id + '/revoke')
    if (epoch !== conversationEpoch || disposed) return
    messages.value = messages.value.map(item => Number(item.id) === Number(msg.id) ? { ...item, is_revoked: true, content: '' } : item)
    if (replyTo.value?.id === msg.id) replyTo.value = null
    await loadMessages(true)
  } catch (e) { toast.error(e.response?.data?.error || '撤回失败') }
  finally { revoking.value = false; revokeTarget.value = null }
}
function deleteMessage(msg) { deleteTarget.value = msg; showDeleteConfirm.value = true; hideContextMenu() }
async function doDeleteMessage() {
  const msg = deleteTarget.value
  if (!msg || deleting.value) return
  const epoch = conversationEpoch
  deleting.value = true
  try {
    await api.delete('/messages/' + msg.id)
    if (epoch !== conversationEpoch || disposed) return
    messages.value = messages.value.filter(item => Number(item.id) !== Number(msg.id))
    searchResults.value = searchResults.value.filter(item => Number(item.id) !== Number(msg.id))
    if (replyTo.value?.id === msg.id) replyTo.value = null
    messages.value = messages.value.map(item => Number(item.reply_to_id) === Number(msg.id) ? { ...item, reply_to_missing: true, reply_to: { id: msg.id, available: false, reason: 'unavailable' }, reply_to_content: '' } : item)
    toast.success('已从你的聊天记录中删除')
  } catch (e) { toast.error(e.response?.data?.error || '删除失败') }
  finally { deleting.value = false; deleteTarget.value = null }
}
async function copyMessage(msg) {
  try { await navigator.clipboard.writeText(msg.content); toast.success('已复制') }
  catch { toast.error('复制失败，请选择消息文字后复制') }
  hideContextMenu()
}
function canRevoke(msg) {
  if (!msg || !isMine(msg) || msg.is_revoked) return false
  const created = new Date(String(msg.created_at).replace(' ', 'T')).getTime()
  return Number.isFinite(created) && Date.now() - created >= 0 && Date.now() - created <= 5 * 60 * 1000
}
function onTouchStart(msg) { clearTimeout(longPressTimer); longPressTimer = setTimeout(() => handleLongPress(msg), 600) }
function onTouchEnd() { clearTimeout(longPressTimer) }
function openReportModal() { showReportModal.value = true; selectedMsgIds.value = new Set(); reportReason.value = '' }
function toggleMsgSelection(id) { if (selectedMsgIds.value.has(id)) selectedMsgIds.value.delete(id); else if (selectedMsgIds.value.size < 50) selectedMsgIds.value.add(id) }
async function submitReport() {
  if (reportSubmitting.value) return
  if (!reportReason.value.trim()) { toast.error('请填写举报描述'); return }
  reportSubmitting.value = true
  try {
    await api.post('/messages/report-user', { reported_user_id: Number(route.params.id), reason: reportReason.value.trim(), selected_message_ids: [...selectedMsgIds.value] })
    toast.success('举报已提交，管理员会尽快处理')
    showReportModal.value = false
  } catch (e) { toast.error(e.response?.data?.error || '举报失败') }
  finally { reportSubmitting.value = false }
}
function stopPolling() { clearTimeout(refreshTimer); refreshTimer = null }
function startPolling() {
  stopPolling()
  if (disposed || document.visibilityState === 'hidden') return
  refreshTimer = setTimeout(async () => {
    if (!historyLoading.value && !contextLoading.value) await loadMessages(true)
    startPolling()
  }, pollMs.value)
}
async function onVisibilityChange() {
  stopPolling()
  if (document.visibilityState !== 'visible' || disposed) return
  await loadMessages(true)
  startPolling()
}
function updateViewport() {
  if (nearBottom.value && !viewingContext.value) nextTick(scrollToBottom)
}
function cancelLoads() {
  loadVersion++; searchVersion++
  cancelHistoryLoads()
  loadController?.abort(); searchController?.abort()
  searchLoading.value = false
}
async function openConversation() {
  saveDraft()
  const epoch = ++conversationEpoch
  cancelLoads()
  stopPolling()
  restoringDraft = true
  messages.value = []; chatUser.value = null; newMessage.value = ''; replyTo.value = null; outbox.value = []
  activeSendId = null; sending.value = false
  latestKnownId = 0; oldestCursor = null; hasMore.value = false; hasMoreAfter.value = false
  nearBottom.value = true; viewingContext.value = false; newMessagesCount.value = 0
  searchResults.value = []; searchQuery.value = ''; searchError.value = ''; searchPerformed.value = false; showSearch.value = false
  showReportModal.value = false; showClearChatConfirm.value = false; showRevokeConfirm.value = false; showDeleteConfirm.value = false
  showEmoji.value = false; highlightedId.value = null; historyError.value = ''; loadError.value = ''
  hideContextMenu()
  draftOwner = { accountId: String(userStore.user?.id || ''), peerId: String(route.params.id) }
  if (draftOwner.accountId) restoreDraft()
  restoringDraft = false
  await loadMessages()
  if (disposed || epoch !== conversationEpoch) return
  await validateDraftReply()
  if (disposed || epoch !== conversationEpoch) return
  await nextTick()
  scrollToBottom()
  updateViewport()
  startPolling()
}
watch([newMessage, replyTo], saveDraft, { deep: true, flush: 'sync' })
watch(() => route.params.id, openConversation, { flush: 'sync' })
watch(() => userStore.user?.id, (id, previousId) => {
  accountEpoch++
  clearAccountDrafts(previousId)
  draftOwner = null
  sending.value = false
  if (id) openConversation()
  else { conversationEpoch++; cancelLoads(); stopPolling(); messages.value = []; outbox.value = []; newMessage.value = ''; replyTo.value = null }
}, { flush: 'sync' })
watch(pollMs, () => startPolling())
onMounted(async () => {
  document.addEventListener('click', hideContextMenu)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.visualViewport?.addEventListener?.('resize', updateViewport)
  window.visualViewport?.addEventListener?.('scroll', updateViewport)
  window.addEventListener?.('resize', updateViewport)
  await openConversation()
})
onBeforeUnmount(() => {
  saveDraft()
  disposed = true
  cancelLoads()
  stopPolling()
  clearTimeout(longPressTimer); clearTimeout(highlightTimer)
  document.removeEventListener('click', hideContextMenu)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.visualViewport?.removeEventListener?.('resize', updateViewport)
  window.visualViewport?.removeEventListener?.('scroll', updateViewport)
  window.removeEventListener?.('resize', updateViewport)
})
</script>

<template>
  <section ref="chatRoot" class="chat-room" :class="'density-' + density" aria-label="私聊">
    <header class="chat-header glass">
      <button type="button" class="btn btn-secondary btn-sm back-button" @click="router.push('/chat')"><Icon name="chevron-left" :size="16" /><span>返回</span></button>
      <div class="chat-heading"><h2>{{ chatUser ? chatName : '私聊' }}</h2><p>与同学保持联系</p></div>
      <div class="header-actions">
        <button type="button" class="header-tool" aria-label="搜索聊天记录" :aria-expanded="showSearch" aria-controls="private-chat-search" @click="showSearch ? closeSearch() : showSearch = true"><Icon name="search" :size="18" /><span>搜索</span></button>
        <button type="button" class="header-tool" @click="openReportModal" aria-label="举报用户"><Icon name="flag" :size="17" /><span>举报</span></button>
        <button type="button" class="header-tool" :disabled="clearing" @click="clearChat" aria-label="清空我的聊天记录"><Icon name="trash" :size="17" /><span>清空</span></button>
      </div>
    </header>
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <section v-if="showSearch" id="private-chat-search" class="search-panel glass" aria-labelledby="private-search-heading">
      <div class="search-title"><h3 id="private-search-heading">搜索此会话</h3><button type="button" class="text-action" @click="closeSearch">收起</button></div>
      <form class="search-form" @submit.prevent="searchMessages(false)">
        <input v-model="searchQuery" type="search" maxlength="100" aria-label="搜索聊天记录" placeholder="输入关键词查找聊天记录" />
        <button class="btn btn-secondary btn-sm" :disabled="searchLoading || !searchQuery.trim()">{{ searchLoading ? '搜索中' : '查找' }}</button>
      </form>
      <p v-if="searchError" role="alert" class="inline-error">{{ searchError }}</p>
      <div v-if="searchResults.length" class="search-results" aria-label="聊天搜索结果">
        <button v-for="result in searchResults" :key="result.id" type="button" class="search-result" :disabled="contextLoading" @click="jumpToMessage(result.id)">
          <span class="search-result-meta">{{ authorName(result) }}<time>{{ formatTime(result.created_at) }}</time></span>
          <span>{{ result.is_revoked ? '消息已撤回' : result.content }}</span>
        </button>
        <button v-if="searchHasMore" type="button" class="text-action" :disabled="searchLoading" @click="searchMessages(true)">更多搜索结果</button>
      </div>
      <p v-else-if="searchQuery.trim() && !searchLoading && !searchError" class="search-tip">{{ searchPerformed ? '没有找到匹配的消息，试试其他关键词。' : '输入关键词后点击查找。搜索不会标记消息已读。' }}</p>
    </section>

    <p v-if="loadError" class="state-error" role="alert">{{ loadError }}<button type="button" class="btn btn-secondary btn-sm" @click="loadMessages(messages.length > 0)">重试</button></p>
    <div v-if="loading && messages.length === 0" class="chat-loading" aria-busy="true" aria-label="正在加载聊天记录"><SkeletonCard :lines="2" /><SkeletonCard :lines="2" /><SkeletonCard :lines="3" /></div>
    <template v-else>
      <div v-if="viewingContext" class="context-banner"><span>正在查看较早的消息</span><button type="button" class="text-action" @click="returnToLatest">返回最新</button></div>
      <div ref="messagesArea" class="messages-area glass" :class="{ 'is-empty': messages.length === 0 }" tabindex="0" aria-label="聊天记录，可滚动查看历史" @scroll.passive="onMessagesScroll">
        <div class="history-actions">
          <button v-if="hasMore" type="button" class="history-button" :disabled="historyLoading || contextLoading" @click="loadHistory('before')">{{ historyLoading ? '加载中…' : '加载更早的消息' }}</button>
          <span v-else-if="messages.length" class="history-start">已经到最早的消息</span>
        </div>
        <p v-if="historyError" class="inline-error" role="alert">{{ historyError }} <button type="button" class="text-action" @click="loadHistory(historyDirection)">重试</button></p>
        <div v-if="messages.length === 0 && !loading" class="empty-state"><Icon name="message" :size="30" /><h3>从一句问候开始</h3><p>在下方写下你的第一条消息</p></div>
        <article v-for="msg in messages" :key="msg.id" :data-message-id="msg.id" tabindex="-1" class="message-item" :class="{ 'message-mine': isMine(msg), 'message-highlighted': highlightedId === Number(msg.id) }" :aria-label="authorName(msg) + '的消息'" @contextmenu="showContextMenu($event, msg)" @touchstart.passive="onTouchStart(msg)" @touchend="onTouchEnd" @touchmove="onTouchEnd" @touchcancel="onTouchEnd">
          <div class="message-column">
            <span class="message-author">{{ authorName(msg) }}</span>
            <div class="message-bubble" :class="{ revoked: msg.is_revoked }">
              <button v-if="replyInfo(msg)" type="button" class="reply-preview" :disabled="!replyInfo(msg).available || contextLoading" :aria-label="'查看引用的' + replyInfo(msg).author + '的消息'" @click="jumpToMessage(replyInfo(msg).id)">
                <strong>{{ replyInfo(msg).author }}</strong><span>{{ replyInfo(msg).text }}</span><small v-if="replyInfo(msg).available">查看原消息</small>
              </button>
              <p class="message-content">{{ msg.is_revoked ? '消息已撤回' : msg.content }}</p>
            </div>
            <div class="message-meta"><time v-if="showTimestamps" :datetime="msg.created_at">{{ formatTime(msg.created_at) }}</time><span v-if="isMine(msg) && !msg.is_revoked">{{ msg.is_read ? '已读' : '已发送' }}</span></div>
            <div class="message-actions" :aria-label="authorName(msg) + '的消息操作'">
              <button v-if="!msg.is_revoked" type="button" class="message-action" @click="setReply(msg)"><Icon name="reply" :size="14" />引用</button>
              <button type="button" class="message-action" aria-haspopup="dialog" :aria-expanded="contextMenu.show && contextMenu.msg?.id === msg.id" @click.stop="showContextMenu($event, msg)">更多<span aria-hidden="true"> ···</span></button>
            </div>
          </div>
        </article>
        <div v-if="viewingContext && hasMoreAfter" class="history-actions"><button type="button" class="history-button" :disabled="historyLoading" @click="loadHistory('after')">{{ historyLoading ? '加载中…' : '加载后续消息' }}</button></div>
      </div>
      <div v-if="newMessagesCount || !nearBottom || viewingContext" class="latest-bar"><button type="button" class="latest-button" @click="returnToLatest"><Icon name="chevron-down" :size="16" />{{ newMessagesCount ? newMessagesCount + ' 条新消息，回到最新' : '回到最新消息' }}</button></div>

      <section v-if="outbox.length" class="outbox" aria-label="待确认的发送记录" aria-live="polite">
        <article v-for="record in outbox" :key="record.client_message_id" class="outbox-item" :class="{ failed: record.status === 'failed' }">
          <p>{{ record.content }}</p>
          <div class="outbox-status"><span>{{ record.status === 'sending' ? '正在发送…' : record.error }}</span>
            <button v-if="record.status === 'failed' && record.retryable" type="button" class="text-action" :disabled="sending" @click="retryMessage(record)">重试发送</button>
            <button v-if="record.status === 'failed' && !record.retryable" type="button" class="text-action" @click="editFailedMessage(record)">修改消息</button>
            <button v-if="record.status === 'failed'" type="button" class="text-action" aria-label="移除此条本地发送提示" @click="dismissFailed(record)">移除提示</button>
          </div>
        </article>
      </section>
      <div v-if="replyTo" class="reply-bar glass" role="status"><div class="reply-bar-content"><span class="reply-bar-label">回复 {{ replyTo.sender_nickname || authorName(replyTo) }}</span><span class="reply-bar-text">{{ replyUnavailable ? '原消息已失效，请取消引用后发送' : replyTo.content }}</span></div><button type="button" class="reply-bar-close" aria-label="取消引用" @click="replyTo = null"><Icon name="close" :size="18" /></button></div>
      <div v-if="showEmoji" class="emoji-picker glass" aria-label="选择表情"><div class="emoji-grid"><button v-for="emoji in emojis" :key="emoji" type="button" class="emoji-btn" :aria-label="'插入 ' + emoji" @click="addEmoji(emoji)">{{ emoji }}</button></div></div>
      <PrivateChatComposer ref="composer" v-model="newMessage" :sending="sending" :disabled="loading && messages.length === 0" :shortcut="sendShortcut" :send-blocked="replyUnavailable" :replying="!!replyTo" :emoji-open="showEmoji" @send="sendMessage" @emoji="showEmoji = !showEmoji" />
    </template>

    <Teleport to="body"><div v-if="contextMenu.show" ref="menuRef" tabindex="-1" role="dialog" aria-modal="true" aria-label="消息操作" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
      <button v-if="!contextMenu.msg?.is_revoked" type="button" class="context-item" @click="setReply(contextMenu.msg)"><Icon name="reply" :size="16" />引用</button>
      <button v-if="!contextMenu.msg?.is_revoked" type="button" class="context-item" @click="copyMessage(contextMenu.msg)"><Icon name="copy" :size="16" />复制文字</button>
      <button v-if="canRevoke(contextMenu.msg)" type="button" class="context-item danger" @click="revokeMessage(contextMenu.msg)"><Icon name="refresh" :size="16" />撤回消息</button>
      <button type="button" class="context-item danger" @click="deleteMessage(contextMenu.msg)"><Icon name="trash" :size="16" />仅从我的记录删除</button>
      <button type="button" class="context-item" @click="hideContextMenu">取消</button>
    </div></Teleport>
    <!-- 举报弹窗 -->
    <Teleport to="body">
      <div v-if="showReportModal" class="report-overlay" @click.self="showReportModal = false">
        <div ref="reportModal" tabindex="-1" class="report-modal glass-strong" role="dialog" aria-modal="true" aria-labelledby="chat-report-title" @click.stop>
          <h3 id="chat-report-title">举报用户</h3>
          <p class="text-muted mb-2">举报 {{ chatUser?.nickname || '该用户' }}，请选择相关聊天记录作为证据</p>

          <div class="evidence-section">
            <label class="evidence-label">选择聊天记录作为证据 <span class="text-muted">(点击选择)</span></label>
            <div class="evidence-messages">
              <label
                v-for="msg in reportableMessages"
                :key="'sel-' + msg.id"
                class="evidence-item"
                :class="{ selected: selectedMsgIds.has(msg.id), mine: isMine(msg) }"
              >
                <input type="checkbox" :checked="selectedMsgIds.has(msg.id)" @change="toggleMsgSelection(msg.id)" :disabled="!selectedMsgIds.has(msg.id) && selectedMsgIds.size >= 50" class="ev-check" />
                <span class="ev-sender">{{ isMine(msg) ? '我' : (chatUser?.nickname || '对方') }}</span>
                <span class="ev-text">{{ msg.content.substring(0, 80) }}</span>
              </label>
            </div>
            <p class="text-muted" style="font-size:12px;margin-top:4px">已选 {{ selectedMsgIds.size }} 条</p>
          </div>

          <div class="form-group">
            <label for="chat-report-reason">举报描述</label>
            <textarea id="chat-report-reason" v-model="reportReason" placeholder="请描述该用户的违规行为..." rows="3" maxlength="1000"></textarea>
          </div>

          <div class="report-actions">
            <button class="btn btn-danger" :disabled="!reportReason.trim() || reportSubmitting" @click="submitReport">
              {{ reportSubmitting ? '提交中...' : '提交举报' }}
            </button>
            <button class="btn btn-secondary" @click="showReportModal = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>


    <ConfirmModal :show="showClearChatConfirm" title="清空我的聊天记录" message="将清空你这一侧的聊天记录，对方的记录会保留。此操作无法撤销。" confirm-text="清空" danger @confirm="doClearChat" @update:show="showClearChatConfirm = $event" />
    <ConfirmModal :show="showRevokeConfirm" title="撤回消息" message="撤回后双方将看不到这条消息的内容，确定撤回吗？" confirm-text="撤回" @confirm="doRevokeMessage" @update:show="showRevokeConfirm = $event" />
    <ConfirmModal :show="showDeleteConfirm" title="删除我的记录" message="仅从你的记录中删除这条消息，对方仍能查看。此操作无法撤销。" confirm-text="仅为我删除" danger @confirm="doDeleteMessage" @update:show="showDeleteConfirm = $event" />
  </section>
</template>

<style scoped>
.chat-room { display: flex; flex-direction: column; gap: 10px; height: var(--app-content-height, calc(100dvh - 112px)); min-height: 0; padding-bottom: env(safe-area-inset-bottom, 0px); overflow: hidden; }
.chat-header { display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 12px 14px; border-radius: var(--radius-lg); }
.chat-heading { flex: 1; min-width: 0; }
.chat-heading h2 { font-size: 1.125rem; line-height: 1.35; font-weight: 650; overflow-wrap: anywhere; margin: 0; }
.chat-heading p { margin: 3px 0 0; color: var(--text-muted); font-size: 0.75rem; }
.header-actions { display: flex; gap: 4px; flex-shrink: 0; }
.header-tool { display: inline-flex; justify-content: center; align-items: center; gap: 5px; min-width: 44px; min-height: 44px; padding: 8px; border: 0; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.8125rem; border-radius: var(--radius-sm); cursor: pointer; }
.header-tool:hover, .header-tool[aria-expanded="true"] { background: var(--accent-soft); color: var(--text-link); }
.chat-loading { flex: 1; display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.messages-area { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; overflow-anchor: none; padding: 12px 14px; scrollbar-gutter: stable; }
.history-actions { display: flex; justify-content: center; padding: 4px 0 14px; }
.messages-area.is-empty { display: flex; flex-direction: column; }
.messages-area.is-empty > .empty-state { width: 100%; box-sizing: border-box; margin-block: auto; padding-block: clamp(2rem, 8vh, 5rem); }
.history-button { min-height: 40px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-secondary); border-radius: var(--radius-pill); padding: 8px 16px; font: inherit; font-size: 0.8125rem; cursor: pointer; }
.history-button:hover { background: var(--accent-soft); }
.history-start { color: var(--text-muted); font-size: 0.75rem; }
.message-item { display: flex; justify-content: flex-start; margin: 0 0 16px; padding: 4px 5px; border-radius: var(--radius-md); scroll-margin-block: 24px; transition: background 0.2s ease; }
.message-mine { justify-content: flex-end; }
.message-column { max-width: min(82%, 38rem); min-width: 0; }
.message-author { display: block; color: var(--text-muted); font-size: 0.75rem; margin: 0 3px 5px; }
.message-mine .message-author { text-align: right; }
.message-bubble { padding: 11px 15px; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: 15px 15px 15px 4px; }
.message-mine .message-bubble { background: color-mix(in srgb, var(--accent-1) 22%, var(--surface-raised)); border-color: var(--accent-line); border-radius: 15px 15px 4px 15px; }
.message-bubble.revoked { background: var(--surface-raised); border-style: dashed; color: var(--text-secondary); }
.message-content { margin: 0; font-size: 0.9375rem; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-meta { display: flex; gap: 8px; padding: 5px 3px 0; color: var(--text-muted); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
.message-mine .message-meta { justify-content: flex-end; }
.message-actions { display: flex; gap: 4px; margin-top: 2px; }
.message-mine .message-actions { justify-content: flex-end; }
.message-action { display: inline-flex; gap: 4px; align-items: center; min-width: 46px; min-height: 32px; padding: 5px 8px; color: var(--text-secondary); background: transparent; border: 0; border-radius: var(--radius-sm); font: inherit; font-size: 0.75rem; cursor: pointer; }
.message-action:hover { color: var(--text-link); background: var(--accent-soft); }
.message-highlighted { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--text-link); }
.reply-preview { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; max-width: 100%; width: 100%; margin: 0 0 9px; padding: 8px 10px; color: var(--text-secondary); text-align: left; background: color-mix(in srgb, var(--bg-deep) 35%, transparent); border: 0; border-left: 3px solid var(--accent-line); border-radius: var(--radius-xs); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.reply-preview strong { color: var(--text-link); font-size: 0.75rem; }
.reply-preview span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap; }
.reply-preview small { color: var(--text-muted); font-size: 0.6875rem; }
.reply-preview:disabled { opacity: 1; cursor: default; border-color: var(--border-strong); }
.reply-preview:disabled strong { color: var(--text-muted); }
.reply-bar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; flex-shrink: 0; border-radius: var(--radius-md); border-left: 3px solid var(--accent-line); }
.reply-bar-content { flex: 1; min-width: 0; }
.reply-bar-label { display: block; font-size: 0.75rem; color: var(--text-link); margin-bottom: 3px; }
.reply-bar-text { display: block; font-size: 0.8125rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reply-bar-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; min-height: 40px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); cursor: pointer; }
.context-menu { position: fixed; z-index: var(--z-modal); width: 184px; padding: 6px; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-md); }
.context-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 9px 10px; border: 0; border-radius: var(--radius-sm); color: var(--text-primary); text-align: left; background: transparent; font: inherit; font-size: 0.8125rem; cursor: pointer; }
.context-item:hover { background: var(--bg-card-hover); }
.context-item.danger { color: var(--danger); }
.context-banner, .latest-bar { flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--text-secondary); font-size: 0.8125rem; }
.context-banner { justify-content: space-between; padding: 3px 12px; background: var(--accent-soft); border-radius: var(--radius-sm); }
.latest-button { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 8px 16px; border: 1px solid var(--accent-line); background: var(--surface-raised); color: var(--text-link); border-radius: var(--radius-pill); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.text-action { min-height: 36px; padding: 4px 8px; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--text-link); font: inherit; font-size: 0.8125rem; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.text-action:hover { background: var(--accent-soft); }
.state-error { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.5; font-size: 0.8125rem; margin: 0; }
.inline-error { margin: 8px 0; color: var(--danger); font-size: 0.8125rem; line-height: 1.6; }
.search-panel { padding: 10px 14px; border-radius: var(--radius-md); flex-shrink: 0; max-height: 38%; overflow: auto; }
.search-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.search-title h3 { font-size: 0.9375rem; margin: 0; }
.search-form { display: flex; gap: 8px; }
.search-form input { flex: 1; min-width: 0; }
.search-results { display: flex; flex-direction: column; margin-top: 8px; }
.search-result { display: flex; flex-direction: column; gap: 5px; text-align: left; color: var(--text-primary); background: transparent; border: 0; border-bottom: 1px solid var(--border); padding: 10px 4px; font: inherit; font-size: 0.8125rem; cursor: pointer; }
.search-result:hover { background: var(--accent-soft); }
.search-result > span:last-child { overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.search-result-meta { display: flex; justify-content: space-between; gap: 12px; color: var(--text-muted); font-size: 0.75rem; }
.search-tip { color: var(--text-muted); font-size: 0.75rem; margin: 7px 0 0; }
.outbox { flex-shrink: 0; max-height: 24%; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.outbox-item { padding: 10px 12px; background: var(--bg-card); border: 1px dashed var(--border-strong); border-radius: var(--radius-md); }
.outbox-item.failed { border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.outbox-item > p { max-height: 4rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8125rem; margin: 0; }
.outbox-status { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 3px; font-size: 0.75rem; color: var(--text-muted); }
.outbox-item.failed .outbox-status > span { color: var(--danger); }
.emoji-picker { flex-shrink: 0; padding: 8px; border-radius: var(--radius-md); max-height: 132px; overflow: auto; }
.emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.emoji-btn { min-height: 40px; border: 0; border-radius: var(--radius-sm); background: transparent; font-size: 1.375rem; cursor: pointer; }
.emoji-btn:hover { background: var(--accent-soft); }
.report-overlay { position: fixed; inset: 0; display: flex; justify-content: center; align-items: center; padding: 16px; z-index: var(--z-modal); background: var(--overlay); }
.report-modal { padding: 24px; border-radius: var(--radius-lg); width: 100%; max-width: 500px; max-height: calc(100dvh - 32px); overflow-y: auto; }
.report-modal h3 { margin-bottom: 8px; font-size: 1.125rem; }
.evidence-section { margin-bottom: 16px; }
.evidence-label { display: block; font-size: 0.875rem; margin-bottom: 8px; color: var(--text-secondary); }
.evidence-messages { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 4px; }
.evidence-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; min-height: 44px; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.8125rem; }
.evidence-item:hover, .evidence-item.selected { background: var(--accent-soft); }
.ev-check { width: 16px; height: 16px; accent-color: var(--accent-1); flex-shrink: 0; }
.ev-sender { font-weight: 600; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0; width: 30px; }
.ev-text { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.report-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 12px; }
.density-compact .message-item { margin-bottom: 6px; }
.density-compact .message-bubble { padding: 8px 12px; }
.density-compact .message-author { margin-bottom: 2px; }
@media (max-width: 640px) { .chat-header { padding: 8px; gap: 8px; } .header-tool span { display: none; } .header-tool { padding: 7px; } .back-button { padding: 8px; } .chat-heading p { display: none; } .messages-area { padding: var(--space-3) var(--space-2); } .message-column { max-width: 90%; } .message-action { min-height: 38px; } .report-modal { padding: 18px; } .chat-room { gap: 8px; } }
@media (max-height: 560px) { .chat-heading p, .message-author { display: none; } .chat-header { padding-block: 4px; } .outbox { max-height: 20%; } .search-panel { max-height: 42%; } }
@media (hover: none) and (pointer: coarse), (max-width: 640px) {
  .history-button, .message-action, .text-action, .reply-bar-close, .latest-button, .emoji-btn { min-height: 44px; min-width: 44px; }
  .emoji-grid { grid-template-columns: repeat(auto-fit, minmax(44px, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .message-item { transition: none; } }
</style>
