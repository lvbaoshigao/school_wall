<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '../../api'
import Icon from '../Icon.vue'
import { buildOverviewTrend, formatOverviewCount as count, formatOverviewTime, formatOverviewUptime, normalizeAdminOverview } from '../../utils/adminOverview.js'

const props = defineProps({
  wallId: { type: Number, default: null },
  wallName: { type: String, default: '' },
  globalScope: { type: Boolean, default: false },
  canNavigate: { type: Function, default: () => false },
})
const emit = defineEmits(['navigate'])
const days = ref(7)
const selectedWallId = ref(props.wallId ? String(props.wallId) : '')
const overview = ref(null)
const loading = ref(false)
const error = ref('')
const wallChoices = ref([])
const wallPage = ref(1)
const metric = ref('posts')
const metricOptions = [
  { key: 'posts', label: '新增帖子' }, { key: 'comments', label: '新增评论' },
  { key: 'members', label: '新增成员关系' }, { key: 'votes', label: '新增投票' },
  { key: 'users', label: '新注册用户' },
]
let request = null
let version = 0
let disposed = false
const queryKey = computed(() => JSON.stringify([days.value, selectedWallId.value]))
const shownMetrics = computed(() => metricOptions.filter(option => overview.value?.daily.some(row => row[option.key] != null)))
const metricLabel = computed(() => metricOptions.find(option => option.key === metric.value)?.label || '新增帖子')
const trend = computed(() => buildOverviewTrend(overview.value?.daily || [], metric.value))
const pendingTodos = computed(() => overview.value?.todos.filter(todo => todo.count > 0) || [])
const hasTodoPermission = computed(() => Object.entries(overview.value?.pending || {}).some(([key, value]) => key !== 'total' && value != null))
const wallPageCount = computed(() => Math.max(1, Math.ceil((overview.value?.walls.length || 0) / 10)))
const visibleWalls = computed(() => overview.value?.walls.slice((wallPage.value - 1) * 10, wallPage.value * 10) || [])
const scopeLabel = computed(() => !overview.value ? (selectedWallId.value ? props.wallName || '本墙统计范围' : '全局管理范围') : overview.value.scope.kind === 'wall'
  ? overview.value.walls.find(wall => wall.id === overview.value.scope.wall_id)?.name || props.wallName || '所选校园墙'
  : '全局管理范围')
const summaryCards = computed(() => {
  if (!overview.value) return []
  const { totals, today } = overview.value
  return [
    { key: 'users', label: '用户', value: totals.users, icon: 'users', detail: '正常状态 ' + count(totals.active_users) + ' · 封禁 ' + count(totals.banned_users), today: today.users },
    { key: 'walls', label: '校园墙', value: totals.walls, icon: 'school', detail: '启用 ' + count(totals.active_walls) },
    { key: 'members', label: '有效成员关系', value: totals.members, icon: 'user-plus', detail: '跨墙加入分别计数', today: today.members },
    { key: 'posts', label: '帖子', value: totals.posts, icon: 'file', detail: '匿名帖 ' + count(totals.anonymous_posts), today: today.posts },
    { key: 'comments', label: '评论', value: totals.comments, icon: 'message', today: today.comments },
    { key: 'votes', label: '投票', value: totals.votes, icon: 'chart', today: today.votes },
  ].filter(card => card.value != null)
})
const dateRange = computed(() => overview.value ? overview.value.range.start_date + ' 至 ' + overview.value.range.end_date : '')
const chartLabel = computed(() => metricLabel.value + '，' + dateRange.value + '，合计 ' + count(trend.value.total))
function wallStatus(status) { return ({ active: '启用', banned: '已停用', archived: '已归档', disabled: '已停用' })[status] || status || '未知状态' }
function bytes(value) { return Number.isFinite(value) && value >= 0 ? (value / 1048576).toFixed(1) + ' MB' : '—' }
function current(id, key, controller) { return !disposed && version === id && queryKey.value === key && request === controller && !controller.signal.aborted }

