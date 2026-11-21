import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'

// 只缓存正式初始化；临时状态在后端重启后失效。
let setupStatus = null
async function ensureSetupChecked() {
  if (setupStatus) return setupStatus
  try {
    const { data } = await api.get('/setup/status')
    if (data.initialized) setupStatus = data
    return data
  } catch { return { initialized: true } } // 网络错误时保留表单，下次导航重新检查
}

export function resetSetupCheck() { setupStatus = null }

const routes = [
  { path: '/', name: 'Home', component: () => import('../views/Home.vue'), meta: { auth: true, wall: true } },
  { path: '/login', name: 'Login', component: () => import('../views/Login.vue'), meta: { guest: true } },
  { path: '/register', name: 'Register', component: () => import('../views/Register.vue'), meta: { guest: true } },
  { path: '/walls', name: 'WallSelect', component: () => import('../views/WallSelect.vue'), meta: { auth: true } },
  { path: '/profile', name: 'Profile', component: () => import('../views/Profile.vue'), meta: { auth: true } },
  { path: '/bookmarks', name: 'Bookmarks', component: () => import('../views/Bookmarks.vue'), meta: { auth: true } },
  { path: '/settings', name: 'Settings', component: () => import('../views/Settings.vue'), meta: { auth: true } },
  { path: '/search', name: 'Search', component: () => import('../views/Search.vue'), meta: { auth: true, wall: true } },
  { path: '/banned', name: 'Banned', component: () => import('../views/Banned.vue') },
  { path: '/user/:id', name: 'ProfileView', component: () => import('../views/ProfileView.vue'), meta: { auth: true } },
  { path: '/chat', name: 'Chat', component: () => import('../views/Chat.vue'), meta: { auth: true } },
  { path: '/friends/search', name: 'FriendSearch', component: () => import('../views/FindFriends.vue'), meta: { auth: true } },
  { path: '/friends/discover', name: 'FriendDiscover', component: () => import('../views/FindFriends.vue'), meta: { auth: true, wall: true } },
  { path: '/chat/:id', name: 'ChatRoom', component: () => import('../views/ChatRoom.vue'), meta: { auth: true } },
  { path: '/post/create', name: 'CreatePost', component: () => import('../views/CreatePost.vue'), meta: { auth: true, wall: true } },
  { path: '/post/:id', name: 'PostDetail', component: () => import('../views/PostDetail.vue'), meta: { auth: true, wall: true } },
  { path: '/inbox', name: 'Inbox', component: () => import('../views/Inbox.vue'), meta: { auth: true } },
  { path: '/confession/write', name: 'WriteConfession', component: () => import('../views/WriteConfession.vue'), meta: { auth: true, wall: true } },
  { path: '/votes', name: 'Votes', component: () => import('../views/Votes.vue'), meta: { auth: true, wall: true } },
  { path: '/vote/create', name: 'CreateVote', component: () => import('../views/CreateVote.vue'), meta: { auth: true, wall: true } },
  { path: '/vote/:id', name: 'VoteDetail', component: () => import('../views/VoteDetail.vue'), meta: { auth: true, wall: true } },
  { path: '/admin', name: 'Admin', component: () => import('../views/Admin.vue'), meta: { auth: true } },
  { path: '/help/counseling', name: 'HelpCounseling', component: () => import('../views/HelpCounseling.vue'), meta: { auth: true, wall: true } },
  { path: '/help/report', name: 'ReportForm', component: () => import('../views/ReportForm.vue'), meta: { auth: true, wall: true } },
  { path: '/report/status/:code', name: 'ReportStatus', component: () => import('../views/ReportStatus.vue'), meta: { auth: true } },
  { path: '/bug-report', name: 'BugReport', component: () => import('../views/BugReport.vue'), meta: { auth: true } },
  { path: '/tree-hole/chat/:conversationId', name: 'TreeHoleChat', component: () => import('../views/TreeHoleChat.vue'), meta: { auth: true, wall: true } },
  { path: '/tree-hole/list', name: 'TreeHoleConversations', component: () => import('../views/TreeHoleConversations.vue'), meta: { auth: true, wall: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to, from, next) => {
  const userStore = useUserStore()
  const wallStore = useWallStore()
  // 首次导航先恢复账户/权限，避免刷新后界面闪错状态。
  if (userStore.isLoggedIn && !userStore.user && to.path !== '/banned') await userStore.fetchUser()

  // 未正式初始化时，仅已登录的临时会话可以进入站点。
  const { initialized, temporary } = await ensureSetupChecked()
  if (!initialized && !(temporary && userStore.isLoggedIn) && to.path !== '/login') {
    return next('/login')
  }

  if (to.meta.auth && !userStore.isLoggedIn) {
    return next({ path: '/login', query: { redirect: to.fullPath } })
  }
  if (to.meta.guest && userStore.isLoggedIn) {
    return next('/')
  }
  if (to.meta.admin && !userStore.can('global.moderate')) {
    return next('/')
  }
  // 需要校园墙上下文的页面：确保已加载墙列表且已选墙
  if (to.meta.wall && userStore.isLoggedIn) {
    if (!wallStore.loaded) {
      try { await wallStore.fetchMyWalls() } catch {}
    }
    if (!wallStore.currentWall) {
      return next('/walls')
    }
  }
  next()
})

export function safeLoginRedirect(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
  const target = router.resolve(value)
  if (!target.matched.length || target.meta.guest || target.path === '/banned') return fallback
  return target.fullPath
}

export default router
