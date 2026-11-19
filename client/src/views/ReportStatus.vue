<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const report = ref(null)
const loading = ref(true)
const notFound = ref(false)
const loadError = ref('')
let loadVersion = 0
let controller = null
let disposed = false

const statusMap = {
  pending: { label: '待处理', color: 'status-pending' },
  processing: { label: '处理中', color: 'status-processing' },
  resolved: { label: '已处理', color: 'status-resolved' },
  rejected: { label: '已驳回', color: 'status-rejected' },
}

async function loadReport() {
  const version = ++loadVersion
  controller?.abort()
  controller = new AbortController()
  const requestController = controller
  loading.value = true
  notFound.value = false
  loadError.value = ''
  report.value = null
  try {
    const res = await api.get(`/reports/track/${encodeURIComponent(route.params.code)}`, { signal: requestController.signal })
    if (disposed || version !== loadVersion) return
    report.value = res.data
  } catch (e) {
    if (disposed || version !== loadVersion || requestController.signal.aborted) return
    // 不存在与无权查看仍统一展示；网络/服务故障提供重试。
    if ([403, 404].includes(e.response?.status)) notFound.value = true
    else loadError.value = '举报状态加载失败，请检查网络后重试'
  } finally {
    if (!disposed && version === loadVersion) loading.value = false
  }
}

const formatDate = (d) => {
  if (!d) return ''
  return new Date(d.replace(' ', 'T')).toLocaleString('zh-CN')
}

watch(() => route.params.code, loadReport, { immediate: true })
onBeforeUnmount(() => { disposed = true; loadVersion++; controller?.abort() })
</script>

<template>
  <div class="status-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回首页</button>

    <div v-if="loading" class="loading">加载中</div>

    <p v-else-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" @click="loadReport">重试</button></p>
    <div v-else-if="notFound" class="not-found glass-strong">
      <div class="icon"><Icon name="search" :size="34" /></div>
      <h2>未找到举报记录</h2>
      <p class="text-muted">请检查追踪码是否正确: <strong>{{ route.params.code }}</strong></p>
      <p class="text-muted">追踪码格式: RPT-年份+8位字符，如 RPT-2026A3B5C7D9（旧的 4 位追踪码仍可查询）</p>
    </div>

    <div v-else-if="report" class="report-detail glass-strong">
      <div class="detail-header">
        <h2>举报状态查询</h2>
        <span class="status-badge" :class="statusMap[report.status]?.color">
          {{ statusMap[report.status]?.label || report.status }}
        </span>
      </div>

      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">追踪码</span>
          <span class="detail-value code">{{ report.tracking_code }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">举报类型</span>
          <span class="detail-value">{{ report.report_types }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">提交时间</span>
          <span class="detail-value">{{ formatDate(report.created_at) }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">最后更新</span>
          <span class="detail-value">{{ formatDate(report.updated_at) }}</span>
        </div>
      </div>

      <div v-if="report.status_note" class="status-note">
        <span class="detail-label">处理备注</span>
        <p>{{ report.status_note }}</p>
      </div>

      <div class="status-timeline">
        <div class="timeline-item" :class="{ active: true }">
          <div class="timeline-dot"></div>
          <span>已提交</span>
        </div>
        <div class="timeline-item" :class="{ active: ['processing','resolved','rejected'].includes(report.status) }">
          <div class="timeline-dot"></div>
          <span>处理中</span>
        </div>
        <div class="timeline-item" :class="{ active: ['resolved','rejected'].includes(report.status) }">
          <div class="timeline-dot"></div>
          <span>{{ report.status === 'rejected' ? '已驳回' : '已处理' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.not-found { text-align: center; padding: 48px 28px; }
.not-found .icon { font-size: 3rem; margin-bottom: 16px; }

.report-detail { padding: 28px; }

.detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
.detail-header h2 { font-size: 1.375rem; }

.status-badge { padding: 6px 16px; border-radius: var(--radius-xl); font-size: 0.875rem; font-weight: 600; }
.status-pending { background: rgba(255,200,0,0.2); color: var(--warning); }
.status-processing { background: color-mix(in srgb, var(--accent-1) 20%, transparent); color: var(--text-link); }
.status-resolved { background: rgba(46,213,115,0.2); color: var(--success); }
.status-rejected { background: rgba(255,107,107,0.2); color: var(--danger-light); }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
@media (max-width: 500px) { .detail-grid { grid-template-columns: 1fr; } }

.detail-item { padding: 14px 16px; background: rgba(255,255,255,0.05); border-radius: var(--radius-md); }
.detail-label { display: block; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
.detail-value { font-size: 0.9375rem; font-weight: 600; }
.detail-value.code { font-family: monospace; letter-spacing: 2px; color: var(--text-link); }

.status-note { padding: 16px; background: rgba(255,255,255,0.05); border-radius: var(--radius-md); margin-bottom: 24px; }
.status-note p { margin-top: 8px; font-size: 0.875rem; line-height: 1.6; color: var(--text-secondary); }

.status-timeline { display: flex; align-items: center; justify-content: space-between; padding: 20px 0; }
.timeline-item { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 1; position: relative; }
.timeline-item::before { content: ''; position: absolute; top: 10px; left: -50%; right: 50%; height: 2px; background: rgba(255,255,255,0.1); }
.timeline-item:first-child::before { display: none; }
.timeline-item.active::before { background: rgba(46,213,115,0.5); }
.timeline-dot { width: 20px; height: 20px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.2); z-index: 1; }
.timeline-item.active .timeline-dot { background: rgba(46,213,115,0.3); border-color: rgba(46,213,115,0.6); }
.timeline-item span { font-size: 0.75rem; color: var(--text-muted); }
.timeline-item.active span { color: var(--text-primary); }

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.detail-value { overflow-wrap: anywhere; }
.status-note p { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) { .report-detail, .not-found { padding: 22px 16px; } }
</style>
