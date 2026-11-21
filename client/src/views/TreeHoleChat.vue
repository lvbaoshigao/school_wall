<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useSettingsStore } from '../stores/settings'
import { useTimeAgo } from '../composables/useTimeAgo'
import api, { getSessionToken, getApiErrorMessage } from '../api'
import { useToast } from '../composables/useToast'
import { createSocialScope, anonymousMessages, mergeMessages, pollMilliseconds, isNearBottom } from '../components/chat-social/socialState'
import SocialComposer from '../components/chat-social/SocialComposer.vue'
import Icon from '../components/Icon.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const { fullTime } = useTimeAgo()
const toast = useToast()
const chatMessages = ref([])
const newMessage = ref('')
const loading = ref(true)
const sending = ref(false)
const showEmoji = ref(false)
const isClosed = ref(false)
const isInitiator = ref(false)
const canReport = ref(false)
const loadError = ref('')
const historyError = ref('')
const sendError = ref('')
const messagesArea = ref(null)
const composerRef = ref(null)
const closing = ref(false)
const reporting = ref(false)
const loadingHistory = ref(false)
const hasMoreHistory = ref(false)
const historyCursor = ref(null)
const unseenCount = ref(0)
const copyFallback = ref('')
const operationStatus = ref('')
const showCloseConfirm = ref(false)
const showReportConfirm = ref(false)
const reportReason = ref('')
const dense = computed(() => settingsStore.prefs.chat_density === 'compact')
const showTimestamps = computed(() => settingsStore.prefs.chat_show_timestamps !== false)
const shortcut = computed(() => settingsStore.prefs.chat_send_shortcut === 'modifier' ? 'modifier' : 'enter')
const scope = createSocialScope(() => ({ token: getSessionToken(), wallId: wallStore.currentWallId, session: userStore.sessionRevision, conversation: String(route.params.conversationId || '') }))
let disposed = false
let loadVersion = 0
let contextVersion = 0
let latestRequest
let refreshTimer = null
const emojis = ['😀', '😂', '😊', '🥰', '🤔', '😅', '😢', '🥺', '👍', '👏', '🙏', '💪', '❤️', '💕', '🎉', '🌟', '🙂', '😉', '🤗', '😌', '🌱', '☀️', '🍀', '🌷']

