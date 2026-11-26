<script setup>
import { ref, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import EmptyState from '../components/EmptyState.vue'
import ErrorState from '../components/ErrorState.vue'
import TrendingBoard from '../components/TrendingBoard.vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useSettingsStore } from '../stores/settings'
import { useWallStore } from '../stores/wall'
import Icon from '../components/Icon.vue'

const router = useRouter()
const { timeAgo } = useTimeAgo()
const wallStore = useWallStore()

const posts = ref([])
const categories = ref(['全部', '吐槽', '分享', '求助', '讨论', '其他'])
const settingsStore = useSettingsStore()
// 初值取自用户偏好；偏好还没拉回来时用默认值，onMounted 里会再对齐一次
const activeCategory = ref(settingsStore.prefs.feed_category)
const sortMode = ref(settingsStore.prefs.feed_sort) // 'latest' | 'hot'
// 用户手动切过分类/排序后，就不再被后到的偏好覆盖
let touchedByUser = false
const loading = ref(true)
const loadError = ref('')
const requestedPage = ref(1)
let postsRequest = 0
let postsController
let wallRequest = 0
let disposed = false
let active = false
let seenPublication = null
const page = ref(1)
const total = ref(0)
const limit = 20
const showCategorySidebar = ref(true)
const showTopicDrawer = ref(false)
const mobileTopics = ref(false)
function updateViewport() {
  mobileTopics.value = window.innerWidth <= 768
  if (!mobileTopics.value) showTopicDrawer.value = false
}

const drawerRef = ref(null)
useFocusTrap(showTopicDrawer, drawerRef, () => { showTopicDrawer.value = false })

async function loadPosts(p = 1, category = null, sort = null) {
  const request = ++postsRequest
  postsController?.abort()
  postsController = new AbortController()
  const wallId = wallStore.currentWallId
  requestedPage.value = Math.max(1, Number(p) || 1)
  loading.value = true
  loadError.value = ''
  try {
    const sm = sort || sortMode.value
    const cat = category || activeCategory.value
    const params = new URLSearchParams({ page: requestedPage.value, limit })

    if (sm === 'hot') {
      params.set('sort', 'hot')
    } else if (cat && cat !== '全部') {
      params.set('category', cat)
    }

    const res = await api.get(`/posts?${params.toString()}`, { signal: postsController.signal })
    if (disposed || request !== postsRequest || wallId !== wallStore.currentWallId) return
    posts.value = Array.isArray(res.data.posts) ? res.data.posts : []
    total.value = Math.max(0, Number(res.data.total) || 0)
    const lastPage = Math.max(1, Math.ceil(total.value / limit))
    if (p > lastPage) return loadPosts(lastPage, cat, sm)
    page.value = requestedPage.value

    if (Array.isArray(res.data.categories)) {
      const allCats = ['全部', ...new Set([...res.data.categories.filter(c => c !== '全部'), '吐槽', '分享', '求助', '讨论', '其他'])]
      categories.value = allCats
    }
  } catch (e) {
    if (disposed || request !== postsRequest || wallId !== wallStore.currentWallId || e.code === 'ERR_CANCELED') return
    loadError.value = '帖子加载失败，请检查网络后重试'
  } finally {
    if (request === postsRequest && !disposed) loading.value = false
  }
}

function switchCategory(cat) {
  touchedByUser = true
  activeCategory.value = cat
  sortMode.value = 'latest'
  showTopicDrawer.value = false
  loadPosts(1, cat, 'latest')
}

function switchSort(sort) {
  touchedByUser = true
  sortMode.value = sort
  if (sort === 'hot') activeCategory.value = '全部'
  showTopicDrawer.value = false
  loadPosts(1, null, sort)
}

function toggleCategorySidebar() {
  updateViewport()
  if (mobileTopics.value) {
    showTopicDrawer.value = !showTopicDrawer.value
  } else {
    showCategorySidebar.value = !showCategorySidebar.value
  }
}

function onPostDeleted(id) {
  if (!posts.value.some(p => p.id === id)) return
  posts.value = posts.value.filter(p => p.id !== id)
  total.value = Math.max(0, total.value - 1)
  if (!posts.value.length && page.value > 1) loadPosts(page.value - 1)
}


const totalPages = computed(() => Math.ceil(total.value / limit))

// ===== 右栏：校园墙介绍 =====
// store 里的 currentWall 来自 GET /walls 列表，只有 name/description/角色，
// 没有成员数、墙主和创建时间，所以这里单独取一次 GET /walls/:id。
const wallInfo = ref(null)
const wallInfoLoading = ref(false)

const WALL_ROLE_LABEL = { owner: '墙主', admin: '校园墙管理员', tree_hole: '树洞志愿者', member: '成员' }
const myRoleLabel = computed(() => WALL_ROLE_LABEL[wallInfo.value?.my_role] || '')

async function loadWallInfo() {
  const id = wallStore.currentWallId
  const request = ++wallRequest
  wallInfo.value = null
  if (!id) { wallInfoLoading.value = false; return }
  wallInfoLoading.value = true
  try {
    const res = await api.get(`/walls/${id}`)
    if (disposed || request !== wallRequest || id !== wallStore.currentWallId) return
    wallInfo.value = res.data
  } catch {
    if (disposed || request !== wallRequest) return
    // 右栏是补充信息，拉不到就整块不显示，不打断主信息流也不弹错误提示
    wallInfo.value = null
  } finally {
    if (request === wallRequest && !disposed) wallInfoLoading.value = false
  }
}

// 顶栏切换校园墙后要跟着换，否则右栏还停在上一个墙
watch(() => wallStore.currentWallId, () => {
  posts.value = []
  total.value = 0
  if (active) { loadPosts(1); loadWallInfo() }
})

onBeforeUnmount(() => {
  disposed = true; postsRequest++; wallRequest++; postsController?.abort()
  if (typeof window !== 'undefined') window.removeEventListener('resize', updateViewport)
})


// 偏好可能晚于本组件挂载才从服务端拉回来；到了之后重新对齐默认排序/分类并重载一次。
// 只在用户还没手动切过（仍是初始值）时才覆盖，否则会把人正在看的分类顶掉。
watch(() => settingsStore.loaded, (ok) => {
  if (!ok || touchedByUser) return
  const p = settingsStore.prefs
  if (p.feed_sort === sortMode.value && p.feed_category === activeCategory.value) return
  sortMode.value = p.feed_sort
  activeCategory.value = p.feed_category
  page.value = 1
  if (active) loadPosts(1)
})

onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
})

