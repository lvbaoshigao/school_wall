<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const toast = useToast()

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const nickname = ref('')
const realName = ref('')
const loading = ref(false)
const success = ref(false)
const successMsg = ref('')

async function handleRegister() {
  if (!username.value || !password.value) { toast.error('请填写用户名和密码'); return }
  if (password.value !== confirmPassword.value) { toast.error('两次密码输入不一致'); return }
  if (password.value.length < 6) { toast.error('密码至少6个字符'); return }

  loading.value = true
  try {
    await userStore.register(username.value, password.value, nickname.value || username.value, realName.value)
    await wallStore.fetchMyWalls()
    success.value = true
    successMsg.value = '注册成功！接下来请选择或加入一个校园墙'
    toast.success('注册成功！')
    setTimeout(() => router.push('/walls'), 1000)
  } catch (e) {
    toast.error(e.response?.data?.error || '注册失败')
  } finally { loading.value = false }
}
</script>

<template>
  <div class="auth-page">
    <div v-if="success" class="auth-card glass-strong success-card">
      <div class="success-icon"><Icon name="check-circle" :size="40" /></div>
      <h2>注册成功！</h2>
      <p class="text-muted">{{ successMsg }}</p>
      <button class="btn btn-primary mt-3" @click="router.push('/walls')">选择校园墙</button>
    </div>

    <div v-else class="auth-card glass-strong">
      <h2>注册</h2>
      <p class="text-muted mb-3">加入校园墙</p>

      <div class="form-group"><label>用户名</label><input v-model="username" placeholder="3-20个字符" @keyup.enter="handleRegister" /></div>
      <div class="form-group"><label>昵称</label><input v-model="nickname" placeholder="你的昵称" /></div>
      <div class="form-group"><label>真实姓名 <span class="text-muted">(用于表白信搜索)</span></label><input v-model="realName" placeholder="你的真实姓名" /></div>
      <div class="form-group"><label>密码</label><input v-model="password" type="password" placeholder="至少6个字符" /></div>
      <div class="form-group"><label>确认密码</label><input v-model="confirmPassword" type="password" placeholder="再次输入密码" @keyup.enter="handleRegister" /></div>

      <button class="btn btn-primary" style="width:100%" :disabled="loading" @click="handleRegister">
        {{ loading ? '注册中...' : '注册' }}
      </button>

      <p class="text-center mt-2">
        <span class="text-muted">已有账号？</span>
        <router-link to="/login">去登录</router-link>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page { display: flex; justify-content: center; align-items: center; min-height: calc(100vh - 120px); animation: fadeIn 0.5s ease; }
.auth-card { width: 100%; max-width: 400px; padding: 32px; }
.auth-card h2 { font-size: 24px; margin-bottom: 4px; }
.success-card { text-align: center; padding: 48px 32px; }
.success-icon { display: flex; justify-content: center; color: var(--success-light, #7bed9f); margin-bottom: 16px; }
</style>
