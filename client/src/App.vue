<script setup>
import { ref, computed, onMounted, provide, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from './stores/user'
import { useWallStore } from './stores/wall'
import { useSettingsStore } from './stores/settings'
import Navbar from './components/Navbar.vue'
import ToastContainer from './components/ToastContainer.vue'
import BackToTop from './components/BackToTop.vue'
import PublishFab from './components/PublishFab.vue'
import api from './api'

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

const wallpaperUrl = ref('')
const wallpaperLoaded = ref(false)
function initialTheme() {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
const currentTheme = ref(initialTheme())
let wallpaperRequest = 0

// 主题管理
function toggleTheme() {
  currentTheme.value = currentTheme.value === 'dark' ? 'light' : 'dark'
  try { localStorage.setItem('theme', currentTheme.value) } catch {}
  applyTheme()
}

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

provide('theme', { current: currentTheme, toggle: toggleTheme })

async function getRandomWallpaper() {
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
  applyTheme()
  if (userStore.token) {
    await userStore.fetchUser()
    if (userStore.isLoggedIn) {
      wallStore.fetchMyWalls()
      settingsStore.loadSettings()
    }
  }
  getRandomWallpaper()
})
</script>

<template>
  <div class="app-container">
    <a class="skip-link" href="#main-content">跳到主要内容</a>

    <div class="bg-wallpaper" :class="{ loaded: wallpaperLoaded }">
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
    />
    <main id="main-content" ref="mainRef" tabindex="-1" class="main-content" :class="{ 'main-wide': isWideLayout }">
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
    <BackToTop />
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
  filter: blur(2px) brightness(0.68);
  opacity: 0.22;
}

.wallpaper-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  /* 壁纸作为低对比背景纹理，避免抢占帖子与状态文字的阅读层级。 */
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-deep) 80%, transparent) 0%,
    color-mix(in srgb, var(--bg-deep) 95%, transparent) 100%
  );
}

.main-content {
  max-width: var(--container);
  margin: 0 auto;
  outline: none;
  scroll-margin-top: 80px;
  padding: 84px var(--space-4) var(--space-6);
}

/* 主页专用：加宽到 1280px 好放下左右两栏。
   两侧栏（140 + 280 + 32 间距）全部来自原先浪费掉的留白，
   中间帖子列宽度与改动前基本一致（约 796px vs 812px），正文观感不变。 */
.main-wide {
  max-width: var(--container-wide);
}
</style>
