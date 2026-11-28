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
import { focusIfActive } from './utils/focus.js'

const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const mainRef = ref(null)
// 身份或校园墙变化时销毁旧缓存，避免显示前一会话的私信与帖子。
const cacheScope = computed(() => [userStore.sessionRevision, userStore.user?.id || 'guest', wallStore.currentWallId || 'none'].join(':'))
watch(() => route.path, async () => {
  await nextTick()
  focusIfActive(mainRef.value)
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
const wallpaperImageRef = ref(null)
const wallpaperRenderRequest = ref(0)
const wallpaperNotice = ref('')
// 随项目发布的有限兜底资源；不依赖壁纸元数据 API。
const localWallpaperFallbacks = ['/rele/1.jpg', '/rele/2.jpg', '/rele/3.jpg', '/rele/4.png']
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
const wallpaperSource = computed(() => settingsStore.prefs.wallpaper_source === 'local' ? 'local' : 'bing')
const wallpaperNoticeMessage = computed(() => {
  if (wallpaperNotice.value === 'fallback') return '必应壁纸暂不可用，已改用本地壁纸。'
  if (wallpaperNotice.value === 'local-fallback') return '壁纸服务暂不可用，已使用内置本地壁纸。'
  if (wallpaperNotice.value === 'retained') return '壁纸加载失败，已保留当前壁纸。'
  if (wallpaperNotice.value === 'unavailable') return '壁纸暂不可用，已显示主题背景。'
  return ''
})
let wallpaperRequest = 0
let wallpaperAbort = null
let wallpaperPreloadCancel = null
let wallpaperInitializing = false
let wallpaperIndex = 0
let wallpaperTotal = 0
let wallpaperActualSource = 'bing'
let wallpaperAttemptedUrls = new Set()
let wallpaperAttemptedSources = new Set()

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
watch([wallpaperEnabled, wallpaperSource], ([enabled]) => {
  if (enabled && mounted.value && !wallpaperInitializing) getRandomWallpaper()
  else if (!enabled) {
    wallpaperRequest++
    cancelWallpaperWork()
    wallpaperUrl.value = ''
    wallpaperLoaded.value = false
    wallpaperNotice.value = ''
    wallpaperTotal = 0
  }
}, { flush: 'sync' })

function cancelWallpaperWork() {
  wallpaperAbort?.abort()
  wallpaperAbort = null
  wallpaperPreloadCancel?.()
  wallpaperPreloadCancel = null
}

function safeWallpaperUrl(value) {
  if (typeof value !== 'string') throw new Error('Missing wallpaper URL')
  const url = new URL(value, window.location.origin)
  if (url.origin !== window.location.origin || url.username || url.password || url.search || url.hash) throw new Error('Invalid wallpaper origin')
  const bing = /^\/api\/wallpaper\/image\/[a-f0-9]{64}\.jpg$/.test(url.pathname)
  const local = /^\/rele\/[^/]+\.(jpe?g|png|gif|webp|bmp)$/i.test(url.pathname)
  const name = decodeURIComponent(url.pathname.split('/').pop())
  if ((!bing && !local) || /[/\\\u0000-\u001f]/.test(name) || name.startsWith('.')) throw new Error('Invalid wallpaper path')
  return url.href
}

function preloadWallpaper(url) {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    let finished = false
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      image.onload = image.onerror = null
      if (wallpaperPreloadCancel === cancel) wallpaperPreloadCancel = null
      if (error) { image.removeAttribute?.('src'); reject(error) }
      else resolve()
    }
    const cancel = () => finish(new Error('Wallpaper request superseded'))
    const timer = setTimeout(() => finish(new Error('Wallpaper image timed out')), 6000)
    wallpaperPreloadCancel = cancel
    image.onload = async () => {
      try { if (image.decode) await image.decode(); finish() }
      catch { finish(new Error('Wallpaper image cannot be decoded')) }
    }
    image.onerror = () => finish(new Error('Wallpaper image failed to load'))
    image.src = url
    if (image.complete && image.naturalWidth > 0) image.onload()
  })
}

