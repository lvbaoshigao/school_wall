<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '../api'
import Icon from '../components/Icon.vue'
import { useSettingsStore } from '../stores/settings'
import { useMarkdown } from '../composables/useMarkdown'
import { useConfessionContext } from '../composables/useConfessionContext'
import { confessionPayload, newConfessionMessageId } from '../utils/confessions'

const router = useRouter()
const settingsStore = useSettingsStore()
const { renderMarkdown } = useMarkdown()
const { contextKey, wallId, active, capture } = useConfessionContext()
const searchQuery = ref('')
const searchResults = ref([])
const selectedUser = ref(null)
const title = ref('')
const content = ref('')
const isAnonymous = ref(settingsStore.prefs.default_anonymous_confession)
const allowReplies = ref(false)
const direct = ref(false)
const preview = ref(false)
const loading = ref(false)
const error = ref('')
const success = ref(false)
const searching = ref(false)
const searchError = ref('')
let searchTimer = null
let redirectTimer = null
let searchVersion = 0
let searchRequest = null
let pendingSubmission = null

function cancelSearch() {
  clearTimeout(searchTimer)
  searchRequest?.abort()
  searchVersion++
  searching.value = false
}
watch(contextKey, () => {
  cancelSearch()
  clearTimeout(redirectTimer)
  searchQuery.value = ''
  searchResults.value = []
  selectedUser.value = null
  title.value = ''
  content.value = ''
  isAnonymous.value = settingsStore.prefs.default_anonymous_confession
  allowReplies.value = false
  direct.value = false
  preview.value = false
  loading.value = false
  success.value = false
  error.value = ''
  searchError.value = ''
  pendingSubmission = null
}, { flush: 'sync' })

watch(searchQuery, val => {
  cancelSearch()
  const version = searchVersion
  const query = val.trim()
  searchResults.value = []
  searchError.value = ''
  searching.value = !!query && active.value && !!wallId.value
  if (!searching.value) return
  searchTimer = setTimeout(async () => {
    const request = capture()
    searchRequest = request
    try {
      const res = await api.get('/users/search', { ...request.config, params: { q: query, wall_id: wallId.value } })
      if (request.current() && version === searchVersion) searchResults.value = Array.isArray(res.data) ? res.data : []
    } catch (e) {
      if (request.current() && version === searchVersion) searchError.value = getApiErrorMessage(e, '搜索失败，请重新输入或稍后重试')
    } finally {
      if (request.current() && version === searchVersion) searching.value = false
      request.release()
    }
  }, 300)
})
onBeforeUnmount(() => { cancelSearch(); clearTimeout(redirectTimer) })

function selectUser(user) {
  if (loading.value) return
  selectedUser.value = user
  searchQuery.value = ''
  searchResults.value = []
}
function clearUser() { if (!loading.value) selectedUser.value = null }

async function submit() {
  if (loading.value || success.value) return
  if (!active.value || !wallId.value) { error.value = '请先登录并选择校园墙'; return }
  if (!selectedUser.value) { error.value = '请选择收件人'; return }
  if (!direct.value && !content.value.trim()) { error.value = '内容不能为空'; return }
  const draft = confessionPayload({ receiverId: selectedUser.value.id, wallId: wallId.value, direct: direct.value, title: title.value, content: content.value, anonymous: isAnonymous.value, allowReplies: allowReplies.value })
  const fingerprint = JSON.stringify(draft)
  if (pendingSubmission?.fingerprint !== fingerprint) pendingSubmission = { fingerprint, id: newConfessionMessageId() }
  draft.payload.client_message_id = pendingSubmission.id
  const request = capture()
  loading.value = true
  error.value = ''
  try {
    await api.post(draft.endpoint, draft.payload, request.config)
    if (!request.current()) return
    success.value = true
    redirectTimer = setTimeout(() => { if (request.current()) router.push('/inbox') }, 2000)
  } catch (e) {
    if (request.current()) error.value = getApiErrorMessage(e, '发送失败，请重试')
  } finally {
    if (request.current()) loading.value = false
    request.release()
  }
}
</script>

