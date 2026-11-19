<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const toast = useToast()

const activeTab = ref('my') // 'my' | 'pending'
const myConversations = ref([])
const pendingConversations = ref([])
const loading = ref(true)
const selectMode = ref(false)
const selectedIds = ref(new Set())

const showDeleteConfirm = ref(false)
const deleting = ref(false)
const assigning = ref(new Set())
const loadError = ref('')

async function loadConversations() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.get('/messages/tree-hole/conversations')
    myConversations.value = res.data.my || []
    pendingConversations.value = res.data.pending || []
  } catch (e) {
    loadError.value = '树洞对话加载失败，请重试'
  } finally {
    loading.value = false
  }
}

function openChat(convId) {
  if (selectMode.value) { toggleSelect(convId); return }
  router.push(`/tree-hole/chat/${convId}`)
}

async function assignConversation(convId) {
  if (assigning.value.has(convId)) return
  assigning.value.add(convId)
  try {
    const res = await api.post(`/messages/tree-hole/${convId}/assign`)
    toast.success(res.data.message)
    router.push(`/tree-hole/chat/${convId}`)
  } catch (e) {
    toast.error(e.response?.data?.error || '响应失败')
    loadConversations()
  } finally { assigning.value.delete(convId) }
}

function toggleSelect(convId) {
  if (selectedIds.value.has(convId)) selectedIds.value.delete(convId)
  else selectedIds.value.add(convId)
}

function toggleSelectAll() {
  const list = activeTab.value === 'my' ? myConversations.value : pendingConversations.value
  if (selectedIds.value.size === list.length) {
    selectedIds.value.clear()
  } else {
    list.forEach(c => selectedIds.value.add(c.conversation_id))
  }
}

function enterSelectMode() {
  if (activeTab.value !== 'my' || deleting.value) return
  selectMode.value = true
  selectedIds.value.clear()
}

function exitSelectMode() {
  selectMode.value = false
  selectedIds.value.clear()
}

function promptDeleteSelected() {
  if (selectedIds.value.size === 0) return
  showDeleteConfirm.value = true
}

async function deleteSelected() {
  if (deleting.value || !selectedIds.value.size) return
  deleting.value = true
  const ids = [...selectedIds.value]
  try {
    const results = await Promise.allSettled(ids.map(cid => api.delete('/messages/tree-hole/' + cid)))
    const removed = new Set(ids.filter((id, index) => results[index].status === 'fulfilled'))
    myConversations.value = myConversations.value.filter(c => !removed.has(c.conversation_id))
    selectedIds.value = new Set(ids.filter(id => !removed.has(id)))
    if (selectedIds.value.size) toast.error('部分对话删除失败，已保留失败项，可重新提交')
    else { selectMode.value = false; toast.success('已删除选中的对话') }
  } finally { deleting.value = false }
}
watch(activeTab, exitSelectMode)

const timeAgo = (date) => {
  if (!date) return ''
  const d = new Date(date.replace(' ', 'T'))
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 0) return '刚刚'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return d.toLocaleDateString()
}

onMounted(() => loadConversations())
</script>

