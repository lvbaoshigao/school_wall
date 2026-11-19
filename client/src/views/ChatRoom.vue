<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useToast } from '../composables/useToast'
import api from '../api'
import { useFocusTrap } from '../composables/useFocusTrap'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import SkeletonCard from '../components/SkeletonCard.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
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
const loadError = ref('')
const messagesArea = ref(null)
const reportModal = ref(null)
const menuRef = ref(null)
const clearing = ref(false)
const revoking = ref(false)
useFocusTrap(() => showReportModal.value, reportModal, () => { showReportModal.value = false })
useFocusTrap(() => contextMenu.value.show, menuRef, hideContextMenu)
let disposed = false
let loadVersion = 0
let loadController = null

const emojis = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎',
  '🤔', '😅', '😢', '😭', '😡', '🥺', '😴', '🤯',
  '👍', '👎', '👏', '🙏', '💪', '❤️', '💔', '💕',
  '🎉', '🎊', '🎈', '🎁', '🌟', '⭐', '🔥', '💯',
  '😊', '😇', '🙂', '😉', '😋', '🤗', '🤭', '🤫',
  '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪'
]

let refreshTimer = null
// 轮询间隔：会话已有专用接口，不必再像以前那样 5 秒搬一次全量收件箱
const POLL_MS = 20000

// 每次刷新取消上一轮请求，版本号同时隔离路由切换和卸载后的响应。
async function loadMessages(silent = false) {
  if (disposed) return
  const userId = String(route.params.id)
  const version = ++loadVersion
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  if (!silent) loading.value = true
  try {
    if (!chatUser.value) {
      try {
        const userRes = await api.get('/auth/user/' + userId, { signal: controller.signal })
        if (disposed || version !== loadVersion) return
        chatUser.value = userRes.data
      } catch (e) {
        if (controller.signal.aborted) return
      }
    }
    const res = await api.get('/messages/conversation/' + userId, { params: { limit: 100 }, signal: controller.signal })
    if (disposed || version !== loadVersion) return
    // 撤回和已读会改变已有消息；不能仅用首尾 ID 判断是否更新。
    messages.value = res.data.messages || []
    loadError.value = ''
  } catch (e) {
    if (!disposed && version === loadVersion && !controller.signal.aborted) {
      loadError.value = e.response?.data?.error || '消息加载失败，请重试'
    }
  } finally {
    if (!disposed && version === loadVersion) loading.value = false
  }
}


async function sendMessage() {
  if (disposed || loading.value || !newMessage.value.trim() || sending.value) return
  if (newMessage.value.trim().length > 2000) { toast.error('消息不能超过2000字'); return }
  const receiverId = String(route.params.id)
  const content = newMessage.value.trim()
  sending.value = true
  try {
    await api.post('/messages', {
      receiver_id: Number(receiverId),
      type: 'private',
      content,
      is_anonymous: false,
      reply_to_id: replyTo.value?.id || 0,
    })
    if (disposed || String(route.params.id) !== receiverId) return
    newMessage.value = ''
    showEmoji.value = false
    replyTo.value = null
    await loadMessages(true)
    await nextTick()
    scrollToBottom()
  } catch (e) {
    toast.error(e.response?.data?.error || '发送失败')
  } finally {
    sending.value = false
  }
}

// 举报弹窗的证据列表：原先是模板内 messages.filter(...)，
// 每次渲染（包括鼠标移动引起的重渲染）都会新建数组并全量过滤一遍。
const reportableMessages = computed(() => messages.value.filter(m => !m.is_revoked))

function addEmoji(emoji) { newMessage.value += emoji }

async function clearChat() {
  showClearChatConfirm.value = true
}

async function doClearChat() {
  if (clearing.value) return
  clearing.value = true
  try {
    const res = await api.delete(`/messages/chat/${route.params.id}`)
    toast.success(res.data.message)
    await loadMessages(true)
  } catch (e) { toast.error(e.response?.data?.error || '清空失败') }
  finally { clearing.value = false }
}

function scrollToBottom() {
  const area = messagesArea.value
  if (area) area.scrollTop = area.scrollHeight
}

function showContextMenu(e, msg) {
  e.preventDefault()
  const rect = e.currentTarget?.getBoundingClientRect()
  const x = e.clientX || rect?.left || 16
  const y = e.clientY || rect?.bottom || 80
  contextMenu.value = { show: true, x: Math.max(8, Math.min(x, window.innerWidth - 170)), y: Math.max(8, Math.min(y, window.innerHeight - 160)), msg }
}

