<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useSettingsStore } from '../stores/settings'
import { resetSetupCheck, safeLoginRedirect } from '../router'
import { useToast } from '../composables/useToast'
import api, { getApiErrorMessage, getUsernameError, getPasswordError } from '../api'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const toast = useToast()
const checkingSetup = ref(true)
const needsSetup = ref(false)
const setupError = ref('')
const error = ref('')
const fieldErrors = ref({})
const formElement = ref(null)
const username = ref('')
const password = ref('')
const loading = ref(false)
const setupForm = ref({ username: '', password: '', nickname: '', wall_name: '', wall_description: '' })
const setupLoading = ref(false)

async function checkSetup() {
  checkingSetup.value = true
  setupError.value = ''
  try { needsSetup.value = !(await api.get('/setup/status')).data.initialized }
  catch (e) { setupError.value = getApiErrorMessage(e, '无法检查系统状态，请重试') }
  finally { checkingSetup.value = false }
}

async function focusError() {
  await nextTick()
  formElement.value?.querySelector('[aria-invalid="true"]')?.focus()
}

async function finishLogin() {
  await Promise.all([wallStore.fetchMyWalls(), settingsStore.loadSettings()])
  const fallback = wallStore.hasWall ? '/' : '/walls'
  await router.replace(safeLoginRedirect(route.query.redirect, fallback))
}

async function handleSetup() {
  if (setupLoading.value) return
  const f = setupForm.value
  fieldErrors.value = { username: getUsernameError(f.username), password: getPasswordError(f.password),
    wall_name: f.wall_name.trim().length < 2 || f.wall_name.trim().length > 30 ? '校园墙名称需要 2–30 个字符' : '' }
  if (Object.values(fieldErrors.value).some(Boolean)) { await focusError(); return }
  setupLoading.value = true
  error.value = ''
  try {
    const res = await api.post('/setup', { ...f, username: f.username.trim(), nickname: f.nickname.trim(), wall_name: f.wall_name.trim(), wall_description: f.wall_description.trim() })
    userStore.acceptSession(res.data)
    wallStore.setCurrentWall(res.data.wall.id)
    await userStore.fetchPermissions()
    resetSetupCheck()
    await finishLogin()
    toast.success('首次设置已完成')
  } catch (e) { error.value = getApiErrorMessage(e, '初始化失败，请重试') }
  finally { setupLoading.value = false }
}

async function handleLogin() {
  if (loading.value) return
  fieldErrors.value = { username: getUsernameError(username.value), password: getPasswordError(password.value, { login: true }) }
  if (Object.values(fieldErrors.value).some(Boolean)) { await focusError(); return }
  loading.value = true
  error.value = ''
  try { await userStore.login(username.value, password.value); await finishLogin() }
  catch (e) { error.value = getApiErrorMessage(e, '登录失败，请重试') }
  finally { loading.value = false }
}

onMounted(checkSetup)
</script>