<template>
  <div class="confession-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div v-if="success" class="success-card glass-strong">
      <div class="success-icon"><Icon name="check-circle" :size="40" /></div>
      <h2>{{ direct ? '实名直接表白已送出！' : '表白信已送出！' }}</h2>
      <p class="text-muted">对方会在收件箱中收到你的信</p>
      <p class="text-muted">正在跳转到收件箱...</p>
    </div>

    <div v-else class="confession-card glass-strong">
      <h2>撰写表白信</h2>
      <p class="text-muted mb-3">把你的心意传达给TA</p>

      <div v-if="error" class="error-msg" role="alert">{{ error }}</div>

      <fieldset class="confession-fields" :disabled="loading">
      <div class="form-group">
        <label class="checkbox-label"><input type="checkbox" v-model="direct" />实名直接表白</label>
        <p class="text-muted mode-hint">{{ direct ? '选择收信人后即可发送。系统将使用你的昵称实名表达心意，不发送标题或正文，也不开放回复。' : '写一封表白信，选择是否匿名和允许回复。' }}</p>
      </div>
      <!-- 选择收件人 -->
      <div class="form-group">
        <label for="confession-recipient">收件人</label>
        <div v-if="selectedUser" class="selected-user">
          <span class="avatar-sm">{{ (selectedUser.real_name || selectedUser.nickname || selectedUser.username)[0] }}</span>
          <div>
            <strong>{{ selectedUser.real_name || selectedUser.nickname || selectedUser.username }}</strong>
            <span v-if="selectedUser.real_name" class="text-muted"> · {{ selectedUser.nickname }}</span>
            <span v-if="selectedUser.class_number" class="text-muted"> · {{ selectedUser.class_number }}班</span>
          </div>
          <button class="btn btn-sm btn-secondary" @click="clearUser">更换</button>
        </div>
        <div v-else class="search-box">
          <input
            id="confession-recipient"
            v-model="searchQuery"
            placeholder="输入真实姓名搜索收件人..."
          />
          <div v-if="searchResults.length > 0" class="search-results glass">
            <button
              type="button"
              v-for="user in searchResults"
              :key="user.id"
              class="search-item"
              @click="selectUser(user)"
            >
              <span class="avatar-xs">{{ (user.real_name || user.nickname || user.username)[0] }}</span>
              <div>
                <strong>{{ user.real_name || user.nickname || user.username }}</strong>
                <span v-if="user.real_name" class="text-muted"> · {{ user.nickname }}</span>
                <span v-if="user.class_number" class="text-muted"> · {{ user.class_number }}班</span>
              </div>
            </button>
          </div>
          <p v-if="searching" role="status" class="search-empty text-muted">正在搜索收件人…</p>
          <p v-else-if="searchError" role="alert" class="state-error">{{ searchError }}</p>
          <div v-else-if="searchQuery.trim().length > 0 && searchResults.length === 0" class="search-empty text-muted">
            未找到用户
          </div>
        </div>
      </div>

      <template v-if="!direct">
      <!-- 标题 -->
      <div class="form-group">
        <label for="confession-title">标题 <span class="text-muted">(可选)</span></label>
        <input id="confession-title" maxlength="100" v-model="title" placeholder="给信起个标题..." />
      </div>

      <!-- 内容 -->
      <div class="form-group">
        <label for="confession-content">内容</label>
        <div class="preview-tabs" aria-label="正文显示方式">
          <button type="button" class="btn btn-sm btn-secondary" :aria-pressed="!preview" @click="preview = false">编辑</button>
          <button type="button" class="btn btn-sm btn-secondary" :aria-pressed="preview" @click="preview = true">Markdown 预览</button>
        </div>
        <div v-if="preview" class="markdown-body confession-preview" v-html="renderMarkdown(content || '暂无内容')"></div>
        <textarea v-else
          id="confession-content"
          v-model="content"
          placeholder="写下你想对TA说的话..."
          rows="6"
          maxlength="2000"
        ></textarea>
        <div class="char-count">{{ content.length }}/2000</div>
      </div>

      <!-- 匿名选项 -->
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="isAnonymous" />
          匿名发送（对方看不到你是谁）
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-label"><input type="checkbox" v-model="allowReplies" />允许收信人回复</label>
        <p class="text-muted mode-hint">关闭后，这封信不会显示回复按钮。</p>
      </div>
      <div v-if="isAnonymous" class="anonymous-notice">
        收信人看不到你的身份，可以申请查看；只有你在收件箱明确同意后，才会向该收信人披露。系统保留身份信息以防止滥用。
      </div>
      </template>
      <div v-else class="anonymous-notice" role="note">本次为实名直接表白，对方会知道是你。确认收信人后点击下方按钮发送。</div>
      </fieldset>
      <button class="btn btn-primary submit-button" :disabled="loading || !active || !wallId || !selectedUser || (!direct && !content.trim())" @click="submit">
        {{ loading ? '发送中…' : direct ? '实名直接表白' : '发送表白信' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.confession-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
.mode-hint { margin-top: 6px; font-size: 0.8125rem; line-height: 1.6; }
.preview-tabs { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.confession-preview { min-height: 150px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); overflow-wrap: anywhere; overflow-x: auto; }
.confession-preview :deep(img) { max-width: 100%; height: auto; }
.submit-button { width: 100%; }
@media (prefers-reduced-motion: reduce) { .confession-page { animation: none; } }

.confession-page {
  animation: fadeIn 0.5s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.confession-card, .success-card {
  padding: 28px;
}

.confession-card h2, .success-card h2 {
  font-size: 1.375rem;
  margin-bottom: 4px;
}

.success-card {
  text-align: center;
  padding: 48px 28px;
}

.success-icon { display: flex; justify-content: center; color: var(--success-light, var(--success)); margin-bottom: 16px; }

.selected-user {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
}

.selected-user .avatar-sm {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.selected-user div {
  flex: 1;
}

.search-box {
  position: relative;
}

.search-results {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  max-height: 300px;
  overflow-y: auto;
  margin-top: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.2s;
  border-radius: var(--radius-sm);
}

.search-item:hover {
  background: rgba(255, 255, 255, 0.15);
}

.avatar-xs {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--btn-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8125rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.search-item div {
  flex: 1;
}

.search-item strong {
  font-size: 0.875rem;
}

.search-empty {
  padding: 12px;
  text-align: center;
  font-size: 0.8125rem;
}

textarea {
  resize: vertical;
  min-height: 150px;
}

.char-count {
  text-align: right;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.anonymous-notice {
  background: color-mix(in srgb, var(--accent-1) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-1) 30%, transparent);
  color: var(--text-secondary);
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  margin-bottom: 16px;
  line-height: 1.5;
}

.error-msg {
  background: rgba(255, 107, 107, 0.2);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: var(--danger-light);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  margin-bottom: 16px;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.search-item { width: 100%; border: 0; color: var(--text-primary); font: inherit; text-align: left; background: transparent; }
.selected-user { flex-wrap: wrap; }
.selected-user > div { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 480px) { .confession-card, .success-card { padding: 22px 16px; } }
</style>
