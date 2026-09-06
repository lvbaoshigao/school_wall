<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

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

async function loadVote() {
  loading.value = true
  try {
    const res = await api.get(`/votes/${route.params.id}`)
    vote.value = res.data
  } catch (e) {
    if (e.response?.status === 404) {
      toast.error('投票不存在')
      router.push('/votes')
    }
  } finally {
    loading.value = false
  }
}

function selectOption(optionId) {
  if (vote.value.voted || isEnded.value) return
  selectedOption.value = optionId
}

function confirmVote() {
  if (!selectedOption.value) {
    toast.error('请先选择一个选项')
    return
  }
  showConfirm.value = true
}

async function doVote() {
  if (!userStore.isLoggedIn) {
    router.push('/login')
    return
  }

  voting.value = true
  showConfirm.value = false
  try {
    await api.post(`/votes/${vote.value.id}/vote`, { option_id: selectedOption.value })
    selectedOption.value = null
    await loadVote()
  } catch (e) {
    toast.error(e.response?.data?.error || '投票失败')
  } finally {
    voting.value = false
  }
}

async function deleteVote() {
  if (!confirm('确定删除这个投票？')) return
  try {
    await api.delete(`/votes/${vote.value.id}`)
    router.push('/votes')
  } catch (e) {
    toast.error(e.response?.data?.error || '删除失败')
  }
}

const isEnded = computed(() => {
  if (!vote.value?.end_at) return false
  return new Date(vote.value.end_at) < new Date()
})

const totalVotes = computed(() => {
  if (!vote.value?.options) return 0
  return vote.value.options.reduce((sum, opt) => sum + opt.vote_count, 0)
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

onMounted(() => loadVote())
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

      <div class="options-list">
        <div
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
        </div>
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
        <button v-if="canDelete" class="btn btn-sm btn-danger" @click="deleteVote">删除</button>
      </div>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <div v-if="showConfirm" class="modal-overlay" @click.self="showConfirm = false">
    <div class="modal glass-strong">
      <h3>确认投票</h3>
      <p>你选择了：</p>
      <div class="confirm-option">{{ selectedOptionText }}</div>
      <p class="text-muted" style="font-size:13px;margin-top:12px">投票后不可更改，确定提交吗？</p>
      <div class="modal-actions">
        <button class="btn btn-primary" @click="doVote">确定提交</button>
        <button class="btn btn-secondary" @click="showConfirm = false">再想想</button>
      </div>
    </div>
  </div>

  <div v-if="loading && !vote" class="loading">加载中</div>
</template>

<style scoped>
.vote-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.vote-card { padding: 28px; }

.vote-header { margin-bottom: 16px; }
.vote-header h2 { font-size: 22px; margin-bottom: 10px; }

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
  font-size: 12px;
}

.tag-anonymous { background: rgba(159,147,134,0.2); color: #c9b99a; }
.tag-ended { background: rgba(255,107,107,0.2); color: #ffb8b8; }
.tag-active { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.tag-voted { background: rgba(169,155,134,0.2); color: #d4c5b0; }

.vote-description {
  font-size: 15px;
  color: var(--text-secondary);
  margin-bottom: 12px;
  line-height: 1.6;
}

.vote-end-time {
  margin-bottom: 20px;
  font-size: 13px;
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
  border-color: #c9b99a;
  box-shadow: inset 0 0 0 3px #c9b99a;
}

.option-text { font-size: 15px; }

.option-count {
  font-size: 13px;
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
  background: linear-gradient(90deg, #c9b99a, #a8937a);
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
  font-size: 15px;
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

.modal h3 { margin-bottom: 16px; font-size: 20px; }

.confirm-option {
  padding: 14px 20px;
  background: rgba(201,185,154,0.15);
  border: 1px solid rgba(201,185,154,0.3);
  border-radius: var(--radius-md);
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0;
  color: #d4c5b0;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 20px;
}
</style>
