import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref, onScopeDispose } from 'vue'
import api, { getSessionToken, subscribeSessionChange, getApiErrorMessage, readStorage, writeStorage } from '../api'
import { useUserStore } from './user'
import { useWallStore } from './wall'

// 导航栏选项卡定义（前端唯一来源，与后端 DEFAULT_NAV_PREFS 保持一致）
// icon 为 components/Icon.vue 的图标名；顶栏按钮只显示文字，图标仅用于设置页的列表标识
export const NAV_ITEMS = [
  { key: 'home',    icon: 'home',    label: '主页',      type: 'link', path: '/',             desc: '帖子动态主页', requireTreeHole: false },
  { key: 'publish', icon: 'edit',    label: '发布',      type: 'dropdown', children: [
      { label: '发帖', path: '/post/create' },
      { label: '表白', path: '/confession/write' },
      { label: '发起投票', path: '/vote/create' },
  ], desc: '发帖 / 表白 / 发起投票' },
  // type: 'search' —— 顶栏渲染为搜索输入框而非按钮，不参与导航按钮循环
  { key: 'search',  icon: 'search',  label: '搜索',      type: 'search', path: '/search',       desc: '顶栏帖子搜索框', requireTreeHole: false },
  { key: 'votes',   icon: 'chart',   label: '投票',      type: 'link', path: '/votes',        desc: '查看 / 参与投票' },
  { key: 'chat',    icon: 'message', label: '聊天',      type: 'link', path: '/chat',         desc: '好友私信（带未读提示）' },
  { key: 'inbox',   icon: 'inbox',   label: '收件箱',    type: 'link', path: '/inbox',        desc: '系统通知 / 互动消息（带未读提示）' },
  { key: 'treehole',icon: 'leaf',    label: '树洞',      type: 'link', path: '/tree-hole/list', desc: '匿名树洞对话（树洞志愿者可见）', requireTreeHole: true },
  { key: 'bookmarks',icon: 'bookmark',label: '收藏',      type: 'link', path: '/bookmarks',    desc: '查看收藏的帖子' },
  { key: 'help',    icon: 'help',    label: '求助',      type: 'dropdown', children: [
      { label: '倾诉', path: '/help/counseling' },
      { label: '举报', path: '/help/report' },
  ], desc: '倾诉 / 安全举报' },
]

// 与服务端偏好schema同步；账号隐私字段有意不在可导入/重置范围内。
export const PREF_SCHEMA = {
  feed_sort: { type: 'enum', values: ['latest', 'hot'], def: 'latest', group: 'reading' },
  feed_category: { type: 'enum', values: ['全部', '吐槽', '分享', '求助', '讨论', '其他'], def: '全部', group: 'reading' },
  density: { type: 'enum', values: ['comfortable', 'compact'], def: 'comfortable', group: 'reading' },
  time_format: { type: 'enum', values: ['relative', 'absolute'], def: 'relative', group: 'reading' },
  font_scale: { type: 'enum', values: ['sm', 'md', 'lg'], def: 'md', group: 'reading' },
  auto_load_images: { type: 'bool', def: true, group: 'reading' },
  default_anonymous_post: { type: 'bool', def: false, group: 'publishing' },
  default_markdown: { type: 'bool', def: false, group: 'publishing' },
  confirm_before_post: { type: 'bool', def: false, group: 'publishing' },
  default_anonymous_confession: { type: 'bool', def: true, group: 'publishing' },
  badge_interaction: { type: 'bool', def: true, group: 'notifications' },
  badge_announcement: { type: 'bool', def: true, group: 'notifications' },
  badge_system: { type: 'bool', def: true, group: 'notifications' },
  badge_report: { type: 'bool', def: true, group: 'notifications' },
  unread_interval: { type: 'enum', values: ['0', '15', '30', '60', '300'], def: '30', group: 'notifications' },
  notify_on_comment: { type: 'bool', def: true, group: 'notifications' },
  notify_on_like: { type: 'bool', def: true, group: 'notifications' },
  reduce_motion: { type: 'bool', def: false, group: 'appearance' },
  high_contrast: { type: 'bool', def: false, group: 'appearance' },
  always_focus_ring: { type: 'bool', def: false, group: 'appearance' },
  disable_blur: { type: 'bool', def: false, group: 'appearance' },
  accent: { type: 'enum', values: ['indigo', 'teal', 'forest', 'amber', 'rose', 'slate'], def: 'teal', group: 'appearance' },
  theme_mode: { type: 'enum', values: ['system', 'light', 'dark'], def: 'system', group: 'appearance' },
  wallpaper_enabled: { type: 'bool', def: true, group: 'appearance' },
  chat_send_shortcut: { type: 'enum', values: ['enter', 'modifier'], def: 'enter', group: 'chat' },
  chat_density: { type: 'enum', values: ['comfortable', 'compact'], def: 'comfortable', group: 'chat' },
  chat_show_timestamps: { type: 'bool', def: true, group: 'chat' },
  chat_poll_interval: { type: 'enum', values: ['10', '20', '30', '60'], def: '20', group: 'chat' },
}

