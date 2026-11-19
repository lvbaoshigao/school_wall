<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useMarkdown } from '../composables/useMarkdown'
import { useToast } from '../composables/useToast'
import AvatarIcon from './AvatarIcon.vue'
import Lightbox from './Lightbox.vue'
import Icon from './Icon.vue'
import { useSettingsStore } from '../stores/settings'
import api from '../api'
import ConfirmModal from './ConfirmModal.vue'

// 本组件是多根节点（卡片 + 灯箱），Vue 不会自动透传 attrs，
// 需手动把 class/style（如列表传入的 --i）绑到卡片根元素上
defineOptions({ inheritAttrs: false })

const props = defineProps({
  post: { type: Object, required: true }
})

const emit = defineEmits(['like-changed', 'bookmark-changed', 'deleted'])
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const { timeAgo } = useTimeAgo()
const { getTextContent, getPostImages, renderMarkdown } = useMarkdown()
const toast = useToast()
const lightboxRef = ref(null)
const settingsStore = useSettingsStore()
// 关掉「自动加载帖子图片」后，图片先不请求，点占位块才加载
const showImages = ref(settingsStore.prefs.auto_load_images)

const authorDisplay = computed(() => {
  if (props.post.is_anonymous) return '匿名用户'
  return props.post.author_nickname || '未知用户'
})

const classDisplay = computed(() => {
  if (props.post.is_anonymous || !props.post.author_class) return ''
  return `${props.post.author_class}班`
})

const textContent = computed(() => getTextContent(props.post.content))
const postImages = computed(() => getPostImages(props.post.content))
const renderedHtml = computed(() => {
  if (!props.post.is_markdown) return ''
  return renderMarkdown(props.post.content)
})

const showDeleteConfirm = ref(false)
const showReportConfirm = ref(false)
const reportReason = ref('')
const isLiking = ref(false)
const isBookmarking = ref(false)
const isDeleting = ref(false)
const isReporting = ref(false)
let disposed = false
onBeforeUnmount(() => { disposed = true })
function postConfig(post = props.post) {
  return { headers: { 'X-Wall-Id': post.wall_id || wallStore.currentWallId } }
}

async function toggleLike() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  if (isLiking.value) return
  isLiking.value = true
  const target = props.post
  const liked = !!target.liked
  try {
    if (liked) await api.delete(`/posts/${target.id}/like`, postConfig(target))
    else await api.post(`/posts/${target.id}/like`, {}, postConfig(target))
    if (disposed || target !== props.post) return
    target.liked = !liked
    target.like_count = Math.max(0, (Number(target.like_count) || 0) + (liked ? -1 : 1))
    emit('like-changed', target)
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  } finally {
    isLiking.value = false
  }
}

async function deletePost() {
  showDeleteConfirm.value = true
}

async function doDeletePost() {
  if (isDeleting.value) return
  isDeleting.value = true
  const target = props.post
  try {
    await api.delete(`/posts/${target.id}`, postConfig(target))
    if (disposed || target !== props.post) return
    toast.success('已删除')
    emit('deleted', target.id)
  } catch (e) {
    toast.error(e.response?.data?.error || '删除失败')
  } finally { isDeleting.value = false }
}

async function toggleBookmark() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  if (isBookmarking.value) return
  isBookmarking.value = true
  const target = props.post
  const bookmarked = !!target.bookmarked
  try {
    if (bookmarked) {
      await api.delete(`/posts/${target.id}/bookmark`, postConfig(target))
      if (disposed || target !== props.post) return
      target.bookmarked = false
      toast.success('已取消收藏')
    } else {
      await api.post(`/posts/${target.id}/bookmark`, {}, postConfig(target))
      if (disposed || target !== props.post) return
      target.bookmarked = true
      toast.success('已收藏')
    }
    emit('bookmark-changed', target)
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  } finally { isBookmarking.value = false }
}

function goToDetail(event) {
  if (event?.target?.closest('a, button, input, textarea, select') && event.currentTarget === event.target.closest('.post-card')) return
  if (props.post.wall_id && props.post.wall_id !== wallStore.currentWallId) wallStore.switchWall(props.post.wall_id)
  router.push(`/post/${props.post.id}`)
}

function goToAuthor(e) {
  e.stopPropagation()
  if (!props.post.is_anonymous && props.post.author_id) {
    router.push(`/user/${props.post.author_id}`)
  }
}

