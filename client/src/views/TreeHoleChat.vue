<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
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
const messagesArea = ref(null)
const closing = ref(false)
const reporting = ref(false)
let disposed = false
let loadVersion = 0
let loadController = null
let refreshTimer = null

const showCloseConfirm = ref(false)
const showReportConfirm = ref(false)
const reportReason = ref('')

const emojis = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎',
  '🤔', '😅', '😢', '😭', '😡', '🥺', '😴', '🤯',
  '👍', '👎', '👏', '🙏', '💪', '❤️', '💔', '💕',
  '🎉', '🎊', '🎈', '🎁', '🌟', '⭐', '🔥', '💯',
  '😊', '😇', '🙂', '😉', '😋', '🤗', '🤭', '🤫',
  '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪'
]

async function loadMessages() {
  if (disposed) return
  const conversationId = String(route.params.conversationId)
  const version = ++loadVersion
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  try {
    const res = await api.get('/messages/tree-hole/' + conversationId, { signal: controller.signal })
    if (disposed || version !== loadVersion) return
    chatMessages.value = Array.isArray(res.data) ? res.data : (res.data.messages || [])
    isClosed.value = !!res.data.is_closed
    isInitiator.value = !!res.data.is_initiator
    canReport.value = !!res.data.can_report
    loadError.value = ''
  } catch (e) {
    if (disposed || version !== loadVersion || controller.signal.aborted) return
    if (e.response?.status === 403 || e.response?.status === 404) {
      toast.error('对话不存在或无权访问')
      router.push('/tree-hole/list')
    } else loadError.value = '对话加载失败，请重试'
  } finally {
    if (!disposed && version === loadVersion) loading.value = false
  }
}


async function sendMessage() {
  if (disposed || loading.value || !newMessage.value.trim() || sending.value || isClosed.value) return
  const conversationId = String(route.params.conversationId)
  sending.value = true
  try {
    await api.post(`/messages/tree-hole/${conversationId}/reply`, {
      content: newMessage.value.trim()
    })
    if (disposed || String(route.params.conversationId) !== conversationId) return
    newMessage.value = ''
    showEmoji.value = false
    await loadMessages()
    await nextTick()
    scrollToBottom()
  } catch (e) {
    toast.error(e.response?.data?.error || '发送失败')
  } finally {
    sending.value = false
  }
}

function promptCloseConversation() {
  showCloseConfirm.value = true
}

async function closeConversation() {
  if (closing.value || isClosed.value) return
  closing.value = true
  try {
    await api.post(`/messages/tree-hole/${route.params.conversationId}/close`)
    isClosed.value = true
    await loadMessages()
  } catch (e) {
    toast.error(e.response?.data?.error || '关闭失败')
  } finally { closing.value = false }
}

function addEmoji(emoji) { newMessage.value += emoji }

function promptReport() {
  reportReason.value = ''
  showReportConfirm.value = true
}

async function doReport() {
  if (reporting.value || !canReport.value) return
  if (!reportReason.value.trim()) { toast.error('请填写举报原因'); return }
  if (reportReason.value.trim().length > 1000) { toast.error('举报原因不能超过1000字'); return }
  reporting.value = true
  try {
    await api.post('/messages/report-user', {
      conversation_id: route.params.conversationId,
      reason: reportReason.value.trim(),
      selected_message_ids: chatMessages.value.filter(m => !m.is_mine).slice(-50).map(m => m.id),
    })
    toast.success('举报已提交')
    showReportConfirm.value = false
  } catch (e) {
    toast.error(e.response?.data?.error || '举报失败')
  } finally { reporting.value = false }
}

function scrollToBottom() {
  const area = messagesArea.value
  if (area) area.scrollTop = area.scrollHeight
}

