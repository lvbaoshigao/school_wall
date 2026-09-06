<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import SkeletonCard from '../components/SkeletonCard.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()

// 一个组件承载两种模式，由路由决定，切换标签走 router 而不是内部状态，
// 这样「搜索好友 / 发现好友」各自有独立可回退的地址
const mode = computed(() => (route.path.endsWith('/discover') ? 'discover' : 'search'))

const query = ref('')
const results = ref([])
const searched = ref(false)
const loading = ref(false)
const discoverList = ref([])
const discoverLoading = ref(false)
// 已发过请求的用户：按钮就地变为「已发送」，避免重复点击
const requested = ref(new Set())

async function doSearch() {
  const q = query.value.trim()
  if (!q) { toast.info('请输入 ID、账号、昵称或真实姓名'); return }
  loading.value = true
  searched.value = true
  try {
    const res = await api.get(`/users/search?q=${encodeURIComponent(q)}`)
    results.value = res.data
  } catch (e) {
    toast.error(e.response?.data?.error || '搜索失败')
  } finally {
    loading.value = false
  }
}

async function loadDiscover() {
  discoverLoading.value = true
  try {
    const res = await api.get('/users/discover')
    discoverList.value = res.data
  } catch (e) {
    toast.error(e.response?.data?.error || '加载失败')
  } finally {
    discoverLoading.value = false
  }
}

