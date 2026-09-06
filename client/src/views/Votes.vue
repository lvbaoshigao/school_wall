<script setup>
import SkeletonCard from '../components/SkeletonCard.vue'
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()

const votes = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 20

async function loadVotes(p = 1) {
  loading.value = true
  try {
    const res = await api.get(`/votes?page=${p}&limit=${limit}`)
    votes.value = res.data.votes
    total.value = res.data.total
    page.value = p
  } catch (e) {
    console.error('加载投票失败', e)
  } finally {
    loading.value = false
  }
}

function goToDetail(id) {
  router.push(`/vote/${id}`)
}

const totalPages = computed(() => Math.ceil(total.value / limit))

const isEnded = (vote) => {
  if (!vote.end_at) return false
  return new Date(vote.end_at) < new Date()
}

const totalVotes = (vote) => {
  return vote.options?.reduce((sum, opt) => sum + opt.vote_count, 0) || 0
}

const truncateText = (text, len = 50) => {
  if (!text) return ''
  return text.length > len ? text.substring(0, len) + '...' : text
}

onMounted(() => loadVotes())
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

    <template v-else>
      <div v-if="votes.length === 0" class="empty-state">
        <div class="icon"><Icon name="chart" :size="34" /></div>
        <p>暂无投票，来发起第一个吧！</p>
      </div>

      <div class="votes-list">
        <div v-for="vote in votes" :key="vote.id" class="vote-card glass" @click="goToDetail(vote.id)">
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
        </div>
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
.votes-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-header h2 { font-size: 24px; }

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
  font-size: 17px;
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
  font-size: 11px;
}

.tag-anonymous {
  background: rgba(159, 147, 134, 0.2);
  color: #c9b99a;
}

.tag-ended {
  background: rgba(255, 107, 107, 0.2);
  color: #ffb8b8;
}

.tag-active {
  background: rgba(46, 213, 115, 0.2);
  color: #b8ffb8;
}

.tag-voted {
  background: rgba(169, 155, 134, 0.2);
  color: #d4c5b0;
}

.vote-desc {
  font-size: 14px;
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
  font-size: 13px;
  color: var(--text-secondary);
}

.preview-more {
  padding: 4px 12px;
  font-size: 13px;
  color: var(--text-muted);
}

.vote-footer {
  display: flex;
  gap: 16px;
  font-size: 12px;
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
  gap: 16px;
  padding: 24px 0;
}
</style>
