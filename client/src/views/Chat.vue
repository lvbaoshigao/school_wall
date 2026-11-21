<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import api, { getSessionToken, getApiErrorMessage } from '../api'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useSettingsStore } from '../stores/settings'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useToast } from '../composables/useToast'
import { createSocialScope, pollMilliseconds } from '../components/chat-social/socialState'
import Icon from '../components/Icon.vue'
import AvatarIcon from '../components/AvatarIcon.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const router = useRouter()
const toast = useToast()
const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const { timeAgo } = useTimeAgo()
const friends = ref([])
const pendingRequests = ref([])
const loading = ref(true)
const sortBy = ref('name')
const activeTab = ref('recent')
const query = ref('')
const conversationSort = ref('activity')
const conversations = ref([])
const summariesLoading = ref(true)
const loadingMore = ref(false)
const summariesError = ref('')
const hasMore = ref(false)
const cursor = ref(null)
const openedAt = ref({})
const showDeleteConfirm = ref(false)
const showBlockConfirm = ref(false)
const deleteTarget = ref(null)
const blockTarget = ref(null)
const busy = ref(new Set())
const actionBusy = ref(false)
const loadError = ref('')
const scope = createSocialScope(() => ({ token: getSessionToken(), wallId: wallStore.currentWallId, session: userStore.sessionRevision }))
let disposed = false
let friendVersion = 0
let summaryVersion = 0
let summaryRequest
let timer
const dense = computed(() => settingsStore.prefs.chat_density === 'compact')
const showTimestamps = computed(() => settingsStore.prefs.chat_show_timestamps !== false)
const unreadTotal = computed(() => conversations.value.reduce((sum, item) => sum + Math.max(0, Number(item.unread_count) || 0), 0))
function openedStorageKey() { return 'school-wall:chat-opened:' + (userStore.user?.id || 'current') }
function restoreOpened() {
  openedAt.value = {}
  if (!userStore.user?.id) return
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(openedStorageKey()) || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) openedAt.value = Object.fromEntries(Object.entries(value).filter(([id, time]) => /^[1-9]\d*$/.test(id) && Number.isFinite(time) && time > 0).slice(0, 100))
  } catch { /* 浏览器禁用存储时仍可正常聊天。 */ }
}
async function loadFriends() {
  const version = ++friendVersion
  const request = scope.request()
  loading.value = true
  loadError.value = ''
  try {
    const [friendsRes, pendingRes] = await Promise.all([api.get('/friends', request.config), api.get('/friends/pending', request.config)])
    if (!request.current() || version !== friendVersion) return
    friends.value = Array.isArray(friendsRes.data) ? friendsRes.data : []
    pendingRequests.value = Array.isArray(pendingRes.data) ? pendingRes.data : []
  } catch (e) { if (request.current() && version === friendVersion) loadError.value = getApiErrorMessage(e, '好友列表加载失败，请重试') }
  finally { if (request.current() && version === friendVersion) loading.value = false; request.release() }
}
async function loadConversations(append = false, silent = false) {
  if (disposed || append && (!hasMore.value || loadingMore.value || summariesLoading.value) || silent && loadingMore.value) return
  summaryRequest?.cancel()
  const request = scope.request()
  summaryRequest = request
  const version = ++summaryVersion
  if (append) loadingMore.value = true
  else if (!silent) summariesLoading.value = true
  summariesError.value = ''
  const params = { limit: 30 }
  if (append && cursor.value) params.before = cursor.value
  try {
    const res = await api.get('/messages/conversations', { ...request.config, params })
    if (!request.current() || version !== summaryVersion) return
    const incoming = (Array.isArray(res.data.conversations) ? res.data.conversations : []).filter(item => Number.isSafeInteger(Number(item.user_id)) && Number(item.user_id) > 0)
    conversations.value = append || silent ? [...new Map([...conversations.value, ...incoming].map(item => [Number(item.user_id), item])).values()] : incoming
    if (!silent || !cursor.value) {
      hasMore.value = !!res.data.hasMore
      cursor.value = res.data.next_before_id || res.data.next_before || null
      if (!cursor.value) hasMore.value = false
    }
  } catch (e) { if (request.current() && version === summaryVersion) summariesError.value = getApiErrorMessage(e, '最近会话加载失败，请重试') }
  finally {
    if (request.current() && version === summaryVersion) { summariesLoading.value = false; loadingMore.value = false }
    request.release()
  }
}
const sortedFriends = computed(() => {
  const list = [...friends.value]
  if (sortBy.value === 'name') list.sort((a, b) => (a.friend_nickname || '').localeCompare(b.friend_nickname || '', 'zh-CN'))
  else list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  return list
})
const visibleConversations = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return conversations.value.filter(item => !keyword || ((item.other_user?.nickname || '') + ' ' + (item.last_message?.is_revoked ? '消息已撤回' : item.last_message?.content || '')).toLocaleLowerCase().includes(keyword)).sort((a, b) => {
    if (conversationSort.value === 'opened') return (openedAt.value[b.user_id] || 0) - (openedAt.value[a.user_id] || 0) || b.last_message_id - a.last_message_id
    if (conversationSort.value === 'unread') return Number(Number(b.unread_count) > 0) - Number(Number(a.unread_count) > 0) || b.last_message_id - a.last_message_id
    return b.last_message_id - a.last_message_id
  })
})
function lastMessageText(item) {
  const message = item.last_message
  return message?.is_revoked ? '消息已撤回' : (message?.content || '暂无消息')
}
function deliveryStatus(item) {
  const message = item.last_message
  if (!message || message.is_revoked || Number(message.sender_id) !== Number(userStore.user?.id)) return ''
  return message.is_read ? '已读' : '未读'
}
async function respondToRequest(requestId, action) {
  if (busy.value.has(requestId)) return
  const request = scope.request()
  busy.value.add(requestId)
  try {
    const res = await api.put('/friends/' + requestId + '/respond', { action }, request.config)
    if (!request.current()) return
    toast.success(res.data.message || '好友请求已处理')
    loadFriends()
  } catch (e) { if (request.current()) toast.error(getApiErrorMessage(e, '操作失败')) }
  finally { if (request.current()) busy.value.delete(requestId); request.release() }
}
function deleteFriend(friend) { if (actionBusy.value) return; deleteTarget.value = friend; showDeleteConfirm.value = true }
function blockUser(friend) { if (actionBusy.value) return; blockTarget.value = friend; showBlockConfirm.value = true }
async function doDeleteFriend() {
  const target = deleteTarget.value
  if (!target || actionBusy.value) return
  const request = scope.request()
  actionBusy.value = true
  try {
    await api.delete('/friends/' + target.id, request.config)
    if (request.current()) { await loadFriends(); await loadConversations() }
  } catch (e) { if (request.current()) toast.error(getApiErrorMessage(e, '删除失败')) }
  finally { if (request.current()) { actionBusy.value = false; deleteTarget.value = null }; request.release() }
}
async function doBlockUser() {
  const target = blockTarget.value
  if (!target || actionBusy.value) return
  const request = scope.request()
  actionBusy.value = true
  try {
    await api.post('/friends/block', { user_id: target.friend_id }, request.config)
    if (request.current()) { toast.success('已拉黑'); await loadFriends(); await loadConversations() }
  } catch (e) { if (request.current()) toast.error(getApiErrorMessage(e, '操作失败')) }
  finally { if (request.current()) { actionBusy.value = false; blockTarget.value = null }; request.release() }
}
function openChat(friendId) {
  const id = Number(friendId)
  if (!Number.isSafeInteger(id) || id <= 0) return
  openedAt.value = Object.fromEntries(Object.entries({ ...openedAt.value, [id]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 100))
  try { if (userStore.user?.id) globalThis.sessionStorage?.setItem(openedStorageKey(), JSON.stringify(openedAt.value)) } catch {}
  router.push('/chat/' + id)
}
function stopPolling() { clearTimeout(timer); timer = null }
function startPolling() {
  stopPolling()
  if (disposed || document.visibilityState === 'hidden') return
  timer = setTimeout(async () => {
    if (activeTab.value === 'recent') await loadConversations(false, true)
    startPolling()
  }, pollMilliseconds(settingsStore.prefs.chat_poll_interval))
}
function resetContext() {
  scope.reset(); friendVersion++; summaryVersion++; stopPolling()
  friends.value = []; pendingRequests.value = []; conversations.value = []; query.value = ''; cursor.value = null; hasMore.value = false
  busy.value = new Set(); actionBusy.value = false; showDeleteConfirm.value = showBlockConfirm.value = false
  restoreOpened(); loadFriends(); loadConversations(); startPolling()
}
function onVisibilityChange() { if (document.visibilityState === 'visible') { loadConversations(false, true); startPolling() } else stopPolling() }
watch(() => [wallStore.currentWallId, userStore.sessionRevision, userStore.token], resetContext)
watch(() => settingsStore.prefs.chat_poll_interval, startPolling)
onMounted(() => { restoreOpened(); loadFriends(); loadConversations(); startPolling(); document.addEventListener('visibilitychange', onVisibilityChange) })
onBeforeUnmount(() => { disposed = true; scope.dispose(); stopPolling(); document.removeEventListener('visibilitychange', onVisibilityChange) })
</script>

<template>
  <div class="chat-page" :class="{ compact: dense }">
    <header class="page-heading"><div><h1>会话</h1><p class="text-muted">继续未完的对话，或和同学打个招呼</p></div><RouterLink class="btn btn-secondary btn-sm" to="/tree-hole/list"><Icon name="leaf" :size="16" />匿名树洞</RouterLink></header>

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

    <div class="view-tabs" role="group" aria-label="聊天列表类型">
      <button :aria-pressed="activeTab === 'recent'" :class="{ active: activeTab === 'recent' }" @click="activeTab = 'recent'">最近会话 <span v-if="unreadTotal" class="unread-badge">{{ unreadTotal > 99 ? '99+' : unreadTotal }}</span></button>
      <button :aria-pressed="activeTab === 'friends'" :class="{ active: activeTab === 'friends' }" @click="activeTab = 'friends'">好友 <span v-if="pendingRequests.length" class="request-count">{{ pendingRequests.length }} 个请求</span></button>
    </div>
    <section v-if="activeTab === 'recent'" aria-label="最近私聊会话" :aria-busy="summariesLoading || loadingMore">
      <div class="conversation-tools">
        <label class="conversation-search"><span>搜索最近会话</span><input v-model="query" type="search" maxlength="100" placeholder="姓名或最后一条消息" /></label>
        <label class="conversation-sort"><span>排序</span><select v-model="conversationSort"><option value="activity">最近消息</option><option value="unread">未读优先</option><option value="opened">最近打开</option></select></label>
        <button class="btn btn-secondary" :disabled="summariesLoading || loadingMore" @click="loadConversations()">刷新</button>
      </div>
      <p class="search-note text-muted">搜索仅匹配已加载的 {{ conversations.length }} 个会话<span v-if="hasMore">，可在下方加载更多</span>。</p>
      <div v-if="summariesLoading" class="skeleton-wrap" role="status" aria-label="正在加载最近会话"><SkeletonCard v-for="i in 3" :key="i" :lines="1" /></div>
      <p v-if="summariesError" class="state-error" role="alert">{{ summariesError }} <button class="btn btn-secondary btn-sm" @click="loadConversations()">重试</button></p>
      <div v-if="!summariesLoading && visibleConversations.length === 0 && !summariesError" class="empty-state"><Icon name="message" :size="32" /><p>{{ query.trim() ? '已加载的会话中没有匹配结果' : '还没有最近会话' }}</p><button v-if="!query.trim()" class="btn btn-secondary" @click="activeTab = 'friends'">从好友开始聊天</button></div>
      <ul v-if="!summariesLoading && visibleConversations.length" class="conversation-list">
        <li v-for="item in visibleConversations" :key="item.user_id">
          <button class="conversation-row glass" :class="{ 'has-unread': Number(item.unread_count) > 0 }" :aria-label="'打开与' + (item.other_user?.nickname || '用户') + '的会话' + (item.unread_count ? '，' + item.unread_count + '条未读' : '')" @click="openChat(item.user_id)">
            <AvatarIcon :src="item.other_user?.available === false ? '' : item.other_user?.avatar || ''" :name="item.other_user?.nickname || '用户'" size="lg" />
            <span class="conversation-body"><span class="conversation-top"><strong>{{ item.other_user?.nickname || '用户已不可用' }}</strong><time v-if="showTimestamps" class="text-muted">{{ timeAgo(item.last_time) }}</time></span><span class="conversation-bottom"><span class="conversation-preview"><span v-if="deliveryStatus(item)" class="delivery-state">{{ deliveryStatus(item) }} · </span>{{ lastMessageText(item) }}</span><span v-if="item.unread_count > 0" class="unread-badge">{{ item.unread_count > 99 ? '99+' : item.unread_count }}</span></span><span v-if="item.can_send === false" class="unavailable text-muted">当前无法发送消息，可查看历史</span></span>
          </button>
        </li>
      </ul>
      <div v-if="hasMore && !summariesLoading" class="load-more"><button class="btn btn-secondary" :disabled="loadingMore" @click="loadConversations(true)">{{ loadingMore ? '正在加载…' : '加载更多会话' }}</button></div>
    </section>
    <section v-else aria-label="好友与好友请求">
    <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载好友">
      <SkeletonCard v-for="i in 3" :key="i" :lines="1" />
    </div>

    <p v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadFriends">重试</button></p>
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
              <button class="btn btn-sm btn-primary" :disabled="busy.has(req.id)" @click="respondToRequest(req.id, 'accept')">同意</button>
              <button class="btn btn-sm btn-secondary" :disabled="busy.has(req.id)" @click="respondToRequest(req.id, 'reject')">拒绝</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 好友列表 -->
      <div class="section">
        <div class="section-header">
          <h3>好友列表</h3>
          <div class="sort-tabs">
            <button class="sort-tab" :aria-pressed="sortBy === 'name'" :class="{ active: sortBy === 'name' }" @click="sortBy='name'">A-Z</button>
            <button class="sort-tab" :aria-pressed="sortBy === 'time'" :class="{ active: sortBy === 'time' }" @click="sortBy='time'">最近</button>
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

    </section>

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

h2 { font-size: 1.5rem; margin-bottom: 20px; }

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
  font-size: 0.875rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.find-entry:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.find-entry .entry-arrow { margin-left: auto; opacity: 0.5; }

.section { margin-bottom: 24px; }
.section h3 { font-size: 1.125rem; margin-bottom: 12px; }

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
  font-size: 0.75rem;
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
  border-left: 3px solid var(--text-link);
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
  font-size: 1rem;
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
  font-size: 1.125rem;
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
.friend-name { font-weight: 600; font-size: 0.9375rem; }

.chat-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.8125rem;
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
  font-size: 0.875rem;
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
  color: var(--danger);
}