function applyMeta(data) {
  isClosed.value = isClosed.value || !!data.is_closed
  isInitiator.value = !!data.is_initiator
  canReport.value = data.can_report === true
}
function conversationPath() { return '/messages/tree-hole/' + encodeURIComponent(String(route.params.conversationId || '')) }
function denyAccess() {
  scope.reset(); loadVersion++; stopPolling()
  chatMessages.value = []; canReport.value = false; hasMoreHistory.value = false; isClosed.value = true
  copyFallback.value = ''; unseenCount.value = 0; loading.value = loadingHistory.value = sending.value = closing.value = reporting.value = false
}
async function loadMessages(silent = false) {
  if (disposed || silent && loadingHistory.value) return
  latestRequest?.cancel()
  const request = scope.request()
  latestRequest = request
  const version = ++loadVersion
  const path = conversationPath()
  const wasNearBottom = isNearBottom(messagesArea.value)
  const previousLast = chatMessages.value.at(-1)?.id || 0
  const previousFirst = chatMessages.value[0]?.id || 0
  try {
    const res = await api.get(path, { ...request.config, params: { limit: 50 } })
    if (!request.current() || version !== loadVersion) return
    let incoming = anonymousMessages(Array.isArray(res.data) ? res.data : res.data.messages)
    const initialIncoming = incoming
    let page = res.data
    // 补齐新增空洞并更新已加载历史的撤回/已读状态，不恢复旧内容。
    while (previousFirst && incoming.length && incoming[0].id > previousFirst && page.hasMore && page.next_before_id) {
      const older = await api.get(path, { ...request.config, params: { limit: 200, before: page.next_before_id } })
      if (!request.current() || version !== loadVersion) return
      const rows = anonymousMessages(older.data.messages)
      if (!rows.length || rows[0].id >= incoming[0].id) break
      incoming = mergeMessages(rows, incoming)
      page = older.data
    }
    if (!request.current() || version !== loadVersion) return
    chatMessages.value = previousLast && incoming.length ? mergeMessages(chatMessages.value, incoming) : incoming
    if (!previousLast || !incoming.length) {
      hasMoreHistory.value = !!res.data.hasMore
      historyCursor.value = res.data.next_before_id || res.data.next_before || null
      if (!historyCursor.value) hasMoreHistory.value = false
    }
    applyMeta(res.data)
    loadError.value = ''
    loading.value = false
    const fresh = incoming.filter(message => message.id > previousLast && !message.is_mine).length
    await nextTick()
    if (!request.current() || version !== loadVersion) return
    if (!previousLast || wasNearBottom) scrollToBottom()
    else if (initialIncoming.length) unseenCount.value += fresh
  } catch (e) {
    if (!request.current() || version !== loadVersion) return
    if (e.response?.status === 403 || e.response?.status === 404) {
      denyAccess()
    }
    loadError.value = getApiErrorMessage(e, e.response?.status === 403 || e.response?.status === 404 ? '对话不存在或当前无权访问' : '对话加载失败，请重试')
  } finally { if (request.current() && version === loadVersion) loading.value = false; request.release() }
}
async function retryMessages() { await loadMessages(); if (!disposed) startPolling() }
async function loadOlderMessages() {
  if (loadingHistory.value || !hasMoreHistory.value || !historyCursor.value || loading.value) return
  const request = scope.request()
  loadingHistory.value = true
  historyError.value = ''
  const area = messagesArea.value
  const previousHeight = area?.scrollHeight || 0
  const previousTop = area?.scrollTop || 0
  try {
    const res = await api.get(conversationPath(), { ...request.config, params: { limit: 50, before: historyCursor.value } })
    if (!request.current()) return
    chatMessages.value = mergeMessages(anonymousMessages(res.data.messages), chatMessages.value)
    hasMoreHistory.value = !!res.data.hasMore
    historyCursor.value = res.data.next_before_id || res.data.next_before || null
    if (!historyCursor.value) hasMoreHistory.value = false
    applyMeta(res.data)
    await nextTick()
    if (request.current() && area && area === messagesArea.value) area.scrollTop = previousTop + area.scrollHeight - previousHeight
  } catch (e) {
    if (!request.current()) return
    if (e.response?.status === 403 || e.response?.status === 404) { denyAccess(); loadError.value = '对话不存在或当前无权访问' }
    else historyError.value = getApiErrorMessage(e, '历史消息加载失败，请重试')
  }
  finally { if (request.current()) loadingHistory.value = false; request.release() }
}
async function sendMessage() {
  const text = newMessage.value.trim()
  if (disposed || loading.value || !text || sending.value || isClosed.value) return
  if (text.length > 2000) { sendError.value = '消息不能超过 2000 字'; return }
  const request = scope.request()
  const path = conversationPath()
  sending.value = true
  sendError.value = ''
  try {
    await api.post(path + '/reply', { content: text }, request.config)
    if (!request.current()) return
    if (newMessage.value.trim() === text) newMessage.value = ''
    showEmoji.value = false
    await loadMessages(true)
    if (request.current()) composerRef.value?.focus()
  } catch (e) { if (request.current()) sendError.value = getApiErrorMessage(e, '发送失败，内容已保留，请重试') }
  finally { if (request.current()) sending.value = false; request.release() }
}
function promptCloseConversation() { if (!closing.value && !isClosed.value) showCloseConfirm.value = true }
async function closeConversation() {
  if (closing.value || isClosed.value) return
  const request = scope.request()
  closing.value = true
  try {
    await api.post(conversationPath() + '/close', {}, request.config)
    if (!request.current()) return
    isClosed.value = true
    stopPolling()
    await loadMessages(true)
  } catch (e) { if (request.current()) toast.error(getApiErrorMessage(e, '关闭失败')) }
  finally { if (request.current()) closing.value = false; request.release() }
}
function addEmoji(emoji) { composerRef.value?.insertText(emoji) }
function promptReport() { if (!canReport.value) return; reportReason.value = ''; showReportConfirm.value = true }
async function doReport() {
  if (reporting.value || !canReport.value) return
  const reason = reportReason.value.trim()
  if (!reason || reason.length > 1000) { toast.error('请填写 1–1000 字的举报原因'); return }
  const request = scope.request()
  const conversationId = String(route.params.conversationId)
  reporting.value = true
  try {
    await api.post('/messages/report-user', { conversation_id: conversationId, reason, selected_message_ids: chatMessages.value.filter(message => !message.is_mine).slice(-50).map(message => message.id) }, request.config)
    if (request.current()) { toast.success('举报已提交'); showReportConfirm.value = false }
  } catch (e) { if (request.current()) toast.error(getApiErrorMessage(e, '举报失败')) }
  finally { if (request.current()) reporting.value = false; request.release() }
}
async function copyMessage(message) {
  if (message.is_revoked || !message.content) return
  const request = scope.request()
  copyFallback.value = ''
  operationStatus.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(message.content)
    if (request.current()) operationStatus.value = '消息内容已复制'
  } catch {
    if (request.current()) { copyFallback.value = message.content; operationStatus.value = '浏览器无法自动复制，请在下方选中文本后复制' }
  } finally { request.release() }
}
function scrollToBottom() { const area = messagesArea.value; if (area) area.scrollTop = area.scrollHeight; unseenCount.value = 0 }
function onMessagesScroll() { if (isNearBottom(messagesArea.value)) unseenCount.value = 0 }
function stopPolling() { clearTimeout(refreshTimer); refreshTimer = null }
function startPolling() {
  stopPolling()
  if (disposed || isClosed.value || document.visibilityState === 'hidden') return
  const version = contextVersion
  refreshTimer = setTimeout(async () => { await loadMessages(true); if (!disposed && version === contextVersion) startPolling() }, pollMilliseconds(settingsStore.prefs.chat_poll_interval))
}
async function onVisibilityChange() {
  stopPolling()
  if (disposed || document.visibilityState !== 'visible') return
  const version = contextVersion
  await loadMessages(true)
  if (!disposed && version === contextVersion) startPolling()
}
async function openConversation() {
  scope.reset(); stopPolling(); contextVersion++; loadVersion++
  const version = contextVersion
  chatMessages.value = []; newMessage.value = ''; loading.value = true; sending.value = closing.value = reporting.value = false
  isClosed.value = isInitiator.value = canReport.value = false; loadingHistory.value = false; hasMoreHistory.value = false; historyCursor.value = null
  showReportConfirm.value = showCloseConfirm.value = showEmoji.value = false
  loadError.value = historyError.value = sendError.value = copyFallback.value = operationStatus.value = ''; unseenCount.value = 0
  await loadMessages()
  if (!disposed && version === contextVersion) startPolling()
}
watch(() => [route.params.conversationId, wallStore.currentWallId, userStore.sessionRevision, userStore.token], openConversation)
watch(() => settingsStore.prefs.chat_poll_interval, startPolling)
onMounted(() => { document.addEventListener('visibilitychange', onVisibilityChange); return openConversation() })
onBeforeUnmount(() => { disposed = true; scope.dispose(); loadVersion++; contextVersion++; stopPolling(); document.removeEventListener('visibilitychange', onVisibilityChange) })
</script>

