<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'

const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()

const tab = ref('mine')
const discover = ref([])
const loading = ref(false)
const q = ref('')
const msg = ref('')
const err = ref('')

// 建墙申请
const showApply = ref(false)
const applyName = ref('')
const applyDesc = ref('')
const applyLoading = ref(false)

const myWalls = computed(() => wallStore.myWalls)

async function loadDiscover() {
  loading.value = true
  try {
    const res = await api.get('/walls/discover', { params: { q: q.value } })
    discover.value = res.data
  } catch (e) {
    err.value = e.response?.data?.error || '加载失败'
  } finally {
    loading.value = false
  }
}

async function enterWall(id) {
  wallStore.switchWall(id)
  router.push('/')
}

async function joinWall(w) {
  msg.value = ''; err.value = ''
  try {
    const res = await api.post(`/walls/${w.id}/join`)
    msg.value = res.data.message
    await wallStore.fetchMyWalls()
    await loadDiscover()
    if (res.data.status === 'active') {
      wallStore.switchWall(w.id)
    }
  } catch (e) {
    err.value = e.response?.data?.error || '操作失败'
  }
}

async function submitApply() {
  if (!applyName.value || applyName.value.trim().length < 2) {
    err.value = '请填写名称（至少2字）'
    return
  }
  applyLoading.value = true
  msg.value = ''; err.value = ''
  try {
    const res = await api.post('/walls/apply-create', { wall_name: applyName.value.trim(), description: applyDesc.value.trim() })
    msg.value = res.data.message
    applyName.value = ''; applyDesc.value = ''
    showApply.value = false
  } catch (e) {
    err.value = e.response?.data?.error || '申请失败'
  } finally {
    applyLoading.value = false
  }
}

function switchTab(t) {
  tab.value = t
  msg.value = ''; err.value = ''
  if (t === 'discover' && discover.value.length === 0) loadDiscover()
}

onMounted(() => {
  wallStore.fetchMyWalls()
})
</script>

<template>
  <div class="wall-select">
    <div class="glass-strong header-card">
      <h2>我的校园墙</h2>
      <p class="text-muted">每个校园墙相互独立、信息互不串通。你可以加入多个校园墙并随时切换。</p>
    </div>

    <div class="tabs glass">
      <button :class="{ active: tab === 'mine' }" @click="switchTab('mine')">我加入的</button>
      <button :class="{ active: tab === 'discover' }" @click="switchTab('discover')">发现校园墙</button>
      <button :class="{ active: tab === 'apply' }" @click="switchTab('apply'); showApply = true">申请建墙</button>
    </div>

    <div v-if="msg" class="ok-msg">{{ msg }}</div>
    <div v-if="err" class="error-msg">{{ err }}</div>

    <!-- 我加入的 -->
    <div v-if="tab === 'mine'">
      <div v-if="myWalls.length === 0" class="empty glass">
        你还没有加入任何校园墙。去「发现校园墙」加入一个吧！
      </div>
      <div v-for="w in myWalls" :key="w.id" class="wall-card glass">
        <div class="wall-info">
          <strong>{{ w.name }}</strong>
          <span class="role-tag" :class="'r-' + w.wall_role">{{ ({owner:'墙主',admin:'墙管理员',tree_hole:'树洞志愿者',member:'成员'})[w.wall_role] }}</span>
          <p class="text-muted">{{ w.description || '暂无简介' }}</p>
        </div>
        <div class="wall-actions">
          <span v-if="wallStore.currentWallId === w.id" class="current-badge">当前</span>
          <button class="btn btn-primary btn-sm" @click="enterWall(w.id)">进入</button>
        </div>
      </div>
    </div>

    <!-- 发现 -->
    <div v-else-if="tab === 'discover'">
      <div class="form-inline">
        <input v-model="q" placeholder="搜索校园墙名称" @keyup.enter="loadDiscover" />
        <button class="btn btn-secondary btn-sm" @click="loadDiscover">搜索</button>
      </div>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else>
        <div v-if="discover.length === 0" class="empty glass">暂无可加入的校园墙</div>
        <div v-for="w in discover" :key="w.id" class="wall-card glass">
          <div class="wall-info">
            <strong>{{ w.name }}</strong>
            <span class="text-muted">· {{ w.member_count }} 人</span>
            <span v-if="w.require_join_approval" class="approval-tag">需审批</span>
            <p class="text-muted">{{ w.description || '暂无简介' }}</p>
          </div>
          <div class="wall-actions">
            <span v-if="w.my_status === 'active'" class="current-badge">已加入</span>
            <span v-else-if="w.my_status === 'pending'" class="pending-badge">待审批</span>
            <button v-else class="btn btn-primary btn-sm" @click="joinWall(w)">
              {{ w.require_join_approval ? '申请加入' : '加入' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 申请建墙 -->
    <div v-else-if="tab === 'apply'" class="glass apply-card">
      <h3>申请创建新的校园墙</h3>
      <p class="text-muted" style="margin-bottom:12px">申请将发送给超级管理员审批，通过后你将成为该墙的墙主。</p>
      <div class="form-group">
        <label>学校/校园墙名称</label>
        <input v-model="applyName" placeholder="如：XX中学校园墙" />
      </div>
      <div class="form-group">
        <label>简介（可选）</label>
        <input v-model="applyDesc" placeholder="一句话介绍" />
      </div>
      <button class="btn btn-primary" :disabled="applyLoading" @click="submitApply">
        {{ applyLoading ? '提交中...' : '提交建墙申请' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wall-select { max-width: 720px; margin: 0 auto; padding: 16px; }
.header-card { padding: 24px; margin-bottom: 16px; }
.header-card h2 { margin-bottom: 6px; }
.tabs { display: flex; gap: 4px; padding: 6px; border-radius: var(--radius-md); margin-bottom: 16px; }
.tabs button {
  flex: 1; background: none; border: none; color: var(--text-secondary);
  padding: 10px; border-radius: var(--radius-sm); cursor: pointer; font-size: 14px;
}
.tabs button.active { background: color-mix(in srgb, var(--accent-1) 30%, transparent); color: #fff; }
.wall-card {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px; border-radius: var(--radius-md); margin-bottom: 10px; gap: 12px;
}
.wall-info { flex: 1; min-width: 0; }
.wall-info strong { font-size: 16px; }
.wall-info p { font-size: 13px; margin-top: 4px; }
.wall-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.role-tag { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-md); margin-left: 8px; }
.r-owner { background: rgba(255,215,0,0.2); color: #ffd700; }
.r-admin { background: color-mix(in srgb, var(--accent-1) 20%, transparent); color: #a8b8ff; }
.r-tree_hole { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.r-member { background: rgba(255,255,255,0.1); color: var(--text-secondary); }
.approval-tag { font-size: 11px; color: #ffb8b8; margin-left: 8px; }
.current-badge { font-size: 12px; color: #b8ffb8; }
.pending-badge { font-size: 12px; color: #ffd98a; }
.empty { padding: 32px; text-align: center; color: var(--text-secondary); border-radius: var(--radius-md); }
.form-inline { display: flex; gap: 8px; margin-bottom: 12px; }
.form-inline input { flex: 1; }
.apply-card { padding: 24px; border-radius: var(--radius-md); }
.apply-card h3 { margin-bottom: 8px; }
.ok-msg {
  background: rgba(46,213,115,0.2); border: 1px solid rgba(46,213,115,0.3);
  color: #b8ffb8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 12px;
}
.error-msg {
  background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3);
  color: #ffb8b8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 12px;
}
.loading { text-align: center; color: var(--text-secondary); padding: 20px; }
</style>