// KeepAlive 返回只触发 activated；发布后回到最新的全部分类，确保新帖可见。
onActivated(() => {
  active = true
  const publication = wallStore.lastPublishedPost
  if (publication && publication !== seenPublication && publication.wallId === wallStore.currentWallId) {
    touchedByUser = true
    activeCategory.value = '全部'
    sortMode.value = 'latest'
    page.value = 1
  }
  seenPublication = publication
  loadPosts(page.value)
  loadWallInfo()
})
onDeactivated(() => {
  active = false
  showTopicDrawer.value = false
  postsRequest++
  wallRequest++
  postsController?.abort()
})
</script>

<template>
  <div class="home">
    <!-- 话题分类入口（桌面收起左栏 / 移动弹出抽屉） -->
    <div class="home-topbar">
      <div class="feed-heading"><h1>校园动态</h1><p class="text-muted">分享近况，也听听身边的声音</p></div>
      <button class="btn btn-secondary btn-sm topic-toggle" @click="toggleCategorySidebar"
              :aria-expanded="mobileTopics ? showTopicDrawer : showCategorySidebar" :aria-controls="mobileTopics ? 'topic-drawer' : 'topic-panel'"
              title="话题分类">
        话题
      </button>
    </div>

    <!-- 主体区域 -->
    <div class="main-layout">
      <!-- 左侧分类栏（桌面可收起）。
           刻意不用 <Transition> + v-if：那样每次切换都会销毁并重建整个侧栏，
           插入的那一帧要重排整个三栏 flex 布局（flex:1 的帖子区加两个 sticky 栏），
           开销远大于后续的宽度插值 —— 卡顿就出在这一帧。改成常驻元素切 class，
           只剩下纯粹的宽度过渡。 -->
      <aside id="topic-panel" class="category-sidebar glass" :class="{ collapsed: !showCategorySidebar }"
             :inert="showCategorySidebar ? null : true" aria-label="话题分类">
        <div class="sidebar-title">话题分类</div>
        <div class="category-list">
          <button
            v-for="cat in categories"
            :key="cat"
            class="cat-btn"
            :class="{ active: activeCategory === cat && sortMode === 'latest' }"
            :aria-pressed="activeCategory === cat && sortMode === 'latest'"
            @click="switchCategory(cat)"
          >
            {{ cat }}
          </button>
        </div>
        <div class="sidebar-divider"></div>
        <button class="cat-btn hot-btn" :class="{ active: sortMode === 'hot' }"
                :aria-pressed="sortMode === 'hot'" @click="switchSort('hot')">
          热门帖子
        </button>
      </aside>

      <!-- 右侧帖子列表 -->
      <section class="posts-area" :aria-busy="loading" aria-label="校园帖子">
        <!-- 骨架屏加载 -->
        <template v-if="loading">
          <!-- 骨架屏间距统一走 .skeleton-stack（gap 12px，与帖子列表一致）。
               原先卡片与 8px 垫片是两个并列 v-for：4 张卡片先全部零间距堆叠，
               32px 垫片全落在列表末尾 —— 加载期布局与加载后对不上。 -->
          <div class="skeleton-stack">
            <SkeletonCard v-for="i in 4" :key="i" :lines="3" />
          </div>
        </template>

        <ErrorState v-else-if="loadError" role="alert" :title="loadError" @retry="loadPosts(requestedPage)" />
        <template v-else>
          <div v-if="posts.length === 0">
            <EmptyState
              icon="file"
              :title="sortMode === 'hot' ? '暂无热门帖子' : (activeCategory !== '全部' ? `暂无${activeCategory}类帖子` : '还没有帖子，来发第一条吧！')"
              action-text="去发帖"
              @action="router.push('/post/create')"
            />
          </div>

          <div class="posts-list">
            <PostCard
              v-for="(post, idx) in posts"
              :key="post.id"
              :post="post"
              :style="{ '--i': idx }"
              @deleted="onPostDeleted"
            />
          </div>

          <div v-if="totalPages > 1" class="pagination">
            <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="loadPosts(page - 1)">上一页</button>
            <span class="text-muted">{{ page }} / {{ totalPages }}</span>
            <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages" @click="loadPosts(page + 1)">下一页</button>
          </div>
        </template>
      </section>

      <!-- 右栏：校园墙介绍 + 话题热榜 -->
      <aside v-if="wallInfo || wallInfoLoading" class="wall-sidebar" aria-label="校园墙介绍">
        <div class="glass wall-sidebar-card">
          <div class="sidebar-title">校园墙</div>

          <div v-if="wallInfoLoading" class="wall-loading">
            <div class="wall-skel wall-skel-title"></div>
            <div class="wall-skel"></div>
            <div class="wall-skel wall-skel-short"></div>
          </div>

          <template v-else-if="wallInfo">
            <div class="wall-name">{{ wallInfo.name }}</div>
            <p class="wall-desc" :class="{ 'is-empty': !wallInfo.description }">
              {{ wallInfo.description || '这个校园墙还没有填写简介' }}
            </p>

            <div class="wall-stats">
              <div class="wall-stat">
                <span class="num">{{ wallInfo.member_count ?? '—' }}</span>
                <span class="label">成员</span>
              </div>
              <div v-if="myRoleLabel" class="wall-stat">
                <span class="role-badge">{{ myRoleLabel }}</span>
                <span class="label">我的身份</span>
              </div>
            </div>

            <div class="sidebar-divider"></div>

            <dl class="wall-meta">
              <div class="wall-meta-row">
                <dt>墙主</dt><dd>{{ wallInfo.owner_name || '(无)' }}</dd>
              </div>
              <div class="wall-meta-row">
                <dt>创建于</dt><dd>{{ timeAgo(wallInfo.created_at) }}</dd>
              </div>
              <div class="wall-meta-row">
                <dt>加入方式</dt><dd>{{ wallInfo.require_join_approval ? '需审核' : '自由加入' }}</dd>
              </div>
            </dl>

            <button class="btn btn-secondary btn-sm wall-action" @click="router.push('/walls')">
              切换 / 加入校园墙
            </button>
          </template>
        </div>

        <TrendingBoard @select-category="switchCategory" />
      </aside>
    </div>
  </div>

  <!-- 话题分类抽屉（移动端 / 顶栏「话题」按钮） -->
  <Transition name="drawer">
    <div v-if="showTopicDrawer" class="topic-drawer-overlay" @click.self="showTopicDrawer = false">
      <div id="topic-drawer" ref="drawerRef" class="topic-drawer glass-strong" role="dialog" aria-modal="true" aria-label="话题分类">
        <div class="drawer-header">
          <span>话题分类</span>
          <button class="close-btn" aria-label="关闭话题分类" @click="showTopicDrawer = false"><Icon name="close" :size="17" /></button>
        </div>
        <div class="drawer-cats">
          <button
            v-for="cat in categories"
            :key="cat"
            class="cat-btn drawer-cat"
            :class="{ active: activeCategory === cat && sortMode === 'latest' }"
            :aria-pressed="activeCategory === cat && sortMode === 'latest'"
            @click="switchCategory(cat)"
          >
            {{ cat }}
          </button>
          <button class="cat-btn hot-btn drawer-cat" :class="{ active: sortMode === 'hot' }"
                  :aria-pressed="sortMode === 'hot'" @click="switchSort('hot')">
            热门帖子
          </button>
        </div>
      </div>
    </div>
  </Transition>

