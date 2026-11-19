<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import api, { getApiErrorMessage } from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const toast = useToast()

const user = ref(null)
const loading = ref(true)
const loadError = ref('')
const addingFriend = ref(false)
let controller = null
const friendPending = ref(false)

async function loadUser() {
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  const id = String(route.params.id)
  loading.value = true
  user.value = null
  loadError.value = ''
  friendPending.value = false
  addingFriend.value = false
  try {
    if (!/^[1-9][0-9]*$/.test(id)) { loadError.value = '用户不存在或已注销'; return }
    const res = await api.get('/auth/user/' + id, { signal })
    if (!signal.aborted) user.value = res.data
  } catch (error) {
    if (!signal.aborted) loadError.value = getApiErrorMessage(error, error.response?.status === 404 ? '用户不存在或已注销' : '用户资料加载失败，请重试')
  } finally { if (!signal.aborted) loading.value = false }
}

async function addFriend() {
  if (addingFriend.value || friendPending.value || !user.value) return
  if (!userStore.isLoggedIn) {
    router.push('/login')
    return
  }
  const targetId = user.value.id
  addingFriend.value = true
  try {
    await api.post('/friends/add', { friend_id: targetId })
    if (user.value?.id === targetId) friendPending.value = true
    toast.success('好友请求已发送')
  } catch (e) {
    toast.error(getApiErrorMessage(e, '好友请求发送失败，请重试'))
  } finally { if (user.value?.id === targetId) addingFriend.value = false }
}

const genderDisplay = (g) => {
  const map = { male: '男', female: '女', other: '其他' }
  return map[g] || ''
}

watch(() => route.params.id, loadUser, { immediate: true })
onUnmounted(() => controller?.abort())
</script>

<template>
  <div class="profile-view" v-if="user">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.back()"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="profile-card glass-strong">
      <div class="profile-header">
        <div class="avatar-wrapper">
          <img v-if="user.avatar" :src="user.avatar" class="avatar-lg" :alt="(user.nickname || user.username) + '的头像'" />
          <div v-else class="avatar-placeholder">{{ (user.nickname || user.username)[0] }}</div>
        </div>
        <div class="profile-info">
          <h1>{{ user.nickname || user.username }}</h1>
          <p class="text-muted">@{{ user.username }}</p>
          <div class="profile-tags">
            <span v-if="genderDisplay(user.gender)" class="tag">{{ genderDisplay(user.gender) }}</span>
            <span v-if="user.class_number" class="tag">{{ user.class_number }}班</span>
            <span v-if="user.is_graduate" class="tag">{{ user.graduation_year }}届</span>
          </div>
        </div>
      </div>

      <div v-if="user.bio" class="profile-bio">
        <p>{{ user.bio }}</p>
      </div>

      <div class="profile-stats">
        <div class="stat">
          <span class="stat-value">{{ user.postCount || 0 }}</span>
          <span class="stat-label">帖子</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ user.voteCount || 0 }}</span>
          <span class="stat-label">投票</span>
        </div>
      </div>

      <!-- 联系方式 -->
      <div v-if="user.show_contact && (user.contact_qq || user.contact_wechat || user.contact_weibo || user.contact_bilibili)" class="contact-section">
        <h3>联系方式</h3>
        <div class="contact-list">
          <div v-if="user.contact_qq" class="contact-item">
            <span class="contact-label">QQ</span>
            <span>{{ user.contact_qq }}</span>
          </div>
          <div v-if="user.contact_wechat" class="contact-item">
            <span class="contact-label">微信</span>
            <span>{{ user.contact_wechat }}</span>
          </div>
          <div v-if="user.contact_weibo" class="contact-item">
            <span class="contact-label">微博</span>
            <span>{{ user.contact_weibo }}</span>
          </div>
          <div v-if="user.contact_bilibili" class="contact-item">
            <span class="contact-label">B站</span>
            <span>{{ user.contact_bilibili }}</span>
          </div>
        </div>
      </div>

      <div class="profile-actions">
        <button
          v-if="userStore.isLoggedIn && userStore.user?.id !== user.id"
          class="btn btn-primary"
          :disabled="friendPending || addingFriend"
          @click="addFriend"
        >
          {{ addingFriend ? '发送中…' : friendPending ? '已发送请求' : '添加好友' }}
        </button>
        <button class="btn btn-secondary" @click="router.push('/')">返回首页</button>
      </div>
    </div>
  </div>

  <div v-else class="empty-state" :role="loadError ? 'alert' : 'status'" :aria-busy="loading">
    <p>{{ loadError || '正在加载用户资料…' }}</p>
    <button v-if="loadError" class="btn btn-primary" @click="loadUser">重新加载</button>
    <router-link v-if="loadError" class="btn btn-secondary" to="/">返回首页</router-link>
  </div>
</template>

<style scoped>
.profile-view { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.profile-card { padding: 28px; }

.profile-header {
  display: flex;
  gap: 20px;
  margin-bottom: 20px;
}

.avatar-wrapper { flex-shrink: 0; }

.avatar-lg {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 700;
  color: #fff;
}

.profile-info h2 { font-size: 22px; margin-bottom: 4px; }
.profile-tags { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

.tag {
  padding: 3px 10px;
  border-radius: var(--radius-xl);
  font-size: 12px;
  background: rgba(169, 155, 134, 0.2);
  color: #d4c5b0;
}

.profile-bio {
  padding: 14px 16px;
  background: rgba(255,255,255,0.05);
  border-radius: var(--radius-md);
  margin-bottom: 20px;
}

.profile-bio p {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.profile-stats {
  display: flex;
  gap: 32px;
  margin-bottom: 20px;
  padding: 16px 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  border-bottom: 1px solid rgba(255,255,255,0.08);
}

.stat { text-align: center; }
.stat-value { display: block; font-size: 24px; font-weight: 700; }
.stat-label { font-size: 13px; color: var(--text-muted); }

.contact-section {
  margin-bottom: 20px;
}

.contact-section h3 {
  font-size: 16px;
  margin-bottom: 12px;
}

.contact-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.contact-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(255,255,255,0.05);
  border-radius: var(--radius-md);
}

.contact-label {
  font-size: 13px;
  font-weight: 600;
  color: #c9b99a;
  width: 40px;
}

.profile-actions {
  display: flex;
  gap: 12px;
}
.profile-view { max-width: 45rem; margin-inline: auto; }
.profile-card { border-top: 3px solid var(--accent-1); padding: clamp(1.25rem, 4vw, 2rem); }
.profile-info { min-width: 0; overflow-wrap: anywhere; }
.profile-info h1 { font-size: 1.65rem; line-height: 1.35; letter-spacing: -.025em; }
.avatar-lg, .avatar-placeholder { border-radius: var(--radius-lg); }
.tag { color: var(--text-link); background: var(--accent-soft); }
.contact-label { color: var(--text-secondary); flex-shrink: 0; }
.contact-item, .profile-bio p { overflow-wrap: anywhere; }
.profile-actions { flex-wrap: wrap; }
@media (max-width: 400px) { .profile-header { gap: 1rem; } .avatar-lg, .avatar-placeholder { width: 4rem; height: 4rem; } }
@media (prefers-reduced-motion: reduce) { .profile-view { animation: none; } }
</style>
