<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import ErrorState from '../components/ErrorState.vue'
import Icon from '../components/Icon.vue'
import { useWallStore } from '../stores/wall'

const route = useRoute()
const router = useRouter()
const wallStore = useWallStore()
const query = ref('')
const searchedQuery = ref('')
const posts = ref([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const searched = ref(false)
const error = ref('')
const validation = ref('')
let requestId = 0
let controller
let disposed = false

function syncQuery(keyword) {
  if (route.query.q === keyword || !route.query.q && !keyword) return
  const params = { ...route.query }
  if (keyword) params.q = keyword
  else delete params.q
  router.replace({ query: params }).catch(() => {})
}

async function doSearch(q = query.value, updateUrl = true) {
  const keyword = typeof q === 'string' ? q.trim() : ''
  if (/^RPT-\d{4}(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{4})$/i.test(keyword)) {
    router.push('/report/status/' + keyword.toUpperCase())
    return
  }
  const request = ++requestId
  controller?.abort()
  loading.value = false
  error.value = ''
  validation.value = ''
  if (keyword.length < 2 || keyword.length > 50) {
    posts.value = []
    total.value = 0
    searched.value = false
    validation.value = '请输入 2–50 个字符的关键词'
    return
  }
  controller = new AbortController()
  const wallId = wallStore.currentWallId
  query.value = keyword
  searchedQuery.value = keyword
  searched.value = true
  loading.value = true
  posts.value = []
  total.value = 0
  hasMore.value = false
  if (updateUrl) syncQuery(keyword)
  try {
    const res = await api.get('/posts/search', { params: { q: keyword }, signal: controller.signal })
    if (disposed || request !== requestId || wallId !== wallStore.currentWallId) return
    posts.value = Array.isArray(res.data.posts) ? res.data.posts : []
    total.value = Math.max(0, Number(res.data.total) || 0)
    hasMore.value = !!res.data.hasMore
  } catch (e) {
    if (disposed || request !== requestId || wallId !== wallStore.currentWallId || e.code === 'ERR_CANCELED') return
    error.value = '搜索失败，请检查网络后重试'
  } finally {
    if (request === requestId && !disposed) loading.value = false
  }
}

function clearSearch(updateUrl = true) {
  requestId++
  controller?.abort()
  query.value = ''
  searchedQuery.value = ''
  posts.value = []
  total.value = 0
  searched.value = false
  loading.value = false
  hasMore.value = false
  error.value = ''
  validation.value = ''
  if (updateUrl) syncQuery('')
}

function onPostDeleted(id) {
  if (!posts.value.some(post => post.id === id)) return
  posts.value = posts.value.filter(post => post.id !== id)
  total.value = Math.max(0, total.value - 1)
}

watch(() => route.query.q, q => {
  const keyword = typeof q === 'string' ? q.trim() : ''
  if (!keyword) { clearSearch(false); return }
  if (keyword !== searchedQuery.value || !searched.value) doSearch(keyword, false)
}, { immediate: true })
watch(() => wallStore.currentWallId, () => {
  if (searchedQuery.value) doSearch(searchedQuery.value, false)
  else clearSearch(false)
})
onBeforeUnmount(() => { disposed = true; requestId++; controller?.abort() })
</script>

<template>
  <div class="search-page">
    <header class="search-header glass">
      <h1>搜索校园</h1>
      <p class="search-intro text-muted">在当前校园墙，找到你关心的话题</p>
      <form class="search-form" role="search" @submit.prevent="doSearch()">
        <label class="search-field" for="campus-search">
          <span>关键词</span>
          <input id="campus-search" v-model="query" type="search" placeholder="搜索帖子内容或举报追踪码" maxlength="50" :aria-invalid="!!validation" aria-describedby="search-help search-validation" />
        </label>
        <button class="btn btn-primary" type="submit">{{ loading ? '重新搜索' : '搜索' }}</button>
        <button v-if="searched || query" class="btn btn-secondary" type="button" @click="clearSearch()">清除</button>
      </form>
      <p id="search-help" class="search-help text-muted">输入 2–50 个字符；也可输入完整 RPT 追踪码查看举报进度。</p>
      <p id="search-validation" class="validation" role="status">{{ validation }}</p>
    </header>

    <section class="results-area" :aria-busy="loading" aria-label="搜索结果">
      <div v-if="loading" class="skeleton-stack" role="status" aria-label="正在搜索">
        <SkeletonCard v-for="i in 3" :key="i" :lines="3" />
      </div>
      <ErrorState v-else-if="error" role="alert" :title="error" @retry="doSearch(searchedQuery)" />
      <template v-else-if="searched">
        <p class="result-count text-muted" role="status">「{{ searchedQuery }}」{{ hasMore ? '已显示前' : '共' }} {{ total }} 条结果<span v-if="hasMore">，试试更具体的关键词</span></p>
        <div v-if="posts.length === 0" class="empty-state">
          <div class="icon"><Icon name="search" :size="34" /></div>
          <p>没有找到与「{{ searchedQuery }}」匹配的帖子</p>
          <p class="text-muted">换个关键词，或缩短搜索内容后再试</p>
        </div>
        <div v-else class="results-list">
          <PostCard v-for="post in posts" :key="post.id" :post="post" @deleted="onPostDeleted" />
        </div>
      </template>
      <div v-else class="empty-state">
        <div class="icon"><Icon name="search" :size="34" /></div>
        <p>从一个关键词开始</p>
        <p class="text-muted">搜索课程、活动或同学们正在讨论的话题</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.search-page { max-width: 56rem; margin-inline: auto; }
.search-header { padding: var(--space-5); margin-bottom: var(--space-5); }
.search-header h1 { font-size: var(--font-2xl); letter-spacing: -.035em; margin-bottom: var(--space-1); }
.search-intro { font-size: var(--font-sm); margin-bottom: var(--space-5); }
.search-form { display: flex; align-items: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.search-field { display: grid; gap: var(--space-2); flex: 1 1 16rem; min-width: 0; color: var(--text-secondary); font-size: var(--font-sm); }
.search-field input { min-width: 0; width: 100%; }
.search-help { font-size: var(--font-xs); line-height: 1.7; margin-top: var(--space-3); }
.validation { color: var(--danger-light); font-size: var(--font-sm); }
.validation:empty { display: none; }
.results-area, .results-list { display: flex; flex-direction: column; gap: var(--space-3); }
.result-count { font-size: var(--font-sm); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .search-header { padding: var(--space-4); }
  .search-field { flex-basis: 100%; }
  .search-form .btn { flex: 1; }
}
</style>
