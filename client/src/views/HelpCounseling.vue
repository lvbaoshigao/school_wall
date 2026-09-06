<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()
const content = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)
const conversationId = ref('')

async function submit() {
  if (!content.value.trim()) {
    error.value = '请填写倾诉内容'
    return
  }
  if (content.value.length > 2000) {
    error.value = '内容不能超过2000字'
    return
  }

  loading.value = true
  error.value = ''
  try {
    const res = await api.post('/messages/tree-hole', { content: content.value.trim() })
    conversationId.value = res.data.conversation_id
    success.value = true
  } catch (e) {
    error.value = e.response?.data?.error || '发送失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="counseling-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div v-if="success" class="success-card glass-strong">
      <div class="success-icon"><Icon name="check-circle" :size="40" /></div>
      <h2>已发送给树洞志愿者</h2>
      <p class="text-muted">你的消息已匿名送达，树洞会尽快回复你</p>
      <div class="action-btns">
        <button class="btn btn-primary" @click="router.push(`/tree-hole/chat/${conversationId}`)">查看对话</button>
        <button class="btn btn-secondary" @click="router.push('/tree-hole/list')">所有树洞对话</button>
      </div>
    </div>

    <div v-else class="counseling-card glass-strong">
      <h2>匿名倾诉</h2>
      <p class="text-muted mb-3">向树洞志愿者倾诉你的烦恼</p>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <div class="info-notice">
        你的消息将匿名发送给一位树洞志愿者，双方身份完全保密。树洞志愿者会在收到消息后尽快回复你。
      </div>

      <div class="form-group">
        <label>你想说什么？</label>
        <textarea
          v-model="content"
          placeholder="写下你的心里话..."
          rows="8"
          maxlength="2000"
        ></textarea>
        <div class="char-count">{{ content.length }}/2000</div>
      </div>

      <button class="btn btn-primary" style="width: 100%" :disabled="loading || !content.trim()" @click="submit">
        {{ loading ? '发送中…' : '匿名发送给树洞' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.counseling-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.counseling-card, .success-card { padding: 28px; }
.counseling-card h2, .success-card h2 { font-size: 22px; margin-bottom: 4px; }

.success-card { text-align: center; padding: 48px 28px; }
.success-icon { display: flex; justify-content: center; color: var(--success-light, #7bed9f); margin-bottom: 16px; }
.action-btns { display: flex; gap: 12px; justify-content: center; margin-top: 20px; }

.info-notice {
  background: color-mix(in srgb, var(--accent-1) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-1) 30%, transparent);
  color: var(--text-primary);
  padding: 14px 18px;
  border-radius: var(--radius-md);
  font-size: 14px;
  margin-bottom: 20px;
  line-height: 1.6;
}

textarea { resize: vertical; min-height: 180px; }
.char-count { text-align: right; font-size: 12px; color: var(--text-muted); margin-top: 4px; }

.error-msg {
  background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3);
  color: #ffb8b8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 16px;
}
</style>
