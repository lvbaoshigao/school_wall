<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useSettingsStore } from '../stores/settings'
import { useRouter } from 'vue-router'
import api from '../api'
import AvatarIcon from './AvatarIcon.vue'
import Icon from './Icon.vue'
import { useMarkdown } from '../composables/useMarkdown'
import { useToast } from '../composables/useToast'
import { useFocusTrap } from '../composables/useFocusTrap'
import { observeScrollProgress } from '../composables/useScrollProgress'

const emit = defineEmits(['change-wallpaper', 'toggle-theme'])
const props = defineProps({
  theme: { type: String, default: 'dark' },
  themeMode: { type: String, default: 'system' },
  themeSaving: { type: Boolean, default: false },
})

const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const { renderMarkdown, truncateText } = useMarkdown()
const toast = useToast()

const navRef = ref(null)
const mobileToggleRef = ref(null)
const showMenu = ref(false)
const openDropdown = ref('')
const showWallMenu = ref(false)
const showMobileMenu = ref(false)
const searchQuery = ref('')
const showSearchMenu = ref(false)
const unreadCount = ref(0)
const unreadChat = ref(0)
const unreadTreeHole = ref(0)
const unreadSystem = ref(0)
const unreadAnnouncement = ref(0)
let unreadTimer = null
let stopScrollProgress = null

const isLoggedIn = computed(() => userStore.isLoggedIn)
const user = computed(() => userStore.user)
const currentWall = computed(() => wallStore.currentWall)
const myWalls = computed(() => wallStore.myWalls.filter(wall => !wall.member_status || wall.member_status === 'active'))
const unreadScope = computed(() => [userStore.sessionRevision, userStore.user?.id, wallStore.currentWallId].join(':'))
const primaryKeys = new Set(['home', 'publish', 'chat', 'inbox'])
const primaryNav = computed(() => settingsStore.visibleNav.filter(item => primaryKeys.has(item.key)))
const secondaryNav = computed(() => settingsStore.visibleNav.filter(item => !primaryKeys.has(item.key) && item.type !== 'search'))
const moreActive = computed(() => secondaryNav.value.some(item => item.type === 'link' ? isActive(item) : item.children?.some(child => isActive(child))))
function disableLeavingPanel(element) { element.setAttribute('inert', '') }
// 树洞入口按「在当前墙是否拥有树洞权限」显示。
// 重构前这里还带了 || isGlobalAdmin，但服务端从来只认 wall_members.wall_role ——
// 不是志愿者的全局管理员点进去只会看到空队列、接入时 403，属于死入口，这次一并去掉。
const canSeeTreeHole = computed(() => wallStore.canHere('wall.tree_hole'))

// 管理后台：只要在全局或当前墙里有任何一项管理能力就显示
const canOpenAdmin = computed(() =>
  userStore.can('global.moderate') || userStore.can('global.user.manage') ||
  wallStore.canHere('wall.stats.view') || wallStore.canHere('wall.member.view'))

function selectWall(id) {
  if (!wallStore.switchWall(id)) {
    toast.error('无法切换到此校园墙，请刷新列表后重试')
    return
  }
  closeMenus()
  router.push('/')
}

async function fetchUnread() {
  if (!userStore.isLoggedIn) return
  const scope = unreadScope.value
  try {
    const res = await api.get('/messages/unread-count')
    if (scope !== unreadScope.value || !userStore.isLoggedIn) return
    unreadCount.value = res.data.count || 0
    unreadChat.value = res.data.chat || 0
    unreadTreeHole.value = res.data.treeHole || 0
    unreadSystem.value = res.data.system || 0
    unreadAnnouncement.value = res.data.announcement || 0
  } catch {}
}

// 轮询间隔来自「设置 → 通知与提醒 → 未读检查频率」；'0' 表示只在进页面时查一次
function restartUnreadTimer() {
  clearInterval(unreadTimer)
  unreadTimer = null
  const seconds = parseInt(settingsStore.prefs.unread_interval, 10)
  if (Number.isFinite(seconds) && seconds > 0) {
    unreadTimer = setInterval(fetchUnread, seconds * 1000)
  }
}

// 点击下拉菜单外部时收起所有打开的菜单（墙切换 / 发布类下拉 / 头像菜单）。
// 此前完全没有外部关闭逻辑：点开后再点页面空白处，菜单会一直挂着。
// 捕获阶段执行，先于按钮自身的 click；点在 dropdown-wrapper 内则放行给原有逻辑。
function closeMenus() {
  showWallMenu.value = false
  showMenu.value = false
  openDropdown.value = ''
  showSearchMenu.value = false
  showMobileMenu.value = false
}

function toggleNavMenu(key) {
  const wasOpen = key === 'wall' ? showWallMenu.value : key === 'account' ? showMenu.value : openDropdown.value === key
  closeMenus()
  if (key === 'wall') showWallMenu.value = !wasOpen
  else if (key === 'account') showMenu.value = !wasOpen
  else openDropdown.value = wasOpen ? '' : key
}

function onDocClick(event) {
  if (navRef.value?.contains(event.target) && event.target?.closest?.('.dropdown-wrapper, .mobile-menu, .mobile-menu-btn')) return
  closeMenus()
}

