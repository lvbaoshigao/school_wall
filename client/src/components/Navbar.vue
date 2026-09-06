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

const emit = defineEmits(['change-wallpaper', 'toggle-theme'])
const props = defineProps({ theme: { type: String, default: 'dark' } })

const userStore = useUserStore()
const wallStore = useWallStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const { renderMarkdown, truncateText } = useMarkdown()
const toast = useToast()

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

const isLoggedIn = computed(() => userStore.isLoggedIn)
const user = computed(() => userStore.user)
const currentWall = computed(() => wallStore.currentWall)
const myWalls = computed(() => wallStore.myWalls)
// 树洞入口按「在当前墙是否拥有树洞权限」显示。
// 重构前这里还带了 || isGlobalAdmin，但服务端从来只认 wall_members.wall_role ——
// 不是志愿者的全局管理员点进去只会看到空队列、接入时 403，属于死入口，这次一并去掉。
const canSeeTreeHole = computed(() => wallStore.canHere('wall.tree_hole'))

// 管理后台：只要在全局或当前墙里有任何一项管理能力就显示
const canOpenAdmin = computed(() =>
  userStore.can('global.moderate') || userStore.can('global.user.manage') ||
  wallStore.canHere('wall.stats.view') || wallStore.canHere('wall.member.view'))

function selectWall(id) {
  wallStore.switchWall(id)
  showWallMenu.value = false
  showMobileMenu.value = false
  if (router.currentRoute.value.path === '/') {
    location.reload()
  } else {
    router.push('/')
  }
}