<template>
  <section class="auth-page" aria-labelledby="auth-title">
    <div v-if="checkingSetup" class="auth-card glass-strong" role="status" aria-busy="true"><p>正在检查系统状态…</p></div>
    <div v-else class="auth-card glass-strong" :class="{ 'setup-card': needsSetup }">
      <p class="auth-eyebrow">校园墙 · 账户</p>
      <h1 id="auth-title">{{ needsSetup ? '从这里，开启校园社区' : '欢迎回来' }}</h1>
      <p class="auth-intro text-muted">{{ needsSetup ? '创建管理员账号与第一个校园墙。' : '登录后，继续看看校园里的新鲜事。' }}</p>
      <div v-if="setupError" class="form-notice" role="alert">{{ setupError }} <button type="button" class="text-action" @click="checkSetup">重新检查</button></div>
      <p v-if="error" class="form-notice" role="alert">{{ error }}</p>
      <form v-if="needsSetup" ref="formElement" novalidate :aria-busy="setupLoading" @submit.prevent="handleSetup">
        <fieldset :disabled="setupLoading">
          <legend>超级管理员账号</legend>
          <div class="form-group"><label for="setup-username">用户名</label><input id="setup-username" v-model="setupForm.username" autocomplete="username" maxlength="20" required :aria-invalid="!!fieldErrors.username" aria-describedby="setup-username-help" /><p id="setup-username-help" class="field-help" :class="{ 'field-error': fieldErrors.username }">{{ fieldErrors.username || '3–20 个字符，登录时使用' }}</p></div>
          <div class="form-group"><label for="setup-nickname">昵称（可选）</label><input id="setup-nickname" v-model="setupForm.nickname" autocomplete="nickname" maxlength="30" /></div>
          <div class="form-group"><label for="setup-password">密码</label><input id="setup-password" v-model="setupForm.password" type="password" autocomplete="new-password" maxlength="1024" required :aria-invalid="!!fieldErrors.password" aria-describedby="setup-password-help" /><p id="setup-password-help" class="field-help" :class="{ 'field-error': fieldErrors.password }">{{ fieldErrors.password || '至少 6 个字符，支持粘贴与密码管理器' }}</p></div>
        </fieldset>
        <fieldset :disabled="setupLoading">
          <legend>第一个校园墙</legend>
          <div class="form-group"><label for="setup-wall">校园墙名称</label><input id="setup-wall" v-model="setupForm.wall_name" maxlength="30" required :aria-invalid="!!fieldErrors.wall_name" aria-describedby="setup-wall-error" /><p v-if="fieldErrors.wall_name" id="setup-wall-error" class="field-help field-error">{{ fieldErrors.wall_name }}</p></div>
          <div class="form-group"><label for="setup-description">简介（可选）</label><textarea id="setup-description" v-model="setupForm.wall_description" maxlength="500" rows="2"></textarea></div>
        </fieldset>
        <button type="submit" class="btn btn-primary auth-submit" :disabled="setupLoading">{{ setupLoading ? '正在创建…' : '完成设置并进入' }}</button>
        <p class="auth-footnote text-muted">你将成为超级管理员和第一个校园墙的墙主。</p>
      </form>
      <form v-else ref="formElement" novalidate :aria-busy="loading" @submit.prevent="handleLogin">
        <div class="form-group"><label for="login-username">用户名</label><input id="login-username" v-model="username" name="username" autocomplete="username" autocapitalize="none" :spellcheck="false" maxlength="20" required :aria-invalid="!!fieldErrors.username" aria-describedby="login-username-error" /><p v-if="fieldErrors.username" id="login-username-error" class="field-help field-error">{{ fieldErrors.username }}</p></div>
        <div class="form-group"><label for="login-password">密码</label><input id="login-password" v-model="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required :aria-invalid="!!fieldErrors.password" aria-describedby="login-password-error" /><p v-if="fieldErrors.password" id="login-password-error" class="field-help field-error">{{ fieldErrors.password }}</p></div>
        <button type="submit" class="btn btn-primary auth-submit" :disabled="loading">{{ loading ? '正在登录…' : '登录' }}</button>
        <p class="auth-footer"><span class="text-muted">还没有账号？</span> <router-link :to="{ path: '/register', query: route.query.redirect ? { redirect: route.query.redirect } : {} }">创建账号</router-link></p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.auth-page { display: grid; place-items: center; min-height: calc(100dvh - 10rem); padding: 1.5rem 0 3rem; }
.auth-card { width: 100%; max-width: 28rem; padding: clamp(1.25rem, 4vw, 2.5rem); border-top: 3px solid var(--accent-1); }
.setup-card { max-width: 32rem; }
.auth-eyebrow { color: var(--text-link); font-size: .8rem; font-weight: 600; letter-spacing: .06em; margin-bottom: .65rem; }
h1 { font-size: clamp(1.65rem, 4vw, 2rem); line-height: 1.3; letter-spacing: -.03em; text-wrap: balance; }
.auth-intro { margin: .6rem 0 1.8rem; line-height: 1.7; }
fieldset { border: 0; min-width: 0; padding: 0; margin: 0 0 1.25rem; }
legend { font-weight: 600; margin-bottom: 1rem; }
label { font-weight: 500; }
.field-help { font-size: .8rem; line-height: 1.6; margin-top: .4rem; color: var(--text-muted); }
.field-error { color: var(--danger-light); }
.form-notice { padding: .8rem 1rem; margin-bottom: 1rem; border-radius: var(--radius-sm); background: var(--bg-input); border-left: 3px solid var(--danger); line-height: 1.7; }
.auth-submit { width: 100%; min-height: 2.9rem; margin-top: .4rem; }
.auth-footer { text-align: center; margin-top: 1.5rem; }
.auth-footnote { text-align: center; font-size: .8rem; line-height: 1.6; margin-top: 1rem; }
.text-action { color: var(--text-link); background: none; border: 0; min-height: 2.75rem; padding: .4rem; text-decoration: underline; cursor: pointer; }
</style>