function onNavKeydown(event) {
  const wrapper = event.target.closest?.('.dropdown-wrapper')
  if (event.key === 'Escape') {
    const mobileWasOpen = showMobileMenu.value
    if (!mobileWasOpen && !showMenu.value && !showWallMenu.value && !openDropdown.value && !showSearchMenu.value) return
    event.preventDefault()
    closeMenus()
    if (mobileWasOpen) mobileToggleRef.value?.focus()
    else wrapper?.querySelector('button, input')?.focus()
  } else if (event.key === 'ArrowDown' && wrapper && event.target.matches('button[aria-expanded="true"]')) {
    event.preventDefault()
    wrapper.querySelector('.dropdown button')?.focus()
  }
}

function onNavFocusout(event) {
  const wrapper = event.target.closest?.('.dropdown-wrapper')
  if (wrapper && !wrapper.contains(event.relatedTarget)) {
    showMenu.value = false
    showWallMenu.value = false
    openDropdown.value = ''
    showSearchMenu.value = false
  }
  if (!navRef.value?.contains(event.relatedTarget)) showMobileMenu.value = false
}

function onResize() {
  if (window.innerWidth > 1120) showMobileMenu.value = false
}

onMounted(() => {
  stopScrollProgress = observeScrollProgress(navRef.value)
  document.addEventListener('click', onDocClick, true)
  window.addEventListener('resize', onResize)
  if (userStore.isLoggedIn) {
    fetchUnread()
    restartUnreadTimer()
  }
})

// 改完设置立即生效，不需要刷新
watch(() => settingsStore.prefs.unread_interval, () => {
  if (userStore.isLoggedIn) restartUnreadTimer()
})
watch(unreadScope, () => {
  clearInterval(unreadTimer)
  unreadCount.value = unreadChat.value = unreadTreeHole.value = unreadSystem.value = unreadAnnouncement.value = 0
  closeMenus()
  closeAnnouncements()
  if (userStore.isLoggedIn) { fetchUnread(); restartUnreadTimer() }
})
watch(() => router.currentRoute.value.fullPath, closeMenus)

onUnmounted(() => {
  stopScrollProgress?.()
  document.removeEventListener('click', onDocClick, true)
  window.removeEventListener('resize', onResize)
  clearInterval(unreadTimer)
})

function logout() {
  userStore.logout()
  showMenu.value = false
  showMobileMenu.value = false
  router.push('/login')
}

function toggleDropdown(key) {
  toggleNavMenu(key)
}

function go(path) {
  showMenu.value = false
  openDropdown.value = ''
  showWallMenu.value = false
  showMobileMenu.value = false
  router.push(path)
}

function goSearch() {
  const q = (searchQuery.value || '').trim()
  showSearchMenu.value = false
  if (!q) return
  // 新码是 8 位十六进制（4 字节随机），旧码 4 位，两种都要能识别
  if (/^RPT-\d{4}(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{4})$/i.test(q)) {
    router.push(`/report/status/${q.toUpperCase()}`)
  } else {
    router.push({ path: '/search', query: { q } })
  }
}

function isActive(item) {
  const p = router.currentRoute.value.path
  if (item.path === '/') return p === '/'
  return p === item.path || p.startsWith(item.path + '/')
}

function changeWallpaper() {
  emit('change-wallpaper')
  showMobileMenu.value = false
}

// 先用 Authorization 头换一张种在 HttpOnly Cookie 里的短期票据，再开窗。
// 早先是 window.open('/dashboard?token=' + token)，管理员 JWT 会被 nginx 记进访问日志。
async function openDashboard() {
  try {
    await api.post('/dashboard/session')
    window.open('/dashboard', '_blank', 'noopener,noreferrer')
  } catch {
    toast.error('无法打开管理后台，请重新登录后再试')
  }
}

const mobileBack = computed(() => ({
  ChatRoom: { path: '/chat', label: '返回聊天列表' },
  TreeHoleChat: { path: '/tree-hole/list', label: '返回匿名会话列表' },
  Settings: { path: '/', label: '返回校园动态' },
  PostDetail: { path: '/', label: '返回校园动态' },
})[router.currentRoute.value.name] || null)
const userAvatar = computed(() => user.value?.avatar || '')
// 模板里 4 处引用但此前从未定义 —— 用户名与头像 alt 一直渲染为空
const userName = computed(() => user.value?.nickname || user.value?.username || '用户')

// 公告弹窗
const showAnnouncementModal = ref(false)
const announcementList = ref([])
const announcementLoading = ref(false)
const announcementError = ref('')
let announcementRequest = 0
const showAnnDetail = ref(false)
const selectedAnn = ref(null)
const annModalRef = ref(null)
// 弹窗焦点管理：打开移入焦点、Tab 锁在弹层内、Esc 关闭、关闭后焦点还给公告按钮。
// 此前公告弹窗没有这套处理，键盘用户会被困在弹窗背后的页面里。
useFocusTrap(showAnnouncementModal, annModalRef, closeAnnouncements)

async function fetchAnnouncements() {
  const request = ++announcementRequest
  const scope = unreadScope.value
  announcementLoading.value = true
  announcementError.value = ''
  try {
    const res = await api.get('/announcements')
    if (request !== announcementRequest || scope !== unreadScope.value) return
    if (!Array.isArray(res.data)) throw new Error('Invalid announcements')
    announcementList.value = res.data
    // 仅在实际读取成功后标记，失败时保留未读提示。
    api.put('/messages/read-all', { type: 'announcement' }).then(() => {
      if (scope === unreadScope.value) unreadAnnouncement.value = 0
    }).catch(() => {})
  } catch {
    if (request === announcementRequest && scope === unreadScope.value) announcementError.value = '公告加载失败，请检查网络后重试'
  } finally {
    if (request === announcementRequest) announcementLoading.value = false
  }
}