function handleLongPress(msg) {
  contextMenu.value = { show: true, x: window.innerWidth / 2, y: window.innerHeight / 2, msg }
}

function hideContextMenu() {
  contextMenu.value = { show: false, x: 0, y: 0, msg: null }
}

function setReply(msg) {
  if (msg.is_revoked) return
  replyTo.value = msg
  hideContextMenu()
}

async function revokeMessage(msg) {
  revokeTarget.value = msg
  showRevokeConfirm.value = true
}

async function doRevokeMessage() {
  const msg = revokeTarget.value
  if (!msg || revoking.value) return
  revoking.value = true
  try {
    await api.put(`/messages/${msg.id}/revoke`)
    await loadMessages(true)
  } catch (e) {
    toast.error(e.response?.data?.error || '撤回失败')
  }
  revoking.value = false
  revokeTarget.value = null
}

async function copyMessage(msg) {
  try { await navigator.clipboard.writeText(msg.content); toast.success('已复制') }
  catch { toast.error('复制失败，请选择消息文字后复制') }
  hideContextMenu()
}

function canRevoke(msg) {
  if (msg.sender_id !== userStore.user?.id || msg.is_revoked) return false
  const created = new Date(msg.created_at.replace(' ', 'T')).getTime()
  return Date.now() - created <= 5 * 60 * 1000
}

function isMine(msg) {
  return msg.sender_id === userStore.user?.id
}

let longPressTimer = null
function onTouchStart(msg) {
  clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => handleLongPress(msg), 600)
}
function onTouchEnd() {
  clearTimeout(longPressTimer)
}

function openReportModal() {
  showReportModal.value = true
  selectedMsgIds.value = new Set()
  reportReason.value = ''
}

function toggleMsgSelection(msgId) {
  if (selectedMsgIds.value.has(msgId)) selectedMsgIds.value.delete(msgId)
  else selectedMsgIds.value.add(msgId)
}

async function submitReport() {
  if (reportSubmitting.value) return
  if (!reportReason.value.trim()) { toast.error('请填写举报描述'); return }
  reportSubmitting.value = true
  try {
    await api.post('/messages/report-user', {
      reported_user_id: parseInt(route.params.id),
      reason: reportReason.value.trim(),
      selected_message_ids: [...selectedMsgIds.value]
    })
    toast.success('举报已提交，管理员会尽快处理')
    showReportModal.value = false
  } catch (e) {
    toast.error(e.response?.data?.error || '举报失败')
  } finally {
    reportSubmitting.value = false
  }
}

