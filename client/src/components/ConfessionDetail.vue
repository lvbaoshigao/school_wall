<script setup>
import { computed, ref, watch, onBeforeUnmount, useId } from 'vue'
import { useUserStore } from '../stores/user'
import { useConfessionContext } from '../composables/useConfessionContext'
import { useMarkdown } from '../composables/useMarkdown'
import { useTimeAgo } from '../composables/useTimeAgo'
import { confessionRootId, canReplyToConfession, canRequestConfessionIdentity, identityStatusLabel, newConfessionMessageId } from '../utils/confessions'
import ConfirmModal from './ConfirmModal.vue'
import api, { getApiErrorMessage } from '../api'

const props = defineProps({ message: { type: Object, required: true } })
const emit = defineEmits(['changed', 'read'])
const userStore = useUserStore()
const { contextKey, active, capture } = useConfessionContext()
const { renderMarkdown } = useMarkdown()
const { timeAgo } = useTimeAgo()
const fieldId = useId()
const confession = ref(null)
const replies = ref([])
const loading = ref(false)
const olderLoading = ref(false)
const loadError = ref('')
const actionError = ref('')
const hasMore = ref(false)
const beforeId = ref(null)
const replyContent = ref('')
const replyPreview = ref(false)
const replyBusy = ref(false)
const showIdentityConfirm = ref(false)
const identityMessage = ref('')
const identityPreview = ref(false)
const identityBusy = ref(false)
const identityNotice = ref('')
let version = 0
let threadRequest = null
let replyDraft = null
const canReply = computed(() => canReplyToConfession(confession.value))
const canRequestIdentity = computed(() => canRequestConfessionIdentity(confession.value, userStore.user?.id))
const targetWall = () => Number(props.message.wall_id) || undefined

function senderName(message) {
  if (Number(message.sender_id) === Number(userStore.user?.id)) return '我'
  if (message.revealed_sender) return message.revealed_sender.nickname || '写信人'
  return message.is_anonymous || !message.sender_id ? '匿名写信人' : message.sender_nickname || '写信人'
}
async function loadThread(older = false) {
  if (!active.value || (older && (olderLoading.value || !hasMore.value))) return
  threadRequest?.abort()
  const request = capture(targetWall())
  threadRequest = request
  const expected = version
  const rootId = confessionRootId(props.message)
  if (!rootId) return request.release()
  if (older) olderLoading.value = true
  else loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get('/messages/confessions/' + rootId + '/thread', {
      ...request.config, params: { limit: 20, ...(older && beforeId.value ? { before: beforeId.value } : {}) },
    })
    if (!request.current() || expected !== version) return
    confession.value = data.confession
    const incoming = Array.isArray(data.messages) ? data.messages : []
    const unique = new Map((older ? [...incoming, ...replies.value] : incoming).map(item => [item.id, item]))
    replies.value = [...unique.values()]
    hasMore.value = !!data.hasMore
    beforeId.value = data.next_before_id
    markVisibleRead([data.confession, ...incoming], expected)
  } catch (e) {
    if (request.current() && expected === version) loadError.value = getApiErrorMessage(e, '表白详情加载失败，请重试')
  } finally {
    if (request.current() && expected === version) { loading.value = false; olderLoading.value = false }
    request.release()
  }
}
async function markVisibleRead(items, expected) {
  const unread = items.filter(item => item && !item.is_read && Number(item.receiver_id) === Number(userStore.user?.id))
  if (!unread.length) return
  const request = capture(targetWall())
  try {
    await api.put('/messages/read-batch', { ids: unread.map(item => item.id) }, request.config)
    if (!request.current() || expected !== version) return
    unread.forEach(item => { item.is_read = 1 })
    emit('read', unread.map(item => item.id))
  } catch (e) {
    if (request.current() && expected === version) actionError.value = getApiErrorMessage(e, '标记已读失败，可以重新加载详情重试')
  } finally { request.release() }
}
function reset() {
  version++
  threadRequest?.abort()
  confession.value = null
  replies.value = []
  loading.value = false
  olderLoading.value = false
  hasMore.value = false
  beforeId.value = null
  loadError.value = ''
  actionError.value = ''
  replyContent.value = ''
  replyPreview.value = false
  replyBusy.value = false
  replyDraft = null
  showIdentityConfirm.value = false
  identityMessage.value = ''
  identityPreview.value = false
  identityBusy.value = false
  identityNotice.value = ''
  if (active.value) loadThread()
}
watch(() => [contextKey.value, confessionRootId(props.message), props.message.wall_id], reset, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { version++; threadRequest?.abort() })