function openAnnouncements() {
  if (showMobileMenu.value) mobileToggleRef.value?.focus()
  closeMenus()
  showAnnouncementModal.value = true
  fetchAnnouncements()
}

function closeAnnouncements() {
  announcementRequest++
  announcementLoading.value = false
  showAnnouncementModal.value = false
  showAnnDetail.value = false
  selectedAnn.value = null
}

function openAnnDetail(ann) {
  selectedAnn.value = ann
  showAnnDetail.value = true
}

function renderAnnouncement(content) {
  return renderMarkdown(content)
}
</script>

<template>
  <nav ref="navRef" class="navbar" :class="{ 'menu-open': showMobileMenu }" aria-label="主导航" @keydown="onNavKeydown" @focusout="onNavFocusout">
    <div class="nav-inner">
      <!-- 左：已登录显示墙切换器（取代原 logo），未登录显示 logo -->
      <div class="nav-left">
        <button v-if="mobileBack" class="nav-btn nav-icon-btn nav-back mobile-only" :aria-label="mobileBack.label" :title="mobileBack.label" @click="go(mobileBack.path)"><Icon name="chevron-left" :size="20" /></button>
        <div v-if="isLoggedIn" class="dropdown-wrapper wall-switcher">
          <button class="wall-btn" aria-controls="nav-wall-menu" :aria-expanded="showWallMenu" @click="toggleNavMenu('wall')" :title="currentWall?.name || currentWall?.description || '切换校园墙'"
                  :aria-label="(currentWall?.name || '选择校园墙') + '，切换校园墙'">
            <Icon name="school" :size="15" />
            <span class="wall-name">{{ currentWall?.name || '选择校园墙' }}</span>
            <Icon name="chevron-down" :size="14" />
          </button>
          <Transition name="nav-scale" @before-leave="disableLeavingPanel">
          <div v-if="showWallMenu" id="nav-wall-menu" class="dropdown wall-dropdown">
            <div class="dropdown-header"><strong>我的校园墙</strong></div>
            <div class="dropdown-divider"></div>
            <button v-for="w in myWalls" :key="w.id" class="dropdown-item wall-item"
                    :class="{ active: w.id === wallStore.currentWallId }" @click="selectWall(w.id)">
              {{ w.name }}
              <Icon v-if="w.id === wallStore.currentWallId" class="check" name="check" :size="15" label="当前校园墙" />
            </button>
            <div v-if="myWalls.length === 0" class="dropdown-item text-muted">暂未加入任何墙</div>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" @click="go('/walls')">加入 / 申请建墙</button>
          </div>
          </Transition>
        </div>
        <router-link v-else to="/" class="logo" @click="showMobileMenu = false">
          <Icon name="school" :size="20" />校园墙
        </router-link>

        <!-- 主题 / 壁纸放在左侧：右栏已经排了导航项和头像，是最挤的一栏；
             这两个按钮与「当前在看哪个墙」一样属于视图级开关，归到左边也更成组。 -->
        <div class="nav-tools desktop-only">
          <button v-if="isLoggedIn" class="nav-btn nav-icon-btn ann-btn" @click="openAnnouncements"
                  title="公告" aria-label="公告">
            <Icon name="megaphone" :size="17" />
            <span v-if="unreadAnnouncement > 0" class="ann-dot" role="status" :aria-label="`${unreadAnnouncement} 条未读公告`"></span>
          </button>
          <button v-if="settingsStore.tools.theme" class="nav-btn nav-icon-btn" :disabled="props.themeSaving" @click="emit('toggle-theme')"
                  :title="props.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'"
                  :aria-label="props.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'">
            <Icon :name="props.theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </button>
          <button v-if="settingsStore.tools.wallpaper && settingsStore.prefs.wallpaper_enabled !== false" class="nav-btn nav-icon-btn" @click="changeWallpaper"
                  title="换壁纸" aria-label="换壁纸">
            <Icon name="image" :size="17" />
          </button>
        </div>
      </div>

      <!-- 中：帖子搜索框，只在主页显示 -->
      <div class="nav-center desktop-only">
        <div v-if="isLoggedIn && settingsStore.nav.search !== false && router.currentRoute.value.path === '/'" class="nav-search dropdown-wrapper">
          <div class="search-input-wrap">
            <Icon class="search-icon" name="search" :size="15" />
            <input
              v-model="searchQuery"
              type="search"
              aria-label="搜索帖子"
              placeholder="搜索帖子"
              @keyup.enter="goSearch"
              @focus="showSearchMenu = true"
              aria-controls="nav-search-panel"
              aria-describedby="nav-search-help"
            />
          </div>
          <Transition name="nav-scale" @before-leave="disableLeavingPanel">
          <div v-if="showSearchMenu" id="nav-search-panel" class="dropdown search-dropdown" @mousedown.prevent>
            <div id="nav-search-help" class="search-dropdown-tip text-muted">搜索帖子内容，或输入追踪码 RPT-XXXX 查询举报进度</div>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" @click="goSearch">搜索「{{ searchQuery || '…' }}」</button>
          </div>
          </Transition>
        </div>
        <button v-else-if="isLoggedIn && settingsStore.nav.search !== false" class="nav-btn nav-search-shortcut nav-search-shortcut-visible" aria-label="搜索帖子" @click="go('/search')"><Icon name="search" :size="17" />搜索帖子</button>
      </div>

      <!-- 核心入口有固定上限；辅助入口收进更多，给等宽两翼保留可靠空间。 -->
      <div class="nav-right desktop-only">
        <template v-if="isLoggedIn">
          <div class="nav-primary-links">
            <template v-for="item in primaryNav" :key="item.key">
              <div v-if="item.type === 'dropdown'" class="dropdown-wrapper">
                <button class="nav-btn" :aria-controls="'nav-menu-' + item.key" :aria-expanded="openDropdown === item.key" @click="toggleDropdown(item.key)">
                  {{ item.label }}<Icon name="chevron-down" :size="14" />
                </button>
                <Transition name="nav-scale" @before-leave="disableLeavingPanel">
                  <div v-if="openDropdown === item.key" :id="'nav-menu-' + item.key" class="dropdown" @click="openDropdown = ''">
                    <button v-for="child in item.children" :key="child.path" class="dropdown-item" @click="go(child.path)">{{ child.label }}</button>
                  </div>
                </Transition>
              </div>
              <button v-else-if="item.type === 'link'" class="nav-btn nav-btn-with-dot" :class="{ 'nav-active': isActive(item) }" :aria-current="isActive(item) ? 'page' : undefined" @click="go(item.path)">
                {{ item.label }}
                <span v-if="item.key === 'chat' && unreadChat > 0" class="nav-dot" role="status" aria-label="有未读消息"></span>
                <span v-if="item.key === 'inbox' && unreadSystem > 0" class="nav-dot" role="status" aria-label="有未读消息"></span>
                <span v-if="item.key === 'inbox' && unreadCount > 0" class="unread-badge" role="status" :aria-label="unreadCount + ' 条未读'">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
              </button>
            </template>
            <div v-if="secondaryNav.length" class="dropdown-wrapper nav-more-wrapper">
              <button class="nav-btn" :class="{ 'nav-active': moreActive }" aria-controls="nav-more-menu" :aria-expanded="openDropdown === 'more'" @click="toggleDropdown('more')">更多<Icon name="chevron-down" :size="14" /></button>
              <Transition name="nav-scale" @before-leave="disableLeavingPanel">
                <div v-if="openDropdown === 'more'" id="nav-more-menu" class="dropdown more-dropdown">
                  <template v-for="item in secondaryNav" :key="item.key">
                    <template v-if="item.type === 'dropdown'">
                      <div class="dropdown-section-label">{{ item.label }}</div>
                      <button v-for="child in item.children" :key="child.path" class="dropdown-item" :aria-current="isActive(child) ? 'page' : undefined" @click="go(child.path)">{{ child.label }}</button>
                    </template>
                    <button v-else class="dropdown-item" :aria-current="isActive(item) ? 'page' : undefined" @click="go(item.path)">{{ item.label }}<span v-if="item.key === 'treehole' && unreadTreeHole > 0" class="nav-dot-inline" role="status" aria-label="有未读消息"></span></button>
                  </template>
                </div>
              </Transition>
            </div>
          </div>
          <div class="dropdown-wrapper nav-account-wrapper">
            <button class="avatar-btn" aria-label="账号菜单" :aria-expanded="showMenu" aria-controls="nav-account-menu" @click="toggleNavMenu('account')"><AvatarIcon :src="userAvatar" :name="userName" size="md" /></button>
            <Transition name="nav-scale" @before-leave="disableLeavingPanel">
              <div v-if="showMenu" id="nav-account-menu" class="dropdown account-dropdown" @click="showMenu = false">
                <div class="dropdown-header"><strong>{{ userName }}</strong><span class="text-muted">@{{ user?.username }}</span></div>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item" @click="go('/profile')">个人主页</button>
                <button class="dropdown-item" @click="go('/settings')">设置</button>
                <button v-if="canOpenAdmin" class="dropdown-item" @click="go('/admin')">管理后台</button>
                <button v-if="userStore.can('global.dashboard')" class="dropdown-item" @click="openDashboard">运行看板</button>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item danger" @click="logout">退出登录</button>
              </div>
            </Transition>
          </div>
        </template>
        <template v-else>
          <button class="btn btn-secondary btn-sm" @click="go('/login')">登录</button>
          <button class="btn btn-primary btn-sm" @click="go('/register')">注册</button>
        </template>
      </div>

      <!-- 移动端汉堡菜单 -->
      <button ref="mobileToggleRef" class="mobile-menu-btn mobile-only" aria-controls="nav-mobile-panel" :aria-label="showMobileMenu ? '关闭菜单' : '打开菜单'"
              :aria-expanded="showMobileMenu" @click="showMobileMenu = !showMobileMenu">
        <Icon :name="showMobileMenu ? 'close' : 'menu'" :size="22" />
      </button>
    </div>

    <!-- 移动端菜单面板 -->
    <Transition name="nav-scale" @before-leave="disableLeavingPanel">
      <div v-if="showMobileMenu" id="nav-mobile-panel" class="mobile-menu" role="group" aria-label="移动端导航">
        <template v-if="isLoggedIn">
          <div class="mobile-user-info">
            <AvatarIcon :src="userAvatar" :name="userName" size="lg" />
            <div>
              <strong>{{ userName }}</strong>
              <span class="text-muted">@{{ user?.username }}</span>
            </div>
          </div>
          <div class="mobile-divider"></div>
          <button v-if="settingsStore.tools.theme" class="mobile-item" :disabled="props.themeSaving" @click="emit('toggle-theme')">
            {{ props.theme === 'dark' ? '切换亮色' : '切换暗色' }}
          </button>
          <div class="mobile-divider"></div>
          <div class="mobile-wall-label">当前校园墙：{{ currentWall?.name || '未选择' }}</div>
          <button v-for="w in myWalls" :key="w.id" class="mobile-item wall-mobile-item"
                  :class="{ active: w.id === wallStore.currentWallId }" @click="selectWall(w.id)">
            {{ w.name }}
            <Icon v-if="w.id === wallStore.currentWallId" class="check" name="check" :size="15" label="当前校园墙" />
          </button>
          <button class="mobile-item" @click="go('/walls')">加入 / 申请建墙</button>
          <button class="mobile-item" @click="openAnnouncements">公告<span v-if="unreadAnnouncement > 0" class="unread-badge">{{ unreadAnnouncement > 99 ? '99+' : unreadAnnouncement }} 条未读</span></button>
          <button class="mobile-item" @click="go('/profile')">个人主页</button>
          <div class="mobile-divider"></div>
          <template v-for="item in settingsStore.visibleNav" :key="item.key">
            <template v-if="item.type === 'dropdown'">
              <button v-for="c in item.children" :key="c.path" class="mobile-item" @click="go(c.path)">{{ c.label }}</button>
            </template>
            <button v-else-if="item.type === 'link'" class="mobile-item" :class="{ 'mobile-active': isActive(item) }" :aria-current="isActive(item) ? 'page' : undefined" @click="go(item.path)">
              {{ item.label }}
              <span v-if="item.key === 'chat' && unreadChat > 0" class="nav-dot-inline"></span>
              <span v-if="item.key === 'treehole' && unreadTreeHole > 0" class="nav-dot-inline"></span>
              <span v-if="item.key === 'inbox' && unreadSystem > 0" class="nav-dot-inline"></span>
              <span v-if="item.key === 'inbox' && unreadCount > 0" class="unread-badge" role="status" :aria-label="`${unreadCount} 条未读`">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
            </button>
          </template>
          <button v-if="settingsStore.nav.search !== false" class="mobile-item" @click="go('/search')">搜索</button>
          <button class="mobile-item" @click="go('/settings')">设置</button>
          <button v-if="canOpenAdmin" class="mobile-item" @click="go('/admin')">管理后台</button>
          <button v-if="userStore.can('global.dashboard')" class="mobile-item" @click="openDashboard">运行看板</button>
          <button v-if="settingsStore.tools.wallpaper && settingsStore.prefs.wallpaper_enabled !== false" class="mobile-item" @click="changeWallpaper">换壁纸</button>
          <div class="mobile-divider"></div>
          <button class="mobile-item danger" @click="logout">退出登录</button>
        </template>
        <template v-else>
          <button class="mobile-item" @click="go('/login')">登录</button>
          <button class="mobile-item" @click="go('/register')">注册</button>
          <button v-if="settingsStore.tools.theme" class="mobile-item" :disabled="props.themeSaving" @click="emit('toggle-theme')">{{ props.theme === 'dark' ? '切换亮色' : '切换暗色' }}</button>
        </template>
      </div>
    </Transition>
  </nav>

  <!-- 公告弹窗 -->
  <Teleport to="body">
    <div v-if="showAnnouncementModal" class="announcement-overlay" @click.self="closeAnnouncements">
      <div ref="annModalRef" tabindex="-1" class="announcement-modal glass-strong" role="dialog" aria-modal="true" aria-label="公告">
        <div class="ann-modal-header">
          <h3>公告</h3>
          <button class="close-btn" aria-label="关闭公告" @click="closeAnnouncements"><Icon name="close" :size="17" /></button>
        </div>
        <div class="ann-modal-body">
          <div v-if="announcementLoading" class="loading" role="status" aria-live="polite">正在加载公告…</div>
          <div v-else-if="announcementError" class="state-block" role="status">
            <Icon name="alert-triangle" :size="28" />
            <p>{{ announcementError }}</p>
            <button class="btn btn-secondary" @click="fetchAnnouncements">重试</button>
          </div>
          <div v-else-if="announcementList.length === 0" class="empty-state">
            <div class="icon"><Icon name="megaphone" :size="34" /></div>
            <p>暂无公告</p>
          </div>
          <div v-else-if="showAnnDetail && selectedAnn" class="ann-detail-view">
            <button class="btn btn-secondary btn-sm" @click="showAnnDetail = false">
              <Icon name="chevron-left" :size="14" />返回列表
            </button>
            <div class="ann-detail-item">
              <div class="ann-item-header">
                <strong>{{ selectedAnn.title }}</strong>
                <span class="text-muted" style="font-size:12px">{{ new Date(selectedAnn.created_at).toLocaleDateString() }}</span>
              </div>
              <div class="ann-item-body md-body" v-html="renderAnnouncement(selectedAnn.content)"></div>
              <div class="ann-item-footer text-muted">—— {{ selectedAnn.author_name }}</div>
            </div>
          </div>
          <div v-else class="ann-list">
            <div v-for="a in announcementList" :key="a.id" class="ann-item" role="button" tabindex="0"
                 @click="openAnnDetail(a)" @keydown.enter="openAnnDetail(a)" @keydown.space.prevent="openAnnDetail(a)">
              <div class="ann-item-header">
                <strong>{{ a.title }}</strong>
                <span class="text-muted" style="font-size:12px">{{ new Date(a.created_at).toLocaleDateString() }}</span>
              </div>
              <div class="ann-item-body">{{ truncateText(a.content, 80) }}</div>
              <div class="ann-item-footer text-muted">—— {{ a.author_name }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.navbar {
  /* The app keeps a constant expanded clearance; morph only this fixed surface. */
  --nav-scroll-progress: 0;
  --nav-morph: var(--nav-scroll-progress);
  --nav-current-top: calc(var(--nav-morph) * var(--navbar-shell-top-gap));
  --nav-current-height: calc(var(--navbar-expanded-height) - var(--nav-morph) * (var(--navbar-expanded-height) - var(--app-nav-height)));
  --nav-current-bottom: calc(var(--safe-area-top) + var(--nav-current-top) + var(--nav-current-height));
  --nav-side-inset: calc(var(--nav-morph) * max(var(--navbar-shell-side-gap), var(--safe-area-left), var(--safe-area-right), (100% - var(--navbar-shell-width)) / 2));
  position: fixed;
  top: var(--visual-viewport-offset-top);
  left: 0;
  right: 0;
  z-index: var(--z-nav);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: var(--safe-area-top) 0 0;
  background: transparent;
  border: 0;
  pointer-events: none;
}

.navbar.menu-open { z-index: calc(var(--z-floating) + 1); }
.navbar :focus-visible { outline-offset: 2px; }

/* 两种主题沿用同一套语义 token。 */

/* 两翼等宽，中心保留固定搜索宽度；核心入口数量有上限，辅助入口在更多面板中。
   minmax(0, 1fr) 允许墙名称截断，所有按钮仍保持完整触摸目标。 */
.nav-inner {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 216px minmax(0, 1fr);
  align-items: center;
  width: calc(100% - var(--nav-side-inset) * 2);
  min-width: 0;
  height: var(--nav-current-height);
  margin: var(--nav-current-top) auto 0;
  padding: 0 max(clamp(12px, 1.35vw, 24px), var(--safe-area-left), var(--safe-area-right));
  gap: 16px;
  overflow: visible;
  pointer-events: auto;
  border: 1px solid color-mix(in srgb, var(--border-strong) 72%, transparent);
  border-radius: calc(var(--nav-morph) * var(--nav-current-height));
  background: var(--surface-nav);
  -webkit-backdrop-filter: var(--nav-glass-filter);
  backdrop-filter: var(--nav-glass-filter);
  box-shadow: var(--navbar-shell-shadow), inset 0 1px 0 var(--navbar-shell-highlight);
}
.nav-inner::before {
  content: '';
  position: absolute;
  z-index: 0;
  inset: 1px;
  border-radius: inherit;
  background: linear-gradient(180deg, var(--navbar-shell-sheen), transparent 58%);
  pointer-events: none;
}
.nav-inner > * { position: relative; z-index: 1; min-width: 0; }

.nav-left { display: flex; align-items: center; gap: 16px; min-width: 0; grid-column: 1; }
.nav-center { display: flex; align-items: center; justify-content: center; min-width: 0; grid-column: 2; }
/* 两个图标按钮已经是最小尺寸，再压就变形，因此不参与收缩；
   左栏要让位时由旁边的墙切换器（有 ellipsis）收窄。 */
.nav-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.logo {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-lg);
  font-weight: 700;
  color: var(--text-primary);
  text-decoration: none;
}

