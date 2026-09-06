<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const router = useRouter()
const toast = useToast()
const friends = ref([])
const pendingRequests = ref([])
const loading = ref(true)
const sortBy = ref('name')
const showDeleteConfirm = ref(false)
const showBlockConfirm = ref(false)
const deleteTarget = ref(null)
const blockTarget = ref(null)

async function loadFriends() {
  loading.value = true
  try {
    const [friendsRes, pendingRes] = await Promise.all([
      api.get('/friends'),
      api.get('/friends/pending')
    ])
    friends.value = friendsRes.data
    pendingRequests.value = pendingRes.data
  } catch (e) {
    console.error('加载好友失败', e)
  } finally {
    loading.value = false
  }
}

const sortedFriends = computed(() => {
  const list = [...friends.value]
  if (sortBy.value === 'name') {
    list.sort((a, b) => (a.friend_nickname || '').localeCompare(b.friend_nickname || ''))
  } else {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
  return list
})

async function respondToRequest(requestId, action) {
  try {
    const res = await api.put(`/friends/${requestId}/respond`, { action })
    toast.success(res.data.message)
    loadFriends()
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

async function deleteFriend(friend) {
  deleteTarget.value = friend
  showDeleteConfirm.value = true
}

async function doDeleteFriend() {
  if (!deleteTarget.value) return
  try {
    await api.delete(`/friends/${deleteTarget.value.id}`)
    loadFriends()
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
  deleteTarget.value = null
}

async function blockUser(friend) {
  blockTarget.value = friend
  showBlockConfirm.value = true
}

async function doBlockUser() {
  if (!blockTarget.value) return
  try {
    await api.post('/friends/block', { user_id: blockTarget.value.friend_id })
    toast.success('已拉黑')
    loadFriends()
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
  blockTarget.value = null
}

function openChat(friendId) {
  router.push(`/chat/${friendId}`)
}

onMounted(() => loadFriends())
</script>

<template>
  <div class="chat-page">
    <h2>聊天</h2>

    <!-- 搜索好友 / 发现好友：各自是独立页面，这里只是入口 -->
    <div class="find-bar glass">
      <button class="find-entry" @click="router.push('/friends/search')">
        <Icon name="search" :size="16" />
        <span>搜索好友</span>
        <Icon class="entry-arrow" name="chevron-right" :size="15" />
      </button>
      <button class="find-entry" @click="router.push('/friends/discover')">
        <Icon name="compass" :size="16" />
        <span>发现好友</span>
        <Icon class="entry-arrow" name="chevron-right" :size="15" />
      </button>
    </div>

    <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载好友">
      <SkeletonCard v-for="i in 3" :key="i" :lines="1" />
    </div>

    <template v-else>
      <!-- 好友请求 -->
      <div v-if="pendingRequests.length > 0" class="section">
        <h3>好友请求 ({{ pendingRequests.length }})</h3>
        <div class="requests-list">
          <div v-for="req in pendingRequests" :key="req.id" class="request-item glass">
            <div class="request-info">
              <div class="request-avatar">
                <img v-if="req.sender_avatar" :src="req.sender_avatar" alt="" class="avatar-img" />
                <span v-else>{{ (req.sender_nickname || '?')[0] }}</span>
              </div>
              <div>
                <strong>{{ req.sender_nickname }}</strong>
                <span class="text-muted" style="font-size:12px">请求添加你为好友</span>
              </div>
            </div>
            <div class="request-actions">
              <button class="btn btn-sm btn-primary" @click="respondToRequest(req.id, 'accept')">同意</button>
              <button class="btn btn-sm btn-secondary" @click="respondToRequest(req.id, 'reject')">拒绝</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 好友列表 -->
      <div class="section">
        <div class="section-header">
          <h3>好友列表</h3>
          <div class="sort-tabs">
            <button class="sort-tab" :class="{ active: sortBy === 'name' }" @click="sortBy='name'">A-Z</button>
            <button class="sort-tab" :class="{ active: sortBy === 'time' }" @click="sortBy='time'">最近</button>
          </div>
        </div>

        <div v-if="sortedFriends.length === 0" class="empty-state">
          <div class="icon"><Icon name="users" :size="34" /></div>
          <p>暂无好友</p>
          <span class="text-muted">用上方的「搜索好友」或「发现好友」认识同学</span>
        </div>

        <div v-else class="friends-list">
          <div
            v-for="friend in sortedFriends"
            :key="friend.id"
            class="friend-item glass"
          >
            <div class="friend-main" role="link" tabindex="0"
                 :aria-label="`和 ${friend.friend_nickname} 聊天`"
                 @click="openChat(friend.friend_id)" @keydown.enter="openChat(friend.friend_id)">
              <div class="friend-avatar">
                <img v-if="friend.friend_avatar" :src="friend.friend_avatar" alt="" class="avatar-img" />
                <span v-else>{{ (friend.friend_nickname || '?')[0] }}</span>
              </div>
              <div class="friend-info">
                <span class="friend-name">{{ friend.friend_nickname }}</span>
              </div>
              <span class="chat-hint">发消息<Icon name="chevron-right" :size="14" /></span>
            </div>
            <div class="friend-actions">
              <button class="action-btn" @click.stop="blockUser(friend)" title="拉黑用户">
                <Icon name="ban" :size="15" /><span class="action-label">拉黑</span>
              </button>
              <button class="action-btn danger" @click.stop="deleteFriend(friend)" title="删除好友">
                <Icon name="trash" :size="15" /><span class="action-label">删除</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 删除好友确认 -->
    <ConfirmModal
      :show="showDeleteConfirm"
      title="删除好友"
      :message="deleteTarget ? `确定删除好友 ${deleteTarget.friend_nickname}？` : ''"
      confirm-text="删除"
      cancel-text="取消"
      :danger="true"
      @confirm="doDeleteFriend"
      @update:show="showDeleteConfirm = $event"
    />

    <!-- 拉黑确认 -->
    <ConfirmModal
      :show="showBlockConfirm"
      title="拉黑用户"
      :message="blockTarget ? `确定拉黑 ${blockTarget.friend_nickname}？拉黑后对方无法给你发消息。` : ''"
      confirm-text="拉黑"
      cancel-text="取消"
      :danger="true"
      @confirm="doBlockUser"
      @update:show="showBlockConfirm = $event"
    />
  </div>
</template>

<style scoped>
.chat-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

h2 { font-size: 24px; margin-bottom: 20px; }

.skeleton-wrap { display: flex; flex-direction: column; gap: var(--space-3); }

/* 搜索/发现好友入口 */
.find-bar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-4);
}
.find-entry {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 10px 12px;
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.find-entry:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.find-entry .entry-arrow { margin-left: auto; opacity: 0.5; }

.section { margin-bottom: 24px; }
.section h3 { font-size: 18px; margin-bottom: 12px; }

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.sort-tabs {
  display: flex;
  gap: 4px;
  background: rgba(255,255,255,0.05);
  padding: 3px;
  border-radius: var(--radius-sm);
}

.sort-tab {
  background: none;
  border: none;
  color: var(--text-muted);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.sort-tab.active {
  background: rgba(255,255,255,0.15);
  color: #fff;
}

.sort-tab:hover {
  color: var(--text-secondary);
}

.requests-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.request-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  border-left: 3px solid #c9b99a;
}

.request-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.request-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  overflow: hidden;
}

.request-actions {
  display: flex;
  gap: 8px;
}

.friends-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.friend-item {
  border-radius: var(--radius-md);
  overflow: hidden;
}

.friend-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  transition: background 0.2s;
}

.friend-main:hover {
  background: rgba(255, 255, 255, 0.05);
}
.friend-main:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-1) 75%, transparent);
  outline-offset: -2px;
}

.friend-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  overflow: hidden;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.friend-info { flex: 1; }
.friend-name { font-weight: 600; font-size: 15px; }

.chat-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  color: var(--text-muted);
}

.friend-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.action-btn {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.action-btn.danger:hover {
  background: rgba(255, 107, 107, 0.15);
  color: #ff6b6b;
}

.action-label {
  font-size: 12px;
}
</style>