<template>
  <div class="tree-hole-chat" :class="{ compact: dense }">
    <div class="chat-header glass">
      <button class="btn btn-secondary btn-sm" @click="router.push('/tree-hole/list')"><Icon name="chevron-left" :size="15" />返回</button>
      <div class="chat-title"><h1>匿名对话</h1><p class="text-muted">只显示对话内容，不公开双方身份</p></div>
      <div class="header-right">
        <span v-if="isClosed" class="closed-badge">已归档</span>
        <button v-else class="btn btn-secondary btn-sm" :disabled="closing || loading" @click="promptCloseConversation">关闭对话</button>
        <button v-if="canReport" :disabled="reporting" class="btn btn-secondary btn-sm" @click="promptReport" title="举报">举报</button>
      </div>
    </div>

    <div v-if="loading" class="skeleton-stack" role="status" aria-label="正在加载匿名对话"><SkeletonCard :lines="4" /><SkeletonCard :lines="2" /></div>

    <div v-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="retryMessages">重试</button></div>
    <template v-if="!loading && (!loadError || chatMessages.length)">
      <div ref="messagesArea" class="messages-area glass" :class="{ 'is-empty': chatMessages.length === 0 }" role="log" aria-label="树洞消息" :aria-live="loadingHistory ? 'off' : 'polite'" aria-relevant="additions text" @scroll.passive="onMessagesScroll">
        <div v-if="hasMoreHistory" class="history-control"><button class="btn btn-secondary btn-sm" :disabled="loadingHistory" @click="loadOlderMessages">{{ loadingHistory ? '正在加载…' : '加载更早的消息' }}</button></div>
        <p v-if="historyError" class="state-error" role="alert">{{ historyError }} <button class="btn btn-secondary btn-sm" @click="loadOlderMessages">重试</button></p>
        <div v-if="chatMessages.length === 0" class="empty-state">
          <p>暂无消息，开始对话吧</p>
        </div>

        <div
          v-for="msg in chatMessages"
          :key="msg.id"
          class="message-item"
          :class="{ 'message-mine': msg.is_mine }"
        >
          <div v-if="msg.is_revoked && msg.content === '[对话已关闭]'" class="system-notice">
            对话已关闭
          </div>
          <template v-else>
            <div class="message-label">{{ msg.is_mine ? '我' : (isInitiator ? '树洞志愿者' : '匿名倾诉者') }}</div>
            <div class="message-bubble" :class="{ revoked: msg.is_revoked }">
              <div class="message-content">{{ msg.is_revoked ? '消息已撤回' : msg.content }}</div>
              <div v-if="showTimestamps" class="message-time">{{ fullTime(msg.created_at) }}<span v-if="msg.is_mine && !msg.is_revoked"> · {{ msg.is_read ? '已读' : '未读' }}</span></div>
            </div>
            <button v-if="!msg.is_revoked" class="copy-message" @click="copyMessage(msg)" :aria-label="'复制' + (msg.is_mine ? '我的' : '对方的') + '这条消息'">复制</button>
          </template>
        </div>
      </div>

      <button v-if="unseenCount" class="new-message-link btn btn-secondary btn-sm" @click="scrollToBottom">{{ unseenCount }} 条新消息 · 查看最新</button>
      <p v-if="operationStatus" class="operation-status text-muted" role="status">{{ operationStatus }}</p>
      <div v-if="copyFallback" class="copy-fallback glass"><label for="anonymous-copy">手动复制消息</label><textarea id="anonymous-copy" :value="copyFallback" readonly rows="3" @focus="$event.target.select()"></textarea><button class="btn btn-secondary btn-sm" @click="copyFallback = ''">完成</button></div>
      <div v-if="isClosed" class="closed-notice glass">
        对话已关闭，无法继续发送消息
      </div>

      <template v-else>
        <div v-if="showEmoji" id="anonymous-emojis" class="emoji-picker glass" @keydown.esc="showEmoji = false; composerRef?.focus()">
          <div class="emoji-grid">
            <button v-for="emoji in emojis" :key="emoji" class="emoji-btn" :aria-label="'插入表情 ' + emoji" @click="addEmoji(emoji)">{{ emoji }}</button>
          </div>
        </div>

        <p v-if="sendError" class="state-error" role="alert">{{ sendError }}</p>
        <SocialComposer ref="composerRef" v-model="newMessage" :sending="sending" :disabled="loading || isClosed" :shortcut="shortcut" @submit="sendMessage"><template #tools><button class="emoji-toggle" type="button" aria-label="插入表情" aria-controls="anonymous-emojis" :aria-expanded="showEmoji" @click="showEmoji = !showEmoji" :class="{ active: showEmoji }"><Icon name="smile" :size="19" /></button></template></SocialComposer>
      </template>
    </template>

    <ConfirmModal
      :show="showCloseConfirm"
      title="关闭对话"
      message="确定关闭此对话？关闭后双方将无法继续发送消息。"
      confirmText="确定关闭"
      danger
      @confirm="closeConversation"
      @cancel="showCloseConfirm = false"
      @update:show="showCloseConfirm = $event"
    />

    <ConfirmModal
      :show="showReportConfirm"
      title="举报用户"
      confirmText="提交举报"
      danger
      :prompt="true"
      :promptValue="reportReason"
      promptPlaceholder="请填写举报原因..."
      @confirm="doReport"
      @cancel="showReportConfirm = false"
      @update:show="showReportConfirm = $event"
      @update:promptValue="reportReason = $event"
    />
  </div>