/* 顶栏搜索框。宽度跟随中栏，上限 260px —— 屏幕再宽也不必拉成一条长框。 */
.nav-search { display: flex; align-items: center; width: 100%; max-width: 260px; min-width: 0; }
.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 0 12px;
  transition: border-color 0.25s var(--ease), background 0.25s var(--ease);
}
.search-input-wrap:focus-within {
  border-color: color-mix(in srgb, var(--accent-1) 60%, transparent);
  background: var(--bg-input-focus);
}
.search-icon { opacity: 0.65; flex-shrink: 0; }
/* 输入框填满中栏，宽度由栅格决定。
   原先是 150px、聚焦时撑到 220px —— 中栏当时按内容(auto)定宽，
   这一撑就把整行挤超了容器宽度，而 .nav-right 是 flex-end 对齐，
   溢出的内容往左跑，正好压在搜索框上。改成跟随栅格后不会再有这个问题，
   聚焦反馈交给上面的边框和底色。 */
.nav-search input {
  width: 100%;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: var(--font-sm);
  padding: 0;
}
.nav-search input::placeholder { color: var(--text-muted); }


/* 搜索建议面板跟随搜索框居中 */
.search-dropdown { right: auto; left: 50%; transform: translateX(-50%); min-width: 260px; }
.search-dropdown-tip { font-size: 12px; padding: 8px 12px; }

