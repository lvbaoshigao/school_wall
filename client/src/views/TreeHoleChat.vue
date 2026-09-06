<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
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
const otherUserId = ref(null)
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
  try {
    const res = await api.get(`/messages/tree-hole/${route.params.conversationId}`)
    chatMessages.value = res.data.messages || res.data
    isClosed.value = res.data.is_closed || false
    isInitiator.value = res.data.is_initiator || false
    otherUserId.value = res.data.other_user_id || null
  } catch (e) {
    if (e.response?.status === 403 || e.response?.status === 404) {
      toast.error('对话不存在或无权访问')
      router.push('/tree-hole/list')
    }
  } finally {
    loading.value = false
  }
}

async function sendMessage() {
  if (!newMessage.value.trim() || sending.value || isClosed.value) return
  sending.value = true
  try {
    await api.post(`/messages/tree-hole/${route.params.conversationId}/reply`, {
      content: newMessage.value.trim()
    })
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
  try {
    await api.post(`/messages/tree-hole/${route.params.conversationId}/close`)
    isClosed.value = true
    await loadMessages()
  } catch (e) {
    toast.error(e.response?.data?.error || '关闭失败')
  }
}

function addEmoji(emoji) { newMessage.value += emoji }

function promptReport() {
  reportReason.value = ''
  showReportConfirm.value = true
}

async function doReport() {
  if (!otherUserId.value || !reportReason.value.trim()) { toast.error('请填写举报原因'); return }
  try {
    await api.post('/messages/report-user', {
      reported_user_id: otherUserId.value,
      reason: reportReason.value.trim(),
      selected_message_ids: chatMessages.value.filter(m => !m.is_mine).map(m => m.id),
    })
    toast.success('举报已提交')
    showReportConfirm.value = false
  } catch (e) {
    toast.error(e.response?.data?.error || '举报失败')
  }
}

function scrollToBottom() {
  const area = document.querySelector('.messages-area')
  if (area) area.scrollTop = area.scrollHeight
}

onMounted(async () => {
  await loadMessages()
  await nextTick()
  scrollToBottom()
  refreshTimer = setInterval(async () => {
    const prevCount = chatMessages.value.length
    await loadMessages()
    if (chatMessages.value.length > prevCount) {
      await nextTick()
      scrollToBottom()
    }
  }, 5000)
})

onUnmounted(() => { clearInterval(refreshTimer) })
</script>

<template>
  <div class="tree-hole-chat">
    <div class="chat-header glass">
      <button class="btn btn-secondary btn-sm" @click="router.push('/tree-hole/list')"><Icon name="chevron-left" :size="15" />返回</button>
      <h3>匿名对话</h3>
      <div class="header-right">
        <span v-if="isClosed" class="closed-badge">已归档</span>
        <button v-else class="btn btn-secondary btn-sm" @click="promptCloseConversation">关闭对话</button>
        <button v-if="otherUserId" class="btn btn-secondary btn-sm" @click="promptReport" title="举报">举报</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中</div>

    <template v-else>
      <div class="messages-area">
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
          <input v-model="newMessage" placeholder="输入消息..." @keyup.enter="sendMessage" :disabled="sending" />
          <button class="btn btn-primary" :disabled="!newMessage.trim() || sending" @click="sendMessage">
            {{ sending ? '...' : '发送' }}
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
.chat-header h3 { flex: 1; font-size: 18px; }
.header-right { display: flex; align-items: center; gap: 8px; }

.closed-badge { font-size: 12px; padding: 3px 10px; border-radius: var(--radius-md); background: rgba(255,255,255,0.1); color: var(--text-muted); }

.messages-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.message-item { display: flex; flex-direction: column; align-items: flex-start; }
.message-item.message-mine { align-items: flex-end; }

.message-label { font-size: 11px; color: var(--text-muted); margin-bottom: 2px; padding: 0 4px; }

.message-bubble { max-width: 70%; padding: 10px 14px; border-radius: var(--radius-lg); background: rgba(255,255,255,0.1); border-bottom-left-radius: 4px; }
.message-mine .message-bubble { background: color-mix(in srgb, var(--accent-1) 30%, transparent); border-bottom-left-radius: 16px; border-bottom-right-radius: 4px; }
.message-bubble.revoked { opacity: 0.5; font-style: italic; }

.message-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.message-time { font-size: 11px; margin-top: 4px; text-align: right; color: var(--text-muted); }

.system-notice { text-align: center; font-size: 13px; color: var(--text-muted); padding: 8px; width: 100%; }

.closed-notice { text-align: center; padding: 14px; border-radius: var(--radius-md); font-size: 14px; color: var(--text-muted); margin-top: 12px; flex-shrink: 0; }

.emoji-picker { padding: 12px; border-radius: var(--radius-md); margin-bottom: 8px; max-height: 200px; overflow-y: auto; }
.emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.emoji-btn { background: none; border: none; font-size: 22px; padding: 6px; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.2); }

.input-area { display: flex; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); margin-top: 12px; flex-shrink: 0; align-items: center; }
.input-area input { flex: 1; }
.emoji-toggle { background: none; border: none; font-size: 24px; cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); transition: all 0.2s; }
.emoji-toggle:hover, .emoji-toggle.active { background: rgba(255,255,255,0.15); }
</style>
