<script setup>
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'
import { useMarkdown, safeImageUrl } from '../composables/useMarkdown'
import { useToast } from '../composables/useToast'
import api from '../api'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useSettingsStore } from '../stores/settings'
import { usePostDraft } from '../composables/usePostDraft.js'

const router = useRouter()
const userStore = useUserStore()
const wallStore = useWallStore()
const { renderMarkdown } = useMarkdown()
const toast = useToast()
const content = ref('')
const category = ref('分享')
const customCategory = ref('')
const useCustomCategory = ref(false)
const settingsStore = useSettingsStore()
const isAnonymous = ref(settingsStore.prefs.default_anonymous_post)
const isMarkdown = ref(settingsStore.prefs.default_markdown)
const loading = ref(false)
const images = ref([])
const uploading = ref(false)
const showMdPreview = ref(false)
const mdTextarea = ref(null)
const error = ref('')
const showConfirmPost = ref(false)
const confirmPostText = ref('')
const categories = ['吐槽', '分享', '求助', '讨论', '其他']
const postContent = computed(() => [content.value.trim(), ...images.value.map(url => '[img]' + url + '[/img]')].filter(Boolean).join('\n'))
const renderedPreview = computed(() => renderMarkdown(content.value || '*暂无内容*'))
const showDiscardDraft = ref(false)
const { draftStatus, hasDraft, captureDraft, completeDraft, discardDraft, isCurrentScope } = usePostDraft({
  userStore, wallStore,
  fields: { content, category, customCategory, useCustomCategory, isAnonymous, isMarkdown, images },
  defaults: () => ({ content: '', category: '分享', customCategory: '', useCustomCategory: false,
    isAnonymous: settingsStore.prefs.default_anonymous_post, isMarkdown: settingsStore.prefs.default_markdown, images: [] }),
})
const draftMessage = computed(() => ({
  restored: '已恢复本标签页为当前校园墙保存的草稿。',
  saved: '草稿已自动保存，刷新或返回此页可继续编辑。',
  unavailable: '浏览器暂时无法保存草稿，请保留此页继续编辑或发布。',
  empty: '草稿保存在本标签页，按账号与校园墙分别保存；退出登录后清除。',
}[draftStatus.value]))
let disposed = false
let uploadController
watch(() => [userStore.sessionRevision, userStore.user?.id, wallStore.currentWallId], () => {
  uploadController?.abort()
  showConfirmPost.value = false
  showDiscardDraft.value = false
}, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; uploadController?.abort() })
function selectCategory(cat) { useCustomCategory.value = false; category.value = cat }
function enableCustomCategory() { useCustomCategory.value = true; category.value = '' }

function insertMd(before, after) {
  const el = mdTextarea.value
  const start = el?.selectionStart ?? content.value.length
  const end = el?.selectionEnd ?? start
  const next = content.value.slice(0, start) + before + content.value.slice(start, end) + after + content.value.slice(end)
  if (next.length > 2000) { error.value = '内容不能超过 2000 字'; return }
  content.value = next
  nextTick(() => { if (el) { el.focus(); el.setSelectionRange(start + before.length, end + before.length) } })
}

async function handleImageUpload(e) {
  const input = e.target
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length || uploading.value || loading.value) return
  error.value = ''
  if (images.value.length + files.length > 9) { error.value = '最多上传 9 张图片'; return }
  const captured = captureDraft()
  if (!captured) { error.value = '账户或校园墙信息未就绪，请稍后重试'; return }
  const token = userStore.token
  uploading.value = true
  uploadController = new AbortController()
  try {
    for (const file of files) {
      if (disposed || !isCurrentScope(captured.scope)) return
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) {
        error.value = '请选择有效的 JPG、PNG、WebP、GIF 或 AVIF 图片，每张不超过 5MB'
        continue
      }
      try {
        const image = await compressImage(file, 1200, 0.8)
        if (disposed || !isCurrentScope(captured.scope)) return
        const res = await api.post('/upload/image', { image }, { signal: uploadController.signal,
          headers: { Authorization: 'Bearer ' + token, 'X-Wall-Id': captured.scope.wallId } })
        if (disposed || !isCurrentScope(captured.scope)) return
        const url = safeImageUrl(res.data.url)
        if (!url) throw new Error('Invalid upload URL')
        images.value.push(url)
      } catch (err) {
        if (disposed || !isCurrentScope(captured.scope)) return
        error.value = '图片“' + file.name + '”上传失败，请重新选择后重试'
      }
    }
  } finally { uploading.value = false }
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let image
    const timer = setTimeout(() => fail(new Error('Image decode timed out')), 15000)
    function fail(reason) { clearTimeout(timer); reject(reason) }
    reader.onerror = () => fail(new Error('File read failed'))
    reader.onabort = () => fail(new Error('File read aborted'))
    reader.onload = ev => {
      image = new Image()
      image.onerror = () => fail(new Error('Image decode failed'))
      image.onload = () => {
        try {
          if (!image.width || !image.height) throw new Error('Empty image')
          const scale = Math.min(1, maxDim / Math.max(image.width, image.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(image.width * scale))
          canvas.height = Math.max(1, Math.round(image.height * scale))
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Canvas unavailable')
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          const data = canvas.toDataURL('image/jpeg', quality)
          if (!data.startsWith('data:image/jpeg;base64,')) throw new Error('Image encode failed')
          clearTimeout(timer)
          resolve(data)
        } catch (reason) { fail(reason) }
      }
      image.src = ev.target.result
    }
    reader.readAsDataURL(file)
  })
}

