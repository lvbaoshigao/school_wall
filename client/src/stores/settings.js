import { defineStore, acceptHMRUpdate } from 'pinia'
import { computed, ref } from 'vue'
import api from '../api'
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

// 偏好 schema：与后端 server/lib/prefs.js 一一对应。
// 后端才是校验方，这里的默认值只用于「还没拉到服务端偏好」时的首屏渲染。
export const PREF_SCHEMA = {
  feed_sort:        { def: 'latest' },
  feed_category:    { def: '全部' },
  density:          { def: 'comfortable' },
  time_format:      { def: 'relative' },
  font_scale:       { def: 'md' },
  auto_load_images: { def: true },

  default_anonymous_post:       { def: false },
  default_markdown:             { def: false },
  confirm_before_post:          { def: false },
  default_anonymous_confession: { def: true },

  badge_interaction:  { def: true },
  badge_announcement: { def: true },
  badge_system:       { def: true },
  badge_report:       { def: true },
  unread_interval:    { def: '30' },
  notify_on_comment:  { def: true },
  notify_on_like:     { def: true },

  reduce_motion:     { def: false },
  high_contrast:     { def: false },
  always_focus_ring: { def: false },
  disable_blur:      { def: false },

  accent: { def: 'indigo' },
}

// 可选主题色。每项给出两个色标，按钮渐变、选中态、焦点环都由它派生。
export const ACCENTS = [
  { key: 'indigo', label: '靛蓝', c1: '#7183f0', c2: '#5a68d8', shadow: '72, 92, 210' },
  { key: 'teal',   label: '青碧', c1: '#3fb8ad', c2: '#2f9389', shadow: '36, 128, 120' },
  { key: 'forest', label: '松绿', c1: '#5cb073', c2: '#438c59', shadow: '48, 110, 70' },
  { key: 'amber',  label: '琥珀', c1: '#e0a34a', c2: '#c4832f', shadow: '150, 100, 30' },
  { key: 'rose',   label: '绛红', c1: '#e0708a', c2: '#c4526e', shadow: '150, 55, 80' },
  { key: 'slate',  label: '石墨', c1: '#7c8794', c2: '#5f6a77', shadow: '70, 80, 92' },
]

const DEFAULT_NAV = NAV_ITEMS.reduce((acc, item) => { acc[item.key] = true; return acc }, {})
// 导航工具项（主题/壁纸），同样可在设置里开关
const DEFAULT_TOOLS = { theme: true, wallpaper: true }
const DEFAULT_PREFS = Object.fromEntries(Object.entries(PREF_SCHEMA).map(([k, v]) => [k, v.def]))

export const useSettingsStore = defineStore('settings', () => {
  const nav = ref({ ...DEFAULT_NAV })
  const tools = ref({ ...DEFAULT_TOOLS })
  const prefs = ref({ ...DEFAULT_PREFS })
  const loaded = ref(false)

  const userStore = useUserStore()
  const wallStore = useWallStore()

  // 按用户权限过滤后的导航项（树洞需树洞志愿者 / 全局管理员）
  const visibleNav = computed(() => {
    const items = NAV_ITEMS.filter(item => {
      if (!nav.value[item.key]) return false
      if (item.requireTreeHole) {
        return wallStore.canHere('wall.tree_hole')
      }
      return true
    })
    return items
  })

  const accent = computed(() => ACCENTS.find(a => a.key === prefs.value.accent) || ACCENTS[0])

  // 把外观类偏好写到 <html> 上，由 global.css 的属性选择器接管
  function applyAppearance() {
    const el = document.documentElement
    const p = prefs.value
    el.dataset.density = p.density
    el.dataset.fontScale = p.font_scale
    el.dataset.reduceMotion = p.reduce_motion ? 'on' : 'off'
    el.dataset.highContrast = p.high_contrast ? 'on' : 'off'
    el.dataset.focusRing = p.always_focus_ring ? 'always' : 'auto'
    el.dataset.blur = p.disable_blur ? 'off' : 'on'
    const a = accent.value
    el.style.setProperty('--accent-1', a.c1)
    el.style.setProperty('--accent-2', a.c2)
    el.style.setProperty('--accent-shadow-rgb', a.shadow)
  }

  function applyStored(p) {
    nav.value = { ...DEFAULT_NAV }
    tools.value = { ...DEFAULT_TOOLS }
    prefs.value = { ...DEFAULT_PREFS }
    for (const k of Object.keys(nav.value)) {
      if (typeof p[k] === 'boolean') nav.value[k] = p[k]
    }
    for (const k of Object.keys(tools.value)) {
      if (typeof p[k] === 'boolean') tools.value[k] = p[k]
    }
    for (const k of Object.keys(prefs.value)) {
      if (p[k] !== undefined) prefs.value[k] = p[k]
    }
    applyAppearance()
  }

  async function loadSettings() {
    if (!userStore.isLoggedIn) return
    try {
      const res = await api.get('/auth/prefs')
      if (res.data?.prefs) applyStored(res.data.prefs)
    } catch {}
    loaded.value = true
  }

  // 切换导航项显示并持久化到后端
  async function setNavPref(key, val) {
    if (key in nav.value) nav.value = { ...nav.value, [key]: !!val }
    else if (key in tools.value) tools.value = { ...tools.value, [key]: !!val }
    try {
      await api.put('/auth/prefs', { prefs: { [key]: !!val } })
    } catch {}
  }

  // 设置任意偏好项；后端是增量保存，只需传改动的那一个
  async function setPref(key, val) {
    if (!(key in prefs.value)) return
    prefs.value = { ...prefs.value, [key]: val }
    applyAppearance()
    try {
      await api.put('/auth/prefs', { prefs: { [key]: val } })
    } catch {}
  }

  return {
    nav, tools, prefs, loaded, visibleNav, accent,
    loadSettings, setNavPref, setPref, applyAppearance,
  }
})

// 没有这一段时，开发中修改本文件会保留旧的 store 实例：
// 新代码读 settingsStore.prefs 会拿到 undefined 而报错，必须硬刷新才恢复。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}
