<script setup>
import { ref, computed, onMounted, provide } from 'vue'
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

// 主页要用三栏（左分类 / 帖子 / 右墙介绍），需要比其它页面更宽的容器；
// 其余页面维持 1000px 单栏，避免正文行宽过长。
const isWideLayout = computed(() => route.name === 'Home')

const wallpaperUrl = ref('')
const wallpaperLoaded = ref(false)
const currentTheme = ref(localStorage.getItem('theme') || 'dark')

// 主题管理
function toggleTheme() {
  currentTheme.value = currentTheme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', currentTheme.value)
  applyTheme()
}

function applyTheme() {
  if (currentTheme.value === 'light') {
    document.body.classList.add('light-theme')
  } else {
    document.body.classList.remove('light-theme')
  }
}

provide('theme', { current: currentTheme, toggle: toggleTheme })

async function getRandomWallpaper() {
  wallpaperLoaded.value = false
  // 先请求本地壁纸服务：本地图片可控、无第三方依赖、断网也能出图。
  // 原实现把外部 Bing 接口写在一个 try{...return} 里 —— 该 try 永远不可能抛错，
  // 于是 return 一定执行，下面的 api.get('/wallpaper') 属于永远跑不到的死代码，
  // onWallpaperError 的兜底也被这条死路径架空。
  try {
    const res = await api.get('/wallpaper')
    if (res.data?.url) {
      wallpaperUrl.value = res.data.url + '?t=' + Date.now()
      return
    }
  } catch (e) {}
  // 本地取不到再退回主题色渐变底（bg-gradient 常驻，视觉上不会空白）
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
    <main id="main-content" class="main-content" :class="{ 'main-wide': isWideLayout }">
      <router-view v-slot="{ Component, route }">
        <!-- key 必须是 route.name 而不是 route.fullPath：
             放在 keep-alive 内部的组件一旦 key 变化就会被视为不同组件而强制重建，
             用 fullPath 会让带 query / 参数的同一页面（如 /post/1 -> /post/2）也重建，
             更致命的是 Home 等页面每次路径变化都重建，keep-alive 等于完全失效。 -->
        <keep-alive :include="['Home', 'Votes', 'Chat', 'Inbox']" :max="5">
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
  position: relative;
}

/* Skip link：键盘用户按下 Tab 的第一个落点，可跳过顶栏直达正文 */
.skip-link {
  position: absolute;
  top: -60px;
  left: 12px;
  z-index: 10001;
  padding: 10px 16px;
  background: var(--btn-fill);
  color: #fff;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: top 0.2s var(--ease);
}
.skip-link:focus {
  top: 12px;
}

.bg-gradient {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  z-index: -3;
}

body.light-theme .bg-gradient {
  background: linear-gradient(135deg, #e8ecf1 0%, #dce3ea 50%, #e0e7ef 100%);
}

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
  filter: blur(2px) brightness(0.7);
}

.wallpaper-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  /* 壁纸叠加层：同色系单向渐变，跟随主题色（原来是靛蓝→紫→粉的三色斜向渐变） */
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent-1) 38%, transparent) 0%,
    color-mix(in srgb, var(--accent-2) 26%, transparent) 100%
  );
}

.main-content {
  max-width: var(--container);
  margin: 0 auto;
  padding: 80px var(--space-4) var(--space-6);
}

/* 主页专用：加宽到 1280px 好放下左右两栏。
   两侧栏（140 + 280 + 32 间距）全部来自原先浪费掉的留白，
   中间帖子列宽度与改动前基本一致（约 796px vs 812px），正文观感不变。 */
.main-wide {
  max-width: var(--container-wide);
}
</style>