/* 右翼只包含核心导航和独立账号组，与左翼共用等宽轨道。 */
.nav-right {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  grid-column: 3;
  justify-self: end;
}

/* 顶栏三类元素（墙切换 / 搜索 / 导航项）统一为等高胶囊 */
.nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 8px;
  min-width: 44px;
  flex-shrink: 0;
  background: none;
  border: 1px solid transparent;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
  border-radius: var(--radius-pill);
  transition: background 0.25s var(--ease), color 0.25s var(--ease), box-shadow 0.25s var(--ease), transform 0.25s var(--ease);
  white-space: nowrap;
}

.nav-btn:hover {
  background: var(--bg-card-hover);
  color: var(--text-primary);
  transform: translateY(-1px);
}

/* 纯图标按钮（主题/壁纸）：收窄内边距，保持与文字按钮同高 */
.nav-icon-btn { width: 44px; padding: 0; justify-content: center; }

/* 激活项：轻标记 —— 浅底 + 1px 描边，不用外发光大色块 */
.nav-btn.nav-active {
  background: color-mix(in srgb, var(--accent-1) 18%, transparent);
  border-color: color-mix(in srgb, var(--accent-1) 50%, transparent);
  color: var(--text-primary);
}

.nav-btn.nav-active { color: var(--text-link); font-weight: 600; }
.mobile-item.mobile-active { background: var(--accent-soft); color: var(--text-link); font-weight: 600; }