</template>

<style scoped>
.tree-hole-chat { display: flex; flex-direction: column; height: calc(100vh - 100px); animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.chat-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 12px; border-radius: var(--radius-md); flex-shrink: 0; }
.chat-header h3 { flex: 1; font-size: 1.125rem; }
.header-right { display: flex; align-items: center; gap: 8px; }

.closed-badge { font-size: 0.75rem; padding: 3px 10px; border-radius: var(--radius-md); background: rgba(255,255,255,0.1); color: var(--text-muted); }

.messages-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.message-item { display: flex; flex-direction: column; align-items: flex-start; }
.message-item.message-mine { align-items: flex-end; }

.message-label { font-size: 0.6875rem; color: var(--text-muted); margin-bottom: 2px; padding: 0 4px; }

.message-bubble { max-width: 70%; padding: 10px 14px; border-radius: var(--radius-lg); background: rgba(255,255,255,0.1); border-bottom-left-radius: 4px; }
.message-mine .message-bubble { background: color-mix(in srgb, var(--accent-1) 30%, transparent); border-bottom-left-radius: 16px; border-bottom-right-radius: 4px; }
.message-bubble.revoked { opacity: 0.5; font-style: italic; }

.message-content { font-size: 0.875rem; line-height: 1.5; word-break: break-word; }
.message-time { font-size: 0.6875rem; margin-top: 4px; text-align: right; color: var(--text-muted); }

