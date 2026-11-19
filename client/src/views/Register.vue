<script setup>
import { ref, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useSettingsStore } from '../stores/settings'
import { safeLoginRedirect } from '../router'
import { getApiErrorMessage, getUsernameError, getPasswordError } from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const nickname = ref('')
const realName = ref('')
const loading = ref(false)
const success = ref(false)
const error = ref('')
const fieldErrors = ref({})
const formElement = ref(null)

async function handleRegister() {
  if (loading.value) return
  fieldErrors.value = {
    username: getUsernameError(username.value), password: getPasswordError(password.value),
    confirm: password.value !== confirmPassword.value ? '两次密码不一致，请重新确认' : '',
  }
  if (Object.values(fieldErrors.value).some(Boolean)) {
    await nextTick()
    formElement.value?.querySelector('[aria-invalid="true"]')?.focus()
    return
  }
  loading.value = true
  error.value = ''
  try {
    await userStore.register(username.value, password.value, nickname.value.trim() || username.value.trim(), realName.value)
    if (userStore.isLoggedIn) await Promise.all([wallStore.fetchMyWalls(), settingsStore.loadSettings()])
    password.value = ''; confirmPassword.value = ''
    success.value = true
  } catch (e) { error.value = getApiErrorMessage(e, '注册失败，请重试') }
  finally { loading.value = false }
}

function continueAfterRegister() {
  router.replace(userStore.isLoggedIn ? safeLoginRedirect(route.query.redirect, '/walls') : '/login')
}
</script>

<template>
  <section class="auth-page" aria-labelledby="register-title">
    <div v-if="success" class="auth-card glass-strong success-card" role="status">
      <Icon name="check-circle" :size="42" class="success-icon" />
      <h1 id="register-title">账号已创建</h1>
      <p class="text-muted">{{ userStore.isLoggedIn ? '选择或加入一个校园墙，开始你的校园生活。' : '请登录后继续使用校园墙。' }}</p>
      <button type="button" class="btn btn-primary auth-submit" @click="continueAfterRegister">{{ userStore.isLoggedIn ? '继续进入校园墙' : '前往登录' }}</button>
    </div>
    <div v-else class="auth-card glass-strong">
      <p class="auth-eyebrow">校园墙 · 新同学</p>
      <h1 id="register-title">认识校园，也让校园认识你</h1>
      <p class="auth-intro text-muted">创建账号后，你可以选择加入自己的校园墙。</p>
      <p v-if="error" class="form-notice" role="alert">{{ error }}</p>
      <form ref="formElement" novalidate :aria-busy="loading" @submit.prevent="handleRegister">
        <div class="form-group"><label for="register-username">用户名</label><input id="register-username" v-model="username" name="username" autocomplete="username" autocapitalize="none" :spellcheck="false" maxlength="20" required :aria-invalid="!!fieldErrors.username" aria-describedby="register-username-help" /><p id="register-username-help" class="field-help" :class="{ 'field-error': fieldErrors.username }">{{ fieldErrors.username || '3–20 个字符，创建后不可修改' }}</p></div>
        <div class="form-group"><label for="register-nickname">昵称（可选）</label><input id="register-nickname" v-model="nickname" autocomplete="nickname" maxlength="30" aria-describedby="register-nickname-help" /><p id="register-nickname-help" class="field-help">其他同学看到的名称，最多 30 个字符。</p></div>
        <div class="form-group"><label for="register-realname">真实姓名（可选）</label><input id="register-realname" v-model="realName" autocomplete="name" maxlength="20" aria-describedby="register-realname-help" /><p id="register-realname-help" class="field-help">默认不公开，也不允许按真实姓名搜索。你可在设置中调整。</p></div>
        <div class="form-group"><label for="register-password">密码</label><input id="register-password" v-model="password" name="password" type="password" autocomplete="new-password" maxlength="1024" required :aria-invalid="!!fieldErrors.password" aria-describedby="register-password-help" /><p id="register-password-help" class="field-help" :class="{ 'field-error': fieldErrors.password }">{{ fieldErrors.password || '至少 6 个字符，支持粘贴与密码管理器' }}</p></div>
        <div class="form-group"><label for="register-confirm">确认密码</label><input id="register-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" maxlength="1024" required :aria-invalid="!!fieldErrors.confirm" aria-describedby="register-confirm-help" /><p v-if="fieldErrors.confirm" id="register-confirm-help" class="field-help field-error">{{ fieldErrors.confirm }}</p></div>
        <button type="submit" class="btn btn-primary auth-submit" :disabled="loading">{{ loading ? '正在创建账号…' : '创建账号' }}</button>
        <p class="auth-footer"><span class="text-muted">已有账号？</span> <router-link :to="{ path: '/login', query: route.query.redirect ? { redirect: route.query.redirect } : {} }">返回登录</router-link></p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.auth-page { display: grid; place-items: center; min-height: calc(100dvh - 10rem); padding: 1.5rem 0 3rem; }
.auth-card { width: 100%; max-width: 30rem; padding: clamp(1.25rem, 4vw, 2.5rem); border-top: 3px solid var(--accent-1); }
.auth-eyebrow { color: var(--text-link); font-size: .8rem; font-weight: 600; letter-spacing: .06em; margin-bottom: .65rem; }
h1 { font-size: clamp(1.65rem, 4vw, 2rem); letter-spacing: -.03em; line-height: 1.35; text-wrap: balance; }
.auth-intro { margin: .65rem 0 1.8rem; line-height: 1.7; }
label { font-weight: 500; }
.field-help { font-size: .8rem; line-height: 1.6; margin-top: .4rem; color: var(--text-muted); }
.field-error { color: var(--danger-light); }
.form-notice { background: var(--bg-input); border-left: 3px solid var(--danger); padding: .8rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1rem; line-height: 1.7; }
.auth-submit { width: 100%; min-height: 2.9rem; margin-top: .5rem; }
.auth-footer { margin-top: 1.5rem; text-align: center; }
.success-card { text-align: center; }
.success-card h1 { margin: 1rem 0 .75rem; }
.success-card p { line-height: 1.7; margin-bottom: 1.25rem; }
.success-icon { color: var(--text-link); }
</style>
