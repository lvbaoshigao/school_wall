<script setup>
import { ref, watch, onBeforeUnmount, useId } from 'vue'
import { useUserStore } from '../stores/user'
import { useRouter } from 'vue-router'
import { useToast } from '../composables/useToast'
import api from '../api'

const props = defineProps({ postId: { type: Number, required: true } })
const emit = defineEmits(['comment-added'])
const userStore = useUserStore()
const router = useRouter()
const toast = useToast()
const fieldId = useId()
const content = ref('')
const submitting = ref(false)
const error = ref('')
let requestId = 0
let controller
let disposed = false

watch(() => props.postId, () => {
  requestId++
  controller?.abort()
  content.value = ''
  submitting.value = false
  error.value = ''
})
onBeforeUnmount(() => { disposed = true; requestId++; controller?.abort() })

async function submit() {
  if (submitting.value) return
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  const text = content.value.trim()
  error.value = ''
  if (!text || text.length > 500) { error.value = '请输入 1–500 字的评论'; return }
  const postId = props.postId
  const request = ++requestId
  controller = new AbortController()
  submitting.value = true
  try {
    const res = await api.post('/posts/' + postId + '/comments', { content: text }, { signal: controller.signal })
    if (disposed || request !== requestId || props.postId !== postId) return
    if (content.value.trim() === text) content.value = ''
    emit('comment-added', res.data)
    toast.success('评论已发表')
  } catch (e) {
    if (disposed || request !== requestId || e.code === 'ERR_CANCELED') return
    error.value = typeof e.response?.data?.error === 'string' ? e.response.data.error : '评论发送失败，内容已保留，请重试'
  } finally {
    if (!disposed && request === requestId) submitting.value = false
  }
}
</script>

<template>
  <form class="comment-box" :aria-busy="submitting" @submit.prevent="submit">
    <label :for="fieldId">参与讨论</label>
    <textarea :id="fieldId" v-model="content" placeholder="友善交流，写下你的想法…" rows="3" maxlength="500" :aria-invalid="!!error" :aria-describedby="fieldId + '-help ' + fieldId + '-error'" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit"></textarea>
    <p :id="fieldId + '-error'" v-if="error" class="error-msg" role="alert">{{ error }}</p>
    <div class="comment-actions">
      <span :id="fieldId + '-help'" class="text-muted">{{ content.length }}/500 · Ctrl / ⌘ + Enter 发表</span>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="!content.trim() || submitting">{{ submitting ? '发送中…' : '发表评论' }}</button>
    </div>
  </form>
</template>

<style scoped>
.comment-box { margin-top: var(--space-4); padding: var(--space-4); background: var(--accent-soft); border-radius: var(--radius-md); }
.comment-box label { display: block; font-size: var(--font-sm); font-weight: 600; margin-bottom: var(--space-2); color: var(--text-primary); }
.comment-box textarea { resize: vertical; min-height: 6rem; width: 100%; background: var(--bg-input); }
.comment-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: space-between; align-items: center; margin-top: var(--space-3); }
.comment-actions span { font-size: var(--font-xs); line-height: 1.6; font-variant-numeric: tabular-nums; }
.error-msg { margin: var(--space-2) 0 0; }
@media (max-width: 480px) { .comment-box { padding: var(--space-3); } .comment-actions button { margin-left: auto; } }
</style>
