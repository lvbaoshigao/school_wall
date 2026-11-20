<script setup>
import { ref, computed, onMounted, onBeforeUnmount, provide, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from './stores/user'
import { useWallStore } from './stores/wall'
import { useSettingsStore } from './stores/settings'
import Navbar from './components/Navbar.vue'
import ToastContainer from './components/ToastContainer.vue'
import BackToTop from './components/BackToTop.vue'
import PublishFab from './components/PublishFab.vue'
import api, { readStorage } from './api'
import { useToast } from './composables/useToast'

const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const mainRef = ref(null)
// 身份或校园墙变化时销毁旧缓存，避免显示前一会话的私信与帖子。
const cacheScope = computed(() => [userStore.sessionRevision, userStore.user?.id || 'guest', wallStore.currentWallId || 'none'].join(':'))
watch(() => route.path, async () => {
  await nextTick()
  mainRef.value?.focus({ preventScroll: true })
})

// 主页要用三栏（左分类 / 帖子 / 右墙介绍），需要比其它页面更宽的容器；
// 其余页面维持 1000px 单栏，避免正文行宽过长。
const isWideLayout = computed(() => route.name === 'Home')
const isConversationLayout = computed(() => route.name === 'ChatRoom' || route.name === 'TreeHoleChat')
const isSettingsLayout = computed(() => route.name === 'Settings')
const toast = useToast()
const themeSaving = ref(false)
const mounted = ref(false)

const wallpaperUrl = ref('')
const wallpaperLoaded = ref(false)
const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)')
const systemDark = ref(systemTheme?.matches || false)
// 初始化期间只读本地兼容值；迁移与持久化都由设置 store 负责。
const themeMode = computed(() => {
  if (settingsStore.themeModeInitialized) return settingsStore.prefs.theme_mode
  const savedMode = readStorage('theme_mode')
  if (['system', 'light', 'dark'].includes(savedMode)) return savedMode
  const legacy = readStorage('theme')
  return legacy === 'light' || legacy === 'dark' ? legacy : 'system'
})
const currentTheme = computed(() => themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value)
const wallpaperEnabled = computed(() => settingsStore.prefs.wallpaper_enabled !== false)
let wallpaperRequest = 0

async function setThemeMode(mode) {
  if (!['system', 'light', 'dark'].includes(mode) || themeSaving.value) return false
  themeSaving.value = true
  try {
    const saved = await (settingsStore.setThemeMode ? settingsStore.setThemeMode(mode) : settingsStore.setPref('theme_mode', mode))
    if (!saved) toast.error(settingsStore.saveError || '主题保存失败，请重试')
    return saved
  } catch {
    toast.error('主题保存失败，请重试')
    return false
  } finally { themeSaving.value = false }
}
function toggleTheme() {
  return setThemeMode(currentTheme.value === 'dark' ? 'light' : 'dark')
}
function onSystemThemeChange(event) { systemDark.value = event.matches }
watch(currentTheme, applyTheme, { immediate: true })