export const ACCENTS = [
  { key: 'indigo', label: '靛蓝', c1: '#7183f0', c2: '#5a68d8', shadow: '72, 92, 210' },
  { key: 'teal',   label: '青碧', c1: '#397d72', c2: '#2d655c', shadow: '36, 96, 86' },
  { key: 'forest', label: '松绿', c1: '#5cb073', c2: '#438c59', shadow: '48, 110, 70' },
  { key: 'amber',  label: '琥珀', c1: '#e0a34a', c2: '#c4832f', shadow: '150, 100, 30' },
  { key: 'rose',   label: '绛红', c1: '#e0708a', c2: '#c4526e', shadow: '150, 55, 80' },
  { key: 'slate',  label: '石墨', c1: '#7c8794', c2: '#5f6a77', shadow: '70, 80, 92' },
]

const DEFAULT_NAV = NAV_ITEMS.reduce((acc, item) => { acc[item.key] = !['votes', 'treehole', 'bookmarks', 'help'].includes(item.key); return acc }, {})
const DEFAULT_TOOLS = { theme: true, wallpaper: true }
const DEFAULT_PREFS = Object.fromEntries(Object.entries(PREF_SCHEMA).map(([key, spec]) => [key, spec.def]))
export const PREFERENCE_SCHEMA = {
  ...Object.fromEntries(Object.entries({ ...DEFAULT_NAV, ...DEFAULT_TOOLS }).map(([key, def]) => [key, { type: 'bool', def, group: 'navigation' }])),
  ...PREF_SCHEMA,
}
export const PREFERENCE_GROUPS = ['appearance', 'reading', 'publishing', 'chat', 'notifications', 'navigation']

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
export function validatePreferencePatch(input) {
  if (!plainObject(input) || !Object.keys(input).length) throw new Error('偏好必须是非空的JSON对象')
  const patch = {}
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(PREFERENCE_SCHEMA, key)) throw new Error('包含不支持的偏好：' + key)
    const spec = PREFERENCE_SCHEMA[key]
    if ((spec.type === 'bool' && typeof value !== 'boolean') || (spec.type === 'enum' && !spec.values.includes(value))) throw new Error('偏好值无效：' + key)
    patch[key] = value
  }
  return patch
}
export function preferenceDefaults(group = 'all') {
  if (group !== 'all' && !PREFERENCE_GROUPS.includes(group)) throw new Error('无法恢复此分类')
  return Object.fromEntries(Object.entries(PREFERENCE_SCHEMA).filter(([, spec]) => group === 'all' || spec.group === group).map(([key, spec]) => [key, spec.def]))
}
export function parsePreferenceImport(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new Error('偏好文件需要小于64KB')
  let data
  try { data = JSON.parse(text) } catch { throw new Error('文件不是有效的JSON') }
  if (!plainObject(data) || data.format !== 'school-wall-preferences' || data.version !== 1 || Object.keys(data).some(key => !['format', 'version', 'prefs'].includes(key))) throw new Error('不支持的偏好文件格式或版本')
  return validatePreferencePatch(data.prefs)
}

function storedThemeMode() {
  const current = readStorage('theme_mode')
  if (['system', 'light', 'dark'].includes(current)) return current
  const legacy = readStorage('theme')
  return ['light', 'dark'].includes(legacy) ? legacy : null
}