.system-notice { text-align: center; font-size: 0.8125rem; color: var(--text-muted); padding: 8px; width: 100%; }

.closed-notice { text-align: center; padding: 14px; border-radius: var(--radius-md); font-size: 0.875rem; color: var(--text-muted); margin-top: 12px; flex-shrink: 0; }

.emoji-picker { padding: 12px; border-radius: var(--radius-md); margin-bottom: 8px; max-height: 200px; overflow-y: auto; }
.emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.emoji-btn { background: none; border: none; font-size: 1.375rem; padding: 6px; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.2); }

.input-area { display: flex; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); margin-top: 12px; flex-shrink: 0; align-items: center; }
.input-area input { flex: 1; }
.emoji-toggle { background: none; border: none; font-size: 1.5rem; cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-toggle:hover, .emoji-toggle.active { background: rgba(255,255,255,0.15); }

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.tree-hole-chat { height: calc(100dvh - 112px); min-height: 22rem; }
.messages-area { min-height: 0; overscroll-behavior: contain; }
.messages-area.is-empty { display: flex; flex-direction: column; }
.messages-area.is-empty > .empty-state { width: 100%; box-sizing: border-box; margin-block: auto; padding-block: clamp(2rem, 8vh, 5rem); }
.message-content { white-space: pre-wrap; line-height: 1.65; }
.input-area input { min-width: 0; }
@media (max-width: 480px) { .chat-header { flex-wrap: wrap; padding: 10px; } .header-right { margin-left: auto; } .input-area { padding: 10px 8px; gap: 6px; } .message-bubble { max-width: 90%; } }
.tree-hole-chat { height: var(--app-content-height, calc(100dvh - 112px)); min-height: 0; max-width: 58rem; margin-inline: auto; }
.chat-header { flex-wrap: wrap; margin-bottom: var(--space-2); }
.chat-title { flex: 1; min-width: 8rem; }
.chat-title h1 { font-size: var(--font-lg); font-weight: 600; }
.chat-title p { font-size: var(--font-xs); margin-top: var(--space-1); }
.messages-area { overflow-anchor: none; gap: var(--space-4); }
.history-control { display: flex; justify-content: center; margin-bottom: var(--space-3); }
.message-bubble { background: var(--surface-raised); border: 1px solid var(--border-strong); }
.message-mine .message-bubble { background: color-mix(in srgb, var(--accent-1) 22%, var(--surface-raised)); border-color: var(--accent-line); }
.message-bubble.revoked { background: var(--surface-raised); opacity: .88; }
.message-content { font-size: var(--font-base); line-height: 1.7; overflow-wrap: anywhere; }
.message-time { font-size: var(--font-xs); }
.message-label { font-size: var(--font-xs); }
.copy-message { background: transparent; border: 0; color: var(--text-muted); font-size: var(--font-xs); cursor: pointer; min-width: 44px; min-height: 44px; padding: .3rem .6rem; border-radius: var(--radius-sm); }
.copy-message:hover, .emoji-btn:hover, .emoji-toggle:hover, .emoji-toggle.active { color: var(--text-primary); background: var(--bg-card-hover); }
.emoji-toggle { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; min-width: 44px; min-height: 44px; color: var(--text-secondary); }
.new-message-link { align-self: center; margin-bottom: var(--space-2); }
.operation-status { font-size: var(--font-xs); padding: var(--space-2); }
.copy-fallback { padding: var(--space-3); flex-shrink: 0; }
.copy-fallback label { display: block; font-size: var(--font-sm); margin-bottom: var(--space-2); }
.copy-fallback textarea { width: 100%; max-height: 6rem; }
.compact .messages-area { gap: var(--space-2); }
.compact .message-bubble { padding: .4rem .7rem; }
.state-error { flex-shrink: 0; }
@media (max-width: 480px) { .messages-area { padding: var(--space-3); } .message-bubble { max-width: 92%; } .header-right { width: 100%; justify-content: flex-end; } }
</style>