function openLightbox(index) {
  if (lightboxRef.value) {
    lightboxRef.value.open(index)
  }
}

const canDelete = computed(() => {
  return userStore.canInWall('wall.post.delete', props.post.wall_id || wallStore.currentWallId) || (userStore.user && userStore.user.id === props.post.author_id)
})

async function reportPost() {
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  reportReason.value = ''
  showReportConfirm.value = true
}

async function doReportPost() {
  if (isReporting.value) return
  const reason = reportReason.value.trim()
  if (!reason || reason.length > 500) { toast.error('请填写 1–500 字的举报原因'); return }
  isReporting.value = true
  try {
    await api.post(`/posts/${props.post.id}/report`, { reason }, postConfig())
    toast.success('举报已提交，管理员会尽快处理')
  } catch (e) {
    toast.error(e.response?.data?.error || '举报失败')
  } finally { isReporting.value = false }
}
</script>

<template>
  <div
    class="post-card glass"
    v-bind="$attrs"
    role="article"
    tabindex="0"
    :aria-label="`${authorDisplay} 的帖子，回车打开详情`"
    @click="goToDetail"
    @keydown.enter.self="goToDetail"
    @keydown.space.self.prevent="goToDetail"
  >
    <div class="post-header">
      <div class="post-author">
        <span class="author-avatar-wrap" @click="goToAuthor">
          <AvatarIcon
            :src="post.author_avatar || ''"
            :name="authorDisplay"
            size="sm"
            :anonymous="post.is_anonymous"
          />
        </span>
        <div class="author-info" :role="!post.is_anonymous && post.author_id ? 'link' : undefined"
             :tabindex="!post.is_anonymous && post.author_id ? 0 : undefined"
             @click="goToAuthor" @keydown.enter="goToAuthor">
          <span class="author-name" :class="{ clickable: !post.is_anonymous && post.author_id }">{{ authorDisplay }}</span>
          <span v-if="classDisplay" class="author-class">{{ classDisplay }}</span>
        </div>
        <span v-if="post.category" class="tag tag-category">{{ post.category }}</span>
        <span v-if="post.is_anonymous" class="tag tag-anonymous">匿名</span>
      </div>
      <span class="text-muted">{{ timeAgo(post.created_at) }}</span>
    </div>

    <div v-if="textContent && post.is_markdown" class="post-content md-body" v-html="renderedHtml"></div>
    <div v-else-if="textContent" class="post-content">{{ textContent }}</div>

    <div v-if="postImages.length > 0" class="post-images" @click.stop>
      <!-- 关闭「自动加载图片」时先显示占位块，点一下才真正请求图片 -->
      <button
        v-if="!showImages"
        class="img-placeholder"
        :aria-label="`加载 ${postImages.length} 张图片`"
        @click="showImages = true"
      >
        <Icon name="image" :size="18" />
        {{ postImages.length }} 张图片 · 点击加载
      </button>
      <button v-for="(img, i) in (showImages ? postImages : [])" :key="img" class="post-image-button" :aria-label="`放大查看第 ${i + 1} 张图片`" @click="openLightbox(i)">
        <img :src="img" :alt="`帖子配图 ${i + 1}`" class="post-img" loading="lazy" referrerpolicy="no-referrer" />
      </button>
    </div>

    <div class="post-actions" @click.stop @keydown.stop>
      <button class="action-btn" :class="{ active: post.liked }"
              :aria-label="post.liked ? '取消点赞' : '点赞'" :aria-pressed="!!post.liked" :disabled="isLiking" @click="toggleLike">
        <Icon name="heart" :size="16" />{{ post.like_count || 0 }}
      </button>
      <button class="action-btn" :aria-label="`查看 ${post.comment_count || 0} 条评论`" @click="goToDetail">
        <Icon name="message" :size="16" />{{ post.comment_count || 0 }}
      </button>
      <button class="action-btn bookmark" :class="{ active: post.bookmarked }"
              :aria-label="post.bookmarked ? '取消收藏' : '收藏'" :aria-pressed="!!post.bookmarked" :disabled="isBookmarking" @click="toggleBookmark">
        <Icon name="bookmark" :size="16" />
      </button>
      <button v-if="canDelete" class="action-btn danger" aria-label="删除帖子" :disabled="isDeleting" @click="deletePost">
        <Icon name="trash" :size="16" />
      </button>
      <button v-if="userStore.isLoggedIn" class="action-btn" aria-label="举报帖子" :disabled="isReporting" @click="reportPost" title="举报">
        <Icon name="alert-triangle" :size="16" />
      </button>
    </div>
  </div>

  <!-- 图片灯箱 -->
  <Lightbox ref="lightboxRef" :images="postImages" />

  <!-- 删除确认 -->
  <ConfirmModal
    :show="showDeleteConfirm"
    title="删除帖子"
    message="确定要删除这条帖子吗？"
    confirm-text="删除"
    cancel-text="取消"
    :danger="true"
    @confirm="doDeletePost"
    @update:show="showDeleteConfirm = $event"
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
</template>

