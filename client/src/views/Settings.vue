<script setup>
import { ref, inject, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsStore, NAV_ITEMS, PREFERENCE_GROUPS, parsePreferenceImport } from '../stores/settings'
import { useWallStore } from '../stores/wall'
import { useUserStore } from '../stores/user'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import SettingControl from '../components/settings/SettingControl.vue'
import { SETTINGS_SECTIONS, buildSettingsCatalog, resolveSettingsSection, searchSettings } from '../components/settings/catalog'
import api, { getApiErrorMessage, writeStorage } from '../api'

const router = useRouter()
const route = useRoute()
const settingsStore = useSettingsStore()
const wallStore = useWallStore()
const userStore = useUserStore()
const toast = useToast()
const theme = inject('theme', { current: ref('light') })
const resolvedTheme = computed(() => theme.current?.value === 'dark' ? '暗色' : '亮色')
const catalog = buildSettingsCatalog(NAV_ITEMS)
const activeSection = ref(resolveSettingsSection(route.query.section, route.hash))
const search = ref(typeof route.query.q === 'string' ? route.query.q.slice(0, 80) : '')
const searchInput = ref(null)
const pageTop = ref(null)
const sectionHeading = ref(null)
const fileInput = ref(null)
const privacySaving = ref(false)
const accountStatus = ref('idle')
const accountError = ref('')
const actionError = ref('')
const actionBusy = ref('')
const retryOperation = ref(null)
const currentSection = computed(() => SETTINGS_SECTIONS.find(section => section.id === activeSection.value) || SETTINGS_SECTIONS[0])
const isSearching = computed(() => !!search.value.trim())
const results = computed(() => searchSettings(catalog, search.value))
const resultCount = computed(() => results.value.length)
const visibleGroups = computed(() => SETTINGS_SECTIONS.map(section => ({ ...section, items: results.value.filter(item => item.section === section.id) })).filter(section => section.items.length && (isSearching.value || section.id === activeSection.value)))
const busy = computed(() => settingsStore.saving || settingsStore.loading || privacySaving.value)
const errorMessage = computed(() => actionError.value || accountError.value || settingsStore.saveError)
const saveState = computed(() => busy.value ? 'saving' : errorMessage.value ? 'error' : accountStatus.value === 'saved' || settingsStore.saveStatus === 'saved' ? 'saved' : 'idle')
const saveText = computed(() => saveState.value === 'saving' ? settingsStore.loading ? '正在同步…' : '正在保存…' : saveState.value === 'saved' ? '已保存到账号' : saveState.value === 'error' ? '未能保存' : '更改后自动保存')
const unfindable = computed(() => userStore.user && ['allow_search_by_id', 'allow_search_by_username', 'allow_search_by_nickname', 'allow_search_by_real_name'].every(key => !privacyValue(key)))
const visitStats = ref(null)
let visitTimer = null

watch(() => [route.query.section, route.hash], () => { activeSection.value = resolveSettingsSection(route.query.section, route.hash) })
watch(() => route.query.q, value => { search.value = typeof value === 'string' ? value.slice(0, 80) : '' })
watch(() => userStore.sessionRevision, () => { retryOperation.value = null; actionError.value = ''; accountError.value = ''; accountStatus.value = 'idle'; pendingImport.value = null; confirmation.value = null })