</template>

<style scoped>
.home { animation: fadeIn 0.5s ease; min-width: 0; }
.home-topbar > :first-child { min-width: 0; }
.topic-toggle { flex-shrink: 0; min-width: 44px; min-height: 44px; }

/* 话题分类入口：与它控制的左栏同侧 */
.home-topbar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); margin-bottom: var(--space-5); padding: var(--space-4) var(--space-5); background: var(--surface-card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.feed-heading h1 { font-size: var(--font-2xl); letter-spacing: -.035em; margin-bottom: var(--space-1); }
.feed-heading p { font-size: var(--font-sm); }
.topic-toggle { border-radius: var(--radius-pill); }

/* 搜索栏（已移除，功能迁移至顶栏与 /search 页） */

/* 左栏收起/展开。宽度变化必然触发 reflow，这类动画交不给合成器；
   能做的是把重排范围圈住，并且不要在动画开始的同一帧再叠加一次挂载。
   contain: layout paint 让浏览器知道栏内的布局变化不会影响外部，
   宽度插值时不必把整棵树重新算一遍。 */
.category-sidebar {
  overflow: hidden;
  contain: layout paint;
  transition: width 0.3s var(--ease), padding 0.3s var(--ease),
              margin 0.3s var(--ease), opacity 0.25s var(--ease);
}
.category-sidebar.collapsed {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  opacity: 0;
  /* 元素常驻之后它仍然占着 .main-layout 的一格 gap(16px)，收起来会留一条空隙。
     用等量负外边距抵掉，视觉上和原来 v-if 整个移除时一致。 */
  margin-right: -16px;
}

/* 话题抽屉：从左侧滑入，与「话题」按钮同侧 */
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.3s var(--ease); }
.drawer-enter-active .topic-drawer, .drawer-leave-active .topic-drawer { transition: transform 0.3s var(--ease); }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .topic-drawer, .drawer-leave-to .topic-drawer { transform: translateX(-100%); }

