<script setup>
import { ref } from 'vue'
import { useUserStore } from '../stores/user'
import { useRouter } from 'vue-router'
import { useToast } from '../composables/useToast'
import api from '../api'

const props = defineProps({
  postId: { type: Number, required: true }
})

const emit = defineEmits(['comment-added'])
const userStore = useUserStore()
const router = useRouter()
const toast = useToast()

const content = ref('')
const submitting = ref(false)

async function submit() {
  if (!userStore.isLoggedIn) {
    router.push('/login')
    return
  }
  if (!content.value.trim()) return

  submitting.value = true
  try {
    const res = await api.post(`/posts/${props.postId}/comments`, {
      content: content.value.trim()
    })
    content.value = ''
    emit('comment-added', res.data)
    toast.success('评论成功')
  } catch (e) {
    toast.error(e.response?.data?.error || '评论失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="comment-box">
    <textarea
      v-model="content"
      placeholder="写下你的评论..."
      rows="3"
      maxlength="500"
    ></textarea>
    <div class="comment-actions">
      <span class="text-muted">{{ content.length }}/500</span>
      <button class="btn btn-primary btn-sm" :disabled="!content.trim() || submitting" @click="submit">
        {{ submitting ? '发送中...' : '发表评论' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.comment-box {
  margin-top: 16px;
}

.comment-box textarea {
  resize: vertical;
  min-height: 80px;
}

.comment-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}
</style>
