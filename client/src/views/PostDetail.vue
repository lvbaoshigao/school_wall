<script setup>
import { ref, watch, onBeforeUnmount, computed } from 'vue'
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
import SkeletonCard from '../components/SkeletonCard.vue'
import ErrorState from '../components/ErrorState.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const { timeAgo, fullTime } = useTimeAgo()
const { getTextContent, getPostImages, renderMarkdown } = useMarkdown()
const toast = useToast()
const lightboxRef = ref(null)
const showDeleteCommentConfirm = ref(false)
const showReportConfirm = ref(false)
const reportReason = ref('')
const deletingComment = ref(null)
const post = ref(null)
const comments = ref([])
const loading = ref(true)
const error = ref('')
const commentsError = ref('')
const commentsLoading = ref(false)
const commentsTotal = ref(0)
const commentsPage = ref(1)
const commentsLimit = 50
const liking = ref(false)
const bookmarking = ref(false)
const deleting = ref(false)
const reporting = ref(false)
let requestId = 0
let commentsRequest = 0
let controller
let commentsController
let disposed = false
const postImages = computed(() => getPostImages(post.value?.content))
const hasMoreComments = computed(() => comments.value.length < commentsTotal.value)
function config(target) { return { headers: { 'X-Wall-Id': target.wall_id || wallStore.currentWallId } } }

async function loadPost() {
  const request = ++requestId
  commentsRequest++
  controller?.abort()
  commentsController?.abort()
  controller = new AbortController()
  const id = String(route.params.id || '')
  const wallId = wallStore.currentWallId
  post.value = null
  comments.value = []
  error.value = ''
  commentsError.value = ''
  commentsLoading.value = false
  showDeleteCommentConfirm.value = false
  showReportConfirm.value = false
  deletingComment.value = null
  liking.value = bookmarking.value = deleting.value = reporting.value = false
  loading.value = true
  try {
    const res = await api.get('/posts/' + encodeURIComponent(id), { params: { comments_page: 1, comments_limit: commentsLimit }, signal: controller.signal })
    if (disposed || request !== requestId || String(route.params.id) !== id || wallStore.currentWallId !== wallId) return
    if (!res.data.post) throw new Error('Missing post')
    post.value = res.data.post
    comments.value = Array.isArray(res.data.comments) ? res.data.comments : []
    commentsTotal.value = Math.max(comments.value.length, Number(res.data.comments_total ?? res.data.post.comment_count) || 0)
    commentsPage.value = 1
  } catch (e) {
    if (disposed || request !== requestId || e.code === 'ERR_CANCELED') return
    error.value = e.response?.status === 404 ? '帖子不存在，或已从当前校园墙移除' : '帖子加载失败，请检查网络后重试'
  } finally { if (!disposed && request === requestId) loading.value = false }
}

async function loadComments(reset = false) {
  const target = post.value
  if (!target || commentsLoading.value && !reset) return
  const request = ++commentsRequest
  commentsController?.abort()
  commentsController = new AbortController()
  const nextPage = reset ? 1 : commentsPage.value + 1
  commentsLoading.value = true
  commentsError.value = ''
  try {
    const res = await api.get('/posts/' + target.id, { ...config(target), params: { comments_page: nextPage, comments_limit: commentsLimit }, signal: commentsController.signal })
    if (disposed || target !== post.value || request !== commentsRequest) return
    const incoming = Array.isArray(res.data.comments) ? res.data.comments : []
    comments.value = reset ? incoming : [...new Map([...comments.value, ...incoming].map(comment => [comment.id, comment])).values()]
    commentsTotal.value = Math.max(comments.value.length, Number(res.data.comments_total ?? res.data.post?.comment_count) || 0)
    commentsPage.value = Number(res.data.comments_page) || nextPage
    target.comment_count = commentsTotal.value
  } catch (e) {
    if (disposed || target !== post.value || request !== commentsRequest || e.code === 'ERR_CANCELED') return
    commentsError.value = '评论加载失败，请重试'
  } finally { if (!disposed && request === commentsRequest) commentsLoading.value = false }
}