function removeImage(index) { if (!loading.value && !uploading.value) images.value.splice(index, 1) }
function validatePost() {
  error.value = ''
  if (uploading.value) error.value = '图片正在上传，请稍候再发布'
  else if (!postContent.value) error.value = '请填写内容或添加图片'
  else if (postContent.value.length > 2000 || content.value.length > 2000) error.value = '内容与图片链接合计不能超过 2000 字，请缩短内容'
  const finalCategory = (useCustomCategory.value ? customCategory.value : category.value).trim()
  if (!error.value && (!finalCategory || finalCategory.length > 20)) error.value = '请选择分类，或输入不超过 20 字的自定义分类'
  return error.value ? null : { content: postContent.value, category: finalCategory, is_anonymous: isAnonymous.value, is_markdown: isMarkdown.value }
}
async function submit() {
  if (loading.value) return
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  const payload = validatePost()
  if (!payload) return
  if (settingsStore.prefs.confirm_before_post) {
    confirmPostText.value = '确定发布这条' + (isAnonymous.value ? '匿名' : '') + '帖子到「' + payload.category + '」吗？'
    showConfirmPost.value = true
    return
  }
  await doSubmit()
}
async function doSubmit() {
  if (loading.value) return
  if (!userStore.isLoggedIn) { router.push('/login'); return }
  const payload = validatePost()
  if (!payload) return
  const captured = captureDraft()
  if (!captured) { error.value = '账户或校园墙信息未就绪，请稍后重试'; return }
  loading.value = true
  try {
    await api.post('/posts', payload, { headers: { Authorization: 'Bearer ' + userStore.token, 'X-Wall-Id': captured.scope.wallId } })
    completeDraft(captured)
    if (disposed || !isCurrentScope(captured.scope)) return
    toast.success('帖子已发布')
    router.push('/')
  } catch (e) {
    if (disposed || !isCurrentScope(captured.scope)) return
    error.value = typeof e.response?.data?.error === 'string' ? e.response.data.error : '发布失败，内容已保留，请稍后重试'
  } finally { loading.value = false }
}
</script>