// 使用串行 timeout；慢请求不会与下一轮叠加，后台暂停。
function stopPolling() {
  clearTimeout(refreshTimer)
  refreshTimer = null
}
function startPolling() {
  stopPolling()
  if (disposed || document.visibilityState === 'hidden') return
  refreshTimer = setTimeout(async () => {
    const area = messagesArea.value
    const nearBottom = !area || area.scrollHeight - area.scrollTop - area.clientHeight < 80
    await loadMessages(true)
    if (!disposed && nearBottom) { await nextTick(); scrollToBottom() }
    startPolling()
  }, POLL_MS)
}
async function onVisibilityChange() {
  stopPolling()
  if (document.visibilityState !== 'visible' || disposed) return
  await loadMessages(true)
  startPolling()
}
async function openConversation() {
  messages.value = []
  chatUser.value = null
  newMessage.value = ''
  replyTo.value = null
  showReportModal.value = false
  hideContextMenu()
  await loadMessages()
  if (disposed) return
  await nextTick()
  scrollToBottom()
}
watch(() => route.params.id, openConversation)
onMounted(async () => {
  document.addEventListener('click', hideContextMenu)
  document.addEventListener('visibilitychange', onVisibilityChange)
  await openConversation()
  startPolling()
})
onBeforeUnmount(() => {
  disposed = true
  loadVersion++
  loadController?.abort()
  stopPolling()
  clearTimeout(longPressTimer)
  document.removeEventListener('click', hideContextMenu)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="chat-room">
    <div class="chat-header glass">
      <button class="btn btn-secondary btn-sm" @click="router.push('/chat')"><Icon name="chevron-left" :size="15" />返回</button>
      <h3 v-if="chatUser">{{ chatUser.nickname || chatUser.username }}</h3>
      <h3 v-else>聊天</h3>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="openReportModal" title="举报用户" aria-label="举报用户"><Icon name="alert-triangle" :size="15" /></button>
        <button class="btn btn-secondary btn-sm" @click="clearChat" title="清空聊天记录" aria-label="清空聊天记录"><Icon name="trash" :size="15" /></button>
      </div>
    </div>

    <div v-if="loading" class="chat-loading">
      <SkeletonCard :lines="2" />
      <SkeletonCard :lines="2" />
      <SkeletonCard :lines="3" />
    </div>

    <p v-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadMessages()">重试</button></p>
    <template v-else>
      <div ref="messagesArea" class="messages-area" role="log" aria-label="聊天消息" aria-live="polite" aria-relevant="additions text">
        <div v-if="messages.length === 0" class="empty-state">
          <p>暂无消息，开始聊天吧</p>
        </div>

        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message-item"
          :class="{ 'message-mine': isMine(msg) }"
          tabindex="0"
          :aria-label="`${isMine(msg) ? '我' : '对方'}的消息，按回车打开操作`"
          @keydown.enter.prevent="showContextMenu($event, msg)"
          @contextmenu="showContextMenu($event, msg)"
          @touchstart="onTouchStart(msg)"
          @touchend="onTouchEnd"
          @touchmove="onTouchEnd"
        >
          <div class="message-bubble" :class="{ revoked: msg.is_revoked }">
            <div v-if="msg.reply_to_content" class="reply-preview">
              <span class="reply-label">回复</span>
              <span class="reply-text">{{ msg.reply_to_content }}</span>
            </div>
            <div class="message-content">{{ msg.is_revoked ? '[消息已撤回]' : msg.content }}</div>
            <div class="message-time">
              {{ new Date(msg.created_at.replace(' ', 'T')).toLocaleTimeString() }}
            </div>
          </div>
        </div>
      </div>

      <!-- 引用预览 -->
      <div v-if="replyTo" class="reply-bar glass">
        <div class="reply-bar-content">
          <span class="reply-bar-label">回复:</span>
          <span class="reply-bar-text">{{ replyTo.content?.substring(0, 60) }}</span>
        </div>
        <button class="reply-bar-close" aria-label="取消引用" @click="replyTo = null"><Icon name="close" :size="15" /></button>
      </div>

      <!-- 右键菜单 -->
      <Teleport to="body">
        <div v-if="contextMenu.show" ref="menuRef" tabindex="-1" role="dialog" aria-label="消息操作" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
          <button v-if="!contextMenu.msg?.is_revoked" class="context-item" @click="setReply(contextMenu.msg)"><Icon name="reply" :size="15" />引用</button>
          <button v-if="!contextMenu.msg?.is_revoked" class="context-item" @click="copyMessage(contextMenu.msg)"><Icon name="copy" :size="15" />复制</button>
          <button v-if="canRevoke(contextMenu.msg)" class="context-item danger" @click="revokeMessage(contextMenu.msg)"><Icon name="refresh" :size="15" />撤回</button>
        </div>
      </Teleport>

      <div v-if="showEmoji" class="emoji-picker glass">
        <div class="emoji-grid">
          <button v-for="emoji in emojis" :key="emoji" class="emoji-btn" @click="addEmoji(emoji)">{{ emoji }}</button>
        </div>
      </div>

      <div class="input-area glass">
        <button class="emoji-toggle" aria-label="插入表情" :aria-expanded="showEmoji" @click="showEmoji = !showEmoji" :class="{ active: showEmoji }"><Icon name="smile" :size="19" /></button>
        <input v-model="newMessage" aria-label="消息内容" maxlength="2000" :placeholder="replyTo ? '回复消息...' : '输入消息...'" @keydown.enter="!$event.isComposing && sendMessage()" :disabled="sending" />
        <button class="btn btn-primary" :disabled="!newMessage.trim() || sending" @click="sendMessage">
          {{ sending ? '...' : '发送' }}
        </button>
      </div>
    </template>

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

    <!-- 清空聊天确认 -->
    <ConfirmModal
      :show="showClearChatConfirm"
      title="清空聊天记录"
      message="确定清空你在此对话中发出的聊天记录吗？对方发来的消息会保留。"
      confirm-text="清空"
      cancel-text="取消"
      :danger="true"
      @confirm="doClearChat"
      @update:show="showClearChatConfirm = $event"
    />

    <!-- 撤回消息确认 -->
    <ConfirmModal
      :show="showRevokeConfirm"
      title="撤回消息"
      message="确定撤回这条消息？"
      confirm-text="撤回"
      cancel-text="取消"
      :danger="false"
      @confirm="doRevokeMessage"
      @update:show="showRevokeConfirm = $event"
    />
  </div>
</template>

<style scoped>
.chat-room { display: flex; flex-direction: column; height: calc(100vh - 100px); animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.chat-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 12px; border-radius: var(--radius-md); flex-shrink: 0; }
.chat-header h3 { flex: 1; font-size: 1.125rem; }
.header-actions { display: flex; gap: 6px; }

.messages-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.chat-loading { flex: 1; display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.message-item { display: flex; justify-content: flex-start; user-select: none; }
.message-item.message-mine { justify-content: flex-end; }

.message-bubble { max-width: 70%; padding: 10px 14px; border-radius: var(--radius-lg); background: rgba(255,255,255,0.1); border-bottom-left-radius: 4px; }
.message-mine .message-bubble { background: color-mix(in srgb, var(--accent-1) 30%, transparent); border-bottom-left-radius: 16px; border-bottom-right-radius: 4px; }
.message-bubble.revoked { opacity: 0.5; font-style: italic; }

.reply-preview { padding: 6px 10px; margin-bottom: 6px; background: rgba(255,255,255,0.08); border-left: 3px solid rgba(201,185,154,0.5); border-radius: var(--radius-xs); font-size: 0.75rem; }
.reply-label { color: rgba(201,185,154,0.8); margin-right: 4px; }
.reply-text { color: var(--text-muted); }

.message-content { font-size: 0.875rem; line-height: 1.5; word-break: break-word; }
.message-time { font-size: 0.6875rem; margin-top: 4px; text-align: right; color: var(--text-muted); }

.reply-bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-radius: var(--radius-md); margin-bottom: 4px; flex-shrink: 0; }
.reply-bar-content { flex: 1; min-width: 0; }
.reply-bar-label { font-size: 0.75rem; color: var(--text-link); margin-right: 6px; }
.reply-bar-text { font-size: 0.8125rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reply-bar-close { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; padding: 2px 6px; }

.context-menu { position: fixed; z-index: 9999; min-width: 140px; background: var(--surface-raised); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.15); border-radius: var(--radius-md); padding: 6px; box-shadow: var(--shadow-md); }
.context-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text-primary); padding: 10px 14px; font-size: 0.875rem; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s; }
.context-item:hover { background: rgba(255,255,255,0.12); }
.context-item.danger { color: var(--danger); }

