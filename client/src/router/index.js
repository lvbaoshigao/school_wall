import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import api from '../api'

// 懒检查：系统是否已初始化（只查一次，缓存结果）
let setupChecked = false
let systemInitialized = true
async function ensureSetupChecked() {
  if (setupChecked) return systemInitialized
  try {
    const res = await api.get('/setup/status')
    systemInitialized = res.data.initialized
  } catch { systemInitialized = true } // 网络错误默认放行
  setupChecked = true
  return systemInitialized
}

// 重置缓存：用于首次设置完成后，让路由守卫重新检查
export function resetSetupCheck() {
  setupChecked = false
  systemInitialized = true
}

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
  { path: '/tree-hole/chat/:conversationId', name: 'TreeHoleChat', component: () => import('../views/TreeHoleChat.vue'), meta: { auth: true } },
  { path: '/tree-hole/list', name: 'TreeHoleConversations', component: () => import('../views/TreeHoleConversations.vue'), meta: { auth: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to, from, next) => {
  const userStore = useUserStore()
  const wallStore = useWallStore()

  // 系统未初始化时，只允许 /login（显示首次设置表单）
  const initialized = await ensureSetupChecked()
  if (!initialized && to.path !== '/login') {
    return next('/login')
  }

  if (to.meta.auth && !userStore.isLoggedIn) {
    return next('/login')
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
    if (!wallStore.currentWallId) {
      return next('/walls')
    }
  }
  next()
})

export default router