<template>
  <div class="create-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="create-card glass-strong">
      <h1>发布帖子</h1>
      <p class="text-muted mb-3">记录一件小事，发起一场校园里的对话</p>

      <div class="draft-notice">
        <p role="status" aria-live="polite">{{ draftMessage }}</p>
        <button v-if="hasDraft" type="button" class="btn btn-secondary btn-sm" :disabled="loading || uploading" @click="showDiscardDraft = true">清空草稿</button>
      </div>
      <p v-if="error" id="post-error" class="error-msg" role="alert">{{ error }}</p>
      <fieldset :disabled="loading" class="post-fields">
      <div class="form-group">
        <span id="post-category-label" class="field-label">分类</span>
        <div class="category-selector" role="group" aria-labelledby="post-category-label">
          <button v-for="cat in categories" :key="cat" class="cat-btn" :class="{ active: !useCustomCategory && category === cat }" :aria-pressed="!useCustomCategory && category === cat" @click="selectCategory(cat)">{{ cat }}</button>
          <button class="cat-btn cat-custom" :class="{ active: useCustomCategory }" :aria-pressed="useCustomCategory" @click="enableCustomCategory">自定义</button>
        </div>
        <input v-if="useCustomCategory" v-model="customCategory" aria-label="自定义分类" placeholder="输入自定义分类..." class="custom-input" maxlength="20" />
      </div>

      <div class="form-group">
        <label for="post-content">内容</label>
        <div v-if="isMarkdown" class="md-editor">
          <div class="md-toolbar">
            <button class="md-btn" @click="insertMd('**', '**')" title="粗体" aria-label="粗体"><Icon name="bold" :size="15" /></button>
            <button class="md-btn" @click="insertMd('*', '*')" title="斜体" aria-label="斜体"><Icon name="italic" :size="15" /></button>
            <button class="md-btn" @click="insertMd('~~', '~~')" title="删除线" aria-label="删除线"><Icon name="strike" :size="15" /></button>
            <button class="md-btn" @click="insertMd('# ', '')" title="标题" aria-label="标题"><Icon name="heading" :size="15" /></button>
            <button class="md-btn" @click="insertMd('- ', '')" title="列表" aria-label="列表"><Icon name="list" :size="15" /></button>
            <button class="md-btn" @click="insertMd('> ', '')" title="引用" aria-label="引用"><Icon name="quote" :size="15" /></button>
            <button class="md-btn" @click="insertMd('`', '`')" title="行内代码" aria-label="行内代码"><Icon name="code" :size="15" /></button>
            <button class="md-btn" @click="insertMd('```\n', '\n```')" title="代码块" aria-label="代码块"><Icon name="code-block" :size="15" /></button>
            <button class="md-btn" @click="insertMd('[链接](', ')')" title="链接" aria-label="链接"><Icon name="link" :size="15" /></button>
            <button class="md-btn" @click="insertMd('![图片](', ')')" title="图片" aria-label="图片"><Icon name="image" :size="15" /></button>
            <button class="md-btn" @click="insertMd('---\n', '')" title="分割线" aria-label="分割线"><Icon name="divider" :size="15" /></button>
            <span class="md-spacer"></span>
            <button class="md-btn" :class="{ active: showMdPreview }" @click="showMdPreview = !showMdPreview">预览</button>
          </div>
          <div class="md-body-wrap">
            <textarea id="post-content" ref="mdTextarea" v-model="content" aria-describedby="post-count post-error" placeholder="支持 Markdown..." rows="8" maxlength="2000"></textarea>
            <div v-if="showMdPreview" class="md-preview md-body" v-html="renderedPreview"></div>
          </div>
        </div>
        <textarea v-else id="post-content" v-model="content" aria-describedby="post-count post-error" placeholder="写下你想说的..." rows="6" maxlength="2000"></textarea>
        <div id="post-count" class="char-count">{{ postContent.length }}/2000<span v-if="images.length">（含图片链接）</span></div>
      </div>

      <div class="form-group">
        <label>图片 <span class="text-muted">(可选，最多9张，每张不超过5MB)</span></label>
        <div class="image-upload-area">
          <div v-for="(img, i) in images" :key="i" class="image-preview">
            <img :src="img" :alt="`待发布配图 ${i + 1}`" />
            <button class="remove-img-btn" @click="removeImage(i)" aria-label="移除该图片"><Icon name="close" :size="13" /></button>
          </div>
          <label v-if="images.length < 9" class="add-image-btn" :class="{ disabled: uploading || loading }">
            <span v-if="uploading">上传中...</span>
            <span v-else>添加图片</span>
            <input type="file" class="upload-input" aria-label="添加帖子图片" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple @change="handleImageUpload" :disabled="uploading || loading" />
          </label>
        </div>
      </div>

      <div class="form-group"><label class="checkbox-label"><input type="checkbox" v-model="isAnonymous" />匿名发布</label></div>
      <div class="form-group"><label class="checkbox-label"><input type="checkbox" v-model="isMarkdown" />使用 Markdown 格式</label></div>

      <div v-if="isAnonymous" class="anonymous-notice">匿名模式下，你的用户信息不会被保存在帖子中。但为安全起见，系统会保留必要的安全审计信息。</div>

      </fieldset>
      <div class="form-actions">
        <button class="btn btn-primary" :disabled="loading || uploading || (!content.trim() && !images.length)" @click="submit">{{ loading ? '发布中...' : '发布' }}</button>
        <button class="btn btn-secondary" @click="router.push('/')">取消</button>
      </div>
    </div>

    <ConfirmModal
      :show="showDiscardDraft"
      title="清空草稿"
      message="清空当前校园墙的发帖草稿？内容与已添加的图片将从编辑器中移除。"
      confirm-text="清空"
      danger
      @confirm="discardDraft"
      @update:show="showDiscardDraft = $event"
    />

    <!-- 发布确认弹窗 -->
    <ConfirmModal
      :show="showConfirmPost"
      title="确认发布"
      :message="confirmPostText"
      confirm-text="发布"
      cancel-text="取消"
      :danger="false"
      @confirm="doSubmit"
      @update:show="showConfirmPost = $event"
    />
  </div>