function applyTheme() {
  if (currentTheme.value === 'light') {
    document.body.classList.add('light-theme')
  } else {
    document.body.classList.remove('light-theme')
  }
  document.documentElement.style.colorScheme = currentTheme.value
  const color = getComputedStyle(document.body).getPropertyValue('--bg-deep').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

provide('theme', { current: currentTheme, toggle: toggleTheme, mode: themeMode, setMode: setThemeMode })

// 同一套变量供私聊、匿名聊天及短屏菜单消费，缩放时不把 pinch zoom 当作软键盘。
let viewportFrame = 0
const viewportProperties = ['--visual-viewport-height', '--visual-viewport-width', '--visual-viewport-offset-top', '--keyboard-inset-bottom']
function updateViewport() {
  viewportFrame = 0
  const viewport = window.visualViewport
  const height = Math.max(0, viewport?.height ?? window.innerHeight)
  const width = Math.max(0, viewport?.width ?? window.innerWidth)
  const top = Math.max(0, viewport?.offsetTop || 0)
  const scale = viewport?.scale || 1
  const inset = Math.abs(scale - 1) < 0.05 ? Math.max(0, window.innerHeight - height - top) : 0
  const editing = document.activeElement?.matches?.('textarea, input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]), [contenteditable="true"]')
  const root = document.documentElement
  root.style.setProperty('--visual-viewport-height', height + 'px')
  root.style.setProperty('--visual-viewport-width', width + 'px')
  root.style.setProperty('--visual-viewport-offset-top', top + 'px')
  root.style.setProperty('--keyboard-inset-bottom', inset + 'px')
  root.dataset.keyboardOpen = editing && inset > 120 ? 'on' : 'off'
}
function scheduleViewport() {
  if (!viewportFrame) viewportFrame = window.requestAnimationFrame(updateViewport)
}
watch(isConversationLayout, conversation => {
  document.documentElement.dataset.appLayout = conversation ? 'conversation' : 'page'
}, { immediate: true })
watch(wallpaperEnabled, enabled => {
  if (enabled && mounted.value) getRandomWallpaper()
  else if (!enabled) {
    wallpaperRequest++
    wallpaperUrl.value = ''
    wallpaperLoaded.value = false
  }
})

async function getRandomWallpaper() {
  if (!wallpaperEnabled.value) return
  const requestId = ++wallpaperRequest
  wallpaperLoaded.value = false
  // 先请求本地壁纸服务：本地图片可控、无第三方依赖、断网也能出图。
  // 原实现把外部 Bing 接口写在一个 try{...return} 里 —— 该 try 永远不可能抛错，
  // 于是 return 一定执行，下面的 api.get('/wallpaper') 属于永远跑不到的死代码，
  // onWallpaperError 的兜底也被这条死路径架空。
  try {
    const res = await api.get('/wallpaper')
    if (requestId !== wallpaperRequest) return
    if (res.data?.url) {
      const url = new URL(res.data.url, window.location.origin)
      // 壁纸只使用本站服务返回的本地资源，避免加载未授权第三方。
      if (url.origin !== window.location.origin) throw new Error('Invalid wallpaper origin')
      url.searchParams.set('t', String(Date.now()))
      wallpaperUrl.value = url.href
      return
    }
  } catch (e) {}
  // 本地取不到再退回主题色渐变底（bg-gradient 常驻，视觉上不会空白）
  if (requestId !== wallpaperRequest) return
  wallpaperUrl.value = ''
  wallpaperLoaded.value = true
}

function onWallpaperLoad() {
  wallpaperLoaded.value = true
}

function onWallpaperError() {
  // 本地壁纸文件缺失时不无限重试，直接回落到渐变底
  wallpaperUrl.value = ''
  wallpaperLoaded.value = true
}

onMounted(async () => {
  mounted.value = true
  applyTheme()
  updateViewport()
  systemTheme?.addEventListener?.('change', onSystemThemeChange)
  window.addEventListener('resize', scheduleViewport)
  window.addEventListener('orientationchange', scheduleViewport)
  window.visualViewport?.addEventListener('resize', scheduleViewport)
  window.visualViewport?.addEventListener('scroll', scheduleViewport)
  document.addEventListener('focusin', scheduleViewport)
  document.addEventListener('focusout', scheduleViewport)
  if (userStore.token) {
    await userStore.fetchUser()
    if (userStore.isLoggedIn) {
      await Promise.all([wallStore.fetchMyWalls(), settingsStore.loadSettings()])
    }
  }
  if (mounted.value) getRandomWallpaper()
})
onBeforeUnmount(() => {
  mounted.value = false
  wallpaperRequest++
  systemTheme?.removeEventListener?.('change', onSystemThemeChange)
  window.removeEventListener('resize', scheduleViewport)
  window.removeEventListener('orientationchange', scheduleViewport)
  window.visualViewport?.removeEventListener('resize', scheduleViewport)
  window.visualViewport?.removeEventListener('scroll', scheduleViewport)
  document.removeEventListener('focusin', scheduleViewport)
  document.removeEventListener('focusout', scheduleViewport)
  if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
  for (const name of viewportProperties) document.documentElement.style.removeProperty(name)
  delete document.documentElement.dataset.keyboardOpen
  delete document.documentElement.dataset.appLayout
})
</script>

<template>
  <div class="app-container" :class="{ 'app-conversation': isConversationLayout }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>

    <div v-if="wallpaperEnabled" class="bg-wallpaper" :class="{ loaded: wallpaperLoaded }">
      <img
        v-if="wallpaperUrl"
        :src="wallpaperUrl"
        @load="onWallpaperLoad"
        @error="onWallpaperError"
        alt=""
        class="wallpaper-img"
      />
      <div class="wallpaper-overlay"></div>
    </div>

    <div class="bg-gradient"></div>

    <Navbar
      @change-wallpaper="getRandomWallpaper"
      @toggle-theme="toggleTheme"
      :theme="currentTheme"
      :theme-mode="themeMode"
      :theme-saving="themeSaving"
    />
    <main id="main-content" ref="mainRef" tabindex="-1" class="main-content" :class="{ 'main-wide': isWideLayout, 'main-conversation': isConversationLayout, 'main-settings': isSettingsLayout }">
      <router-view v-slot="{ Component, route }">
        <!-- key 必须是 route.name 而不是 route.fullPath：
             放在 keep-alive 内部的组件一旦 key 变化就会被视为不同组件而强制重建，
             用 fullPath 会让带 query / 参数的同一页面（如 /post/1 -> /post/2）也重建，
             更致命的是 Home 等页面每次路径变化都重建，keep-alive 等于完全失效。 -->
        <keep-alive :key="cacheScope" :include="['Home', 'Votes', 'Chat', 'Inbox']" :max="5">
          <component :is="Component" :key="route.name || route.path" />
        </keep-alive>
      </router-view>
    </main>

    <ToastContainer />
    <BackToTop v-if="!isConversationLayout" />
    <PublishFab />
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  min-height: 100dvh;
  position: relative;
}

