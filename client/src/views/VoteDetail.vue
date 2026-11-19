<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const toast = useToast()

const vote = ref(null)
const loading = ref(true)
const voting = ref(false)
const selectedOption = ref(null)
const showConfirm = ref(false)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const loadError = ref('')
const now = ref(Date.now())
let clock = null
let loadVersion = 0
let disposed = false

async function loadVote() {
  const version = ++loadVersion
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.get(`/votes/${route.params.id}`)
    if (disposed || version !== loadVersion) return
    vote.value = res.data
  } catch (e) {
    if (disposed || version !== loadVersion) return
    loadError.value = e.response?.data?.error || '投票加载失败，请重试'
    if (e.response?.status === 404) {
      toast.error('投票不存在')
      router.push('/votes')
    }
  } finally {
    if (!disposed && version === loadVersion) loading.value = false
  }
}

function selectOption(optionId) {
  if (!vote.value || voting.value || vote.value.voted || isEnded.value) return
  selectedOption.value = optionId
}

function confirmVote() {
  if (!vote.value || voting.value || vote.value.voted || isEnded.value) return
  if (!selectedOption.value) {
    toast.error('请先选择一个选项')
    return
  }
  showConfirm.value = true
}

async function doVote() {
  if (!vote.value || voting.value || vote.value.voted || !selectedOption.value || loading.value) return
  now.value = Date.now()
  if (isEnded.value) { showConfirm.value = false; toast.error('投票已结束'); return }
  if (!userStore.isLoggedIn) {
    router.push('/login')
    return
  }

  voting.value = true
  showConfirm.value = false
  try {
    const currentVote = vote.value
    const optionId = selectedOption.value
    await api.post(`/votes/${currentVote.id}/vote`, { option_id: optionId })
    if (disposed || vote.value !== currentVote) return
    currentVote.voted = optionId
    selectedOption.value = null
    await loadVote()
  } catch (e) {
    toast.error(e.response?.data?.error || '投票失败')
  } finally {
    voting.value = false
  }
}

async function deleteVote() {
  if (deleting.value || !vote.value) return
  deleting.value = true
  try {
    await api.delete(`/votes/${vote.value.id}`)
    router.push('/votes')
  } catch (e) {
    toast.error(e.response?.data?.error || '删除失败')
  } finally { deleting.value = false }
}

const isEnded = computed(() => {
  if (!vote.value?.end_at) return false
  return new Date(vote.value.end_at).getTime() <= now.value
})

const totalVotes = computed(() => {
  if (!vote.value?.options) return 0
  return vote.value.options.reduce((sum, opt) => sum + (Number(opt.vote_count) || 0), 0)
})

const getPercent = (count) => {
  if (totalVotes.value === 0) return 0
  return Math.round((count / totalVotes.value) * 100)
}

const canDelete = computed(() => {
  return wallStore.canHere('wall.post.delete') || (userStore.user && userStore.user.id === vote.value?.author_id)
})

const selectedOptionText = computed(() => {
  if (!selectedOption.value || !vote.value?.options) return ''
  const opt = vote.value.options.find(o => o.id === selectedOption.value)
  return opt?.option_text || ''
})

watch([() => route.params.id, () => wallStore.currentWallId], () => {
  vote.value = null
  selectedOption.value = null
  showConfirm.value = false
  showDeleteConfirm.value = false
  loadVote()
})
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  loadVote()
})
onBeforeUnmount(() => { disposed = true; loadVersion++; clearInterval(clock) })
</script>