async function getRandomWallpaper(rotate = false, forceLocal = false, recovering = false) {
  if (!wallpaperEnabled.value || !mounted.value) return
  const requestId = ++wallpaperRequest
  cancelWallpaperWork()
  const controller = new AbortController()
  wallpaperAbort = controller
  // 渲染失败的恢复沿用本轮记录，每个来源、URL 最多尝试一次，避免 error 重试循环。
  if (!recovering) {
    wallpaperAttemptedUrls = new Set()
    wallpaperAttemptedSources = new Set()
  }
  const attemptedUrls = wallpaperAttemptedUrls
  const attemptedSources = wallpaperAttemptedSources
  const isCurrent = () => requestId === wallpaperRequest && wallpaperEnabled.value && mounted.value && !controller.signal.aborted
  const preferredSource = wallpaperSource.value
  // 自动回退后，换图沿实际本地图库轮换；刷新或切换来源时重试首选来源。
  const useLocal = forceLocal || preferredSource === 'local' || (rotate && wallpaperActualSource === 'local')
  const sources = useLocal ? ['local'] : ['bing', 'local']
  const nextIndex = rotate && wallpaperTotal ? (wallpaperIndex + 1) % wallpaperTotal : undefined
  const activate = async (value, details, directFallback = false) => {
    const url = safeWallpaperUrl(value)
    if (attemptedUrls.has(url)) return false
    attemptedUrls.add(url)
    // 图片已解码才替换当前壁纸；加载失败时保留已经显示的背景。
    if (url !== wallpaperUrl.value) await preloadWallpaper(url)
    if (!isCurrent()) return false
    wallpaperRenderRequest.value = requestId
    wallpaperUrl.value = url
    wallpaperLoaded.value = true
    wallpaperIndex = Number.isInteger(details?.idx) && details.idx >= 0 ? details.idx : 0
    wallpaperTotal = Number.isInteger(details?.total) && details.total > 0 ? details.total : 0
    wallpaperActualSource = new URL(url).pathname.startsWith('/rele/') ? 'local' : 'bing'
    wallpaperNotice.value = directFallback ? 'local-fallback' : (preferredSource === 'bing' && wallpaperActualSource === 'local' ? 'fallback' : '')
    return true
  }
  try {
    for (const source of sources) {
      if (!isCurrent()) return
      if (attemptedSources.has(source)) continue
      attemptedSources.add(source)
      try {
        const params = { source }
        if (nextIndex !== undefined) params.idx = nextIndex
        const res = await api.get('/wallpaper', { params, signal: controller.signal, timeout: 8000 })
        if (!isCurrent()) return
        if (await activate(res.data?.url, res.data)) return
      } catch {
        if (!isCurrent()) return
      }
    }
    // API 不可用不代表静态资源不可用；仅尝试随项目发布的这四张图片。
    const start = nextIndex === undefined ? 0 : nextIndex % localWallpaperFallbacks.length
    for (let offset = 0; offset < localWallpaperFallbacks.length; offset++) {
      if (!isCurrent()) return
      const idx = (start + offset) % localWallpaperFallbacks.length
      try {
        if (await activate(localWallpaperFallbacks[idx], { idx, total: localWallpaperFallbacks.length }, true)) return
      } catch {
        if (!isCurrent()) return
      }
    }
    if (isCurrent()) {
      wallpaperLoaded.value = true
      wallpaperNotice.value = wallpaperUrl.value ? 'retained' : 'unavailable'
    }
  } finally {
    if (wallpaperAbort === controller) wallpaperAbort = null
  }
}

function isCurrentWallpaperEvent(event) {
  const target = event?.target
  return mounted.value && wallpaperEnabled.value && wallpaperRenderRequest.value === wallpaperRequest &&
    target && target === wallpaperImageRef.value &&
    (target.currentSrc || target.src) === wallpaperUrl.value
}

function onWallpaperLoad(event) {
  if (isCurrentWallpaperEvent(event)) wallpaperLoaded.value = true
}

function onWallpaperError(event) {
  if (!isCurrentWallpaperEvent(event)) return
  wallpaperAttemptedUrls.add(wallpaperUrl.value)
  wallpaperUrl.value = ''
  wallpaperLoaded.value = false
  getRandomWallpaper(false, true, true)
}

onMounted(async () => {
  mounted.value = true
  wallpaperInitializing = true
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
  wallpaperInitializing = false
  if (mounted.value) getRandomWallpaper()
})
onBeforeUnmount(() => {
  mounted.value = false
  wallpaperRequest++
  cancelWallpaperWork()
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
        :key="wallpaperRenderRequest"
        ref="wallpaperImageRef"
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
      @change-wallpaper="getRandomWallpaper(true)"
      @toggle-theme="toggleTheme"
      :theme="currentTheme"
      :theme-mode="themeMode"
      :theme-saving="themeSaving"
    />
    <main id="main-content" ref="mainRef" tabindex="-1" class="main-content" :class="{ 'main-wide': isWideLayout, 'main-conversation': isConversationLayout, 'main-settings': isSettingsLayout }">
      <p v-if="wallpaperEnabled && wallpaperNoticeMessage" class="wallpaper-notice" role="status" aria-live="polite" aria-atomic="true">{{ wallpaperNoticeMessage }}</p>
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

.wallpaper-notice {
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-card-solid);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
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
.main-conversation > .wallpaper-notice { flex: 0 0 auto; }
.app-conversation :deep(.navbar) { top: var(--visual-viewport-offset-top); }
@media (max-width: 768px) {
  .main-content { padding-inline: max(12px, var(--safe-area-left)) max(12px, var(--safe-area-right)); padding-top: calc(var(--app-header-height) + var(--page-top-gap)); }
}
@media (max-width: 360px) {
  .main-content { padding-inline: max(8px, var(--safe-area-left)) max(8px, var(--safe-area-right)); }
}
</style>
