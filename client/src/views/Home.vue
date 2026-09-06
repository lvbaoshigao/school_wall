<script setup>
import { ref, watch, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import PostCard from '../components/PostCard.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import { useToast } from '../composables/useToast'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useTimeAgo } from '../composables/useTimeAgo'
import { useSettingsStore } from '../stores/settings'
import { useWallStore } from '../stores/wall'
import Icon from '../components/Icon.vue'

const router = useRouter()
const { timeAgo } = useTimeAgo()
const toast = useToast()
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
const page = ref(1)
const total = ref(0)
const limit = 20
const showCategorySidebar = ref(true)
const showTopicDrawer = ref(false)

const drawerRef = ref(null)
useFocusTrap(showTopicDrawer, drawerRef, () => { showTopicDrawer.value = false })

async function loadPosts(p = 1, category = null, sort = null) {
  loading.value = true
  try {
    const sm = sort || sortMode.value
    const cat = category || activeCategory.value
    const params = new URLSearchParams({ page: p, limit })

    if (sm === 'hot') {
      params.set('sort', 'hot')
    } else if (cat && cat !== '全部') {
      params.set('category', cat)
    }

    const res = await api.get(`/posts?${params.toString()}`)
    posts.value = res.data.posts
    total.value = res.data.total
    page.value = p

    if (res.data.categories) {
      const allCats = ['全部', ...new Set([...res.data.categories.filter(c => c !== '全部'), '吐槽', '分享', '求助', '讨论', '其他'])]
      categories.value = allCats
    }
  } catch (e) {
    toast.error('加载帖子失败')
  } finally {
    loading.value = false
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
  if (window.innerWidth <= 600) {
    showTopicDrawer.value = !showTopicDrawer.value
  } else {
    showCategorySidebar.value = !showCategorySidebar.value
  }
}

function onPostDeleted(id) {
  posts.value = posts.value.filter(p => p.id !== id)
  total.value--
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
  if (!id) { wallInfo.value = null; return }
  wallInfoLoading.value = true
  try {
    wallInfo.value = (await api.get(`/walls/${id}`)).data
  } catch {
    // 右栏是补充信息，拉不到就整块不显示，不打断主信息流也不弹错误提示
    wallInfo.value = null
  } finally {
    wallInfoLoading.value = false
  }
}

// 顶栏切换校园墙后要跟着换，否则右栏还停在上一个墙
watch(() => wallStore.currentWallId, loadWallInfo)


// 偏好可能晚于本组件挂载才从服务端拉回来；到了之后重新对齐默认排序/分类并重载一次。
// 只在用户还没手动切过（仍是初始值）时才覆盖，否则会把人正在看的分类顶掉。
watch(() => settingsStore.loaded, (ok) => {
  if (!ok || touchedByUser) return
  const p = settingsStore.prefs
  if (p.feed_sort === sortMode.value && p.feed_category === activeCategory.value) return
  sortMode.value = p.feed_sort
  activeCategory.value = p.feed_category
  page.value = 1
  loadPosts(1)
})

onMounted(() => {
  loadPosts()
  loadWallInfo()
})
</script>

<template>
  <div class="home">
    <!-- 话题分类入口（桌面收起左栏 / 移动弹出抽屉） -->
    <div class="home-topbar">
      <button class="btn btn-secondary btn-sm topic-toggle" @click="toggleCategorySidebar"
              :aria-expanded="showCategorySidebar || showTopicDrawer" aria-controls="topic-panel"
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
      <div class="posts-area">
        <!-- 骨架屏加载 -->
        <template v-if="loading">
          <SkeletonCard v-for="i in 4" :key="i" :lines="3" />
          <div style="height: 8px" v-for="i in 4" :key="'g'+i"></div>
        </template>

        <template v-else>
          <div v-if="posts.length === 0" class="empty-state">
            <div class="icon"><Icon name="file" :size="34" /></div>
            <p>{{ sortMode === 'hot' ? '暂无热门帖子' : (activeCategory !== '全部' ? `暂无${activeCategory}类帖子` : '还没有帖子，来发第一条吧！') }}</p>
            <button class="btn btn-primary btn-sm mt-2" @click="router.push('/post/create')">去发帖</button>
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
      </div>

      <!-- 右栏：校园墙介绍 -->
      <aside v-if="wallInfo || wallInfoLoading" class="wall-sidebar glass" aria-label="校园墙介绍">
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
      </aside>
    </div>
  </div>

  <!-- 话题分类抽屉（移动端 / 顶栏「话题」按钮） -->
  <Transition name="drawer">
    <div v-if="showTopicDrawer" class="topic-drawer-overlay" @click.self="showTopicDrawer = false">
      <div ref="drawerRef" class="topic-drawer glass-strong" role="dialog" aria-modal="true" aria-label="话题分类">
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
.home { animation: fadeIn 0.5s ease; }

/* 话题分类入口：与它控制的左栏同侧 */
.home-topbar { display: flex; justify-content: flex-start; margin-bottom: var(--space-2); }
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
  z-index: 1100;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: flex-start;
}
.topic-drawer {
  width: min(300px, 85vw);
  height: 100%;
  padding: var(--space-5);
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
.main-layout { display: flex; gap: 16px; align-items: flex-start; }
.category-sidebar {
  width: 140px; flex-shrink: 0; padding: 12px; border-radius: var(--radius-lg);
  position: sticky; top: 76px;
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
.cat-btn:hover { background: rgba(255,255,255,0.08); color: var(--text-primary); }
.cat-btn.active { background: rgba(169, 155, 134, 0.25); color: #d4c5b0; font-weight: 600; border-left: 3px solid #c9b99a; }
.hot-btn.active { background: rgba(255, 107, 107, 0.15); border-left: 3px solid #ff6b6b; color: #ffb8b8; }
.posts-area { flex: 1; min-width: 0; }

/* 右栏：校园墙介绍。与左分类栏一样 sticky，跟随滚动停在顶栏下方 */
.wall-sidebar {
  width: 280px; flex-shrink: 0; padding: 16px; border-radius: var(--radius-lg);
  position: sticky; top: 76px;
}
.wall-name { font-size: 17px; font-weight: 700; margin-bottom: 6px; word-break: break-word; }
.wall-desc {
  font-size: 13px; line-height: 1.6; color: var(--text-secondary);
  margin-bottom: 14px; word-break: break-word; white-space: pre-wrap;
}
.wall-desc.is-empty { color: var(--text-muted); font-style: italic; }

.wall-stats { display: flex; gap: 10px; }
.wall-stat {
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
.wall-meta-row dd { color: var(--text-secondary); text-align: right; word-break: break-word; }
.wall-action { width: 100%; }

.wall-loading { display: flex; flex-direction: column; gap: 8px; }
.wall-skel { height: 12px; border-radius: var(--radius-xs); background: var(--bg-card-hover); animation: wallSkel 1.2s ease-in-out infinite; }
.wall-skel-title { height: 18px; width: 60%; }
.wall-skel-short { width: 40%; }
@keyframes wallSkel { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.posts-list { display: flex; flex-direction: column; gap: 12px; }
.pagination { display: flex; justify-content: center; align-items: center; gap: 16px; padding: 24px 0; }

/* 公告弹窗 */
.modal {
  padding: 0; border-radius: var(--radius-lg); width: 90%; max-width: 540px;
  max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;
}
.close-btn {
  display: inline-flex; align-items: center; background: none; border: none;
  color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm);
}
.close-btn:hover { background: rgba(255,255,255,0.1); }

/* 放不下三栏时（小笔记本 / 平板），右栏整块换行到帖子下方而不是直接隐藏，
   墙介绍在窄屏依然可读，只是不再单独占一列。
   必须给 width:100% 才会真的换行：.posts-area 是 flex:1 且 min-width:0，
   光有 flex-wrap 的话它会一路收缩把右栏挤在同一行里。 */
@media (max-width: 1080px) {
  .main-layout { flex-wrap: wrap; }
  .wall-sidebar { width: 100%; position: static; }
  .wall-meta { max-width: 420px; }
}

@media (max-width: 600px) {
  .main-layout { flex-direction: column; }
  .category-sidebar { width: 100%; position: static; padding: 12px; }
  .category-list { flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; }
  .cat-btn { padding: 8px 14px; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; }
  .cat-btn.active { border-left: none; border-bottom: 3px solid #c9b99a; }
  .hot-btn.active { border-left: none; border-bottom: 3px solid #ff6b6b; }
  .sidebar-divider { display: none; }
}
</style>