.action-label {
  font-size: 0.75rem;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.request-item, .friend-item { gap: var(--space-3); }
.request-info, .friend-info { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 480px) { .request-item { flex-wrap: wrap; } .request-actions { margin-left: auto; } }
.chat-page { max-width: 56rem; margin-inline: auto; }
.page-heading { display: flex; gap: var(--space-4); justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: var(--space-5); }
.page-heading h1 { font-size: var(--font-2xl); letter-spacing: -.035em; margin-bottom: var(--space-2); }
.page-heading p { font-size: var(--font-sm); }
.view-tabs { display: flex; gap: var(--space-1); padding-bottom: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--border); }
.view-tabs button { background: transparent; border: 0; display: inline-flex; align-items: center; gap: var(--space-2); min-height: 2.75rem; padding: .65rem 1rem; border-radius: var(--radius-sm); color: var(--text-secondary); cursor: pointer; }
.view-tabs button.active { background: var(--accent-soft); color: var(--text-link); font-weight: 600; }
.conversation-tools { display: flex; align-items: end; gap: var(--space-3); flex-wrap: wrap; }
.conversation-tools label { display: grid; gap: var(--space-2); min-width: 0; font-size: var(--font-sm); color: var(--text-secondary); }
.conversation-search { flex: 1 1 14rem; }
.conversation-sort { flex: 0 1 9rem; }
.conversation-tools input, .conversation-tools select { min-width: 0; width: 100%; }
.search-note { font-size: var(--font-xs); margin: var(--space-3) 0 var(--space-4); line-height: 1.7; }
.conversation-list { list-style: none; padding: 0; display: grid; gap: var(--space-2); }
.conversation-row { display: flex; gap: var(--space-4); align-items: center; width: 100%; padding: var(--space-5); border-radius: var(--radius-md); color: var(--text-primary); text-align: left; cursor: pointer; }
.conversation-row:hover, .friend-main:hover, .find-entry:hover { background: var(--bg-card-hover); }
.conversation-body { min-width: 0; flex: 1; display: grid; gap: var(--space-2); }
.conversation-top, .conversation-bottom { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-width: 0; }
.conversation-top strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-base); }
.conversation-top time { flex-shrink: 0; font-size: var(--font-xs); }
.conversation-preview { font-size: var(--font-sm); color: var(--text-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.delivery-state, .unavailable { color: var(--text-muted); font-size: var(--font-xs); }
.unread-badge { display: inline-flex; align-items: center; justify-content: center; background: var(--accent-1); color: #fff; min-width: 1.5rem; min-height: 1.5rem; padding: .1rem .4rem; border-radius: var(--radius-pill); font-size: .75rem; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.request-count { font-size: var(--font-xs); }
.load-more { display: flex; justify-content: center; padding: var(--space-5) 0; }
.compact .conversation-row { padding: var(--space-3) var(--space-4); }
.friend-actions { border-color: var(--border); }
.sort-tabs { background: var(--bg-input); }
.sort-tab.active { background: var(--accent-soft); color: var(--text-link); }
.action-btn:hover { background: var(--bg-card-hover); }
@media (max-width: 480px) { .conversation-row { padding: var(--space-4); gap: var(--space-3); } .conversation-sort { flex: 1; } .conversation-tools > .btn { flex: 1; } .conversation-top { flex-wrap: wrap; gap: var(--space-1); } .chat-hint { font-size: var(--font-xs); } }
.conversation-row { min-width: 0; transition: background-color .2s var(--ease), border-color .2s var(--ease), box-shadow .2s var(--ease); }
.conversation-row.has-unread { background: color-mix(in srgb, var(--accent-soft) 62%, var(--surface-card)); border-color: var(--accent-line); box-shadow: inset 3px 0 0 var(--accent-1), var(--shadow-md); }
.conversation-top, .conversation-bottom { min-width: 0; }
.conversation-top strong { flex: 1; min-width: 0; }
.conversation-preview { display: block; flex: 1; min-width: 0; }
.conversation-row.has-unread .conversation-preview { color: var(--text-primary); }
</style>