async function fetchUnread() {
  if (!userStore.isLoggedIn) return
  try {
    const res = await api.get('/messages/unread-count')
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

onMounted(() => {
  if (userStore.isLoggedIn) {
    fetchUnread()
    restartUnreadTimer()
  }
})

// 改完设置立即生效，不需要刷新
watch(() => settingsStore.prefs.unread_interval, () => {
  if (userStore.isLoggedIn) restartUnreadTimer()
})

onUnmounted(() => clearInterval(unreadTimer))

function logout() {
  userStore.logout()
  showMenu.value = false
  showMobileMenu.value = false
  router.push('/login')
}

function toggleDropdown(key) {
  openDropdown.value = openDropdown.value === key ? '' : key
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

function hideSearchMenu() {
  setTimeout(() => { showSearchMenu.value = false }, 150)
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
    window.open('/dashboard', '_blank')
  } catch {
    toast.error('无法打开管理后台，请重新登录后再试')
  }
}

const isHomePage = computed(() => router.currentRoute.value.path === '/')
const userAvatar = computed(() => user.value?.avatar || '')

// 公告弹窗
const showAnnouncementModal = ref(false)
const announcementList = ref([])
const announcementLoading = ref(false)
const showAnnDetail = ref(false)
const selectedAnn = ref(null)

async function fetchAnnouncements() {
  announcementLoading.value = true
  try {
    const res = await api.get('/announcements')
    announcementList.value = res.data || []
  } catch {}
  announcementLoading.value = false
}

function openAnnouncements() {
  fetchAnnouncements()
  showAnnouncementModal.value = true
  // 打开弹窗时标记所有公告为已读
  api.put('/messages/read-all', { type: 'announcement' }).catch(() => {})
  unreadAnnouncement.value = 0
}

function closeAnnouncements() {
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
  <nav class="navbar">
    <div class="nav-inner" :class="{ 'nav-inner-wide': isHomePage }">
      <!-- 左：已登录显示墙切换器（取代原 logo），未登录显示 logo -->
      <div class="nav-left">
        <div v-if="isLoggedIn" class="dropdown-wrapper wall-switcher">
          <button class="wall-btn" @click="showWallMenu = !showWallMenu" :title="currentWall?.description || '切换校园墙'">
            <Icon name="school" :size="15" />
            <span class="wall-name">{{ currentWall?.name || '选择校园墙' }}</span>
            <Icon name="chevron-down" :size="14" />
          </button>
          <div v-if="showWallMenu" class="dropdown wall-dropdown">
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
          <button v-if="settingsStore.tools.theme" class="nav-btn nav-icon-btn" @click="emit('toggle-theme')"
                  :title="props.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'"
                  :aria-label="props.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'">
            <Icon :name="props.theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </button>
          <button v-if="settingsStore.tools.wallpaper" class="nav-btn nav-icon-btn" @click="changeWallpaper"
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
              @blur="hideSearchMenu"
            />
          </div>
          <div v-if="showSearchMenu" class="dropdown search-dropdown" @mousedown.prevent>
            <div class="search-dropdown-tip text-muted">搜索帖子内容，或输入追踪码 RPT-XXXX 查询举报进度</div>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" @click="goSearch">搜索「{{ searchQuery || '…' }}」</button>
          </div>
        </div>
      </div>

      <!-- 右：工具与导航 -->
      <div class="nav-right desktop-only">
        <template v-if="isLoggedIn">
          <template v-for="item in settingsStore.visibleNav" :key="item.key">
            <!-- 下拉型（发布/求助） -->
            <div v-if="item.type === 'dropdown'" class="dropdown-wrapper">
              <button class="nav-btn" :aria-expanded="openDropdown === item.key" @click="toggleDropdown(item.key)">
                {{ item.label }}
                <Icon name="chevron-down" :size="14" />
              </button>
              <div v-if="openDropdown === item.key" class="dropdown" @click="openDropdown = ''">
                <button v-for="c in item.children" :key="c.path" class="dropdown-item" @click="go(c.path)">{{ c.label }}</button>
              </div>
            </div>
            <!-- 链接型（type: 'search' 由上方独立搜索框渲染，此处跳过） -->
            <button
              v-else-if="item.type === 'link'"
              class="nav-btn nav-btn-with-dot"
              :class="{ 'nav-active': isActive(item) }"
              :aria-current="isActive(item) ? 'page' : undefined"
              @click="go(item.path)"
            >
              {{ item.label }}
              <span v-if="item.key === 'chat' && unreadChat > 0" class="nav-dot" role="status" aria-label="有未读消息"></span>
              <span v-if="item.key === 'inbox' && unreadSystem > 0" class="nav-dot" role="status" aria-label="有未读消息"></span>
              <span v-if="item.key === 'inbox' && unreadCount > 0" class="unread-badge" role="status" :aria-label="`${unreadCount} 条未读`">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
            </button>
          </template>

          <div class="dropdown-wrapper">
            <button class="avatar-btn" aria-label="账号菜单" :aria-expanded="showMenu" @click="showMenu = !showMenu">
              <AvatarIcon :src="userAvatar" :name="userName" size="md" />
            </button>
            <div v-if="showMenu" class="dropdown" @click="showMenu = false">
              <div class="dropdown-header">
                <strong>{{ userName }}</strong>
                <span class="text-muted">@{{ user?.username }}</span>
              </div>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item" @click="go('/profile')">个人主页</button>
              <button class="dropdown-item" @click="go('/settings')">设置</button>
              <button v-if="canOpenAdmin" class="dropdown-item" @click="go('/admin')">管理后台</button>
              <button v-if="userStore.can('global.dashboard')" class="dropdown-item" @click="openDashboard">运行看板</button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item danger" @click="logout">退出登录</button>
            </div>
          </div>
        </template>
        <template v-else>
          <button class="btn btn-secondary btn-sm" @click="go('/login')">登录</button>
          <button class="btn btn-primary btn-sm" @click="go('/register')">注册</button>
        </template>
      </div>

      <!-- 移动端汉堡菜单 -->
      <button class="mobile-menu-btn mobile-only" :aria-label="showMobileMenu ? '关闭菜单' : '打开菜单'"
              :aria-expanded="showMobileMenu" @click="showMobileMenu = !showMobileMenu">
        <Icon :name="showMobileMenu ? 'close' : 'menu'" :size="22" />
      </button>
    </div>

    <!-- 移动端菜单面板 -->
    <Transition name="slide">
      <div v-if="showMobileMenu" class="mobile-menu">
        <template v-if="isLoggedIn">
          <div class="mobile-user-info">
            <AvatarIcon :src="userAvatar" :name="userName" size="lg" />
            <div>
              <strong>{{ userName }}</strong>
              <span class="text-muted">@{{ user?.username }}</span>
            </div>
          </div>
          <div class="mobile-divider"></div>
          <button v-if="settingsStore.tools.theme" class="mobile-item" @click="emit('toggle-theme')">
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
          <div class="mobile-divider"></div>
          <template v-for="item in settingsStore.visibleNav" :key="item.key">
            <template v-if="item.type === 'dropdown'">
              <button v-for="c in item.children" :key="c.path" class="mobile-item" @click="go(c.path)">{{ c.label }}</button>
            </template>
            <button v-else-if="item.type === 'link'" class="mobile-item" @click="go(item.path)">
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
          <button v-if="settingsStore.tools.wallpaper" class="mobile-item" @click="changeWallpaper">换壁纸</button>
          <div class="mobile-divider"></div>
          <button class="mobile-item danger" @click="logout">退出登录</button>
        </template>
        <template v-else>
          <button class="mobile-item" @click="go('/login')">登录</button>
          <button class="mobile-item" @click="go('/register')">注册</button>
        </template>
      </div>
    </Transition>
  </nav>

  <!-- 公告弹窗 -->
  <Teleport to="body">
    <div v-if="showAnnouncementModal" class="announcement-overlay" @click.self="closeAnnouncements">
      <div class="announcement-modal glass-strong" role="dialog" aria-modal="true" aria-label="公告">
        <div class="ann-modal-header">
          <h3>公告</h3>
          <button class="close-btn" aria-label="关闭公告" @click="closeAnnouncements"><Icon name="close" :size="17" /></button>
        </div>
        <div class="ann-modal-body">
          <div v-if="announcementLoading" class="loading">加载中…</div>
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
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  background: rgba(20, 20, 40, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

body.light-theme .navbar {
  background: rgba(255, 255, 255, 0.85);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

body.light-theme .logo,
body.light-theme .nav-btn,
body.light-theme .dropdown-item,
body.light-theme .mobile-item,
body.light-theme .wall-btn { color: rgba(0, 0, 0, 0.75); }

body.light-theme .nav-btn:hover,
body.light-theme .dropdown-item:hover,
body.light-theme .mobile-item:hover { background: rgba(0, 0, 0, 0.05); color: #000; }

body.light-theme .dropdown,
body.light-theme .mobile-menu {
  background: rgba(255, 255, 255, 0.95);
  border-color: rgba(0, 0, 0, 0.1);
}

body.light-theme .dropdown-divider,
body.light-theme .mobile-divider { background: rgba(0, 0, 0, 0.08); }

/* 三栏布局。两侧按内容占位（auto），中栏吸收剩余空间并在不够时先收窄。
   不用 `1fr auto 1fr`：那样两侧是弹性的、中栏是定宽的，空间不够时被榨干的是两侧 ——
   左栏会被压到比内容还窄，里面的工具按钮（不可收缩）就溢出去压在搜索框上。
   现在反过来，让唯一可以无损收窄的搜索框去让路。 */
.nav-inner {
  max-width: 1000px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  height: 60px;
  padding: 0 var(--space-3);
}

/* 主页正文容器放宽到了 1280px（App.vue 的 .main-wide），
   顶栏内容不跟着放宽的话，左侧墙切换器会缩在左分类栏右边，对不齐。 */
.nav-inner-wide {
  max-width: 1280px;
}

.nav-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.nav-center { display: flex; align-items: center; justify-content: center; min-width: 0; }
/* 两个图标按钮已经是最小尺寸，再压就变形，因此不参与收缩；
   左栏要让位时由旁边的墙切换器（有 ellipsis）收窄。 */
.nav-tools { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

.logo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
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
  height: 32px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-pill);
  padding: 0 12px;
  transition: border-color 0.25s var(--ease), background 0.25s var(--ease);
}
.search-input-wrap:focus-within {
  border-color: color-mix(in srgb, var(--accent-1) 60%, transparent);
  background: rgba(255, 255, 255, 0.12);
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
  color: #fff;
  font-size: 13px;
  padding: 0;
}
.nav-search input::placeholder { color: var(--text-muted); }
body.light-theme .nav-search input { color: rgba(0, 0, 0, 0.8); }
body.light-theme .nav-search input::placeholder { color: rgba(0, 0, 0, 0.35); }
body.light-theme .search-input-wrap { background: rgba(0, 0, 0, 0.05); border-color: rgba(0, 0, 0, 0.1); }
body.light-theme .search-input-wrap:focus-within { border-color: color-mix(in srgb, var(--accent-1) 60%, transparent); background: rgba(0, 0, 0, 0.06); }

/* 搜索建议面板跟随搜索框居中 */
.search-dropdown { right: auto; left: 50%; transform: translateX(-50%); min-width: 260px; }
.search-dropdown-tip { font-size: 12px; padding: 8px 12px; }

/* 不设 min-width: 0 —— 这一栏是 flex-end 对齐，一旦允许收窄到内容以下，
   按钮（都是 nowrap）会从左边溢出去盖住中间的搜索框。
   让它按内容占位，空间不够时由中栏的搜索框收窄来让路。 */
.nav-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

/* 顶栏三类元素（墙切换 / 搜索 / 导航项）统一为等高胶囊 */
.nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  background: none;
  border: 1px solid transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-pill);
  transition: background 0.25s var(--ease), color 0.25s var(--ease), box-shadow 0.25s var(--ease), transform 0.25s var(--ease);
  white-space: nowrap;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  transform: translateY(-1px);
}

/* 纯图标按钮（主题/壁纸）：收窄内边距，保持与文字按钮同高 */
.nav-icon-btn { padding: 0 8px; }

/* 激活项：轻标记 —— 浅底 + 1px 描边，不用外发光大色块 */
.nav-btn.nav-active {
  background: color-mix(in srgb, var(--accent-1) 18%, transparent);
  border-color: color-mix(in srgb, var(--accent-1) 50%, transparent);
  color: #fff;
}

body.light-theme .nav-btn.nav-active {
  background: color-mix(in srgb, var(--accent-1) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent-1) 40%, transparent);
  color: #4a5fc8;
}

.admin-btn { color: #ffd700; }

.unread-badge {
  background: #ff6b6b;
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
  background: #ff6b6b;
  border-radius: 50%;
  border: 1.5px solid rgba(20, 20, 40, 0.9);
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
  background: #ff6b6b;
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
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  background: rgba(20, 20, 40, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

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
.dropdown-divider { height: 1px; background: rgba(255, 255, 255, 0.1); margin: 4px 0; }

.dropdown-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 10px 12px;
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.dropdown-item:hover { background: rgba(255, 255, 255, 0.15); }
.dropdown-item.danger { color: #ff6b6b; }

/* 头像 */
.avatar-btn {
  display: inline-flex;
  align-items: center;
  padding: 0;
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
  color: #fff;
  cursor: pointer;
  padding: 8px;
}

body.light-theme .mobile-menu-btn { color: #333; }

.mobile-menu {
  position: absolute;
  top: 60px;
  left: 0;
  right: 0;
  background: rgba(20, 20, 40, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding: 12px;
  z-index: 999;
  max-height: calc(100vh - 60px);
  overflow-y: auto;
}

.mobile-user-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
}

.mobile-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
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
  font-size: 15px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s;
}

.mobile-item:hover { background: rgba(255, 255, 255, 0.1); }
.mobile-item.danger { color: #ff6b6b; }

/* 校园墙切换器（logo 位置）。间距由 .nav-left 的 gap 统一给，不再单独留 margin */
.wall-switcher { min-width: 0; }
.wall-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  background: color-mix(in srgb, var(--accent-1) 18%, transparent);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  max-width: 180px;
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
.wall-item .check { color: #b8ffb8; }
.mobile-wall-label { padding: 8px 16px; font-size: 12px; color: var(--text-muted); }
.wall-mobile-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wall-mobile-item.active { background: color-mix(in srgb, var(--accent-1) 20%, transparent); }
.wall-mobile-item .check { color: #b8ffb8; }

/* 响应式 */
.desktop-only { display: flex; }
.mobile-only { display: none; }

/* 窄一些的桌面宽度下，中栏被压到剩不下多少，搜索框留着也没法用了 ——
   直接收起，把空间还给导航项。搜索仍可从 /search 页面进入。 */
@media (max-width: 880px) {
  .nav-center { display: none; }
}

@media (max-width: 768px) {
  /* 移动端只剩左侧标识 + 汉堡按钮，三栏网格退回两端对齐 */
  .nav-inner { display: flex; justify-content: space-between; }
  .desktop-only { display: none !important; }
  .mobile-only { display: inline-flex !important; }
}

.slide-enter-active, .slide-leave-active { transition: all 0.3s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateY(-10px); }

/* 公告小红点 */
.ann-btn { position: relative; }
.ann-dot {
  position: absolute; top: 2px; right: 1px;
  width: 8px; height: 8px;
  background: #ff6b6b;
  border-radius: 50%;
  border: 1.5px solid rgba(20, 20, 40, 0.9);
  animation: dotPulse 2s ease-in-out infinite;
}

/* 公告弹窗 */
.announcement-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.6);
  display: flex; justify-content: center; align-items: center;
}
.announcement-modal {
  width: 90%; max-width: 520px;
  max-height: 80vh; display: flex; flex-direction: column;
  padding: 0; border-radius: var(--radius-lg); overflow: hidden;
  background: var(--bg-card);
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
  border-left: 3px solid #c9b99a;
  cursor: pointer;
  transition: background 0.15s ease;
}
.ann-item:hover { background: rgba(255,255,255,0.08); }
.ann-item-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.ann-item-body { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); margin-bottom: 6px; }
.ann-item-footer { font-size: 12px; text-align: right; }
.ann-detail-item { padding: 12px 0; }
.ann-detail-view { display: flex; flex-direction: column; gap: 12px; }
</style>
