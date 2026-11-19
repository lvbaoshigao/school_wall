<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import ErrorState from '../components/ErrorState.vue'
import Icon from '../components/Icon.vue'

const router = useRouter()
const error = ref('')
const requestedPage = ref(1)
let requestId = 0
let controller
let disposed = false

const posts = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 20

async function loadBookmarks(p) {
  const request = ++requestId
  controller?.abort()
  controller = new AbortController()
  requestedPage.value = Math.max(1, Number(p || page.value) || 1)
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/posts/bookmarks/list', {
      params: { page: requestedPage.value, limit }, signal: controller.signal
    })
    if (disposed || request !== requestId) return
    posts.value = Array.isArray(res.data.posts) ? res.data.posts : []
    total.value = Math.max(0, Number(res.data.total) || 0)
    const lastPage = Math.max(1, Math.ceil(total.value / limit))
    if (requestedPage.value > lastPage) return loadBookmarks(lastPage)
    page.value = requestedPage.value
  } catch (e) {
    if (disposed || request !== requestId || e.code === 'ERR_CANCELED') return
    error.value = '收藏加载失败，请检查网络后重试'
  } finally {
    if (!disposed && request === requestId) loading.value = false
  }
}

function onDeleted(id) {
  if (!posts.value.some(p => p.id === id)) return
  posts.value = posts.value.filter(p => p.id !== id)
  total.value = Math.max(0, total.value - 1)
  loadBookmarks(Math.min(page.value, Math.max(1, Math.ceil(total.value / limit))))
}

function onBookmarkChanged(post) {
  if (!post.bookmarked) onDeleted(post.id)
}

const totalPages = computed(() => Math.ceil(total.value / limit))

onMounted(() => loadBookmarks(1))
onBeforeUnmount(() => { disposed = true; requestId++; controller?.abort() })
</script>

<template>
  <div class="bookmarks-page">
    <div class="bookmarks-header glass-strong">
      <h1>我的收藏</h1>
      <p class="text-muted">留住想再读一遍的校园故事<span v-if="!loading && !error"> · {{ total }} 篇</span></p>
    </div>

    <template v-if="loading">
      <div class="skeleton-wrap" aria-busy="true" aria-label="正在加载收藏">
        <SkeletonCard v-for="i in 3" :key="i" :lines="3" />
      </div>
    </template>

    <ErrorState v-else-if="error" role="alert" :title="error" @retry="loadBookmarks(requestedPage)" />
    <template v-else>
      <div v-if="posts.length === 0" class="empty-state">
        <div class="icon"><Icon name="bookmark" :size="34" /></div>
        <p>还没有收藏的帖子</p>
        <p class="text-muted" style="font-size:13px">在帖子上点击书签图标，即可保存在这里</p>
        <button class="btn btn-primary btn-sm mt-2" @click="router.push('/')">去主页看看</button>
      </div>

      <div v-else class="posts-list">
        <PostCard
          v-for="post in posts"
          :key="post.id"
          :post="post"
          @deleted="onDeleted"
          @bookmark-changed="onBookmarkChanged"
        />
      </div>

      <nav v-if="totalPages > 1" class="pagination" aria-label="收藏分页">
        <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="loadBookmarks(page - 1)">上一页</button>
        <span class="text-muted">{{ page }} / {{ totalPages }}</span>
        <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages" @click="loadBookmarks(page + 1)">下一页</button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.bookmarks-page { max-width: 56rem; margin-inline: auto; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.bookmarks-header { padding: 24px; margin-bottom: 16px; border-radius: var(--radius-lg); }
.bookmarks-header h1 { font-size: var(--font-2xl); margin-bottom: var(--space-2); letter-spacing: -.035em; }
.bookmarks-header p { font-size: var(--font-sm); line-height: 1.7; }

.posts-list { display: flex; flex-direction: column; gap: 12px; }
.pagination { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: var(--space-3); padding: var(--space-5) 0; font-variant-numeric: tabular-nums; }
.skeleton-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>