function stopPolling() { clearTimeout(refreshTimer); refreshTimer = null }
function startPolling() {
  stopPolling()
  if (disposed || isClosed.value || document.visibilityState === 'hidden') return
  refreshTimer = setTimeout(async () => {
    const area = messagesArea.value
    const nearBottom = !area || area.scrollHeight - area.scrollTop - area.clientHeight < 80
    await loadMessages()
    if (!disposed && nearBottom) { await nextTick(); scrollToBottom() }
    startPolling()
  }, 10000)
}
async function onVisibilityChange() {
  stopPolling()
  if (disposed || document.visibilityState !== 'visible') return
  await loadMessages()
  startPolling()
}
async function openConversation() {
  loading.value = true
  chatMessages.value = []
  newMessage.value = ''
  isClosed.value = false
  canReport.value = false
  showReportConfirm.value = false
  await loadMessages()
  if (disposed) return
  await nextTick()
  scrollToBottom()
  startPolling()
}
watch(() => route.params.conversationId, openConversation)
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  openConversation()
})
onBeforeUnmount(() => {
  disposed = true
  loadVersion++
  loadController?.abort()
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="tree-hole-chat">
    <div class="chat-header glass">
      <button class="btn btn-secondary btn-sm" @click="router.push('/tree-hole/list')"><Icon name="chevron-left" :size="15" />返回</button>
      <h3>匿名对话</h3>
      <div class="header-right">
        <span v-if="isClosed" class="closed-badge">已归档</span>
        <button v-else class="btn btn-secondary btn-sm" :disabled="closing || loading" @click="promptCloseConversation">关闭对话</button>
        <button v-if="canReport" :disabled="reporting" class="btn btn-secondary btn-sm" @click="promptReport" title="举报">举报</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中</div>

    <div v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadMessages">重试</button></div>
    <template v-else>
      <div ref="messagesArea" class="messages-area" role="log" aria-label="树洞消息" aria-live="polite" aria-relevant="additions text">
        <div v-if="chatMessages.length === 0" class="empty-state">
          <p>暂无消息，开始对话吧</p>
        </div>

        <div
          v-for="msg in chatMessages"
          :key="msg.id"
          class="message-item"
          :class="{ 'message-mine': msg.is_mine }"
        >
          <div v-if="msg.content === '[对话已关闭]'" class="system-notice">
            倾诉者已关闭对话
          </div>
          <template v-else>
            <div class="message-label">{{ msg.is_mine ? '我' : (wallStore.canHere('wall.tree_hole') ? '匿名用户' : '树洞') }}</div>
            <div class="message-bubble" :class="{ revoked: msg.is_revoked }">
              <div class="message-content">{{ msg.content }}</div>
              <div class="message-time">{{ new Date(msg.created_at.replace(' ', 'T')).toLocaleTimeString() }}</div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="isClosed" class="closed-notice glass">
        对话已关闭，无法继续发送消息
      </div>

      <template v-else>
        <div v-if="showEmoji" class="emoji-picker glass">
          <div class="emoji-grid">
            <button v-for="emoji in emojis" :key="emoji" class="emoji-btn" @click="addEmoji(emoji)">{{ emoji }}</button>
          </div>
        </div>

        <div class="input-area glass">
          <button class="emoji-toggle" aria-label="插入表情" :aria-expanded="showEmoji" @click="showEmoji = !showEmoji" :class="{ active: showEmoji }"><Icon name="smile" :size="19" /></button>
          <input v-model="newMessage" aria-label="消息内容" maxlength="2000" placeholder="输入消息..." @keydown.enter="!$event.isComposing && sendMessage()" :disabled="sending" />
          <button class="btn btn-primary" :disabled="!newMessage.trim() || sending" @click="sendMessage">
            {{ sending ? '发送中' : '发送' }}
          </button>
        </div>
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
.message-content { white-space: pre-wrap; line-height: 1.65; }
.input-area input { min-width: 0; }
@media (max-width: 480px) { .chat-header { flex-wrap: wrap; padding: 10px; } .header-right { margin-left: auto; } .input-area { padding: 10px 8px; gap: 6px; } .message-bubble { max-width: 90%; } }
</style>
