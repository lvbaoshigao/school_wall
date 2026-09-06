<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const route = useRoute()
const toast = useToast()

const query = ref('')
const posts = ref([])
const total = ref(0)
const loading = ref(false)
const searched = ref(false)

async function doSearch(q) {
  const keyword = (q ?? query.value).trim()
  if (!keyword) { toast.info('请输入搜索关键词'); return }
  query.value = keyword
  loading.value = true
  searched.value = true
  try {
    const res = await api.get(`/posts/search?q=${encodeURIComponent(keyword)}`)
    posts.value = res.data.posts
    total.value = res.data.total
    // 后端现在对 <2 字符的关键词直接返回空并带提示，不必再发一次请求
    if (res.data.hint) toast.info(res.data.hint)
  } catch (e) {
    toast.error('搜索失败')
  } finally {
    loading.value = false
  }
}

function clearSearch() {
  query.value = ''
  posts.value = []
  total.value = 0
  searched.value = false
}

function onPostDeleted(id) {
  posts.value = posts.value.filter(p => p.id !== id)
  total.value--
}

onMounted(() => {
  if (route.query.q) doSearch(route.query.q)
})

// 已经停留在 /search 时，从顶栏再次搜索只会变更 query，组件不会重新挂载，
// 因此这里监听 query 变化以刷新结果
watch(() => route.query.q, (q) => {
  const keyword = (q || '').trim()
  if (!keyword || keyword === query.value) return
  doSearch(keyword)
})
</script>

<template>
  <div class="search-page">
    <div class="search-header glass">
      <h2>搜索结果</h2>
      <div class="search-form">
        <input
          v-model="query"
          placeholder="搜索帖子内容..."
          @keyup.enter="doSearch()"
        />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="doSearch()">
          {{ loading ? '搜索中…' : '搜索' }}
        </button>
        <button v-if="searched" class="btn btn-secondary btn-sm" @click="clearSearch">清除</button>
      </div>
    </div>

    <template v-if="loading">
      <div class="results-area">
        <SkeletonCard v-for="i in 3" :key="i" :lines="3" />
      </div>
    </template>

    <template v-else-if="searched">
      <div class="results-area">
        <div v-if="posts.length === 0" class="empty-state">
          <div class="icon"><Icon name="search" :size="34" /></div>
          <p>没有找到与「{{ query }}」匹配的帖子</p>
        </div>
        <div v-else class="results-list">
          <PostCard v-for="post in posts" :key="post.id" :post="post" @deleted="onPostDeleted" />
        </div>
        <p v-if="posts.length > 0" class="result-count text-muted">
          共 {{ total }} 条结果<span v-if="total > posts.length">（已显示前 {{ posts.length }} 条）</span>
        </p>
      </div>
    </template>

    <template v-else>
      <div class="empty-state">
        <div class="icon"><Icon name="search" :size="34" /></div>
        <p>输入关键词，搜索当前校园墙的帖子</p>
        <p class="text-muted" style="font-size:13px">也可输入追踪码 RPT-XXXX 查询举报处理进度</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.search-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.search-header { padding: 20px 24px; margin-bottom: 16px; }
.search-header h2 { font-size: 20px; margin-bottom: 12px; }

.search-form { display: flex; gap: 8px; }
.search-form input { flex: 1; }

.results-area { display: flex; flex-direction: column; gap: 12px; }
.results-list { display: flex; flex-direction: column; gap: 12px; }
.result-count { text-align: center; padding: 12px; }
</style>