async function loadOverview() {
  if (disposed) return
  request?.abort()
  const controller = new AbortController()
  request = controller
  const id = ++version
  const key = queryKey.value
  loading.value = true
  error.value = ''
  const wallId = Number(selectedWallId.value) || null
  const options = { params: { days: days.value }, signal: controller.signal }
  if (wallId) {
    options.params.wall_id = wallId
    options.headers = { 'X-Wall-Id': String(wallId) }
  }
  try {
    const { data } = await api.get('/admin/overview', options)
    if (!current(id, key, controller)) return
    const valid = normalizeAdminOverview(data)
    if (!valid || valid.range.days !== days.value || valid.scope.kind !== (wallId ? 'wall' : 'global') || (wallId && valid.scope.wall_id !== wallId)) {
      throw new Error('INVALID_OVERVIEW')
    }
    overview.value = valid
    if (!wallId) wallChoices.value = valid.walls.map(wall => ({ id: wall.id, name: wall.name }))
    wallPage.value = Math.min(wallPage.value, wallPageCount.value)
    if (!shownMetrics.value.some(option => option.key === metric.value)) metric.value = shownMetrics.value[0]?.key || 'posts'
  } catch (cause) {
    if (!current(id, key, controller)) return
    if ([401, 403].includes(cause?.response?.status)) { overview.value = null; wallChoices.value = [] }
    error.value = cause?.message === 'INVALID_OVERVIEW' ? '概览数据格式无效，请重试' : getApiErrorMessage(cause, '管理概览加载失败，请重试')
  } finally {
    if (current(id, key, controller)) loading.value = false
    if (request === controller) request = null
  }
}
watch(queryKey, () => {
  overview.value = null
  wallPage.value = 1
  loadOverview()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; version++; request?.abort(); request = null })
</script>

