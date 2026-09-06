<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { resetSetupCheck } from '../router'
import { useToast } from '../composables/useToast'
import api from '../api'

const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const toast = useToast()

const checkingSetup = ref(true)
const needsSetup = ref(false)

const username = ref('')
const password = ref('')
const loading = ref(false)

const setupForm = ref({
  username: '', password: '', nickname: '',
  wall_name: '', wall_description: '',
})
const setupLoading = ref(false)

async function checkSetup() {
  try {
    const res = await api.get('/setup/status')
    needsSetup.value = !res.data.initialized
  } catch { needsSetup.value = false }
  finally { checkingSetup.value = false }
}

async function handleSetup() {
  const f = setupForm.value
  if (!f.username || !f.password) { toast.error('请填写管理员用户名和密码'); return }
  if (f.username.length < 3 || f.username.length > 20) { toast.error('用户名长度3-20个字符'); return }
  if (f.password.length < 6) { toast.error('密码至少6个字符'); return }
  if (!f.wall_name || f.wall_name.trim().length < 2) { toast.error('请填写校园墙名称'); return }

  setupLoading.value = true
  try {
    const res = await api.post('/setup', f)
    localStorage.setItem('token', res.data.token)
    userStore.token = res.data.token
    userStore.user = res.data.user
    wallStore.setCurrentWall(res.data.wall.id)
    await wallStore.fetchMyWalls()
    resetSetupCheck()
    router.push('/')
    toast.success('初始化完成！')
  } catch (e) {
    toast.error(e.response?.data?.error || '初始化失败')
  } finally { setupLoading.value = false }
}

async function handleLogin() {
  if (!username.value || !password.value) { toast.error('请填写用户名和密码'); return }
  loading.value = true
  try {
    await userStore.login(username.value, password.value)
    await wallStore.fetchMyWalls()
    router.push(wallStore.hasWall ? '/' : '/walls')
  } catch (e) {
    toast.error(e.response?.data?.error || '登录失败')
  } finally { loading.value = false }
}

onMounted(checkSetup)
</script>

<template>
  <div class="auth-page">
    <div v-if="checkingSetup" class="auth-card glass-strong">
      <div class="loading-text">正在检查系统状态...</div>
    </div>

    <div v-else-if="needsSetup" class="auth-card glass-strong setup-card">
      <h2>首次设置</h2>
      <p class="text-muted mb-3">欢迎使用校园墙！请创建超级管理员账号并设置第一个校园墙。</p>

      <div class="setup-section">
        <h3>超级管理员账号</h3>
        <div class="form-group"><label>用户名</label><input v-model="setupForm.username" placeholder="3-20个字符" /></div>
        <div class="form-group"><label>昵称</label><input v-model="setupForm.nickname" placeholder="显示名称（可选）" /></div>
        <div class="form-group"><label>密码</label><input v-model="setupForm.password" type="password" placeholder="至少6个字符" /></div>
      </div>

      <div class="setup-divider"></div>

      <div class="setup-section">
        <h3>第一个校园墙</h3>
        <div class="form-group"><label>校园墙名称</label><input v-model="setupForm.wall_name" placeholder="如：XX中学校园墙" /></div>
        <div class="form-group"><label>简介（可选）</label><input v-model="setupForm.wall_description" placeholder="一句话介绍" /></div>
      </div>

      <button class="btn btn-primary" style="width:100%;margin-top:8px" :disabled="setupLoading" @click="handleSetup">
        {{ setupLoading ? '初始化中...' : '完成设置并进入' }}
      </button>
      <p class="text-muted text-center" style="font-size:12px;margin-top:12px">你将成为超级管理员和第一个校园墙的墙主</p>
    </div>

    <div v-else class="auth-card glass-strong">
      <h2>登录</h2>
      <p class="text-muted mb-3">欢迎回来</p>

      <div class="form-group"><label>用户名</label><input v-model="username" placeholder="请输入用户名" @keyup.enter="handleLogin" /></div>
      <div class="form-group"><label>密码</label><input v-model="password" type="password" placeholder="请输入密码" @keyup.enter="handleLogin" /></div>

      <button class="btn btn-primary" style="width:100%" :disabled="loading" @click="handleLogin">
        {{ loading ? '登录中...' : '登录' }}
      </button>

      <p class="text-center mt-2">
        <span class="text-muted">还没有账号？</span>
        <router-link to="/register">立即注册</router-link>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page { display: flex; justify-content: center; align-items: center; min-height: calc(100vh - 120px); animation: fadeIn 0.5s ease; }
.auth-card { width: 100%; max-width: 400px; padding: 32px; }
.setup-card { max-width: 460px; }
.auth-card h2 { font-size: 24px; margin-bottom: 4px; }
.loading-text { text-align: center; color: var(--text-secondary); padding: 40px 0; }
.setup-section h3 { font-size: 15px; color: var(--text-secondary); margin-bottom: 12px; }
.setup-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 16px 0; }
</style>