.admin-btn { color: #ffd700; }

.unread-badge {
  background: var(--danger-fill);
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: var(--radius-md);
  margin-left: 4px;
  min-width: 16px;
  text-align: center;
  font-weight: 700;
  line-height: 14px;
}

.nav-btn-with-dot { position: relative; }

.nav-dot {
  position: absolute;
  top: 4px;
  right: 2px;
  width: 8px;
  height: 8px;
  background: var(--danger);
  border-radius: 50%;
  border: 1.5px solid var(--surface-raised);
  animation: dotPulse 2s ease-in-out infinite;
}

@keyframes dotPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.3); }
}

.nav-dot-inline {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--danger);
  border-radius: 50%;
  margin-left: 6px;
  vertical-align: middle;
}

/* 下拉菜单 */
.dropdown-wrapper { position: relative; }

.dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  padding: 6px;
  z-index: 1001;
  background: var(--surface-panel);
  -webkit-backdrop-filter: var(--glass-strong-filter);
  backdrop-filter: var(--glass-strong-filter);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  transform-origin: top right;
}

.nav-scale-enter-active, .nav-scale-leave-active { transition: opacity 0.16s var(--ease), scale 0.16s var(--ease); }
.nav-scale-enter-from, .nav-scale-leave-to { opacity: 0; scale: 0.94; }
.nav-scale-leave-active { pointer-events: none; }
.wall-dropdown { transform-origin: top left; }
.search-dropdown { transform-origin: top center; }
.account-dropdown, .more-dropdown { transform-origin: top right; }
.nav-primary-links { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dropdown-section-label { padding: 10px 12px 4px; color: var(--text-muted); font-size: var(--font-xs); }
.more-dropdown .dropdown-item[aria-current="page"] { background: var(--accent-soft); color: var(--text-link); }

.dropdown::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 0;
  right: 0;
  height: 12px;
}