async function sendReply() {
  const text = replyContent.value.trimEnd()
  if (!canReply.value || replyBusy.value || !text.trim()) return
  const rootId = confessionRootId(confession.value)
  const signature = rootId + ':' + text
  if (replyDraft?.signature !== signature) replyDraft = { signature, id: newConfessionMessageId() }
  const request = capture(targetWall())
  const expected = version
  replyBusy.value = true
  actionError.value = ''
  try {
    await api.post('/messages/confessions/' + rootId + '/replies', { content: text, client_message_id: replyDraft.id }, request.config)
    if (!request.current() || expected !== version) return
    replyContent.value = ''
    replyPreview.value = false
    replyDraft = null
    await loadThread()
    if (request.current() && expected === version) emit('changed')
  } catch (e) {
    if (request.current() && expected === version) actionError.value = getApiErrorMessage(e, '回复发送失败，请重试')
  } finally {
    if (request.current() && expected === version) replyBusy.value = false
    request.release()
  }
}
function openIdentityConfirm() {
  if (!canRequestIdentity.value || identityBusy.value) return
  identityPreview.value = false
  showIdentityConfirm.value = true
}
async function requestIdentity() {
  if (!canRequestIdentity.value || identityBusy.value) return
  const request = capture(targetWall())
  const expected = version
  identityBusy.value = true
  actionError.value = ''
  identityNotice.value = ''
  try {
    const { data } = await api.post('/messages/confessions/' + confessionRootId(confession.value) + '/identity-requests', { message: identityMessage.value.trimEnd(), confirmed: true }, request.config)
    if (!request.current() || expected !== version) return
    confession.value = { ...confession.value, identity_request: data.request }
    identityMessage.value = ''
    identityNotice.value = '申请已发送，只有写信人同意后才会披露身份。'
    emit('changed')
  } catch (e) {
    if (request.current() && expected === version) {
      actionError.value = getApiErrorMessage(e, '身份申请发送失败，请重试')
      if (e.response?.status === 409) await loadThread()
    }
  } finally {
    if (request.current() && expected === version) identityBusy.value = false
    request.release()
  }
}
</script>