<template>
  <section class="overview" aria-labelledby="overview-title" :aria-busy="loading">
    <div class="overview-head">
      <div>
        <h3 id="overview-title">管理概览</h3>
        <p class="muted">{{ scopeLabel }} · 仅展示当前权限可见的数据</p>
      </div>
      <div class="overview-controls">
        <label v-if="globalScope && wallChoices.length" class="control-label">统计范围
          <select v-model="selectedWallId">
            <option value="">全局</option>
            <option v-for="wall in wallChoices" :key="wall.id" :value="String(wall.id)">{{ wall.name }}</option>
          </select>
        </label>
        <label class="control-label">趋势时段
          <select v-model.number="days"><option :value="7">近 7 天</option><option :value="30">近 30 天</option><option :value="90">近 90 天</option></select>
        </label>
        <button type="button" class="btn btn-sm btn-secondary refresh-button" :disabled="loading" @click="loadOverview">
          <Icon name="refresh" :size="16" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>
    <p class="refresh-status muted" role="status" aria-live="polite">{{ loading ? (overview ? '正在更新概览…' : '正在加载概览…') : overview ? '最近更新：' + formatOverviewTime(overview.generated_at) : '尚未加载概览' }}</p>
    <div v-if="error" class="overview-error" role="alert">
      <div><strong>{{ error }}</strong><p v-if="overview">当前保留上次成功加载的数据，请留意更新时间。</p></div>
      <button type="button" class="btn btn-sm btn-secondary" :disabled="loading" @click="loadOverview">重试</button>
    </div>
    <div v-if="loading && !overview" class="summary-grid" aria-hidden="true">
      <div v-for="index in 6" :key="index" class="overview-card glass skeleton"><div></div><div></div><div></div></div>
    </div>
    <template v-if="overview">
      <div class="summary-grid">
        <article v-for="card in summaryCards" :key="card.key" class="overview-card glass">
          <div class="metric-heading"><span>{{ card.label }}</span><Icon :name="card.icon" :size="18" /></div>
          <strong class="metric-value">{{ count(card.value) }}</strong>
          <p v-if="card.today != null" class="metric-today">今日新增 {{ count(card.today) }}</p>
          <p v-if="card.detail" class="muted metric-detail">{{ card.detail }}</p>
        </article>
      </div>
      <p class="summary-note muted">现存记录统计 · 点赞 {{ count(overview.totals.likes) }} · 公告 {{ count(overview.totals.announcements) }}<span v-if="overview.scope.kind === 'wall'"> · 用户总数不按墙统计</span></p>

      <section class="overview-section glass" aria-labelledby="overview-trend-title">
        <div class="section-head">
          <h4 id="overview-trend-title">活动趋势</h4>
          <label v-if="shownMetrics.length" class="control-label">趋势指标
            <select v-model="metric"><option v-for="option in shownMetrics" :key="option.key" :value="option.key">{{ option.label }}</option></select>
          </label>
        </div>
        <p class="muted section-description">{{ dateRange }}（含今日）· 按服务器时区 {{ overview.range.timezone }} 的自然日统计现存记录</p>
        <template v-if="overview.daily.length && shownMetrics.length">
          <p class="trend-total">{{ metricLabel }}合计 <strong>{{ count(trend.total) }}</strong></p>
          <div class="trend-chart-wrap" tabindex="0" role="region" aria-label="活动趋势图，可横向滚动">
          <svg class="trend-chart" :viewBox="'0 0 ' + trend.width + ' ' + trend.height" role="img" :aria-label="chartLabel">
            <title>{{ chartLabel }}</title>
            <g v-for="tick in trend.ticks" :key="tick.value" class="chart-axis">
              <line :x1="trend.left" :x2="trend.width - trend.right" :y1="tick.y" :y2="tick.y" />
              <text :x="trend.left - 8" :y="tick.y + 4" text-anchor="end">{{ tick.value.toLocaleString('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }) }}</text>
            </g>
            <path :d="trend.path" class="chart-line" />
            <template v-for="point in trend.points" :key="point.date">
              <circle v-if="point.value != null" :cx="point.x" :cy="point.y" :r="overview.daily.length > 30 ? 2 : 3" class="chart-point"><title>{{ point.date }} · {{ metricLabel }} {{ count(point.value) }}</title></circle>
            </template>
            <text v-for="point in trend.labels" :key="point.date" :x="point.x" :y="trend.height - 10" :text-anchor="point.x === trend.left ? 'start' : point.x === trend.width - trend.right ? 'end' : 'middle'" class="chart-date">{{ point.date.slice(5) }}</text>
          </svg>
          </div>
          <p v-if="trend.total === 0" class="empty-note">此时段暂无{{ metricLabel }}。</p>
          <details class="trend-details">
            <summary>查看每日数据明细</summary>
            <div class="trend-table-wrap" tabindex="0" role="region" aria-label="每日趋势数据，可横向滚动">
              <table><caption class="sr-only">{{ dateRange }}每日统计</caption><thead><tr><th scope="col">日期</th><th v-for="option in shownMetrics" :key="option.key" scope="col">{{ option.label }}</th></tr></thead>
                <tbody><tr v-for="row in overview.daily" :key="row.date"><th scope="row">{{ row.date }}</th><td v-for="option in shownMetrics" :key="option.key">{{ count(row[option.key]) }}</td></tr></tbody>
              </table>
            </div>
          </details>
        </template>
        <p v-else class="empty-note">暂无可展示的趋势数据。</p>
      </section>

      <section class="overview-section glass" aria-labelledby="overview-todo-title">
        <div class="section-head"><h4 id="overview-todo-title">待办事项</h4><span v-if="hasTodoPermission" class="todo-total">共 {{ count(overview.pending.total) }} 项</span></div>
        <p class="muted section-description">仅包含你有权查看或处理的事项。</p>
        <p v-if="overview.todos_meta?.truncated" class="limit-notice">待办列表显示优先的 {{ overview.todos.length }} 项分组，共 {{ count(overview.todos_meta.total) }} 组；上方待办总数包含全部事项。</p>
        <ul v-if="pendingTodos.length" class="todo-list">
          <li v-for="todo in pendingTodos" :key="todo.key + ':' + todo.wall_id">
            <div><strong>{{ todo.title }}</strong><span class="todo-count">{{ count(todo.count) }} 项</span><p v-if="todo.wall_id && overview.scope.kind === 'global'" class="muted">{{ overview.walls.find(wall => wall.id === todo.wall_id)?.name || '校园墙 #' + todo.wall_id }}</p></div>
            <button v-if="canNavigate(todo)" type="button" class="btn btn-sm btn-secondary" :aria-label="'去处理' + todo.title" @click="emit('navigate', todo)">去处理 <Icon name="chevron-right" :size="14" /></button>
            <span v-else class="muted todo-hint">请在对应管理页处理</span>
          </li>
        </ul>
        <p v-else class="empty-note">{{ hasTodoPermission ? '当前权限范围内暂无待办事项。' : '当前未授予待办处理权限。' }}</p>
      </section>

      <section class="overview-section glass" aria-labelledby="overview-walls-title">
        <div class="section-head"><h4 id="overview-walls-title">校园墙信息</h4><span class="muted">可见 {{ count(overview.walls_meta?.total ?? overview.walls.length) }} 个</span></div>
        <p class="muted section-description">成员数为有效成员关系；时段发帖数与上方时段一致。未授权的待处理统计显示为“—”。</p>
        <p v-if="overview.walls_meta?.truncated" class="limit-notice">当前列表展示前 {{ overview.walls.length }} 个校园墙，共 {{ count(overview.walls_meta.total) }} 个；可切换到具体校园墙查看该墙概览。</p>
        <ul v-if="visibleWalls.length" class="wall-grid">
          <li v-for="wall in visibleWalls" :key="wall.id" class="wall-card">
            <div class="wall-title"><h5>{{ wall.name }}</h5><span class="wall-status">{{ wallStatus(wall.status) }}</span></div>
            <dl class="wall-metrics">
              <div><dt>有效成员</dt><dd>{{ count(wall.members) }}</dd></div><div><dt>帖子</dt><dd>{{ count(wall.posts) }}</dd></div>
              <div><dt>评论</dt><dd>{{ count(wall.comments) }}</dd></div><div><dt>投票</dt><dd>{{ count(wall.votes) }}</dd></div>
              <div><dt>时段发帖</dt><dd>{{ count(wall.posts_in_range) }}</dd></div><div><dt>待审成员</dt><dd>{{ count(wall.pending_members) }}</dd></div>
              <div><dt>帖子举报待办</dt><dd>{{ count(wall.pending_post_reports) }}</dd></div><div><dt>安全举报待办</dt><dd>{{ count(wall.pending_safety_reports) }}</dd></div>
            </dl>
          </li>
        </ul>
        <p v-else class="empty-note">当前权限范围内暂无校园墙统计。</p>
        <nav v-if="wallPageCount > 1" class="wall-pagination" aria-label="校园墙信息分页">
          <button type="button" class="btn btn-sm btn-secondary" :disabled="wallPage <= 1" @click="wallPage--">上一页</button>
          <span role="status">{{ wallPage }} / {{ wallPageCount }}</span>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="wallPage >= wallPageCount" @click="wallPage++">下一页</button>
        </nav>
      </section>

      <section v-if="overview.system" class="overview-section glass" aria-labelledby="overview-system-title">
        <div class="section-head"><h4 id="overview-system-title">运行与访问</h4><span class="muted">当前服务进程</span></div>
        <dl class="system-grid">
          <div><dt>持续运行</dt><dd>{{ formatOverviewUptime(overview.system.uptime_seconds) }}</dd></div>
          <div><dt>进程内存 / 堆内存</dt><dd>{{ bytes(overview.system.memory?.rss_bytes) }} / {{ bytes(overview.system.memory?.heap_used_bytes) }}</dd></div>
          <div><dt>数据库</dt><dd>{{ overview.system.database?.temporary ? '临时数据模式' : '持久化模式' }} · {{ overview.system.database?.dirty ? '有更改待保存' : '已同步' }}</dd></div>
          <template v-if="overview.system.visits">
            <div><dt>近 {{ overview.system.visits.window_minutes }} 分钟访问</dt><dd>{{ count(overview.system.visits.requests) }} 次已追踪 API 请求 · {{ count(overview.system.visits.visitors) }} 个访问标识</dd></div>
          </template>
        </dl>
        <p v-if="overview.system.visits" class="muted section-description">仅统计已追踪的 API 请求，不代表页面浏览量；访问标识按登录用户或未登录 IP 去重，不等于独立用户数或在线人数。访问计数仅属于当前进程，服务重启后重置。<span v-if="overview.system.visits.identity_limit">标识上限 {{ count(overview.system.visits.identity_limit) }}，达到上限时可能低估。</span></p>
      </section>
    </template>
    <p v-else-if="!loading && !error" class="empty-note">暂无管理概览数据。</p>
  </section>
</template>

<style scoped>
.overview { min-width: 0; }
.overview-head, .section-head, .wall-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.overview-head { align-items: flex-start; }
h3 { font-size: var(--font-xl); margin: 0 0 6px; }
h4 { font-size: var(--font-lg); margin: 0; }
h5 { font-size: var(--font-md); margin: 0; overflow-wrap: anywhere; }
.muted { color: var(--text-muted); font-size: var(--font-sm); line-height: 1.65; }
.overview-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.control-label { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-xs); color: var(--text-secondary); }
.control-label select { max-width: 210px; min-height: 44px; padding: 6px 10px; font-size: var(--font-sm); }
.refresh-button { min-height: 44px; }
.refresh-status { margin: 12px 0; min-height: 22px; }
.overview-error { padding: 14px 16px; border: 1px solid var(--danger); color: var(--danger); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; overflow-wrap: anywhere; }
.overview-error p { margin-top: 4px; font-size: var(--font-sm); }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 12px; }
.overview-card { padding: 16px; border-radius: var(--radius-md); min-width: 0; }
.metric-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--font-sm); color: var(--text-secondary); }
.metric-heading .icon { color: var(--text-link); }
.metric-value { display: block; font-size: var(--font-2xl); font-variant-numeric: tabular-nums; margin: 8px 0; overflow-wrap: anywhere; }
.metric-today { color: var(--text-link); font-size: var(--font-sm); }
.metric-detail { margin-top: 4px; }
.summary-note { margin: 12px 0 20px; }
.overview-section { padding: 20px; border-radius: var(--radius-lg); margin-top: 16px; min-width: 0; }
.section-description { margin: 10px 0 14px; }
.trend-total { font-size: var(--font-sm); color: var(--text-secondary); }
.trend-total strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.trend-chart-wrap { max-width: 100%; overflow-x: auto; }
.trend-chart { display: block; width: 100%; min-width: 560px; height: auto; margin: 8px 0; }
.chart-axis line { stroke: var(--border-strong); stroke-width: 1; }
.chart-axis text, .chart-date { fill: var(--text-muted); font-size: 12px; }
.chart-line { fill: none; stroke: var(--text-link); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.chart-point { fill: var(--text-link); }
.trend-details { margin-top: 8px; }
.trend-details summary { cursor: pointer; color: var(--text-link); padding: 8px 0; font-size: var(--font-sm); }
.trend-table-wrap { max-width: 100%; overflow: auto; max-height: 360px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
table { width: 100%; border-collapse: collapse; font-size: var(--font-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: right; }
th { color: var(--text-secondary); font-weight: 500; }
th:first-child { text-align: left; }
.empty-note { color: var(--text-muted); line-height: 1.7; font-size: var(--font-sm); padding: 18px 0; }
.todo-total { font-size: var(--font-sm); color: var(--warning); }
.todo-list, .wall-grid { list-style: none; padding: 0; margin: 0; }
.todo-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }
.todo-list li + li { border-top: 1px solid var(--border); }
.todo-list strong { font-size: var(--font-base); }
.todo-count { display: inline-block; margin-left: 10px; font-size: var(--font-sm); color: var(--warning); }
.todo-hint { text-align: right; }
.wall-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.wall-card { padding: 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-md); min-width: 0; }
.wall-status { color: var(--text-secondary); font-size: var(--font-xs); border: 1px solid var(--border-strong); border-radius: var(--radius-pill); padding: 2px 8px; flex-shrink: 0; }
.wall-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
dt { color: var(--text-muted); font-size: var(--font-xs); }
dd { color: var(--text-primary); font-size: var(--font-base); margin: 3px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.limit-notice { color: var(--warning); font-size: var(--font-sm); margin: 12px 0; line-height: 1.65; }
.wall-pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 16px; font-size: var(--font-sm); }
.system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
.skeleton { min-height: 145px; }
.skeleton div { height: 12px; background: var(--bg-input); border-radius: var(--radius-xs); margin-bottom: 16px; width: 70%; }
.skeleton div:nth-child(2) { height: 30px; width: 45%; }
:where(button, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--text-link); outline-offset: 3px; }
@media (max-width: 1000px) { .wall-grid { grid-template-columns: 1fr; } }
@media (max-width: 600px) {
  .overview-head { display: block; }
  .overview-controls { margin-top: 12px; gap: 8px; }
  .control-label { flex: 1; min-width: 100px; }
  .control-label select { width: 100%; max-width: 100%; }
  .overview-section { padding: 16px 12px; }
  .overview-card { padding: 14px; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .metric-value { font-size: var(--font-xl); }
  .trend-chart { min-height: 150px; }
  .todo-list li { flex-wrap: wrap; }
  .todo-hint { text-align: left; }
  .system-grid { grid-template-columns: 1fr; }
  .overview-error { align-items: flex-start; flex-wrap: wrap; }
}
@media (max-width: 350px) { .summary-grid { grid-template-columns: 1fr; } }
</style>
