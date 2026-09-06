<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const router = useRouter()
const toast = useToast()

const posts = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 20

async function loadBookmarks(p) {
  loading.value = true
  try {
    const res = await api.get('/posts/bookmarks/list', {
      params: { page: p || page.value, limit }
    })
    posts.value = res.data.posts || []
    total.value = res.data.total || 0
    page.value = res.data.page || 1
  } catch (e) {
    toast.error('加载收藏失败')
  } finally {
    loading.value = false
  }
}

function onDeleted(id) {
  posts.value = posts.value.filter(p => p.id !== id)
  total.value--
}

const totalPages = computed(() => Math.ceil(total.value / limit))

onMounted(() => loadBookmarks(1))
</script>

<template>
  <div class="bookmarks-page">
    <div class="bookmarks-header glass-strong">
      <h2>我的收藏</h2>
      <p class="text-muted">共 {{ total }} 篇收藏</p>
    </div>

    <template v-if="loading">
      <div class="skeleton-wrap" aria-busy="true" aria-label="正在加载收藏">
        <SkeletonCard v-for="i in 3" :key="i" :lines="3" />
      </div>
    </template>

    <template v-else>
      <div v-if="posts.length === 0" class="empty-state">
        <div class="icon"><Icon name="bookmark" :size="34" /></div>
        <p>还没有收藏的帖子</p>
        <p class="text-muted" style="font-size:13px">在帖子详情页点击书签图标收藏</p>
        <button class="btn btn-primary btn-sm mt-2" @click="router.push('/')">去主页看看</button>
      </div>

      <div v-else class="posts-list">
        <PostCard
          v-for="post in posts"
          :key="post.id"
          :post="post"
          @deleted="onDeleted"
        />
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="loadBookmarks(page - 1)">上一页</button>
        <span class="text-muted">{{ page }} / {{ totalPages }}</span>
        <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages" @click="loadBookmarks(page + 1)">下一页</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bookmarks-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.bookmarks-header { padding: 24px; margin-bottom: 16px; border-radius: var(--radius-lg); }
.bookmarks-header h2 { font-size: 24px; margin-bottom: 4px; }

.posts-list { display: flex; flex-direction: column; gap: 12px; }
.pagination { display: flex; justify-content: center; align-items: center; gap: 16px; padding: 24px 0; }
.skeleton-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>