.emoji-picker { padding: 12px; border-radius: var(--radius-md); margin-bottom: 8px; max-height: 200px; overflow-y: auto; }
.emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.emoji-btn { background: none; border: none; font-size: 1.375rem; padding: 6px; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.2); }

.input-area { display: flex; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); margin-top: 12px; flex-shrink: 0; align-items: center; }
.input-area input { flex: 1; }
.emoji-toggle { background: none; border: none; font-size: 1.5rem; cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-toggle:hover, .emoji-toggle.active { background: rgba(255,255,255,0.15); }

.report-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center; z-index: 9998; }
.report-modal { padding: 24px; border-radius: var(--radius-lg); width: 90%; max-width: 500px; max-height: 80vh; overflow-y: auto; }
.report-modal h3 { margin-bottom: 8px; font-size: 1.125rem; }

.evidence-section { margin-bottom: 16px; }
.evidence-label { display: block; font-size: 0.875rem; margin-bottom: 8px; color: var(--text-secondary); }
.evidence-messages { max-height: 200px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: var(--radius-md); padding: 4px; }
.evidence-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.8125rem; transition: background 0.15s; }
.evidence-item:hover { background: rgba(255,255,255,0.06); }
.evidence-item.selected { background: color-mix(in srgb, var(--accent-1) 15%, transparent); }
.evidence-item.mine .ev-sender { color: var(--text-link); }
.ev-check { width: 16px; height: 16px; accent-color: var(--accent-1); flex-shrink: 0; pointer-events: none; }
.ev-sender { font-weight: 600; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0; width: 30px; }
.ev-text { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

.report-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 12px; }

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.chat-room { height: calc(100dvh - 112px); min-height: 22rem; }
.messages-area { min-height: 0; overscroll-behavior: contain; }
.message-item { user-select: text; }
.message-bubble { max-width: min(80%, 36rem); }
.message-content { white-space: pre-wrap; line-height: 1.65; }
.input-area input, .chat-header h3 { min-width: 0; }
.chat-header h3 { overflow-wrap: anywhere; }
.context-menu { background: var(--surface-raised); z-index: var(--z-modal); }
.ev-check { pointer-events: auto; accent-color: var(--accent-1); }
.reply-preview { border-color: var(--accent-line); }
@media (max-width: 480px) { .chat-header, .input-area { padding: 10px 8px; gap: 6px; } .messages-area { padding: 10px 2px; } .message-bubble { max-width: 90%; } .report-modal { padding: 18px; max-height: 85dvh; } }
</style>
