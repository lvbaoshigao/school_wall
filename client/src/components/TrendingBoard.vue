<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '../api'
import Icon from './Icon.vue'

// 话题热榜：展示当前墙近 N 天各话题的互动热度，点击可切换到该话题。
// 数据来自新增的 GET /posts/trending（服务端按 like*1 + comment*2 聚合）。
const emit = defineEmits(['select-category'])

const loading = ref(true)
const failed = ref(false)
const trending = ref([])
const days = ref(7)

const visibleItems = computed(() =>
  trending.value.filter(t => t.category && t.category !== '全部')
)

async function load() {
  loading.value = true
  failed.value = false
  try {
    const res = await api.get('/posts/trending', { params: { days: 7, limit: 8 } })
    trending.value = res.data.trending || []
    days.value = res.data.days || 7
  } catch (e) {
    failed.value = true
  } finally {
    loading.value = false
  }
}

function pick(cat) {
  emit('select-category', cat)
}

onMounted(load)
</script>

<template>
  <section class="trending-board glass" aria-label="话题热榜">
    <div class="tb-header">
      <span class="tb-title"><Icon name="flame" :size="15" /> 话题热榜</span>
      <span class="tb-days">近 {{ days }} 天</span>
    </div>

    <div v-if="loading" class="tb-skeleton">
      <div v-for="i in 4" :key="i" class="tb-skel-row"></div>
    </div>

    <div v-else-if="failed" class="tb-empty">
      热榜暂时不可用
      <button class="btn btn-secondary btn-sm" @click="load">重试</button>
    </div>

    <div v-else-if="visibleItems.length === 0" class="tb-empty">
      这几天还没有话题，来发第一条吧
    </div>

    <ol v-else class="tb-list">
      <li v-for="(t, i) in visibleItems" :key="t.category">
        <button class="tb-row" @click="pick(t.category)" :aria-label="`切换到话题 ${t.category}`">
          <span class="tb-rank" :class="{ hot: i < 3 }">{{ i + 1 }}</span>
          <span class="tb-name">{{ t.category }}</span>
          <span class="tb-bar">
            <span class="tb-bar-fill" :style="{ width: t.ratio + '%' }"></span>
          </span>
          <span class="tb-count">{{ t.post_count }} 帖</span>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.trending-board {
  padding: var(--space-4);
  border-radius: var(--radius-lg);
}

.tb-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
}
.tb-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.tb-days { font-size: var(--font-xs); color: var(--text-muted); }

.tb-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.tb-row:hover {
  background: var(--bg-card-hover);
  color: var(--text-primary);
}
.tb-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.tb-rank {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-weight: 700;
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.tb-rank.hot { color: var(--danger); }

.tb-name {
  flex-shrink: 0;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.tb-bar {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  overflow: hidden;
}
.tb-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--accent-2), var(--accent-1));
  transition: width 0.5s var(--ease);
}

.tb-count {
  flex-shrink: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
}

.tb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  font-size: var(--font-sm);
  color: var(--text-muted);
}

.tb-skeleton { display: flex; flex-direction: column; gap: 8px; }
.tb-skel-row {
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--bg-card-hover);
  animation: tbSkel 1.2s ease-in-out infinite;
}
@keyframes tbSkel { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

@media (max-width: 600px) {
  .trending-board { display: none; }
}
</style>
