<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useConfessionContext } from '../composables/useConfessionContext'
import { useUserStore } from '../stores/user'
import { useMarkdown } from '../composables/useMarkdown'
import { useTimeAgo } from '../composables/useTimeAgo'
import { formatRegisteredAt, joinedDays, normalizeAccountOverview } from '../utils/accountStatistics.js'
import ConfessionDetail from '../components/ConfessionDetail.vue'
import SkeletonCard from '../components/SkeletonCard.vue'
import Icon from '../components/Icon.vue'
import api, { getApiErrorMessage } from '../api'

const { contextKey, wallId, active, capture } = useConfessionContext()
const userStore = useUserStore()
const { truncateText } = useMarkdown()
const { timeAgo } = useTimeAgo()
const mode = ref('summary')
const overview = ref(null)
const overviewLoading = ref(false)
const overviewError = ref('')
const accountId = computed(() => userStore.user?.id ?? '—')
const registeredAtText = computed(() => formatRegisteredAt(overview.value?.registered_at))
const joinedDaysText = computed(() => {
  const days = joinedDays(overview.value?.registered_at)
  return days == null ? '—' : days + ' 天'
})
const overviewAccountKey = computed(() => JSON.stringify([
  userStore.sessionRevision, userStore.token, userStore.user?.id ?? null, userStore.isLoggedIn,
]))
let overviewVersion = 0
let overviewRequest = null
let overviewDisposed = false
const stats = ref({ anonymous: 0, named: 0, total: 0 })
const statsLoading = ref(false)
const statsError = ref('')
const messages = ref([])
const filter = ref('all')
const page = ref(1)
const requestedPage = ref(1)
const total = ref(0)
const hasMore = ref(false)
const listLoading = ref(false)
const listError = ref('')
const selected = ref(null)
const limit = 10
let statsVersion = 0
let listVersion = 0
let statsRequest = null
let listRequest = null
const filters = [{ key: 'all', label: '全部表白' }, { key: '1', label: '匿名表白' }, { key: '0', label: '非匿名表白' }]
const overviewMetrics = [
  { key: 'walls_joined', label: '加入校园墙', unit: '个' },
  { key: 'friends', label: '好友', unit: '位' },
  { key: 'named_posts', label: '实名发帖', unit: '篇' },
  { key: 'comments', label: '评论', unit: '条' },
  { key: 'bookmarks', label: '收藏', unit: '条' },
  { key: 'votes_participated', label: '参与投票', unit: '次' },
]
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit)))
const selectedMessage = computed(() => messages.value.find(message => message.id === selected.value))

function isCurrentOverviewRequest(key, version, request) {
  return !overviewDisposed && userStore.isLoggedIn && overviewAccountKey.value === key
    && version === overviewVersion && overviewRequest === request && !request.signal.aborted
}
async function loadOverview() {
  if (!userStore.isLoggedIn) return
  overviewRequest?.abort()
  const request = new AbortController()
  overviewRequest = request
  const key = overviewAccountKey.value
  const version = ++overviewVersion
  overview.value = null
  overviewLoading.value = true
  overviewError.value = ''
  try {
    const { data } = await api.get('/auth/statistics', { signal: request.signal })
    if (!isCurrentOverviewRequest(key, version, request)) return
    const valid = normalizeAccountOverview(data)
    if (!valid) {
      overviewError.value = '账号概览数据格式无效，请重试'
      return
    }
    overview.value = valid
  } catch (error) {
    if (!isCurrentOverviewRequest(key, version, request)) return
    overviewError.value = getApiErrorMessage(error, '账号概览加载失败，请重试')
  } finally {
    if (isCurrentOverviewRequest(key, version, request)) overviewLoading.value = false
    if (overviewRequest === request) overviewRequest = null
  }
}
const overviewScopeWatch = watch(overviewAccountKey, () => {
  overviewVersion++
  overviewRequest?.abort()
  overviewRequest = null
  overview.value = null
  overviewLoading.value = false
  overviewError.value = ''
  if (userStore.isLoggedIn) loadOverview()
}, { immediate: true, flush: 'sync' })