.topic-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  top: var(--visual-viewport-offset-top);
  bottom: auto;
  height: var(--visual-viewport-height);
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: flex-start;
}
.topic-drawer {
  width: min(300px, 85vw);
  height: 100%;
  padding: max(var(--space-5), var(--safe-area-top)) var(--space-5) max(var(--space-5), var(--safe-area-bottom)) max(var(--space-5), var(--safe-area-left));
  overscroll-behavior: contain;
  border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
  overflow-y: auto;
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 16px;
}
.drawer-cats { display: flex; flex-direction: column; gap: 4px; }
.drawer-cat { width: 100%; }

/* 主体布局 */
.main-layout { display: flex; gap: 16px; align-items: flex-start; min-width: 0; width: 100%; }
.category-sidebar {
  width: 210px; flex-shrink: 0; padding: 12px; border-radius: var(--radius-lg);
  position: sticky; top: calc(var(--app-header-height) + var(--page-top-gap));
}
.sidebar-title {
  font-size: 13px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; padding: 0 4px;
}
.sidebar-divider { height: 1px; background: var(--border); margin: 4px 2px; }
.category-list { display: flex; flex-direction: column; gap: 4px; }
.cat-btn {
  padding: 8px 10px; border: none; border-radius: var(--radius-sm); background: transparent;
  color: var(--text-secondary); font-size: 14px; cursor: pointer; transition: all 0.2s;
  text-align: left; white-space: nowrap;
}
.cat-btn { min-height: 44px; }
.cat-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.cat-btn.active { background: var(--accent-soft); color: var(--text-primary); font-weight: 600; border-left: 3px solid var(--accent-1); }
.hot-btn.active { background: var(--accent-soft); border-left: 3px solid var(--accent-1); color: var(--text-link); }
.posts-area { flex: 1; min-width: 0; width: 100%; }

