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
const mineLoading = ref(true)
const joining = ref(new Set())
let discoverVersion = 0

// 建墙申请
const showApply = ref(false)
const applyName = ref('')
const applyDesc = ref('')
const applyLoading = ref(false)

const myWalls = computed(() => wallStore.myWalls)

async function loadDiscover() {
  const version = ++discoverVersion
  err.value = ''
  loading.value = true
  try {
    const res = await api.get('/walls/discover', { params: { q: q.value } })
    if (version !== discoverVersion) return
    discover.value = res.data
  } catch (e) {
    if (version === discoverVersion) err.value = e.response?.data?.error || '加载失败'
  } finally {
    if (version === discoverVersion) loading.value = false
  }
}

async function enterWall(id) {
  if (!myWalls.value.some(w => Number(w.id) === Number(id))) { err.value = '你尚未加入该校园墙'; return }
  wallStore.switchWall(id)
  router.push('/')
}

async function joinWall(w) {
  if (joining.value.has(w.id) || w.my_status === 'active' || w.my_status === 'pending') return
  joining.value.add(w.id)
  msg.value = ''; err.value = ''
  try {
    const res = await api.post(`/walls/${w.id}/join`)
    msg.value = res.data.message
    await wallStore.fetchMyWalls()
    await loadDiscover()
    if (res.data.status === 'active' && myWalls.value.some(item => Number(item.id) === Number(w.id))) {
      wallStore.switchWall(w.id)
    }
  } catch (e) {
    err.value = e.response?.data?.error || '操作失败'
  } finally { joining.value.delete(w.id) }
}

async function submitApply() {
  if (applyLoading.value) return
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

onMounted(async () => {
  try { await wallStore.fetchMyWalls() } finally { mineLoading.value = false }
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

    <div v-if="msg" class="ok-msg" role="status">{{ msg }}</div>
    <div v-if="err" class="error-msg" role="alert">{{ err }}</div>

    <!-- 我加入的 -->
    <div v-if="tab === 'mine'">
      <p v-if="mineLoading" class="loading" role="status">正在加载校园墙…</p>
      <div v-else-if="myWalls.length === 0" class="empty glass">
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
        <input aria-label="搜索校园墙名称" v-model="q" placeholder="搜索校园墙名称" @keyup.enter="loadDiscover" />
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
            <button v-else class="btn btn-primary btn-sm" :disabled="joining.has(w.id)" @click="joinWall(w)">
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
        <label for="wall-apply-name">学校/校园墙名称</label>
        <input id="wall-apply-name" maxlength="50" v-model="applyName" placeholder="如：XX中学校园墙" />
      </div>
      <div class="form-group">
        <label for="wall-apply-description">简介（可选）</label>
        <input id="wall-apply-description" maxlength="500" v-model="applyDesc" placeholder="一句话介绍" />
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
  padding: 10px; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.875rem;
}
.tabs button.active { background: color-mix(in srgb, var(--accent-1) 30%, transparent); color: #fff; }
.wall-card {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px; border-radius: var(--radius-md); margin-bottom: 10px; gap: 12px;
}
.wall-info { flex: 1; min-width: 0; }
.wall-info strong { font-size: 1rem; }
.wall-info p { font-size: 0.8125rem; margin-top: 4px; }
.wall-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.role-tag { font-size: 0.6875rem; padding: 2px 8px; border-radius: var(--radius-md); margin-left: 8px; }
.r-owner { background: rgba(255,215,0,0.2); color: var(--warning); }
.r-admin { background: color-mix(in srgb, var(--accent-1) 20%, transparent); color: var(--text-link); }
.r-tree_hole { background: rgba(46,213,115,0.2); color: var(--success); }
.r-member { background: rgba(255,255,255,0.1); color: var(--text-secondary); }
.approval-tag { font-size: 0.6875rem; color: var(--danger-light); margin-left: 8px; }
.current-badge { font-size: 0.75rem; color: var(--success); }
.pending-badge { font-size: 0.75rem; color: var(--warning); }
.empty { padding: 32px; text-align: center; color: var(--text-secondary); border-radius: var(--radius-md); }
.form-inline { display: flex; gap: 8px; margin-bottom: 12px; }
.form-inline input { flex: 1; }
.apply-card { padding: 24px; border-radius: var(--radius-md); }
.apply-card h3 { margin-bottom: 8px; }
.ok-msg {
  background: rgba(46,213,115,0.2); border: 1px solid rgba(46,213,115,0.3);
  color: var(--success); padding: 10px 14px; border-radius: var(--radius-sm); font-size: 0.875rem; margin-bottom: 12px;
}
.error-msg {
  background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3);
  color: var(--danger-light); padding: 10px 14px; border-radius: var(--radius-sm); font-size: 0.875rem; margin-bottom: 12px;
}
.loading { text-align: center; color: var(--text-secondary); padding: 20px; }

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.tabs button.active { color: var(--text-primary); background: var(--accent-soft); font-weight: 600; }
.wall-info strong, .wall-info p { overflow-wrap: anywhere; }
.form-inline input { min-width: 0; }
@media (max-width: 480px) { .wall-select { padding: 0; } .header-card, .apply-card { padding: 20px 16px; } .wall-card { align-items: flex-start; flex-wrap: wrap; } .wall-actions { margin-left: auto; } .tabs button { padding: 10px 6px; } }
</style>