async function toggleLike() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  const target = post.value
  if (!target || liking.value) return
  const liked = !!target.liked
  liking.value = true
  try {
    if (liked) await api.delete('/posts/' + target.id + '/like', config(target))
    else await api.post('/posts/' + target.id + '/like', {}, config(target))
    if (disposed || target !== post.value) return
    target.liked = !liked
    target.like_count = Math.max(0, (Number(target.like_count) || 0) + (liked ? -1 : 1))
  } catch (e) { if (!disposed && target === post.value) toast.error(e.response?.data?.error || '点赞失败，请重试') }
  finally { if (target === post.value) liking.value = false }
}
async function toggleBookmark() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  const target = post.value
  if (!target || bookmarking.value) return
  const bookmarked = !!target.bookmarked
  bookmarking.value = true
  try {
    if (bookmarked) await api.delete('/posts/' + target.id + '/bookmark', config(target))
    else await api.post('/posts/' + target.id + '/bookmark', {}, config(target))
    if (disposed || target !== post.value) return
    target.bookmarked = !bookmarked
    toast.success(bookmarked ? '已取消收藏' : '已收藏')
  } catch (e) { if (!disposed && target === post.value) toast.error(e.response?.data?.error || '收藏失败，请重试') }
  finally { if (target === post.value) bookmarking.value = false }
}
function onCommentAdded(comment) {
  if (!post.value || Number(comment.post_id) !== Number(post.value.id)) return
  // offset 分页在新增/删除后重取第一页，避免重复或遗漏。
  loadComments(true)
}
function deleteComment(comment) { if (deleting.value) return; deletingComment.value = comment; showDeleteCommentConfirm.value = true }
async function doDeleteComment() {
  const comment = deletingComment.value
  const target = post.value
  if (!comment || !target || deleting.value) return
  deleting.value = true
  try {
    await api.delete('/posts/' + target.id + '/comments/' + comment.id, config(target))
    if (disposed || target !== post.value) return
    comments.value = comments.value.filter(item => item.id !== comment.id)
    commentsTotal.value = Math.max(0, commentsTotal.value - 1)
    target.comment_count = commentsTotal.value
    toast.success('评论已删除')
    loadComments(true)
  } catch (e) { if (!disposed && target === post.value) toast.error(e.response?.data?.error || '删除失败，请重试') }
  finally { if (target === post.value) { deleting.value = false; deletingComment.value = null } }
}
function canDeleteComment(comment) {
  return !!userStore.user && (wallStore.canHere('wall.post.delete') || comment.author_id === userStore.user.id)
}
function reportPost() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  reportReason.value = ''
  showReportConfirm.value = true
}
async function doReportPost() {
  const target = post.value
  const reason = reportReason.value.trim()
  if (!target || reporting.value) return
  if (!reason || reason.length > 500) { toast.error('请填写 1–500 字的举报原因'); return }
  reporting.value = true
  try {
    await api.post('/posts/' + target.id + '/report', { reason }, config(target))
    if (!disposed && target === post.value) toast.success('举报已提交，管理员会尽快处理')
  } catch (e) { if (!disposed && target === post.value) toast.error(e.response?.data?.error || '举报失败，请重试') }
  finally { if (target === post.value) reporting.value = false }
}
function openLightbox(idx) { lightboxRef.value?.open(idx) }
watch(() => [route.params.id, wallStore.currentWallId], loadPost, { immediate: true })
onBeforeUnmount(() => { disposed = true; requestId++; commentsRequest++; controller?.abort(); commentsController?.abort() })
</script>

<template>
  <div v-if="loading" class="detail-page skeleton-stack" role="status" aria-label="正在加载帖子"><SkeletonCard :lines="5" /><SkeletonCard :lines="3" /></div>
  <div v-else-if="error" class="detail-page"><ErrorState role="alert" :title="error" @retry="loadPost" /><RouterLink class="btn btn-secondary" to="/">返回校园动态</RouterLink></div>
  <div class="detail-page" v-else-if="post">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <article class="post-detail glass-strong" aria-label="帖子正文">
      <h1 class="detail-heading">{{ post.category || '校园' }} · 帖子详情</h1>
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
        <span class="text-muted" :title="fullTime(post.created_at)">{{ timeAgo(post.created_at) }}</span>
      </div>

      <div v-if="getTextContent(post.content) && post.is_markdown" class="post-content md-body" v-html="renderMarkdown(post.content)"></div>
      <div v-else-if="getTextContent(post.content)" class="post-content">{{ getTextContent(post.content) }}</div>

      <div v-if="postImages.length > 0" class="post-images">
        <button v-for="(img, i) in postImages" :key="img" class="image-button" :aria-label="`放大查看第 ${i + 1} 张图片`" @click="openLightbox(i)"><img :src="img" :alt="`帖子配图 ${i + 1}`" class="post-img" loading="lazy" referrerpolicy="no-referrer" /></button>
      </div>

      <div class="post-actions">
        <button class="action-btn" :class="{ active: post.liked }" :aria-pressed="!!post.liked" :aria-label="post.liked ? '取消点赞' : '点赞'" :disabled="liking" @click="toggleLike">
          <Icon name="heart" :size="17" />{{ post.like_count || 0 }}
        </button>
        <button class="action-btn" :class="{ active: post.bookmarked }" :aria-pressed="!!post.bookmarked" :disabled="bookmarking" @click="toggleBookmark">
          <Icon name="bookmark" :size="17" />{{ post.bookmarked ? '已收藏' : '收藏' }}
        </button>
        <button v-if="userStore.isLoggedIn" class="action-btn" :disabled="reporting" @click="reportPost" title="举报"><Icon name="alert-triangle" :size="17" />举报</button>
      </div>
    </article>

    <section class="comments-section glass" aria-labelledby="comments-heading">
      <h2 id="comments-heading">评论 <span class="text-muted">{{ commentsTotal }}</span></h2>
      <CommentBox :key="post.id" :post-id="post.id" @comment-added="onCommentAdded" />

      <div v-if="comments.length === 0 && !commentsLoading && !commentsError" class="empty-state" style="padding: 24px;">
        <div class="icon"><Icon name="message" :size="34" /></div>
        <p>还没有评论，来聊聊你的看法</p>
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
            <button v-if="canDeleteComment(comment)" class="delete-comment-btn" aria-label="删除评论" :disabled="deleting" @click="deleteComment(comment)" title="删除评论"><Icon name="trash" :size="15" /></button>
          </div>
        </div>
        <div class="comment-content">{{ comment.content }}</div>
      </div>
      <p v-if="commentsError" class="error-msg" role="alert">{{ commentsError }} <button class="btn btn-secondary btn-sm" @click="loadComments(true)">重试</button></p>
      <div v-if="hasMoreComments || commentsLoading" class="comments-pagination">
        <p class="text-muted" role="status">已显示 {{ comments.length }} / {{ commentsTotal }} 条评论</p>
        <button class="btn btn-secondary" :disabled="commentsLoading" @click="loadComments()">{{ commentsLoading ? '正在加载…' : '加载更多评论' }}</button>
      </div>
    </section>

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
      title="举报帖子"
      message="请填写举报原因："
      confirm-text="提交举报"
      cancel-text="取消"
      :prompt="true"
      v-model:prompt-value="reportReason"
      prompt-placeholder="请填写举报原因..."
      @confirm="doReportPost"
      @update:show="showReportConfirm = $event"
    />
  </div>