<style scoped>
.post-card {
  padding: 20px;
  cursor: pointer;
  transition: transform 0.3s var(--ease), box-shadow 0.3s var(--ease), background 0.3s var(--ease);
  border-radius: var(--radius-lg);
  /* 列表入场：依次淡入上浮（父级传入 --i） */
  opacity: 0;
  animation: riseIn 0.45s var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 40ms);
}

.post-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-1) 75%, transparent);
  outline-offset: 2px;
}

.post-card:hover {
  box-shadow: var(--shadow-sm);
  background: var(--bg-card-hover);
}

.post-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.post-author {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.author-info {
  display: flex;
  flex-direction: column;
  cursor: pointer;
}

.author-name {
  font-size: 14px;
  font-weight: 600;
}

.author-name.clickable:hover {
  color: color-mix(in srgb, var(--accent-1) 70%, var(--text-primary));
  text-decoration: underline;
}

.author-class {
  font-size: 12px;
  color: var(--text-muted);
}

.post-content {
  font-size: 15px;
  line-height: 1.6;
  margin-bottom: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
}

.post-images {
  display: grid;
  /* 原先 flex-wrap + 固定 120px：在 320px 屏上三图一行放不下就溢出，
     也不响应 --density。改 grid 自适应列数，最小 84px 保证三图一行不爆。 */
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 6px;
  margin-bottom: 12px;
}

.post-img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: var(--radius-md);
  object-fit: cover;
  cursor: pointer;
  transition: transform 0.2s;
}

.post-img:hover { transform: scale(1.03); }

.img-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.img-placeholder:hover { background: var(--bg-card-hover); color: var(--text-primary); }

.post-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding-top: 12px;
  /* 原写死 rgba(255,255,255,.1)，亮色主题下分隔线不可见 */
  border-top: 1px solid var(--border);
}

.action-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  min-height: 32px;
  justify-content: center;
  border-radius: var(--radius-sm);
  transition: transform 0.25s var(--ease), background 0.25s var(--ease), color 0.25s var(--ease);
  display: flex;
  align-items: center;
  gap: 4px;
}

.action-btn:hover {
  /* 跟随主题变量：亮色主题下悬停底自动换为深色半透明 */
  background: var(--bg-card-hover);
  transform: scale(1.08);
}

/* 已点赞/已收藏：图标填充为实心，不只靠颜色区分 */
.action-btn.active {
  color: var(--danger);
}

.action-btn.active :deep(.icon) {
  fill: currentColor;
}

/* 收藏高亮走显式 class，不再用 nth-child(3) 数位置 ——
   删除/举报按钮带 v-if，按钮顺序一变高亮就会串到别的按钮上 */
.action-btn.bookmark.active {
  color: var(--text-link);
}

.action-btn.danger:hover {
  color: var(--danger);
}

/* 触屏上把操作按钮抬高到 40px，降低点赞/收藏的误触率（桌面维持 32px 密度） */
@media (max-width: 768px) {
  .action-btn {
    min-height: 40px;
    padding: 8px 10px;
  }
}
.post-image-button { display: block; min-width: 0; padding: 0; border: 0; border-radius: var(--radius-md); background: var(--bg-input); overflow: hidden; cursor: zoom-in; }
.post-image-button img { display: block; }
.post-content.md-body { white-space: normal; overflow-wrap: anywhere; }
.post-header { gap: var(--space-3); align-items: flex-start; flex-wrap: wrap; }
.post-header > .text-muted { font-size: var(--font-xs); flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) { .post-card { animation: none; opacity: 1; } }
</style>