function sectionCount(id) { return results.value.filter(item => item.section === id).length }
async function chooseSection(id) {
  if (!SETTINGS_SECTIONS.some(section => section.id === id)) return
  activeSection.value = id
  search.value = ''
  await router.replace({ query: { ...route.query, section: id, q: undefined }, hash: '' })
  await nextTick()
  sectionHeading.value?.focus({ preventScroll: true })
}
function clearSearch() {
  search.value = ''
  if (route.query.q !== undefined) router.replace({ query: { ...route.query, q: undefined } })
  nextTick(() => searchInput.value?.focus())
}
function backToTop() {
  pageTop.value?.scrollIntoView({ block: 'start', behavior: settingsStore.prefs.reduce_motion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  pageTop.value?.focus({ preventScroll: true })
}
function privacyValue(key) {
  return key === 'allow_search_by_real_name' ? userStore.user?.[key] === 1 : userStore.user?.[key] !== 0
}
function valueFor(item) {
  if (item.source === 'privacy') return privacyValue(item.key)
  if (item.source === 'navigation') return Object.hasOwn(settingsStore.nav, item.key) ? settingsStore.nav[item.key] : settingsStore.tools[item.key]
  const value = settingsStore.prefs[item.key]
  return item.invert ? !value : value
}
function disabledReason(item) {
  if (item.source === 'privacy' && !userStore.user) return '账户资料还未加载，请稍后重试。'
  if (item.key === 'allow_search_by_real_name' && !(userStore.user?.real_name || '').trim()) return '请先在个人资料中填写真实姓名。'
  if (item.requireTreeHole && !wallStore.canHere('wall.tree_hole')) return '此入口仅对当前墙的树洞志愿者开放。'
  return ''
}
async function saveSetting(item, value) {
  if (busy.value || disabledReason(item)) return
  actionError.value = ''; accountError.value = ''
  retryOperation.value = () => saveSetting(item, value)
  if (item.source === 'privacy') {
    privacySaving.value = true
    accountStatus.value = 'saving'
    const revision = userStore.sessionRevision
    try {
      await userStore.updateProfile({ [item.key]: value ? 1 : 0 })
      if (revision === userStore.sessionRevision) { accountStatus.value = 'saved'; retryOperation.value = null }
    } catch (error) { if (revision === userStore.sessionRevision) { accountError.value = getApiErrorMessage(error, '隐私设置未保存，请重试'); accountStatus.value = 'error' } }
    finally { privacySaving.value = false }
  } else {
    const storedValue = item.invert ? !value : value
    const ok = item.source === 'navigation' ? await settingsStore.setNavPref(item.key, storedValue) : await settingsStore.setPref(item.key, storedValue)
    if (ok) retryOperation.value = null
  }
}

const confirmation = ref(null)
const showResetScope = ref(false)
const resetScope = ref('all')
const scopeLabels = { all: '全部偏好', appearance: '外观', reading: '阅读', publishing: '发布默认值', chat: '聊天', notifications: '通知', navigation: '导航' }
const pendingImport = ref(null)
const importPreview = computed(() => Object.entries(pendingImport.value?.patch || {}).map(([key, value]) => {
  const item = catalog.find(entry => entry.key === key && entry.source !== 'privacy')
  const displayValue = item?.invert ? !value : value
  const label = typeof displayValue === 'boolean' ? displayValue ? '开启' : '关闭' : item?.options?.find(option => option.value === displayValue)?.label || displayValue
  return { key, name: item?.label || key, value: label }
}))
async function readImport(event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file || busy.value) { input.value = ''; return }
  actionError.value = ''
  try {
    if (file.size > 65536) throw new Error('请选择小于64KB的偏好JSON文件')
    const text = await file.text()
    const patch = parsePreferenceImport(text)
    pendingImport.value = { text, patch }
    confirmation.value = { kind: 'import', title: '导入 ' + Object.keys(patch).length + ' 项偏好', message: '确认后将替换文件中列出的偏好，其余偏好保持不变。不会导入账号、隐私或登录凭证。', button: '确认导入' }
  } catch (error) { actionError.value = error.message || '偏好文件无法读取，请重新选择' }
  finally { input.value = '' }
}
function askReset() {
  if (busy.value || !['all', ...PREFERENCE_GROUPS].includes(resetScope.value)) return
  confirmation.value = { kind: 'reset', scope: resetScope.value, title: '恢复' + scopeLabels[resetScope.value], message: '只恢复所选范围的偏好，不会修改真实姓名、联系方式、搜索隐私、帖子或消息。' + (['all', 'publishing'].includes(resetScope.value) ? '范围包含发布时的匿名默认选项，下次发布前请确认。' : ''), button: '恢复默认' }
}
async function applyImport(text) {
  retryOperation.value = () => applyImport(text)
  actionError.value = ''; accountError.value = ''
  const ok = await settingsStore.importPreferences(text)
  if (ok) { retryOperation.value = null; toast.success('偏好已导入') }
}
async function applyReset(scope) {
  retryOperation.value = () => applyReset(scope)
  actionError.value = ''; accountError.value = ''
  const ok = await settingsStore.resetPreferences(scope)
  if (ok) { retryOperation.value = null; showResetScope.value = false; toast.success(scopeLabels[scope] + '已恢复默认') }
}
async function confirmAction() {
  const action = confirmation.value
  confirmation.value = null
  if (!action || busy.value) return
  if (action.kind === 'import') { const text = pendingImport.value?.text; pendingImport.value = null; if (text) await applyImport(text) }
  else if (action.kind === 'reset') await applyReset(action.scope)
  else if (action.kind === 'clear') { userStore.logout(); writeStorage('banInfo', null, 'sessionStorage'); await router.replace('/login') }
}
function cancelConfirmation() { confirmation.value = null; pendingImport.value = null }
function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
async function exportAccount() {
  if (actionBusy.value) return
  actionBusy.value = 'export_account'; actionError.value = ''
  try {
    const res = await api.get('/auth/export', { responseType: 'blob' })
    const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || 'schoolwall-export.json.gz'
    download(res.data, name.replace(/[\\/:*?"<>|]/g, '_'))
    toast.success('账号数据已导出，请妥善保管')
  } catch (error) { actionError.value = getApiErrorMessage(error, '账号数据导出失败，请重试') }
  finally { actionBusy.value = '' }
}
function handleAction(item) {
  if (item.path) { router.push(item.path); return }
  if (item.key === 'export_preferences') { download(new Blob([JSON.stringify(settingsStore.exportPreferences(), null, 2)], { type: 'application/json' }), 'schoolwall-preferences.json'); toast.success('偏好已导出') }
  else if (item.key === 'import_preferences') fileInput.value?.click()
  else if (item.key === 'reset_preferences') { showResetScope.value = !showResetScope.value; nextTick(() => document.getElementById('reset-scope')?.focus()) }
  else if (item.key === 'export_account') exportAccount()
  else if (item.key === 'clear_session') confirmation.value = { kind: 'clear', title: '清除本机登录状态', message: '操作后会退出当前账号，需要重新登录。服务器中的偏好和账号数据保持不变。', button: '清除并退出' }
}
async function loadVisits() { try { visitStats.value = (await api.get('/stats/visits')).data } catch { visitStats.value = null } }
onMounted(() => { if (!settingsStore.loaded) settingsStore.loadSettings(); loadVisits(); visitTimer = setInterval(loadVisits, 60000) })
onUnmounted(() => { clearInterval(visitTimer); retryOperation.value = null })
</script>

<template>
  <div class="settings-center">
    <header ref="pageTop" class="settings-masthead" tabindex="-1">
      <div><p class="settings-eyebrow">你的校园，按你的习惯</p><h1>设置中心</h1><p class="settings-intro">管理隐私与日常偏好，让校园墙用起来更顺手。</p></div>
      <span class="save-indicator" :class="saveState" role="status" aria-live="polite" aria-atomic="true"><Icon :name="saveState === 'saved' ? 'check-circle' : saveState === 'error' ? 'alert-circle' : 'settings'" :size="16" />{{ saveText }}</span>
    </header>

    <div class="settings-search" role="search" aria-label="搜索设置">
      <Icon name="search" :size="20" />
      <label for="settings-search" class="sr-only">搜索设置</label>
      <input id="settings-search" ref="searchInput" v-model="search" type="search" maxlength="80" placeholder="搜索设置，例如：隐私、消息、文字大小" autocomplete="off" aria-controls="settings-results" @keydown.esc="clearSearch" />
      <button v-if="search" type="button" class="search-clear" aria-label="清空设置搜索" @click="clearSearch"><Icon name="close" :size="17" /></button>
      <span class="search-count" role="status" aria-live="polite">{{ isSearching ? resultCount + ' 项结果' : catalog.length + ' 项设置' }}</span>
    </div>

    <div class="settings-layout">
      <nav class="category-navigation" aria-label="设置分类">
        <p class="category-caption">设置分类</p>
        <label for="settings-category" class="sr-only">选择设置分类</label>
        <select id="settings-category" class="mobile-category" :value="activeSection" @change="chooseSection($event.target.value)"><option v-for="section in SETTINGS_SECTIONS" :key="section.id" :value="section.id">{{ section.title }}{{ isSearching ? ' · ' + sectionCount(section.id) : '' }}</option></select>
        <div class="desktop-categories"><button v-for="section in SETTINGS_SECTIONS" :key="section.id" type="button" class="category-button" :class="{ selected: activeSection === section.id && !isSearching }" :aria-current="activeSection === section.id && !isSearching ? 'true' : undefined" aria-controls="settings-results" @click="chooseSection(section.id)"><Icon :name="section.icon" :size="18" /><span>{{ section.title }}</span><span class="category-count">{{ sectionCount(section.id) }}</span></button></div>
        <p class="category-note"><Icon name="check-circle" :size="15" />偏好随账号同步</p>
      </nav>

      <div id="settings-results" class="settings-content">
        <div v-if="errorMessage" class="settings-feedback" role="alert"><Icon name="alert-circle" :size="18" /><div><p>{{ errorMessage }}</p><p class="feedback-help">保存失败的更改不会覆盖原设置。</p><button v-if="retryOperation && !busy" type="button" class="text-link" @click="retryOperation()">重试上次更改</button><button v-else-if="!settingsStore.loaded && !busy" type="button" class="text-link" @click="settingsStore.loadSettings">重新同步设置</button></div></div>
        <header class="section-heading"><div><p class="section-eyebrow">{{ isSearching ? '跨分类搜索' : '偏好与管理' }}</p><h2 ref="sectionHeading" tabindex="-1">{{ isSearching ? '搜索结果' : currentSection.title }}</h2><p>{{ isSearching ? '找到 ' + resultCount + ' 项匹配的设置' : currentSection.description }}</p></div><button type="button" class="back-top" @click="backToTop"><Icon name="arrow-up" :size="15" />回到顶部</button></header>
        <div v-if="!visibleGroups.length" class="settings-empty" role="status"><Icon name="search" :size="30" /><h3>没有找到相关设置</h3><p>试试“聊天”“隐私”或“主题”，也可以清空搜索浏览分类。</p><button type="button" class="btn btn-secondary" @click="clearSearch">清空搜索</button></div>
        <section v-for="group in visibleGroups" :key="group.id" class="settings-group glass" :aria-label="group.title">
          <header v-if="isSearching" class="result-group-header"><Icon :name="group.icon" :size="17" /><h3>{{ group.title }}</h3><span>{{ group.items.length }} 项</span></header>
          <p v-if="group.id === 'account' && unfindable" class="context-note" role="status">所有搜索方式都已关闭。其他同学无法主动搜索到你，你仍可以添加好友。</p>
          <p v-if="group.id === 'appearance'" class="context-note">当前显示{{ resolvedTheme }}主题。外观更改会立即预览，保存失败时自动恢复。关闭毛玻璃或启用高对比度时，液态玻璃会自动降级为清晰的实色面板。</p>
          <p v-if="group.id === 'notifications'" class="context-note">私信与树洞对话始终计入未读，避免遗漏直接发给你的消息。</p>
          <SettingControl v-for="item in group.items" :key="item.key" :setting="item" :value="valueFor(item)" :disabled="busy || !!disabledReason(item)" :disabled-reason="disabledReason(item)" :busy="actionBusy === item.key" @change="saveSetting(item, $event)" @action="handleAction(item)" />
          <form v-if="group.id === 'data' && showResetScope" class="reset-panel" @submit.prevent="askReset"><label for="reset-scope">选择恢复范围</label><div class="reset-controls"><select id="reset-scope" v-model="resetScope" :disabled="busy"><option v-for="(label, scope) in scopeLabels" :key="scope" :value="scope">{{ label }}</option></select><button type="submit" class="btn btn-secondary" :disabled="busy">继续确认</button></div><p>账号隐私、个人资料和内容不会随偏好恢复而改变。</p></form>
        </section>
        <footer class="settings-footer"><p>设置自动保存到当前账号，可在其他设备继续使用。</p><p v-if="visitStats">近 {{ visitStats.windowMinutes || 60 }} 分钟有 {{ visitStats.visitors }} 位访客访问校园墙。</p></footer>
      </div>
    </div>
    <input ref="fileInput" type="file" accept=".json,application/json" class="sr-only" tabindex="-1" aria-label="选择校园墙偏好JSON文件" @change="readImport" />
    <ConfirmModal :show="!!confirmation" :title="confirmation?.title || '确认更改'" :message="confirmation?.message || ''" :confirm-text="confirmation?.button || '确认'" cancel-text="取消" :danger="confirmation?.kind === 'clear'" @confirm="confirmAction" @cancel="cancelConfirmation" @update:show="!$event && (confirmation = null)">
      <dl v-if="confirmation?.kind === 'import'" class="import-preview"><div v-for="item in importPreview" :key="item.key"><dt>{{ item.name }}</dt><dd>{{ item.value }}</dd></div></dl>
    </ConfirmModal>
  </div>
</template>

<style scoped>
.settings-center { max-width: 70rem; margin: 0 auto; padding: .5rem 0 2rem; }
.settings-masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; margin: .75rem 0 1.8rem; outline: none; scroll-margin-top: 6rem; }
.settings-eyebrow { color: var(--text-link); font-size: .77rem; font-weight: 600; letter-spacing: .07em; margin-bottom: .5rem; }
h1 { margin: 0; font-size: clamp(1.9rem, 4vw, 2.45rem); line-height: 1.25; font-weight: 700; letter-spacing: -.035em; }
.settings-intro { color: var(--text-muted); font-size: .92rem; line-height: 1.8; margin-top: .65rem; text-wrap: pretty; }
.save-indicator { display: inline-flex; align-items: center; gap: .4rem; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: .77rem; color: var(--text-secondary); flex-shrink: 0; min-height: 2.5rem; }
.save-indicator.saved { color: var(--text-link); background: var(--accent-soft); border-color: var(--accent-line); }
.save-indicator.error { color: var(--danger-light); }
.settings-search { display: flex; align-items: center; gap: .75rem; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background-color: var(--surface-card); padding: .35rem .85rem; margin-bottom: 1.65rem; color: var(--text-muted); }
.settings-search:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.settings-search input { min-width: 0; flex: 1; border: 0; box-shadow: none; outline: none; background: none; color: var(--text-primary); padding: .65rem 0; min-height: 2.75rem; font-size: .9rem; border-radius: 0; }
.settings-search input:focus-visible { outline: none; }
.settings-search input::-webkit-search-cancel-button { display: none; }
.search-clear { width: 2.75rem; height: 2.75rem; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; display: grid; place-items: center; border-radius: var(--radius-sm); flex-shrink: 0; }
.search-clear:hover { background: var(--bg-card-hover); }
.search-clear, .back-top, .category-button { transition: background-color var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease); }
.search-clear:active, .back-top:active { background: var(--bg-input-focus); }
.search-count { flex-shrink: 0; font-size: .77rem; font-variant-numeric: tabular-nums; border-left: 1px solid var(--border-strong); padding-left: .8rem; }
.settings-masthead, .settings-search, .category-navigation { background-color: var(--surface-card); }
.settings-masthead { padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.category-navigation { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.settings-layout { display: grid; grid-template-columns: 11.7rem minmax(0, 1fr); gap: 1.8rem; align-items: start; }
.category-navigation { position: sticky; top: 5.75rem; }
.category-caption { font-size: .73rem; color: var(--text-muted); padding: .25rem .8rem .7rem; letter-spacing: .05em; }
.desktop-categories { display: flex; flex-direction: column; gap: .3rem; }
.category-button { width: 100%; display: flex; align-items: center; gap: .65rem; color: var(--text-secondary); border: 1px solid transparent; background: none; padding: .8rem; font: inherit; text-align: left; cursor: pointer; min-height: 2.9rem; border-radius: var(--radius-sm); font-size: .86rem; transition: background .16s ease; }
.category-button:hover { background: var(--bg-card-hover); }
.category-button.selected { color: var(--text-link); background: var(--accent-soft); border-color: var(--accent-line); font-weight: 600; }
.category-count { margin-left: auto; color: var(--text-muted); font-size: .72rem; font-variant-numeric: tabular-nums; }
.category-note { display: flex; align-items: center; gap: .45rem; font-size: .73rem; line-height: 1.7; color: var(--text-muted); padding: 1.1rem .8rem; margin-top: .9rem; border-top: 1px solid var(--border); }
.mobile-category { display: none; }
.settings-content { min-width: 0; }
.section-heading { display: flex; align-items: flex-start; gap: 1rem; justify-content: space-between; margin: .1rem 0 1.2rem; }
.section-eyebrow { font-size: .72rem; color: var(--text-muted); margin-bottom: .35rem; }
.section-heading h2 { font-size: 1.4rem; letter-spacing: -.025em; line-height: 1.45; outline: none; scroll-margin-top: 6rem; }
.section-heading p:last-child { font-size: .83rem; color: var(--text-muted); margin-top: .3rem; line-height: 1.8; }
.back-top { display: inline-flex; align-items: center; justify-content: center; gap: .25rem; min-height: 44px; background: none; border: 0; cursor: pointer; color: var(--text-link); font: inherit; font-size: .74rem; flex-shrink: 0; padding: .4rem; border-radius: var(--radius-sm); }
.settings-group { padding: .25rem 1.5rem; margin-bottom: 1rem; border: 1px solid var(--border); box-shadow: var(--glass-highlight); }
.result-group-header { display: flex; align-items: center; gap: .5rem; padding: 1rem 0 .85rem; color: var(--text-link); border-bottom: 1px solid var(--border); }
.result-group-header h3 { font-size: .92rem; font-weight: 600; }
.result-group-header span { margin-left: auto; font-size: .76rem; color: var(--text-muted); }
.context-note { font-size: .8rem; line-height: 1.8; color: var(--text-secondary); background: var(--accent-soft); padding: .8rem 1rem; margin: 1rem 0 .2rem; border-radius: var(--radius-sm); }
.settings-feedback { display: flex; gap: .7rem; background: var(--bg-card); border: 1px solid var(--border); border-left: 3px solid var(--danger); border-radius: var(--radius-sm); margin-bottom: 1.25rem; padding: 1rem; color: var(--text-primary); font-size: .87rem; line-height: 1.7; }
.settings-feedback > svg { flex-shrink: 0; color: var(--danger-light); margin-top: .2rem; }
.feedback-help { color: var(--text-muted); font-size: .8rem; }
.text-link { color: var(--text-link); background: none; border: 0; font: inherit; text-decoration: underline; min-height: 2.75rem; cursor: pointer; padding: .4rem 0; }
.settings-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 1rem; padding: 2.5rem 1.5rem; border-top: 1px solid var(--border); }
.settings-empty > svg { color: var(--text-muted); }
.settings-empty h3 { font-size: 1.1rem; }
.settings-empty p { font-size: .86rem; color: var(--text-muted); line-height: 1.8; max-width: 32rem; }
.settings-footer { color: var(--text-muted); font-size: .76rem; line-height: 1.9; padding: .75rem .1rem; }
.reset-panel { border-top: 1px solid var(--border); padding: 1rem 0 1.3rem; }
.reset-panel label { font-size: .9rem; font-weight: 600; }
.reset-controls { display: flex; gap: .65rem; margin: .7rem 0; }
.reset-controls select { flex: 1; min-width: 0; color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: .6rem; font: inherit; }
.reset-controls option { background: var(--bg-main); }
.reset-panel p { color: var(--text-muted); font-size: .78rem; line-height: 1.7; }
.import-preview { max-height: 15rem; overflow-y: auto; margin-top: .5rem; border-top: 1px solid var(--border); padding-right: .3rem; }
.import-preview div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; padding: .55rem 0; border-bottom: 1px solid var(--border); font-size: .8rem; line-height: 1.6; }
.import-preview dt { color: var(--text-secondary); }
.import-preview dd { color: var(--text-link); text-align: right; }
@media (max-width: 760px) { .settings-layout { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; } .category-navigation { position: static; } .desktop-categories, .category-caption, .category-note { display: none; } .mobile-category { display: block; width: 100%; min-height: 2.9rem; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); font: inherit; font-weight: 600; padding: .6rem .8rem; } .mobile-category option { background: var(--bg-main); } .settings-masthead { margin-top: .25rem; } }
@media (max-width: 480px) { .settings-center { padding-top: .25rem; } .settings-masthead { flex-direction: column; gap: 1rem; margin-bottom: 1.2rem; } .save-indicator { align-self: flex-start; } .settings-search { flex-wrap: wrap; gap: .4rem; padding: .3rem .65rem; margin-bottom: 1rem; } .search-count { width: 100%; border-left: 0; border-top: 1px solid var(--border); padding: .4rem 0 .15rem; font-size: .73rem; } .settings-group { padding-inline: 1rem; } .section-heading { gap: .5rem; } .back-top { font-size: .7rem; } .settings-intro { font-size: .86rem; } }
@media (prefers-reduced-motion: reduce) { .category-button { transition: none; } }
</style>
