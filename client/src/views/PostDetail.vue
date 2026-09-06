<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useMarkdown } from '../composables/useMarkdown'
import { useToast } from '../composables/useToast'
import api from '../api'
import CommentBox from '../components/CommentBox.vue'
import AvatarIcon from '../components/AvatarIcon.vue'
import Lightbox from '../components/Lightbox.vue'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const { timeAgo } = useTimeAgo()
const { getTextContent, getPostImages, renderMarkdown } = useMarkdown()
const toast = useToast()
const lightboxRef = ref(null)
const showDeleteCommentConfirm = ref(false)
const showReportConfirm = ref(false)
const reportReason = ref('')
const deletingComment = ref(null)
const reportConfirmTitle = ref('')
const reportConfirmMessage = ref('')

const post = ref(null)
const comments = ref([])
const loading = ref(true)

async function loadPost() {
  loading.value = true
  try {
    const res = await api.get(`/posts/${route.params.id}`)
    post.value = res.data.post
    comments.value = res.data.comments
  } catch (e) {
    if (e.response?.status === 404) {
      toast.error('帖子不存在')
      router.push('/')
    }
  } finally {
    loading.value = false
  }
}

const postImages = computed(() => {
  if (!post.value) return []
  return getPostImages(post.value.content)
})

async function toggleLike() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  try {
    if (post.value.liked) {
      await api.delete(`/posts/${post.value.id}/like`)
      post.value.liked = false
      post.value.like_count--
    } else {
      await api.post(`/posts/${post.value.id}/like`)
      post.value.liked = true
      post.value.like_count++
    }
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

async function toggleBookmark() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  try {
    if (post.value.bookmarked) {
      await api.delete(`/posts/${post.value.id}/bookmark`)
      post.value.bookmarked = false
      toast.success('已取消收藏')
    } else {
      await api.post(`/posts/${post.value.id}/bookmark`)
      post.value.bookmarked = true
      toast.success('已收藏')
    }
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

function onCommentAdded(comment) {
  comments.value.push(comment)
  post.value.comment_count++
}

async function deleteComment(comment) {
  deletingComment.value = comment
  showDeleteCommentConfirm.value = true
}

async function doDeleteComment() {
  const comment = deletingComment.value
  if (!comment) return
  try {
    await api.delete(`/posts/${post.value.id}/comments/${comment.id}`)
    comments.value = comments.value.filter(c => c.id !== comment.id)
    post.value.comment_count = Math.max(0, post.value.comment_count - 1)
    toast.success('已删除')
  } catch (e) {
    toast.error(e.response?.data?.error || '删除失败')
  }
  deletingComment.value = null
}

function canDeleteComment(comment) {
  if (!userStore.user) return false
  return wallStore.canHere('wall.post.delete') || comment.author_id === userStore.user.id
}

async function reportPost() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  reportConfirmTitle.value = '举报帖子'
  reportConfirmMessage.value = '请填写举报原因：'
  reportReason.value = ''
  showReportConfirm.value = true
}

async function doReportPost() {
  if (!reportReason.value.trim()) { toast.error('请填写举报原因'); return }
  try {
    await api.post(`/posts/${post.value.id}/report`, { reason: reportReason.value.trim() })
    toast.success('举报已提交，管理员会尽快处理')
  } catch (e) {
    toast.error(e.response?.data?.error || '举报失败')
  }
}

function openLightbox(idx) { lightboxRef.value?.open(idx) }

onMounted(() => loadPost())
</script>

<template>
  <div class="detail-page" v-if="post">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="post-detail glass-strong">
      <div class="post-header">
        <div class="post-author">
          <AvatarIcon
            :src="post.author_avatar || ''"
            :name="post.is_anonymous ? '匿' : (post.author_nickname || '?')"
            size="md"
            :anonymous="post.is_anonymous"
          />
          <div class="author-info">
            <span class="author-name">{{ post.is_anonymous ? '匿名用户' : (post.author_nickname || '未知用户') }}</span>
            <span v-if="!post.is_anonymous && post.author_class" class="text-muted">{{ post.author_class }}班</span>
          </div>
          <span v-if="post.is_anonymous" class="tag tag-anonymous">匿名</span>
        </div>
        <span class="text-muted">{{ timeAgo(post.created_at) }}</span>
      </div>

      <div v-if="getTextContent(post.content) && post.is_markdown" class="post-content md-body" v-html="renderMarkdown(post.content)"></div>
      <div v-else-if="getTextContent(post.content)" class="post-content">{{ getTextContent(post.content) }}</div>

      <div v-if="postImages.length > 0" class="post-images">
        <img v-for="(img, i) in postImages" :key="i" :src="img" alt="" class="post-img" loading="lazy" @click="openLightbox(i)" />
      </div>

      <div class="post-actions">
        <button class="action-btn" :class="{ active: post.liked }" @click="toggleLike">
          <Icon name="heart" :size="17" />{{ post.like_count || 0 }}
        </button>
        <button class="action-btn" :class="{ active: post.bookmarked }" @click="toggleBookmark">
          <Icon name="bookmark" :size="17" />收藏
        </button>
        <button v-if="userStore.isLoggedIn" class="action-btn" @click="reportPost" title="举报"><Icon name="alert-triangle" :size="17" />举报</button>
      </div>
    </div>

    <div class="comments-section glass">
      <h3>评论 ({{ comments.length }})</h3>
      <CommentBox :post-id="post.id" @comment-added="onCommentAdded" />

      <div v-if="comments.length === 0" class="empty-state" style="padding: 24px;">
        <div class="icon"><Icon name="message" :size="34" /></div>
        <p>暂无评论，快来抢沙发！</p>
      </div>

      <div v-for="(comment, idx) in comments" :key="comment.id" class="comment-item" :style="{ '--i': idx }">
        <div class="comment-header">
          <div class="comment-author">
            <AvatarIcon :src="comment.avatar || ''" :name="comment.nickname || '?'" size="sm" />
            <span class="author-name">{{ comment.nickname || '用户' }}</span>
            <span v-if="comment.class_number" class="text-muted">{{ comment.class_number }}班</span>
          </div>
          <div class="comment-meta">
            <span class="text-muted">{{ timeAgo(comment.created_at) }}</span>
            <button v-if="canDeleteComment(comment)" class="delete-comment-btn" @click="deleteComment(comment)" title="删除评论"><Icon name="trash" :size="15" /></button>
          </div>
        </div>
        <div class="comment-content">{{ comment.content }}</div>
      </div>
    </div>

    <!-- 图片灯箱 -->
    <Lightbox ref="lightboxRef" :images="postImages" />

    <!-- 删除评论确认 -->
    <ConfirmModal
      :show="showDeleteCommentConfirm"
      title="删除评论"
      message="确定删除这条评论吗？"
      confirm-text="删除"
      cancel-text="取消"
      :danger="true"
      @confirm="doDeleteComment"
      @update:show="showDeleteCommentConfirm = $event"
    />

    <!-- 举报弹窗 -->
    <ConfirmModal
      :show="showReportConfirm"
      :title="reportConfirmTitle"
      :message="reportConfirmMessage"
      confirm-text="提交举报"
      cancel-text="取消"
      :prompt="true"
      v-model:prompt-value="reportReason"
      prompt-placeholder="请填写举报原因..."
      @confirm="doReportPost"
      @update:show="showReportConfirm = $event"
    />
  </div>

  <div v-else class="loading">加载中</div>
</template>

<style scoped>
.detail-page { animation: fadeIn 0.5s ease; }

.post-detail { padding: 24px; margin-bottom: 16px; }
.post-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.post-author { display: flex; align-items: center; gap: 10px; }
.author-info { display: flex; flex-direction: column; }
.author-name { font-weight: 600; font-size: 15px; }
.post-content { font-size: 16px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; margin-bottom: 16px; color: var(--text-secondary); }
.post-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.post-img { max-width: 250px; max-height: 250px; border-radius: var(--radius-md); object-fit: cover; cursor: pointer; transition: transform 0.2s; }
.post-img:hover { transform: scale(1.02); }
.post-actions { display: flex; gap: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.1); }
.action-btn { background: none; border: none; color: var(--text-secondary); font-size: 15px; cursor: pointer; padding: 6px 10px; border-radius: var(--radius-sm); transition: all 0.2s; }
.action-btn:hover { background: rgba(255,255,255,0.1); }
.action-btn.active { color: #ff6b6b; }

.comments-section { padding: 24px; }
.comments-section h3 { margin-bottom: 16px; font-size: 18px; }
.comment-item {
  padding: 16px 0;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  opacity: 0;
  animation: riseIn 0.4s var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 35ms);
}
.comment-item:last-child { border-bottom: none; }
.comment-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.comment-author { display: flex; align-items: center; gap: 8px; }
.comment-meta { display: flex; align-items: center; gap: 8px; }
.comment-content { font-size: 14px; line-height: 1.6; padding-left: 36px; white-space: pre-wrap; color: var(--text-secondary); }
.delete-comment-btn { background: none; border: none; cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: var(--radius-sm); opacity: 0.5; transition: all 0.2s; }
.delete-comment-btn:hover { opacity: 1; background: rgba(255,107,107,0.15); }
</style>