async function loadStats() {
  if (!active.value || !wallId.value) return
  statsRequest?.abort()
  const request = capture()
  statsRequest = request
  const version = ++statsVersion
  statsLoading.value = true
  statsError.value = ''
  try {
    const { data } = await api.get('/messages/confessions/stats', { ...request.config, params: { wall_id: wallId.value } })
    if (!request.current() || version !== statsVersion) return
    stats.value = { anonymous: Number(data.anonymous) || 0, named: Number(data.named) || 0, total: Number(data.total) || 0 }
  } catch (e) {
    if (request.current() && version === statsVersion) statsError.value = getApiErrorMessage(e, '统计加载失败，请重试')
  } finally {
    if (request.current() && version === statsVersion) statsLoading.value = false
    request.release()
  }
}
async function loadDetails(targetPage = page.value) {
  if (!active.value || !wallId.value) return
  listRequest?.abort()
  const request = capture()
  listRequest = request
  const version = ++listVersion
  const requestedFilter = filter.value
  requestedPage.value = targetPage
  selected.value = null
  listLoading.value = true
  listError.value = ''
  try {
    const { data } = await api.get('/messages/confessions/received', { ...request.config, params: { wall_id: wallId.value, anonymous: requestedFilter, page: targetPage, limit } })
    if (!request.current() || version !== listVersion) return
    messages.value = data.messages || []
    total.value = Number(data.total) || 0
    page.value = Number(data.page) || targetPage
    hasMore.value = !!data.hasMore
  } catch (e) {
    if (request.current() && version === listVersion) listError.value = getApiErrorMessage(e, '表白详情加载失败，请重试')
  } finally {
    if (request.current() && version === listVersion) listLoading.value = false
    request.release()
  }
}
function showDetails(value = filter.value) {
  const changed = filter.value !== value
  mode.value = 'details'
  filter.value = value
  if (wallId.value && (changed || messages.value.length === 0 || listError.value)) loadDetails(1)
}
function showSummary() {
  mode.value = 'summary'
  selected.value = null
  listVersion++
  listRequest?.abort()
  listLoading.value = false
  loadStats()
}
function refreshDetail() { loadStats() }
watch(contextKey, () => {
  statsVersion++
  listVersion++
  statsRequest?.abort()
  listRequest?.abort()
  stats.value = { anonymous: 0, named: 0, total: 0 }
  messages.value = []
  selected.value = null
  filter.value = 'all'
  page.value = 1
  total.value = 0
  hasMore.value = false
  statsError.value = ''
  listError.value = ''
  statsLoading.value = false
  listLoading.value = false
  if (active.value && wallId.value) { loadStats(); if (mode.value === 'details') loadDetails(1) }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => {
  overviewDisposed = true
  overviewScopeWatch()
  overviewVersion++
  overviewRequest?.abort()
  statsVersion++
  listVersion++
  statsRequest?.abort()
  listRequest?.abort()
})
</script>

<template>
  <div class="statistics-page">
    <header class="statistics-header"><div><h2>统计信息</h2><p class="text-muted">账号综合概览与当前校园墙中的表白统计。</p></div><RouterLink class="btn btn-secondary btn-sm" to="/inbox"><Icon name="inbox" :size="15" />收件箱</RouterLink></header>

    <section class="overview-section" aria-labelledby="overview-title">
      <div class="section-heading"><div><h3 id="overview-title">账号概览</h3><p class="text-muted">以下信息为你的账号全局汇总，不随当前校园墙切换。</p></div><span class="account-id glass">账号 ID：{{ accountId }}</span></div>
      <p v-if="overviewError" class="state-error" role="alert">{{ overviewError }} <button class="btn btn-secondary btn-sm" :disabled="overviewLoading" @click="loadOverview">重试</button></p>
      <div v-if="overviewLoading" class="overview-loading" aria-busy="true" aria-label="正在加载账号概览"><SkeletonCard v-for="index in 6" :key="index" :lines="2" /></div>
      <template v-else-if="overview">
        <div class="account-meta glass">
          <div><span class="text-muted">注册时间</span><strong>{{ registeredAtText }}</strong></div>
          <div><span class="text-muted">加入天数</span><strong>{{ joinedDaysText }}</strong></div>
        </div>
        <div class="overview-grid" aria-label="账号综合统计">
          <article v-for="metric in overviewMetrics" :key="metric.key" class="overview-card glass"><span>{{ metric.label }}</span><strong>{{ overview.counts[metric.key] }}<small>{{ metric.unit }}</small></strong></article>
        </div>
        <p class="overview-note text-muted">仅统计可归属到你的实名发帖；匿名发帖不归属于账号，因此不计入发帖总数。</p>
      </template>
    </section>

    <section class="confession-section" aria-labelledby="confession-title">
      <div class="section-heading confession-heading"><div><h3 id="confession-title">表白统计（当前校园墙）</h3><p class="text-muted">收到的原始表白信与实名直接表白；回复和身份详情仍可在信件中查看。</p></div><RouterLink class="btn btn-secondary btn-sm" to="/inbox"><Icon name="inbox" :size="15" />收件箱</RouterLink></div>
      <div v-if="!wallId" class="wall-required glass"><p>选择校园墙后即可查看该墙的表白统计与信件详情；账号概览不受影响。</p><RouterLink class="btn btn-primary btn-sm" to="/walls">选择校园墙</RouterLink></div>
      <template v-else>
        <nav class="statistics-tabs glass" aria-label="表白统计显示方式"><button class="btn btn-sm" :class="mode === 'summary' ? 'btn-primary' : 'btn-secondary'" :aria-pressed="mode === 'summary'" @click="showSummary">汇总</button><button class="btn btn-sm" :class="mode === 'details' ? 'btn-primary' : 'btn-secondary'" :aria-pressed="mode === 'details'" @click="showDetails()">信件详情</button></nav>
        <p v-if="statsError" class="state-error" role="alert">{{ statsError }} <button class="btn btn-secondary btn-sm" :disabled="statsLoading" @click="loadStats">重试</button></p>
        <div v-if="statsLoading" class="summary-grid" aria-busy="true" aria-label="正在加载表白统计"><SkeletonCard v-for="index in 3" :key="index" :lines="2" /></div>
        <div v-else-if="!statsError" class="summary-grid" aria-label="收到的表白数量">
          <button class="stat-card glass" @click="showDetails('1')"><span>匿名表白</span><strong>{{ stats.anonymous }}<small> 封</small></strong><span class="stat-link">查看匿名信 <Icon name="chevron-right" :size="14" /></span></button>
          <button class="stat-card glass" @click="showDetails('0')"><span>非匿名表白</span><strong>{{ stats.named }}<small> 封</small></strong><span class="stat-link">查看非匿名信 <Icon name="chevron-right" :size="14" /></span></button>
          <button class="stat-card glass" @click="showDetails('all')"><span>收到表白总共</span><strong>{{ stats.total }}<small> 封</small></strong><span class="stat-link">查看全部 <Icon name="chevron-right" :size="14" /></span></button>
        </div>
        <p v-if="mode === 'summary' && !statsError" class="text-muted statistics-note">点击数量卡片查看详情。信件回复和身份查看申请不计入；已撤回或从收件箱删除的表白不计入。</p>
        <section v-else-if="mode === 'details'" class="details-section" aria-label="收到的表白信详情">
          <div class="details-toolbar"><div class="filter-options"><button v-for="item in filters" :key="item.key" class="btn btn-secondary btn-sm" :aria-pressed="filter === item.key" @click="showDetails(item.key)">{{ item.label }}</button></div><button class="btn btn-secondary btn-sm" :disabled="listLoading" @click="loadDetails(page)">刷新详情</button></div>
          <div v-if="listLoading" class="details-list" aria-busy="true" aria-label="正在加载表白信"><SkeletonCard v-for="index in 3" :key="index" :lines="2" /></div>
          <p v-else-if="listError" class="state-error" role="alert">{{ listError }} <button class="btn btn-secondary btn-sm" @click="loadDetails(requestedPage)">重试</button></p>
          <template v-else>
            <p v-if="!messages.length" class="empty-state">当前分类暂无表白信。</p>
            <div v-else class="details-list">
              <article v-for="message in messages" :key="message.id" class="received-card glass">
                <div class="received-heading"><span class="confession-kind">{{ message.confession_kind === 'direct' ? '实名直接表白' : message.is_anonymous ? '匿名表白信' : '实名表白信' }}</span><span class="text-muted">{{ timeAgo(message.created_at) }}</span></div>
                <h4>{{ message.title || '表白信' }}</h4>
                <p class="received-preview">{{ truncateText(message.content, 120, message.confession_kind !== 'direct') }}</p>
                <div class="received-footer"><span class="text-muted">来自：{{ message.revealed_sender?.nickname || (message.is_anonymous ? '匿名' : message.sender_nickname || '写信人') }}</span><button class="btn btn-secondary btn-sm" :aria-expanded="selected === message.id" @click="selected = selected === message.id ? null : message.id">{{ selected === message.id ? '收起详情' : '查看详情' }}</button></div>
                <ConfessionDetail v-if="selectedMessage?.id === message.id" :key="message.id" :message="message" @changed="refreshDetail" />
              </article>
            </div>
            <nav class="pagination" aria-label="表白信分页"><button class="btn btn-secondary btn-sm" :disabled="listLoading || page <= 1" @click="loadDetails(page - 1)">上一页</button><span>第 {{ page }} / {{ pageCount }} 页 · {{ total }} 封</span><button class="btn btn-secondary btn-sm" :disabled="listLoading || !hasMore" @click="loadDetails(page + 1)">下一页</button></nav>
          </template>
        </section>
      </template>
    </section>
  </div>
</template>

<style scoped>
.statistics-page { animation: fadeIn 0.5s ease; }
.statistics-header, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.statistics-header { margin-bottom: 24px; }
.statistics-header h2 { font-size: 1.5rem; margin-bottom: 6px; }
.statistics-header p, .section-heading p, .statistics-note, .overview-note { font-size: 0.875rem; line-height: 1.6; }
.section-heading { margin-bottom: 16px; }
.section-heading h3 { font-size: 1.125rem; margin-bottom: 4px; }
.overview-section { margin-bottom: 34px; }
.account-id { padding: 9px 13px; color: var(--text-muted); font-size: 0.8125rem; }
.account-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 18px 20px; margin-bottom: 14px; }
.account-meta > div { display: flex; flex-direction: column; gap: 6px; }
.account-meta span { font-size: 0.8125rem; }
.account-meta strong { font-size: 0.9375rem; font-weight: 600; overflow-wrap: anywhere; }
.overview-grid, .overview-loading { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.overview-card { display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; color: var(--text-primary); }
.overview-card > span { color: var(--text-muted); font-size: 0.875rem; }
.overview-card strong { font-size: 1.75rem; font-variant-numeric: tabular-nums; }
.overview-card small { margin-left: 5px; color: var(--text-muted); font-size: 0.8125rem; font-weight: 400; }
.overview-note { margin-top: 11px; }
.confession-section { border-top: 1px solid var(--border); padding-top: 26px; }
.confession-heading { margin-bottom: 18px; }
.wall-required { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 18px 20px; }
.wall-required p { margin: 0; color: var(--text-muted); font-size: 0.875rem; line-height: 1.6; }
.statistics-tabs { display: flex; padding: 8px; gap: 8px; margin-bottom: 20px; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
.stat-card { display: flex; flex-direction: column; gap: 12px; padding: 22px; text-align: left; color: var(--text-primary); cursor: pointer; }
.stat-card strong { font-size: 2rem; font-variant-numeric: tabular-nums; }
.stat-card small { font-size: 0.875rem; font-weight: 400; }
.stat-link { display: inline-flex; align-items: center; color: var(--text-muted); font-size: 0.8125rem; }
.details-toolbar, .filter-options, .received-heading, .received-footer, .pagination { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.details-toolbar, .received-heading, .received-footer { justify-content: space-between; }
.details-toolbar { margin-bottom: 16px; }
.details-list { display: flex; flex-direction: column; gap: 14px; }
.received-card { padding: 20px; }
.received-heading { font-size: 0.8125rem; margin-bottom: 10px; }
.confession-kind { color: var(--accent-1); font-weight: 600; }
.received-card h4 { font-size: 1rem; margin-bottom: 8px; overflow-wrap: anywhere; }
.received-preview { white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 12px; }
.received-footer, .pagination { font-size: 0.8125rem; }
.pagination { justify-content: center; margin-top: 20px; }
.filter-options [aria-pressed="true"] { border-color: var(--accent-1); color: var(--text-primary); }
@media (max-width: 760px) { .overview-grid, .overview-loading { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .overview-grid, .overview-loading, .summary-grid { grid-template-columns: 1fr; gap: 10px; } .account-meta { gap: 10px; padding: 15px; } .overview-card { flex-direction: row; align-items: center; justify-content: space-between; padding: 15px 16px; } .overview-card strong { font-size: 1.5rem; } .stat-card { padding: 16px; flex-direction: row; align-items: center; justify-content: space-between; flex-wrap: wrap; } .stat-card strong { font-size: 1.5rem; } .stat-link { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .statistics-page { animation: none; } }
</style>