<template>
  <div class="vote-page" v-if="vote">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/votes')"><Icon name="chevron-left" :size="15" />返回投票列表</button>

    <div class="vote-card glass-strong">
      <div class="vote-header">
        <h2>{{ vote.title }}</h2>
        <div class="vote-meta">
          <span v-if="vote.is_anonymous" class="tag tag-anonymous">匿名</span>
          <span v-if="isEnded" class="tag tag-ended">已结束</span>
          <span v-else class="tag tag-active">进行中</span>
          <span v-if="vote.voted" class="tag tag-voted">已投票</span>
          <span class="text-muted">{{ totalVotes }} 人参与</span>
        </div>
      </div>

      <p v-if="vote.description" class="vote-description">{{ vote.description }}</p>

      <div v-if="vote.end_at" class="vote-end-time text-muted">
        截止时间: {{ new Date(vote.end_at).toLocaleString('zh-CN') }}
      </div>

      <div class="options-list" aria-label="投票选项">
        <button
          type="button"
          :disabled="!!vote.voted || isEnded || voting"
          :aria-pressed="selectedOption === opt.id || vote.voted === opt.id"
          v-for="opt in vote.options"
          :key="opt.id"
          class="option-item"
          :class="{
            selected: selectedOption === opt.id,
            voted: vote.voted === opt.id,
            clickable: !vote.voted && !isEnded
          }"
          @click="selectOption(opt.id)"
        >
          <div class="option-header">
            <div class="option-left">
              <span class="option-radio" :class="{ checked: selectedOption === opt.id || vote.voted === opt.id }"
                    :aria-hidden="true"></span>
              <span class="option-text">{{ opt.option_text }}</span>
            </div>
            <span class="option-count">{{ opt.vote_count }}票 ({{ getPercent(opt.vote_count) }}%)</span>
          </div>
          <div class="option-bar">
            <div class="option-bar-fill" :style="{ width: getPercent(opt.vote_count) + '%' }"></div>
          </div>
        </button>
      </div>

      <!-- 投票按钮 -->
      <div v-if="!vote.voted && !isEnded" class="vote-action">
        <button
          class="btn btn-primary"
          :disabled="!selectedOption || voting"
          @click="confirmVote"
        >
          {{ voting ? '提交中…' : '提交投票' }}
        </button>
        <p class="text-muted" style="font-size:12px;margin-top:8px">选择后点击提交，投票后不可更改</p>
      </div>

      <div v-else-if="vote.voted" class="vote-result text-muted">
        <Icon name="check" :size="15" />你已经投过票了
      </div>

      <div class="vote-footer">
        <span class="text-muted">
          {{ vote.author_nickname ? `创建者: ${vote.author_nickname}` : '匿名创建' }}
          · {{ new Date(vote.created_at).toLocaleDateString() }}
        </span>
        <button v-if="canDelete" class="btn btn-sm btn-danger" :disabled="deleting" @click="showDeleteConfirm = true">删除</button>
      </div>
    </div>
  </div>

  <ConfirmModal :show="showConfirm" title="确认投票"
    :message="'你选择了：' + selectedOptionText + '。投票后不可更改，确定提交吗？'"
    confirm-text="确定提交" @confirm="doVote" @update:show="showConfirm = $event" />
  <ConfirmModal :show="showDeleteConfirm" title="删除投票" message="确定删除这个投票？此操作无法撤销。"
    danger confirm-text="删除" @confirm="deleteVote" @update:show="showDeleteConfirm = $event" />
  <p v-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadVote">重试</button></p>

  <div v-if="loading && !vote" class="loading">加载中</div>
</template>

<style scoped>
.vote-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.vote-card { padding: 28px; }

.vote-header { margin-bottom: 16px; }
.vote-header h2 { font-size: 1.375rem; margin-bottom: 10px; }

.vote-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  display: inline-block;
  padding: 3px 10px;
  border-radius: var(--radius-xl);
  font-size: 0.75rem;
}

.tag-anonymous { background: rgba(159,147,134,0.2); color: var(--text-link); }
.tag-ended { background: rgba(255,107,107,0.2); color: var(--danger-light); }
.tag-active { background: rgba(46,213,115,0.2); color: var(--success); }
.tag-voted { background: rgba(169,155,134,0.2); color: var(--text-link); }

.vote-description {
  font-size: 0.9375rem;
  color: var(--text-secondary);
  margin-bottom: 12px;
  line-height: 1.6;
}

.vote-end-time {
  margin-bottom: 20px;
  font-size: 0.8125rem;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 20px;
}

.option-item {
  padding: 14px 16px;
  background: rgba(255,255,255,0.04);
  border: 2px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-md);
  transition: all 0.2s;
}

.option-item.clickable { cursor: pointer; }
.option-item.clickable:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }

.option-item.selected {
  border-color: rgba(201,185,154,0.5);
  background: rgba(201,185,154,0.12);
}

.option-item.voted {
  border-color: rgba(201,185,154,0.4);
  background: rgba(201,185,154,0.08);
}

.option-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.option-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.option-radio {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}

.option-radio.checked {
  border-color: var(--text-link);
  box-shadow: inset 0 0 0 3px var(--text-link);
}

.option-text { font-size: 0.9375rem; }

.option-count {
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.option-bar {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.option-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--text-link), var(--accent-2));
  border-radius: var(--radius-xs);
  transition: width 0.3s ease;
}

.vote-action {
  text-align: center;
  padding: 16px 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 16px;
}

.vote-result {
  text-align: center;
  padding: 16px 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 16px;
  font-size: 0.9375rem;
}

.vote-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 16px;
}

/* 确认弹窗 */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
}

.modal {
  padding: 28px;
  border-radius: var(--radius-lg);
  width: 90%;
  max-width: 400px;
  text-align: center;
}

.modal h3 { margin-bottom: 16px; font-size: 1.25rem; }

.confirm-option {
  padding: 14px 20px;
  background: rgba(201,185,154,0.15);
  border: 1px solid rgba(201,185,154,0.3);
  border-radius: var(--radius-md);
  font-size: 1rem;
  font-weight: 600;
  margin: 12px 0;
  color: var(--text-link);
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 20px;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.option-item { width: 100%; text-align: left; color: var(--text-primary); font: inherit; }
.option-item:disabled { opacity: 1; cursor: default; }
.option-header, .vote-footer { gap: 12px; flex-wrap: wrap; }
.option-left { min-width: 0; }
.option-text, .vote-description { overflow-wrap: anywhere; white-space: pre-wrap; }
.option-count { font-variant-numeric: tabular-nums; }
.option-item.selected, .option-item.voted { border-color: var(--accent-line); background: var(--accent-soft); }
.option-bar-fill { background: var(--accent-1); }
@media (max-width: 480px) { .vote-card { padding: 20px 16px; } .option-item { padding: 14px 12px; } }
</style>