</template>

<style scoped>
.create-page { max-width: 52rem; margin-inline: auto; }
.post-fields { border: 0; padding: 0; min-width: 0; }
.draft-notice { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-3); margin-bottom: var(--space-4); background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.draft-notice p { flex: 1 1 15rem; font-size: var(--font-xs); line-height: 1.7; color: var(--text-muted); }
.draft-notice .btn { min-height: 44px; flex-shrink: 0; }
.field-label { display: block; margin-bottom: var(--space-2); font-size: var(--font-sm); font-weight: 600; }
.create-card { padding: 28px; }
.create-card h1 { font-size: 22px; margin-bottom: 4px; }
.category-selector { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.cat-btn { padding: 8px 16px; border: 1px solid var(--border-strong); border-radius: var(--radius-xl); background: var(--bg-input); color: var(--text-secondary); font-size: 14px; cursor: pointer; transition: all 0.2s; }
.cat-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
.cat-btn.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--text-link); font-weight: 600; }
.cat-custom { border-style: dashed; }
.custom-input { margin-top: 8px; }
textarea { resize: vertical; min-height: 150px; }
.char-count { text-align: right; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.anonymous-notice { background: var(--accent-soft); border: 1px solid var(--accent-line); color: var(--text-secondary); padding: 12px 16px; border-radius: var(--radius-md); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
.form-actions { display: flex; gap: 12px; }
.image-upload-area { display: flex; flex-wrap: wrap; gap: 8px; }
.image-preview { position: relative; width: 100px; height: 100px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid rgba(255,255,255,0.2); }
.image-preview img { width: 100%; height: 100%; object-fit: cover; }
.remove-img-btn { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; border: none; border-radius: 50%; background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.add-image-btn { width: 100px; height: 100px; border: 2px dashed rgba(255,255,255,0.2); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 13px; color: var(--text-muted); text-align: center; transition: all 0.2s; }
.add-image-btn:hover { border-color: rgba(255,255,255,0.4); color: var(--text-secondary); }
.add-image-btn.disabled { opacity: 0.5; cursor: not-allowed; }
.md-editor { border: 1px solid rgba(255,255,255,0.15); border-radius: var(--radius-md); overflow: hidden; }
.md-toolbar { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 8px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.1); }
.md-btn { background: none; border: none; color: var(--text-secondary); padding: 5px 9px; font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s; font-weight: 600; }
.md-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
.md-btn.active { background: var(--accent-soft); color: var(--text-link); }
.md-spacer { flex: 1; }
.md-body-wrap { display: flex; }
.md-body-wrap textarea { flex: 1; min-width: 0; width: 100%; border: none; border-radius: 0; background: var(--bg-input); color: var(--text-primary); padding: 12px; font-size: 14px; line-height: 1.6; resize: vertical; min-height: 180px; font-family: 'SF Mono','Fira Code',monospace; }
.md-body-wrap textarea::placeholder { color: var(--text-muted); }
.md-preview { flex: 1; padding: 12px; border-left: 1px solid rgba(255,255,255,0.1); overflow-y: auto; max-height: 350px; min-height: 180px; }
.create-card h1 { letter-spacing: -.035em; font-size: var(--font-2xl); }
.add-image-btn { position: relative; border-color: var(--border-strong); overflow: hidden; }
.upload-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.add-image-btn:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 3px; }
.remove-img-btn { min-width: 2rem; min-height: 2rem; }
.md-toolbar { background: var(--bg-card); border-color: var(--border); }
.md-btn { min-width: 2.75rem; min-height: 2.75rem; }
.md-btn:hover, .cat-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }
.md-preview { min-width: 0; overflow-wrap: anywhere; border-color: var(--border); }
.image-preview { border-color: var(--border); }
@media (max-width: 768px) { .create-card { padding: var(--space-4); } .md-body-wrap { flex-direction: column; } .md-preview { border-left: 0; border-top: 1px solid var(--border); } .form-actions { flex-wrap: wrap; } .form-actions .btn { flex: 1; } }
</style>