.dropdown-header { padding: 8px 12px; }
.dropdown-header strong { display: block; font-size: 14px; }
.dropdown-divider { height: 1px; background: var(--border); margin: 4px 0; }

.dropdown-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text-secondary);
  min-height: 44px;
  padding: 10px 12px;
  font-size: var(--font-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.dropdown-item:hover { background: var(--bg-card-hover); }
.dropdown-item.danger { color: var(--danger); }

/* 头像 */
.avatar-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.avatar-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent-1) 70%, transparent); outline-offset: 2px; }

/* 移动端 */
.mobile-menu-btn {
  align-items: center;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 10px;
  min-width: 44px;
  min-height: 44px;
  border-radius: var(--radius-md);
}



.mobile-menu {
  position: absolute;
  top: calc(var(--nav-current-bottom) + 8px);
  left: max(8px, var(--safe-area-left));
  right: max(8px, var(--safe-area-right));
  background: var(--surface-panel);
  -webkit-backdrop-filter: var(--glass-strong-filter);
  backdrop-filter: var(--glass-strong-filter);
  padding: 12px;
  z-index: 2;
  /* The rail already follows offsetTop; viewport height is relative to that shifted origin. */
  max-height: max(0px, calc(var(--visual-viewport-height) - var(--app-header-height) - 16px));
  overscroll-behavior: contain;
  padding-bottom: max(12px, var(--safe-area-bottom));
  overflow-y: auto;
  border: 1px solid var(--border-strong);
  border-radius: 24px;
  pointer-events: auto;
  box-shadow: var(--navbar-shell-shadow);
}

.mobile-user-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
}

.mobile-divider {
  height: 1px;
  background: var(--border);
  margin: 8px 0;
}

.mobile-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 12px 16px;
  font-size: var(--font-base);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.mobile-item:hover { background: var(--bg-card-hover); }
.mobile-item.danger { color: var(--danger); }