/* Skip link：键盘用户按下 Tab 的第一个落点，可跳过顶栏直达正文 */
.skip-link {
  position: fixed;
  top: 12px;
  transform: translateY(-160%);
  left: 12px;
  z-index: 10001;
  padding: 10px 16px;
  background: var(--btn-fill);
  color: #fff;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: transform 0.2s var(--ease);
}
.skip-link:focus {
  transform: translateY(0);
  color: #fff;
}

.bg-gradient {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: radial-gradient(ellipse at top left, var(--page-ambient), var(--bg-deep) 70%);
  z-index: -3;
}

/* 亮 / 暗背景均由公共 token 控制，避免 scoped body 选择器失效。 */

.bg-wallpaper {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -2;
  opacity: 0;
  transition: opacity 1s ease;
}

.bg-wallpaper.loaded {
  opacity: 1;
}

.wallpaper-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: var(--wallpaper-image-filter);
  opacity: var(--wallpaper-image-opacity);
}

.wallpaper-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  /* 保留可辨认的原图，正文的对比度由卡片表面承担。 */
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-deep) var(--wallpaper-overlay-top), transparent) 0%,
    color-mix(in srgb, var(--bg-deep) var(--wallpaper-overlay-bottom), transparent) 100%
  );
}

.main-content {
  max-width: var(--container);
  margin: 0 auto;
  outline: none;
  width: 100%;
  min-width: 0;
  scroll-margin-top: var(--app-header-height);
  padding: calc(var(--app-header-height) + var(--page-top-gap)) max(var(--space-4), var(--safe-area-right)) max(var(--space-6), calc(88px + var(--safe-area-bottom))) max(var(--space-4), var(--safe-area-left));
}

/* 主页两侧栏保持等宽，侧栏合计宽度不变，正文阅读宽度保持稳定。 */
.main-wide {
  max-width: var(--container-wide);
}
.main-settings { max-width: var(--container-wide); }
.main-content.main-conversation {
  position: fixed;
  inset-inline: 0;
  top: var(--visual-viewport-offset-top);
  height: var(--visual-viewport-height);
  min-height: 0;
  max-width: var(--container);
  padding-top: calc(var(--app-header-height) + var(--conversation-gap));
  padding-bottom: 0;
  display: flex;
  flex-direction: column;
}
.main-conversation > * { min-height: 0; min-width: 0; flex: 1; }
.app-conversation :deep(.navbar) { top: var(--visual-viewport-offset-top); }
@media (max-width: 768px) {
  .main-content { padding-inline: max(12px, var(--safe-area-left)) max(12px, var(--safe-area-right)); padding-top: calc(var(--app-header-height) + var(--page-top-gap)); }
}
@media (max-width: 360px) {
  .main-content { padding-inline: max(8px, var(--safe-area-left)) max(8px, var(--safe-area-right)); }
}
</style>