<template>
  <div class="conversations-page">
    <div class="page-header">
      <h2>树洞对话</h2>
      <div class="header-actions">
        <button v-if="!selectMode && activeTab === 'my'" class="btn btn-secondary btn-sm" :disabled="loading || myConversations.length === 0" @click="enterSelectMode">选择</button>
        <template v-else-if="selectMode">
          <button class="btn btn-secondary btn-sm" @click="toggleSelectAll">{{ selectedIds.size === (activeTab === 'my' ? myConversations : pendingConversations).length ? '取消全选' : '全选' }}</button>
          <button class="btn btn-danger btn-sm" :disabled="selectedIds.size === 0 || deleting" @click="promptDeleteSelected">删除 ({{ selectedIds.size }})</button>
          <button class="btn btn-secondary btn-sm" @click="exitSelectMode">取消</button>
        </template>
        <button class="btn btn-primary btn-sm" @click="router.push('/help/counseling')">+ 新的倾诉</button>
      </div>
    </div>

    <!-- 选项卡 -->
    <div class="tab-bar">
      <button class="tab-btn" :class="{ active: activeTab === 'my' }" @click="activeTab = 'my'">
        我的对话 <span v-if="myConversations.length" class="tab-count">{{ myConversations.length }}</span>
      </button>
      <button v-if="wallStore.canHere('wall.tree_hole')" class="tab-btn" :class="{ active: activeTab === 'pending' }" @click="activeTab = 'pending'">
        待响应 <span v-if="pendingConversations.length" class="tab-count">{{ pendingConversations.length }}</span>
      </button>
    </div>

    <div v-if="loading" class="loading">加载中</div>

    <p v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadConversations">重试</button></p>
    <template v-else>
      <!-- 我的对话 -->
      <template v-if="activeTab === 'my'">
        <div v-if="myConversations.length === 0" class="empty-state">
          <div class="icon"><Icon name="leaf" :size="34" /></div>
          <p v-if="wallStore.canHere('wall.tree_hole')">暂无树洞对话</p>
          <p v-else>你还没有树洞对话，点击"倾诉"开始</p>
        </div>

        <div v-else class="conv-list">
          <div
            v-for="conv in myConversations"
            :key="conv.conversation_id"
            class="conv-item glass"
            :class="{ selected: selectedIds.has(conv.conversation_id) }"
            :role="selectMode ? undefined : 'link'"
            :tabindex="selectMode ? -1 : 0"
            @keydown.enter.self="openChat(conv.conversation_id)"
            @click="openChat(conv.conversation_id)"
          >
            <div v-if="selectMode" class="conv-check">
              <input type="checkbox" aria-label="选择此对话" :checked="selectedIds.has(conv.conversation_id)" :disabled="deleting" @click.stop @change="toggleSelect(conv.conversation_id)" />
            </div>
            <div class="conv-avatar">
              <Icon name="leaf" :size="18" />
            </div>
            <div class="conv-info">
              <div class="conv-top">
                <span class="conv-name">匿名对话 <span v-if="conv.is_closed" class="closed-tag">已归档</span></span>
                <span class="text-muted">{{ timeAgo(conv.last_time) }}</span>
              </div>
              <div class="conv-preview">
                <span class="preview-text">{{ conv.last_message || '...' }}</span>
                <span v-if="conv.unread_count > 0" class="unread-badge">{{ conv.unread_count }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 待响应 -->
      <template v-if="activeTab === 'pending'">
        <div v-if="pendingConversations.length === 0" class="empty-state">
          <div class="icon"><Icon name="check-circle" :size="34" /></div>
          <p>暂无待响应的倾诉</p>
          <p class="text-muted" style="font-size:13px">有人发起倾诉、又还没等到志愿者回应时，会出现在这里</p>
        </div>

        <div v-else class="conv-list">
          <div
            v-for="conv in pendingConversations"
            :key="conv.conversation_id"
            class="conv-item glass pending-item"
          >
            <div class="conv-avatar pending-avatar">
              <Icon name="user" :size="18" />
            </div>
            <div class="conv-info">
              <div class="conv-top">
                <span class="conv-name">匿名倾诉</span>
                <span class="text-muted">{{ timeAgo(conv.first_time) }}</span>
              </div>
              <div class="conv-preview">
                <span class="preview-text">{{ conv.first_message || '...' }}</span>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" :disabled="assigning.has(conv.conversation_id)" @click.stop="assignConversation(conv.conversation_id)">我来回应</button>
          </div>
        </div>
      </template>
    </template>

    <ConfirmModal
      :show="showDeleteConfirm"
      title="删除对话"
      :message="`确定删除选中的 ${selectedIds.size} 条对话？`"
      confirmText="确定删除"
      danger
      @confirm="deleteSelected"
      @cancel="showDeleteConfirm = false"
      @update:show="showDeleteConfirm = $event"
    />
  </div>
</template>

<style scoped>
.conversations-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.page-header h2 { font-size: 1.5rem; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; background: var(--bg-input); padding: 3px; border-radius: var(--radius-pill); }
.tab-btn {
  flex: 1; border: none; background: none; color: var(--text-muted);
  padding: 8px 16px; border-radius: var(--radius-pill); font-size: 0.875rem;
  cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px;
}
.tab-btn.active { background: var(--accent-soft); color: var(--text-primary); font-weight: 600; }
.tab-count { font-size: 0.75rem; padding: 1px 6px; border-radius: 10px; background: rgba(255,255,255,0.1); }

.conv-list { display: flex; flex-direction: column; gap: 8px; }

.conv-item {
  display: flex; align-items: center; gap: 14px;
  padding: 16px; border-radius: var(--radius-md); cursor: pointer;
  transition: all 0.2s;
}
.conv-item:hover { background: rgba(255,255,255,0.15); transform: translateY(-1px); }
.conv-item.selected { background: color-mix(in srgb, var(--accent-1) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent-1) 30%, transparent); }
.pending-item { cursor: default; border-left: 3px solid var(--accent-line); }
.pending-item:hover { background: rgba(255,255,255,0.08); transform: none; }

.conv-check { flex-shrink: 0; }
.conv-check input { width: 18px; height: 18px; accent-color: var(--accent-1); cursor: pointer; }

.conv-avatar {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--accent-1);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.375rem; flex-shrink: 0;
}
.pending-avatar { background: var(--accent-2); }

.conv-info { flex: 1; min-width: 0; }

.conv-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.conv-name { font-weight: 600; font-size: 0.9375rem; }

.conv-preview { display: flex; justify-content: space-between; align-items: center; }
.preview-text { font-size: 0.8125rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px; }

.unread-badge {
  background: var(--danger); color: #fff; font-size: 0.6875rem;
  padding: 2px 7px; border-radius: var(--radius-md); min-width: 18px; text-align: center; font-weight: 700;
}

.closed-tag {
  font-size: 0.6875rem; padding: 1px 6px; border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.08); color: var(--text-muted);
  margin-left: 6px; font-weight: 400;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.conv-info { min-width: 0; }
.conv-top { gap: 10px; flex-wrap: wrap; }
.conv-check input { accent-color: var(--accent-1); }
@media (max-width: 480px) { .header-actions { flex-wrap: wrap; } .conv-item { padding: 14px 12px; gap: 10px; } .pending-item { flex-wrap: wrap; } .pending-item > button { margin-left: auto; } }
</style>