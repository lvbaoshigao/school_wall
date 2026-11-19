<script setup>
import SkeletonCard from '../components/SkeletonCard.vue'
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { useWallStore } from '../stores/wall'
import Icon from '../components/Icon.vue'

const router = useRouter()
const wallStore = useWallStore()
const loadError = ref('')
const now = ref(Date.now())
let clock = null
let loadVersion = 0
let disposed = false

const votes = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 20

async function loadVotes(p = 1) {
  const version = ++loadVersion
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.get(`/votes?page=${p}&limit=${limit}`)
    if (disposed || version !== loadVersion) return
    votes.value = res.data.votes
    total.value = res.data.total
    page.value = p
  } catch (e) {
    if (!disposed && version === loadVersion) loadError.value = '投票加载失败，请重试'
  } finally {
    if (!disposed && version === loadVersion) loading.value = false
  }
}

function goToDetail(id) {
  router.push(`/vote/${id}`)
}

const totalPages = computed(() => Math.ceil(total.value / limit))

const isEnded = (vote) => {
  if (!vote.end_at) return false
  return new Date(vote.end_at).getTime() <= now.value
}

const totalVotes = (vote) => {
  return vote.options?.reduce((sum, opt) => sum + (Number(opt.vote_count) || 0), 0) || 0
}

const truncateText = (text, len = 50) => {
  if (!text) return ''
  return text.length > len ? text.substring(0, len) + '...' : text
}

watch(() => wallStore.currentWallId, () => { votes.value = []; loadVotes() })
onMounted(() => { loadVotes(); clock = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { disposed = true; loadVersion++; clearInterval(clock) })
</script>

<template>
  <div class="votes-page">
    <div class="page-header">
      <h2>投票中心</h2>
      <button class="btn btn-primary btn-sm" @click="router.push('/vote/create')">+ 发起投票</button>
    </div>

    <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载投票">
      <SkeletonCard v-for="i in 3" :key="i" :lines="2" />
    </div>

    <p v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadVotes(page)">重试</button></p>
    <template v-else>
      <div v-if="votes.length === 0" class="empty-state">
        <div class="icon"><Icon name="chart" :size="34" /></div>
        <p>暂无投票，来发起第一个吧！</p>
      </div>

      <div class="votes-list">
        <RouterLink v-for="vote in votes" :key="vote.id" class="vote-card glass" :to="`/vote/${vote.id}`">
          <div class="vote-header">
            <h3>{{ vote.title }}</h3>
            <div class="vote-tags">
              <span v-if="vote.is_anonymous" class="tag tag-anonymous">匿名</span>
              <span v-if="isEnded(vote)" class="tag tag-ended">已结束</span>
              <span v-else-if="vote.end_at" class="tag tag-active">进行中</span>
              <span v-if="vote.voted" class="tag tag-voted">已投票</span>
            </div>
          </div>

          <p v-if="vote.description" class="vote-desc">{{ truncateText(vote.description, 80) }}</p>

          <div class="vote-preview">
            <span class="preview-item" v-for="(opt, i) in vote.options?.slice(0, 3)" :key="i">
              {{ opt.option_text }}
            </span>
            <span v-if="vote.options?.length > 3" class="preview-more">+{{ vote.options.length - 3 }}个选项</span>
          </div>

          <div class="vote-footer text-muted">
            <span>{{ totalVotes(vote) }} 人参与</span>
            <span>{{ vote.author_nickname ? vote.author_nickname : '匿名创建' }}</span>
            <span v-if="vote.end_at">截止: {{ new Date(vote.end_at).toLocaleDateString() }}</span>
            <span class="click-hint">点击查看详情<Icon name="chevron-right" :size="13" /></span>
          </div>
        </RouterLink>
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="loadVotes(page - 1)">上一页</button>
        <span class="text-muted">{{ page }} / {{ totalPages }}</span>
        <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages" @click="loadVotes(page + 1)">下一页</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.skeleton-wrap { display: flex; flex-direction: column; gap: var(--space-3); }
.votes-page { animation: fadeIn 0.5s ease; min-width: 0; }
.page-header > * { min-width: 0; }
.page-header .btn { min-height: 44px; }
.vote-card { min-width: 0; }
.vote-footer > span { min-width: 0; overflow-wrap: anywhere; }
.vote-tags { min-width: 0; max-width: 100%; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-header h2 { font-size: 1.5rem; }

.votes-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.vote-card {
  padding: 18px 20px;
  cursor: pointer;
  transition: all 0.3s;
  border-radius: var(--radius-lg);
}

.vote-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.vote-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.vote-header h3 {
  font-size: 1.0625rem;
  flex: 1;
}

.vote-tags {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  margin-left: 12px;
}

.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-xl);
  font-size: 0.6875rem;
}

.tag-anonymous {
  background: rgba(159, 147, 134, 0.2);
  color: var(--text-link);
}

.tag-ended {
  background: rgba(255, 107, 107, 0.2);
  color: var(--danger-light);
}

.tag-active {
  background: rgba(46, 213, 115, 0.2);
  color: var(--success);
}

.tag-voted {
  background: rgba(169, 155, 134, 0.2);
  color: var(--text-link);
}

.vote-desc {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 10px;
  line-height: 1.4;
}

.vote-preview {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.preview-item {
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-lg);
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.preview-more {
  padding: 4px 12px;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.vote-footer {
  display: flex;
  gap: 16px;
  font-size: 0.75rem;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  align-items: center;
}

.click-hint {
  margin-left: auto;
  color: var(--text-muted);
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 24px 0;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.vote-card { display: block; color: var(--text-primary); text-decoration: none; }
.vote-header, .vote-footer { gap: 10px; flex-wrap: wrap; }
.vote-header h3, .preview-item { overflow-wrap: anywhere; min-width: 0; }
.vote-tags { flex-wrap: wrap; flex-shrink: 1; margin-left: 0; }
.pagination .btn { min-height: 44px; }
.pagination .text-muted { white-space: nowrap; }
.vote-desc { line-height: 1.65; }
@media (max-width: 480px) { .page-header { gap: 12px; flex-wrap: wrap; } .vote-card { padding: 18px 16px; } .click-hint { margin-left: 0; } }
</style>