/* 校园墙切换器（logo 位置）。间距由 .nav-left 的 gap 统一给，不再单独留 margin */
.wall-switcher { min-width: 0; }
.wall-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 44px;
  background: color-mix(in srgb, var(--accent-1) 18%, transparent);
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  font-size: var(--font-sm);
  cursor: pointer;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  max-width: 160px;
  transition: background 0.25s var(--ease);
}
.wall-btn .wall-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wall-btn:hover { background: color-mix(in srgb, var(--accent-1) 35%, transparent); }
.wall-dropdown { left: 0; right: auto; min-width: 200px; }
.wall-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wall-item.active { background: color-mix(in srgb, var(--accent-1) 25%, transparent); }
/* 勾选图标原为旧米色主题的 #b8ffb8，改为跟随成功色变量 */
.wall-item .check { color: var(--success); }
.mobile-wall-label { padding: 8px 16px; font-size: 12px; color: var(--text-muted); }
.wall-mobile-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wall-mobile-item.active { background: color-mix(in srgb, var(--accent-1) 20%, transparent); }
.wall-mobile-item .check { color: var(--success); }

/* 响应式 */
.desktop-only { display: flex; }
.nav-search-shortcut { display: none; }
.nav-search-shortcut-visible { display: inline-flex; }
.mobile-only { display: none; }

/* 窄一些的桌面宽度下，中栏被压到剩不下多少，搜索框留着也没法用了 ——
   直接收起，把空间还给导航项。搜索仍可从 /search 页面进入。 */
/* The bounded core link group leaves a fixed center track free, even with all optional links enabled. */

@media (min-width: 1121px) { .mobile-menu { display: none; } }

@media (max-width: 1120px) {
  /* Secondary links fold into the existing mobile panel; no destination is removed. */
  .nav-inner { display: flex; justify-content: space-between; padding-inline: max(8px, var(--safe-area-left), var(--safe-area-right)); }
  .nav-left { flex: 1; max-width: calc(100% - 52px); }
  .wall-switcher, .wall-btn { max-width: 100%; }
  .mobile-menu-btn, .nav-back { flex-shrink: 0; }
  .desktop-only { display: none !important; }
  .mobile-only { display: inline-flex !important; }
}

.mobile-menu { transform-origin: top center; }
html[data-blur='off'] .navbar .nav-inner,
html[data-blur='off'] .navbar .mobile-menu,
html[data-blur='off'] .navbar .dropdown { background: var(--surface-raised); -webkit-backdrop-filter: none; backdrop-filter: none; }
html[data-high-contrast='on'] .navbar .nav-inner,
html[data-high-contrast='on'] .navbar .mobile-menu {
  background: var(--surface-raised);
  border: 2px solid var(--text-primary);
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
@media (prefers-reduced-transparency: reduce) {
  .navbar .nav-inner, .navbar .mobile-menu, .navbar .dropdown { background: var(--surface-raised); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
/* A stationary full-width header avoids scroll-linked resizing for motion-sensitive users. */
html[data-reduce-motion='on'] .navbar { --nav-morph: 0; }
@media (prefers-reduced-motion: reduce) {
  .navbar { --nav-morph: 0; }
}


/* 公告小红点 */
.ann-btn { position: relative; }
.ann-dot {
  position: absolute; top: 2px; right: 1px;
  width: 8px; height: 8px;
  background: var(--danger);
  border-radius: 50%;
  border: 1.5px solid var(--surface-raised);
  animation: dotPulse 2s ease-in-out infinite;
}

/* 公告弹窗 */
.announcement-overlay {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: var(--overlay);
  padding: var(--space-4);
  display: flex; justify-content: center; align-items: center;
}
.announcement-modal {
  width: 100%; max-width: 560px;
  max-height: max(0px, calc(var(--visual-viewport-height) - 48px)); display: flex; flex-direction: column;
  padding: 0; border-radius: var(--radius-lg); overflow: hidden;
  background: var(--surface-raised);
}
.ann-modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px; border-bottom: 1px solid var(--border);
}
.ann-modal-header h3 { font-size: 17px; }
.ann-modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.ann-list { display: flex; flex-direction: column; gap: 12px; }
.ann-item {
  padding: 12px 14px;
  background: var(--bg-card-hover);
  border-radius: var(--radius-md);
  /* 原为旧米色主题硬编码 #c9b99a，改为主题色派生 */
  border-left: 3px solid var(--accent-line);
  cursor: pointer;
  transition: background 0.15s ease;
}
.ann-item:hover { background: var(--bg-input-focus); }
.ann-item-header { display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.ann-item-body { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); margin-bottom: 6px; }
.ann-item-footer { font-size: 12px; text-align: right; }
.ann-detail-item { padding: 12px 0; }
.ann-detail-view { display: flex; flex-direction: column; gap: 12px; }
.close-btn { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-sm); color: var(--text-primary); background: var(--bg-input); cursor: pointer; flex-shrink: 0; }
.close-btn:hover { background: var(--bg-input-focus); }
.dropdown { max-width: min(340px, calc(var(--visual-viewport-width) - 24px)); max-height: max(0px, calc(var(--visual-viewport-height) - var(--app-header-height) - 16px)); overflow-y: auto; }
.dropdown-item, .mobile-item, .mobile-wall-label { overflow-wrap: anywhere; }
.mobile-item { min-height: 44px; }
.mobile-user-info > div { min-width: 0; overflow-wrap: anywhere; }
.mobile-user-info .text-muted { display: block; }
@media (max-height: 480px) and (orientation: landscape) {
  .mobile-menu { padding-top: 4px; }
  .mobile-user-info { padding-block: 4px; }
}
</style>