</template>

<style scoped>
.detail-page { max-width: 54rem; min-width: 0; margin-inline: auto; }
.author-info { min-width: 0; overflow-wrap: anywhere; }
.comment-meta { min-width: 0; flex-wrap: wrap; }
.post-actions .action-btn { min-width: 44px; min-height: 44px; }
.comments-pagination > * { max-width: 100%; }
.detail-heading { font-size: var(--font-sm); color: var(--text-muted); font-weight: 500; margin-bottom: var(--space-5); }

.post-detail { padding: 24px; margin-bottom: 16px; }
.post-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.post-author { display: flex; align-items: center; gap: 10px; }
.author-info { display: flex; flex-direction: column; }
.author-name { font-weight: 600; font-size: 15px; }
.post-content { font-size: 16px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; margin-bottom: 16px; color: var(--text-secondary); }
.post-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.post-img { max-width: 250px; max-height: 250px; border-radius: var(--radius-md); object-fit: cover; cursor: pointer; transition: transform 0.2s; }
.post-img:hover { transform: scale(1.02); }
.post-actions { display: flex; gap: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.action-btn { background: none; border: none; color: var(--text-secondary); font-size: 15px; cursor: pointer; padding: 6px 10px; border-radius: var(--radius-sm); transition: all 0.2s; }
.action-btn:hover { background: rgba(255,255,255,0.1); }
.action-btn.active { color: var(--text-link); background: var(--accent-soft); }

.comments-section { padding: 24px; }
.comments-section h2 { margin-bottom: 16px; font-size: 18px; }
.comment-item {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
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
.post-content.md-body { white-space: normal; }
.post-header, .comment-header { gap: var(--space-3); flex-wrap: wrap; align-items: flex-start; }
.post-author, .comment-author { min-width: 0; flex-wrap: wrap; }
.author-name, .comment-content { overflow-wrap: anywhere; }
.post-header > .text-muted, .comment-meta { font-size: var(--font-xs); }
.post-actions { flex-wrap: wrap; gap: var(--space-2); }
.action-btn { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 2.75rem; }
.action-btn:hover { background: var(--bg-card-hover); }
.delete-comment-btn { min-width: 44px; min-height: 44px; color: var(--text-secondary); opacity: 1; }
.image-button { min-width: min(44px, 100%); min-height: 44px; padding: 0; border: 0; background: var(--bg-input); border-radius: var(--radius-md); overflow: hidden; cursor: zoom-in; max-width: 100%; }
.post-img { display: block; max-width: 100%; }
.comments-pagination { display: grid; justify-items: center; gap: var(--space-3); padding-top: var(--space-5); font-size: var(--font-sm); }
@media (max-width: 768px) { .post-detail, .comments-section { padding: var(--space-4); } .comment-content { padding-left: 0; } .post-images { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr)); } .post-img { width: 100%; aspect-ratio: 1; } }
@media (prefers-reduced-motion: reduce) { .comment-item { opacity: 1; animation: none; } }
</style>