async function addFriend(user) {
  try {
    const res = await api.post('/friends/add', { friend_id: user.id })
    requested.value = new Set([...requested.value, user.id])
    toast.success(res.data.message || '好友请求已发送')
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

function openProfile(userId) {
  router.push(`/user/${userId}`)
}

function switchMode(next) {
  if (next === mode.value) return
  router.push(next === 'discover' ? '/friends/discover' : '/friends/search')
}

watch(mode, (m) => {
  if (m === 'discover' && discoverList.value.length === 0) loadDiscover()
}, { immediate: false })

onMounted(() => {
  const q = (route.query.q || '').trim()
  if (mode.value === 'discover') loadDiscover()
  else if (q) { query.value = q; doSearch() }
})
</script>

<template>
  <div class="find-page">
    <div class="page-head">
      <button class="back-btn" aria-label="返回聊天" @click="router.push('/chat')">
        <Icon name="chevron-left" :size="18" />
        返回聊天
      </button>
      <h2>{{ mode === 'discover' ? '发现好友' : '搜索好友' }}</h2>
    </div>

    <div class="mode-tabs glass" role="tablist">
      <button class="mode-tab" role="tab" :aria-selected="mode === 'search'"
              :class="{ active: mode === 'search' }" @click="switchMode('search')">
        <Icon name="search" :size="15" />搜索好友
      </button>
      <button class="mode-tab" role="tab" :aria-selected="mode === 'discover'"
              :class="{ active: mode === 'discover' }" @click="switchMode('discover')">
        <Icon name="compass" :size="15" />发现好友
      </button>
    </div>

    <!-- 搜索模式 -->
    <template v-if="mode === 'search'">
      <div class="panel glass">
        <div class="find-form">
          <input v-model="query" aria-label="搜索好友"
                 placeholder="输入 ID、@账号、昵称或真实姓名" @keyup.enter="doSearch" />
          <button class="btn btn-primary" :disabled="loading" @click="doSearch">
            {{ loading ? '搜索中…' : '搜索' }}
          </button>
        </div>
        <p class="tip text-muted">对方若在设置中关闭了对应搜索方式，将无法被搜到</p>
      </div>

      <div v-if="loading" class="skeleton-wrap" aria-busy="true" aria-label="正在搜索">
        <SkeletonCard v-for="i in 3" :key="i" :lines="1" />
      </div>

      <template v-else-if="searched">
        <div v-if="results.length === 0" class="empty-state">
          <div class="icon"><Icon name="search" :size="34" /></div>
          <p>没有找到匹配的用户</p>
          <span class="text-muted">换个关键词试试，或直接用对方的 ID 搜索</span>
        </div>
        <div v-else class="user-cards">
          <div v-for="u in results" :key="u.id" class="user-card glass" role="link" tabindex="0"
               :aria-label="`查看 ${u.nickname || u.username} 的主页`"
               @click="openProfile(u.id)" @keydown.enter="openProfile(u.id)" @keydown.space.prevent="openProfile(u.id)">
            <div class="user-avatar">
              <img v-if="u.avatar" :src="u.avatar" alt="" class="avatar-img" />
              <span v-else>{{ (u.nickname || u.username || '?')[0] }}</span>
            </div>
            <div class="user-meta">
              <span class="user-name">{{ u.nickname || u.username }}</span>
              <span class="user-sub text-muted">@{{ u.username }} · ID {{ u.id }}</span>
            </div>
            <button class="btn btn-secondary btn-sm" :disabled="requested.has(u.id)"
                    :aria-label="`添加 ${u.nickname || u.username} 为好友`" @click.stop="addFriend(u)">
              {{ requested.has(u.id) ? '已发送' : '加好友' }}
            </button>
          </div>
        </div>
      </template>

      <div v-else class="empty-state">
        <div class="icon"><Icon name="users" :size="34" /></div>
        <p>找到你想认识的同学</p>
        <span class="text-muted">支持用 ID、@账号、昵称或真实姓名搜索</span>
      </div>
    </template>

    <!-- 发现模式 -->
    <template v-else>
      <p class="tip text-muted panel-tip">本校园墙中允许被发现的同学</p>

      <div v-if="discoverLoading" class="skeleton-wrap" aria-busy="true" aria-label="正在加载">
        <SkeletonCard v-for="i in 4" :key="i" :lines="1" />
      </div>

      <div v-else-if="discoverList.length === 0" class="empty-state">
        <div class="icon"><Icon name="compass" :size="34" /></div>
        <p>暂无可发现的用户</p>
        <span class="text-muted">同学们需要在设置中开启「允许将我公布到发现好友」</span>
      </div>

      <div v-else class="user-cards">
        <div v-for="u in discoverList" :key="u.id" class="user-card glass" role="link" tabindex="0"
             :aria-label="`查看 ${u.nickname || u.username} 的主页`"
             @click="openProfile(u.id)" @keydown.enter="openProfile(u.id)" @keydown.space.prevent="openProfile(u.id)">
          <div class="user-avatar">
            <img v-if="u.avatar" :src="u.avatar" alt="" class="avatar-img" />
            <span v-else>{{ (u.nickname || u.username || '?')[0] }}</span>
          </div>
          <div class="user-meta">
            <span class="user-name">{{ u.nickname || u.username }}</span>
            <span class="user-sub text-muted">@{{ u.username }} · ID {{ u.id }}</span>
          </div>
          <button class="btn btn-secondary btn-sm" :disabled="requested.has(u.id)"
                  :aria-label="`添加 ${u.nickname || u.username} 为好友`" @click.stop="addFriend(u)">
            {{ requested.has(u.id) ? '已发送' : '加好友' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.find-page { animation: fadeIn 0.4s ease; }

.page-head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
.page-head h2 { font-size: 22px; }

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.back-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }

.mode-tabs {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-1);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-4);
}
.mode-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  padding: 10px;
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.mode-tab:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.mode-tab.active { background: color-mix(in srgb, var(--accent-1) 22%, transparent); color: var(--text-primary); font-weight: 600; }

.panel { padding: var(--space-4); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
.find-form { display: flex; gap: var(--space-2); }
.find-form input { flex: 1; }
.tip { font-size: 12px; margin-top: var(--space-2); }
.panel-tip { margin: 0 0 var(--space-3); }

.skeleton-wrap { display: flex; flex-direction: column; gap: var(--space-3); }

.user-cards { display: flex; flex-direction: column; gap: var(--space-2); }
.user-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.2s var(--ease), transform 0.2s var(--ease);
}
.user-card:hover { transform: translateY(-1px); }
.user-card:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent-1) 75%, transparent); outline-offset: -2px; }

.user-avatar {
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
.avatar-img { width: 100%; height: 100%; object-fit: cover; }

.user-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.user-name { font-weight: 600; font-size: 14px; }
.user-sub { font-size: 12px; }
</style>
