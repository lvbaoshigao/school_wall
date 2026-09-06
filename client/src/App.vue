<script setup>
import { ref, computed, onMounted, provide } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from './stores/user'
import { useWallStore } from './stores/wall'
import { useSettingsStore } from './stores/settings'
import Navbar from './components/Navbar.vue'
import ToastContainer from './components/ToastContainer.vue'
import BackToTop from './components/BackToTop.vue'
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
  // 优先使用外部 Bing 壁纸 API
  try {
    const testUrl = 'https://bingw.jasonzeng.dev/?index=random&t=' + Date.now()
    wallpaperUrl.value = testUrl
    return
  } catch (e) {}
  // Fallback: 使用本地壁纸
  try {
    const res = await api.get('/wallpaper')
    if (res.data.url) {
      wallpaperUrl.value = res.data.url + '?t=' + Date.now()
    }
  } catch (e) {}
}

function onWallpaperLoad() {
  wallpaperLoaded.value = true
}

function onWallpaperError() {
  api.get('/wallpaper').then(res => {
    if (res.data.url) {
      wallpaperUrl.value = res.data.url + '?t=' + Date.now()
    } else {
      wallpaperLoaded.value = true
    }
  }).catch(() => {
    wallpaperLoaded.value = true
  })
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
    <main class="main-content" :class="{ 'main-wide': isWideLayout }">
      <router-view v-slot="{ Component, route }">
        <keep-alive :include="['Home', 'Votes', 'Chat', 'Inbox']" :max="5">
          <component :is="Component" :key="route.fullPath" />
        </keep-alive>
      </router-view>
    </main>

    <ToastContainer />
    <BackToTop />
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  position: relative;
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
  max-width: 1000px;
  margin: 0 auto;
  padding: 80px 16px 32px;
}

/* 主页专用：加宽到 1280px 好放下左右两栏。
   两侧栏（140 + 280 + 32 间距）全部来自原先浪费掉的留白，
   中间帖子列宽度与改动前基本一致（约 796px vs 812px），正文观感不变。 */
.main-wide {
  max-width: 1280px;
}
</style>