/* 右栏：校园墙介绍 + 话题热榜。与左分类栏一样 sticky，跟随滚动停在顶栏下方 */
.wall-sidebar {
  width: 210px;
  flex-shrink: 0;
  position: sticky;
  top: calc(var(--app-header-height) + var(--page-top-gap));
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.wall-sidebar-card {
  padding: var(--space-4);
  border-radius: var(--radius-lg);
}
.wall-name { font-size: 17px; font-weight: 700; margin-bottom: 6px; word-break: break-word; }
.wall-desc {
  font-size: 13px; line-height: 1.6; color: var(--text-secondary);
  margin-bottom: 14px; word-break: break-word; white-space: pre-wrap;
}
.wall-desc.is-empty { color: var(--text-muted); font-style: italic; }

.wall-stats { display: flex; gap: 10px; }
.wall-stat {
  min-width: 0;
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 10px 6px; background: var(--bg-card); border-radius: var(--radius-md);
}
.wall-stat .num { font-size: 20px; font-weight: 700; line-height: 1; }
.wall-stat .label { font-size: 11px; color: var(--text-muted); }
.role-badge {
  font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--text-primary); white-space: nowrap;
}

.wall-meta { display: flex; flex-direction: column; gap: 7px; margin: 4px 0 14px; }
.wall-meta-row { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.wall-meta-row dt { color: var(--text-muted); flex-shrink: 0; }
.wall-meta-row dd { min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); text-align: right; word-break: break-word; }
.wall-action { width: 100%; }

.wall-loading { display: flex; flex-direction: column; gap: 8px; }
.wall-skel { height: 12px; border-radius: var(--radius-xs); background: var(--bg-card-hover); animation: wallSkel 1.2s ease-in-out infinite; }
.wall-skel-title { height: 18px; width: 60%; }
.wall-skel-short { width: 40%; }
@keyframes wallSkel { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.posts-list { display: flex; flex-direction: column; gap: 12px; }
.pagination { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 24px 0; }
.pagination .text-muted { white-space: nowrap; }
.pagination .btn { min-height: 44px; }

/* 公告弹窗 */
.modal {
  padding: 0; border-radius: var(--radius-lg); width: 90%; max-width: 540px;
  max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;
}
.close-btn {
  display: inline-flex; align-items: center; background: none; border: none;
  color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm);
  justify-content: center; min-width: 44px; min-height: 44px;
}
.close-btn:hover { background: var(--bg-card-hover); }

/* 放不下三栏时（小笔记本 / 平板），右栏整块换行到帖子下方而不是直接隐藏，
   墙介绍在窄屏依然可读，只是不再单独占一列。
   必须给 width:100% 才会真的换行：.posts-area 是 flex:1 且 min-width:0，
   光有 flex-wrap 的话它会一路收缩把右栏挤在同一行里。 */
@media (max-width: 1080px) {
  .main-layout { flex-wrap: wrap; }
  .wall-sidebar {
    width: 100%;
    position: static;
    flex-direction: row;
    align-items: flex-start;
  }
  .wall-sidebar-card { flex: 1; min-width: 260px; }
  .wall-sidebar :deep(.trending-board) { flex: 1; min-width: 260px; }
  .wall-meta { max-width: 420px; }
}

@media (max-width: 768px) {
  .main-layout { flex-direction: column; }
  .wall-sidebar { flex-direction: column; }
  .wall-sidebar-card, .wall-sidebar :deep(.trending-board) { min-width: 0; width: 100%; }
  .category-sidebar { display: none; }
  .category-sidebar { width: 100%; position: static; padding: 12px; }
  .category-list { flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; }
  .cat-btn { padding: 8px 14px; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; }
  .cat-btn.active { border-left: none; border-bottom: 3px solid var(--accent-1); }
  .hot-btn.active { border-left: none; border-bottom: 3px solid var(--accent-1); }
  .sidebar-divider { display: none; }
}
</style>