export const useSettingsStore = defineStore('settings', () => {
  const nav = ref({ ...DEFAULT_NAV })
  const tools = ref({ ...DEFAULT_TOOLS })
  const prefs = ref({ ...DEFAULT_PREFS, theme_mode: storedThemeMode() || 'system' })
  const themeModeInitialized = ref(!getSessionToken())
  const loaded = ref(false)
  const loading = ref(false)
  const saveError = ref('')
  const saveStatus = ref('idle')
  const lastSavedAt = ref(null)
  const pendingCount = ref(0)
  const saving = computed(() => pendingCount.value > 0)
  const userStore = useUserStore()
  const wallStore = useWallStore()
  const visibleNav = computed(() => NAV_ITEMS.filter(item => nav.value[item.key] && (!item.requireTreeHole || wallStore.canHere('wall.tree_hole'))))
  const accent = computed(() => ACCENTS.find(item => item.key === prefs.value.accent) || ACCENTS.find(item => item.key === 'teal'))
  let loadPromise = null
  let saveQueue = Promise.resolve()
  let settingsRevision = 0

  function applyAppearance() {
    if (typeof document === 'undefined') return
    const el = document.documentElement
    const p = prefs.value
    el.dataset.density = p.density
    el.dataset.fontScale = p.font_scale
    el.dataset.reduceMotion = p.reduce_motion ? 'on' : 'off'
    el.dataset.highContrast = p.high_contrast ? 'on' : 'off'
    el.dataset.focusRing = p.always_focus_ring ? 'always' : 'auto'
    el.dataset.blur = p.disable_blur ? 'off' : 'on'
    el.style.setProperty('--accent-1', accent.value.c1)
    el.style.setProperty('--accent-2', accent.value.c2)
    el.style.setProperty('--accent-shadow-rgb', accent.value.shadow)
  }
  function snapshot() { return { ...nav.value, ...tools.value, ...prefs.value } }
  function applyPatch(patch, persistTheme = false) {
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(nav.value, key)) nav.value = { ...nav.value, [key]: value }
      else if (Object.hasOwn(tools.value, key)) tools.value = { ...tools.value, [key]: value }
      else if (Object.hasOwn(prefs.value, key)) prefs.value = { ...prefs.value, [key]: value }
    }
    if (persistTheme && Object.hasOwn(patch, 'theme_mode')) {
      writeStorage('theme_mode', prefs.value.theme_mode)
      themeModeInitialized.value = true
    }
    applyAppearance()
  }
  function applyStored(data) {
    const valid = {}
    for (const [key, spec] of Object.entries(PREFERENCE_SCHEMA)) {
      const value = data?.[key]
      valid[key] = (spec.type === 'bool' && typeof value === 'boolean') || (spec.type === 'enum' && spec.values.includes(value)) ? value : spec.def
    }
    applyPatch(valid)
  }
  function reset() {
    settingsRevision++
    const localMode = storedThemeMode() || 'system'
    applyStored({ theme_mode: localMode })
    themeModeInitialized.value = !getSessionToken()
    loaded.value = false; loading.value = false; saveError.value = ''; saveStatus.value = 'idle'
    lastSavedAt.value = null; pendingCount.value = 0; loadPromise = null; saveQueue = Promise.resolve()
  }
  onScopeDispose(subscribeSessionChange(event => { if (event.resetContext) reset() }))

  async function loadSettings() {
    if (!userStore.isLoggedIn) return false
    if (loadPromise) return loadPromise
    const revision = settingsRevision
    loading.value = true
    const request = saveQueue.catch(() => {}).then(async () => {
      if (revision !== settingsRevision) return false
      try {
        const res = await api.get('/auth/prefs')
        if (revision !== settingsRevision) return false
        const localMode = storedThemeMode()
        const migrateTheme = Array.isArray(res.data?.storedKeys) && !res.data.storedKeys.includes('theme_mode') && localMode !== null
        applyStored({ ...(res.data?.prefs || {}), ...(migrateTheme ? { theme_mode: localMode } : {}) })
        themeModeInitialized.value = true
        writeStorage('theme_mode', prefs.value.theme_mode)
        loaded.value = true; saveError.value = ''
        if (migrateTheme) {
          try {
            await api.put('/auth/prefs', { prefs: { theme_mode: localMode } })
            if (revision !== settingsRevision) return false
          } catch (error) {
            if (revision !== settingsRevision) return false
            saveError.value = getApiErrorMessage(error, '已保留本机主题，暂时无法同步到账号')
          }
        }
        if (!pendingCount.value) saveStatus.value = saveError.value ? 'error' : 'idle'
        return true
      } catch (error) {
        if (revision === settingsRevision) { saveError.value = getApiErrorMessage(error, '设置加载失败，请重试'); saveStatus.value = 'error' }
        return false
      } finally { if (revision === settingsRevision) loading.value = false }
    })
    loadPromise = request
    saveQueue = request
    try { return await request } finally { if (loadPromise === request) loadPromise = null }
  }

  function enqueueSave(patch, persist) {
    const revision = settingsRevision
    const token = getSessionToken()
    if (!token) { saveError.value = '请先登录后保存设置'; saveStatus.value = 'error'; return Promise.resolve(false) }
    pendingCount.value++
    saveStatus.value = 'saving'
    const operation = saveQueue.catch(() => {}).then(async () => {
      if (revision !== settingsRevision) return false
      const before = snapshot()
      applyPatch(patch, true)
      saveError.value = ''
      try {
        const res = await persist(patch)
        if (revision !== settingsRevision) return false
        const normalized = {}
        for (const key of Object.keys(patch)) {
          const value = res?.data?.prefs?.[key]
          const spec = PREFERENCE_SCHEMA[key]
          normalized[key] = (spec.type === 'bool' && typeof value === 'boolean') || (spec.type === 'enum' && spec.values.includes(value)) ? value : patch[key]
        }
        applyPatch(normalized, true)
        lastSavedAt.value = Date.now()
        return true
      } catch (error) {
        if (revision === settingsRevision) {
          applyPatch(Object.fromEntries(Object.keys(patch).map(key => [key, before[key]])), true)
          saveError.value = getApiErrorMessage(error, '保存失败，已恢复原设置')
        }
        return false
      } finally {
        if (revision === settingsRevision) {
          pendingCount.value = Math.max(0, pendingCount.value - 1)
          saveStatus.value = pendingCount.value ? 'saving' : saveError.value ? 'error' : 'saved'
        }
      }
    })
    saveQueue = operation
    return operation
  }
  function setPrefs(input) {
    let patch
    try { patch = validatePreferencePatch(input) }
    catch (error) { saveError.value = error.message; saveStatus.value = 'error'; return Promise.resolve(false) }
    return enqueueSave(patch, value => api.put('/auth/prefs', { prefs: value }))
  }
  function setPref(key, value) {
    if (key === 'theme_mode' && !getSessionToken()) return setThemeMode(value)
    if (!Object.hasOwn(PREF_SCHEMA, key)) return Promise.resolve(false)
    return setPrefs({ [key]: value })
  }
  function setThemeMode(value) {
    if (!PREF_SCHEMA.theme_mode.values.includes(value)) return Promise.resolve(false)
    if (getSessionToken()) return setPref('theme_mode', value)
    applyPatch({ theme_mode: value }, true)
    saveError.value = ''; saveStatus.value = 'idle'
    return Promise.resolve(true)
  }
  function setNavPref(key, value) {
    if (!Object.hasOwn(DEFAULT_NAV, key) && !Object.hasOwn(DEFAULT_TOOLS, key)) return Promise.resolve(false)
    return setPrefs({ [key]: !!value })
  }
  function resetPreferences(group = 'all') {
    let patch
    try { patch = preferenceDefaults(group) }
    catch (error) { saveError.value = error.message; saveStatus.value = 'error'; return Promise.resolve(false) }
    return enqueueSave(patch, async value => {
      try { return await api.post('/auth/prefs/reset', { scope: group }) }
      catch (error) {
        if (![404, 405].includes(error.response?.status)) throw error
        return api.put('/auth/prefs', { prefs: value })
      }
    })
  }
  function exportPreferences() { return { format: 'school-wall-preferences', version: 1, prefs: validatePreferencePatch(snapshot()) } }
  function importPreferences(text) {
    try { return setPrefs(parsePreferenceImport(text)) }
    catch (error) { saveError.value = error.message; saveStatus.value = 'error'; return Promise.resolve(false) }
  }

  return {
    nav, tools, prefs, loaded, loading, visibleNav, accent, themeModeInitialized, saveError, saveStatus, lastSavedAt, saving, pendingCount,
    loadSettings, setNavPref, setPref, setPrefs, setThemeMode, applyAppearance, reset, resetPreferences, exportPreferences, importPreferences,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