<template>
  <section class="confession-detail" aria-label="表白信详情" @click.stop>
    <p v-if="loading" role="status">正在加载表白详情…</p>
    <p v-if="loadError" class="state-error" role="alert">{{ loadError }} <button class="btn btn-secondary btn-sm" :disabled="loading || olderLoading" @click="loadThread(!!confession && hasMore)">重试</button></p>
    <template v-if="confession && !loading">
      <div class="detail-heading"><h3>{{ confession.title || (confession.confession_kind === 'direct' ? '实名直接表白' : '表白信') }}</h3><span class="text-muted">{{ timeAgo(confession.created_at) }}</span></div>
      <p class="text-muted">来自：{{ senderName(confession) }} · {{ confession.is_anonymous ? '匿名表白' : '实名表白' }}</p>
      <p v-if="confession.confession_kind === 'direct'" class="confession-body direct-body">{{ confession.content }}</p>
      <div v-else class="markdown-body confession-body" v-html="renderMarkdown(confession.content)"></div>
      <p v-if="confession.revealed_sender" class="identity-result" role="status">写信人已同意披露：<RouterLink :to="'/user/' + confession.revealed_sender.id">{{ confession.revealed_sender.nickname || '写信人' }}</RouterLink></p>
      <p v-else-if="confession.identity_request" class="text-muted" role="status">{{ identityStatusLabel(confession.identity_request.status) }}</p>
      <button v-if="canRequestIdentity" class="btn btn-sm btn-secondary" :disabled="identityBusy" @click="openIdentityConfirm">{{ identityBusy ? '申请发送中…' : '申请查看身份' }}</button>
      <p v-if="identityNotice" class="text-muted" role="status">{{ identityNotice }}</p>
      <p v-if="actionError" class="state-error" role="alert">{{ actionError }}</p>
      <div v-if="replies.length || canReply || hasMore" class="reply-thread">
        <h4>信件回复</h4>
        <button v-if="hasMore" class="btn btn-secondary btn-sm" :disabled="olderLoading" @click="loadThread(true)">{{ olderLoading ? '加载中…' : '加载更早回复' }}</button>
        <article v-for="reply in replies" :key="reply.id" class="reply-item">
          <div class="detail-heading"><strong>{{ senderName(reply) }}</strong><span class="text-muted">{{ timeAgo(reply.created_at) }}</span></div>
          <div class="markdown-body confession-body" v-html="renderMarkdown(reply.content)"></div>
        </article>
        <form v-if="canReply" class="reply-form" @submit.prevent="sendReply">
          <label :for="fieldId + '-reply'">回复这封表白信</label>
          <p class="text-muted reply-note">通过信件安全回复；匿名写信人的身份仍受保护。</p>
          <div class="preview-tabs"><button type="button" class="btn btn-secondary btn-sm" :aria-pressed="!replyPreview" @click="replyPreview = false">编辑</button><button type="button" class="btn btn-secondary btn-sm" :aria-pressed="replyPreview" @click="replyPreview = true">Markdown 预览</button></div>
          <div v-if="replyPreview" class="markdown-body confession-body preview-body" v-html="renderMarkdown(replyContent || '暂无内容')"></div>
          <textarea v-else :id="fieldId + '-reply'" v-model="replyContent" :disabled="replyBusy" rows="4" maxlength="2000" placeholder="写下回复，支持 Markdown"></textarea>
          <div class="reply-form-footer"><span class="text-muted">{{ replyContent.length }}/2000</span><button class="btn btn-primary btn-sm" :disabled="replyBusy || !replyContent.trim()">{{ replyBusy ? '发送中…' : '发送回复' }}</button></div>
        </form>
      </div>
      <p v-if="!canReply && confession.confession_kind !== 'reply'" class="text-muted reply-note">{{ confession.confession_kind === 'direct' ? '实名直接表白不开放回复。' : '这封表白信未开放回复。' }}</p>
    </template>
    <ConfirmModal :show="showIdentityConfirm" title="申请查看匿名写信人身份" message="只有写信人在收件箱同意后，你才能看到身份。可以附上一段说明，也可以直接发送申请。" confirm-text="确认发送申请" @confirm="requestIdentity" @update:show="showIdentityConfirm = $event">
      <div class="identity-editor">
        <label :for="fieldId + '-identity'">附言（可选，支持 Markdown）</label>
        <div class="preview-tabs"><button type="button" class="btn btn-secondary btn-sm" :aria-pressed="!identityPreview" @click="identityPreview = false">编辑</button><button type="button" class="btn btn-secondary btn-sm" :aria-pressed="identityPreview" @click="identityPreview = true">预览</button></div>
        <div v-if="identityPreview" class="markdown-body confession-body preview-body" v-html="renderMarkdown(identityMessage || '未填写附言')"></div>
        <textarea v-else :id="fieldId + '-identity'" v-model="identityMessage" data-focus-initial rows="5" maxlength="2000" placeholder="告诉对方你为什么希望知道身份…"></textarea>
        <p class="text-muted reply-note">{{ identityMessage.length }}/2000 · 每封信只能申请一次</p>
      </div>
    </ConfirmModal>
  </section>
</template>

<style scoped>
.confession-detail { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border); cursor: default; }
.detail-heading { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.detail-heading h3 { font-size: 1.1rem; overflow-wrap: anywhere; }
.detail-heading span, .reply-note { font-size: 0.8125rem; }
.confession-body { margin: 12px 0; overflow-wrap: anywhere; overflow-x: auto; }
.direct-body { white-space: pre-wrap; }
.identity-result { margin: 12px 0; }
.reply-thread { margin-top: var(--space-4); }
.reply-thread h4 { margin-bottom: 12px; }
.reply-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
.reply-form { margin-top: var(--space-4); }
.reply-form textarea, .identity-editor textarea { width: 100%; resize: vertical; }
.reply-form-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
.preview-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.preview-body { padding: 10px; min-height: 100px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.identity-editor { margin: 12px 0; }
</style>
