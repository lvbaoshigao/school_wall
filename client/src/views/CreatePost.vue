<script setup>
import { ref, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useMarkdown } from '../composables/useMarkdown'
import { useToast } from '../composables/useToast'
import api from '../api'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useSettingsStore } from '../stores/settings'

const router = useRouter()
const userStore = useUserStore()
const { renderMarkdown } = useMarkdown()
const toast = useToast()

const content = ref('')
const category = ref('分享')
const customCategory = ref('')
const useCustomCategory = ref(false)
const settingsStore = useSettingsStore()
// 初始状态取自「设置 → 发布默认值」，单次仍可自由改
const isAnonymous = ref(settingsStore.prefs.default_anonymous_post)
const isMarkdown = ref(settingsStore.prefs.default_markdown)
const loading = ref(false)
const images = ref([])
const uploading = ref(false)
const showMdPreview = ref(false)
const mdTextarea = ref(null)
const renderedPreview = ref('')
const showConfirmPost = ref(false)
const confirmPostText = ref('')

const categories = ['吐槽', '分享', '求助', '讨论', '其他']

function selectCategory(cat) { useCustomCategory.value = false; category.value = cat }
function enableCustomCategory() { useCustomCategory.value = true; category.value = '' }

function insertMd(before, after) {
  const el = mdTextarea.value
  if (!el) { content.value += before + after; return }
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.substring(start, end)
  content.value = content.value.substring(0, start) + before + selected + after + content.value.substring(end)
  nextTick(() => {
    el.focus()
    el.selectionStart = start + before.length
    el.selectionEnd = start + before.length + selected.length
  })
}

function updatePreview() {
  renderedPreview.value = renderMarkdown(content.value || '*暂无内容*')
}

async function handleImageUpload(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  if (images.value.length + files.length > 9) { toast.error('最多上传9张图片'); return }
  uploading.value = true
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { toast.error(`图片 ${file.name} 超过5MB限制`); continue }
    try {
      const base64 = await compressImage(file, 1200, 0.8)
      const res = await api.post('/upload/image', { image: base64 })
      images.value.push(res.data.url)
    } catch (err) { toast.error(`图片 ${file.name} 上传失败`) }
  }
  uploading.value = false
  e.target.value = ''
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let w = img.width, h = img.height
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = h * maxDim / w; w = maxDim }
          else { w = w * maxDim / h; h = maxDim }
        }
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = ev.target.result
    }
    reader.readAsDataURL(file)
  })
}

function removeImage(index) { images.value.splice(index, 1) }

async function submit() {
  if (!content.value.trim() && images.value.length === 0) { toast.error('内容不能为空'); return }
  if (content.value.length > 2000) { toast.error('内容不能超过2000字'); return }
  const finalCategory = useCustomCategory.value ? customCategory.value.trim() : category.value
  if (!finalCategory) { toast.error('请选择或输入分类'); return }
  // 「设置 → 发布默认值 → 发布前二次确认」
  if (settingsStore.prefs.confirm_before_post) {
    confirmPostText.value = `确定发布这条${isAnonymous.value ? '匿名' : ''}帖子到「${finalCategory}」吗？`
    showConfirmPost.value = true
    return
  }

  await doSubmit()
}

async function doSubmit() {
  if (!content.value.trim() && images.value.length === 0) { toast.error('内容不能为空'); return }
  const finalCategory = useCustomCategory.value ? customCategory.value.trim() : category.value
  if (!finalCategory) { toast.error('请选择或输入分类'); return }
  loading.value = true
  try {
    let postContent = content.value.trim()
    if (images.value.length > 0) postContent += '\n' + images.value.map(url => `[img]${url}[/img]`).join('\n')
    await api.post('/posts', { content: postContent, category: finalCategory, is_anonymous: isAnonymous.value, is_markdown: isMarkdown.value })
    toast.success('发布成功！')
    router.push('/')
  } catch (e) {
    toast.error(e.response?.data?.error || '发布失败')
  } finally { loading.value = false }
}
</script>

<template>
  <div class="create-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="create-card glass-strong">
      <h2>发布帖子</h2>
      <p class="text-muted mb-3">分享你的想法</p>

      <div class="form-group">
        <label>分类</label>
        <div class="category-selector">
          <button v-for="cat in categories" :key="cat" class="cat-btn" :class="{ active: !useCustomCategory && category === cat }" @click="selectCategory(cat)">{{ cat }}</button>
          <button class="cat-btn cat-custom" :class="{ active: useCustomCategory }" @click="enableCustomCategory">自定义</button>
        </div>
        <input v-if="useCustomCategory" v-model="customCategory" placeholder="输入自定义分类..." class="custom-input" maxlength="20" />
      </div>

      <div class="form-group">
        <label>内容</label>
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
            <button class="md-btn" :class="{ active: showMdPreview }" @click="showMdPreview = !showMdPreview; if(showMdPreview) updatePreview()">预览</button>
          </div>
          <div class="md-body-wrap">
            <textarea ref="mdTextarea" v-model="content" placeholder="支持 Markdown..." rows="8" maxlength="2000" @input="showMdPreview && updatePreview()"></textarea>
            <div v-if="showMdPreview" class="md-preview md-body" v-html="renderedPreview"></div>
          </div>
        </div>
        <textarea v-else v-model="content" placeholder="写下你想说的..." rows="6" maxlength="2000"></textarea>
        <div class="char-count">{{ content.length }}/2000</div>
      </div>

      <div class="form-group">
        <label>图片 <span class="text-muted">(可选，最多9张，每张不超过5MB)</span></label>
        <div class="image-upload-area">
          <div v-for="(img, i) in images" :key="i" class="image-preview">
            <img :src="img" alt="" />
            <button class="remove-img-btn" @click="removeImage(i)" aria-label="移除该图片"><Icon name="close" :size="13" /></button>
          </div>
          <label v-if="images.length < 9" class="add-image-btn" :class="{ disabled: uploading }">
            <span v-if="uploading">上传中...</span>
            <span v-else>添加图片</span>
            <input type="file" accept="image/*" multiple @change="handleImageUpload" hidden :disabled="uploading" />
          </label>
        </div>
      </div>

      <div class="form-group"><label class="checkbox-label"><input type="checkbox" v-model="isAnonymous" />匿名发布</label></div>
      <div class="form-group"><label class="checkbox-label"><input type="checkbox" v-model="isMarkdown" />使用 Markdown 格式</label></div>

      <div v-if="isAnonymous" class="anonymous-notice">匿名模式下，你的用户信息不会被保存在帖子中。但为安全起见，系统会保留你的IP地址。</div>

      <div class="form-actions">
        <button class="btn btn-primary" :disabled="loading || !content.trim()" @click="submit">{{ loading ? '发布中...' : '发布' }}</button>
        <button class="btn btn-secondary" @click="router.push('/')">取消</button>
      </div>
    </div>

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
.create-page { animation: fadeIn 0.5s ease; }
.create-card { padding: 28px; }
.create-card h2 { font-size: 22px; margin-bottom: 4px; }
.category-selector { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.cat-btn { padding: 8px 16px; border: 1px solid rgba(255,255,255,0.15); border-radius: var(--radius-xl); background: rgba(255,255,255,0.05); color: var(--text-secondary); font-size: 14px; cursor: pointer; transition: all 0.2s; }
.cat-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
.cat-btn.active { background: rgba(169,155,134,0.25); border-color: rgba(201,185,154,0.4); color: #d4c5b0; font-weight: 600; }
.cat-custom { border-style: dashed; }
.custom-input { margin-top: 8px; }
textarea { resize: vertical; min-height: 150px; }
.char-count { text-align: right; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.anonymous-notice { background: rgba(255,200,0,0.15); border: 1px solid rgba(255,200,0,0.3); color: #ffeaa7; padding: 12px 16px; border-radius: var(--radius-md); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
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
.md-btn.active { background: color-mix(in srgb, var(--accent-1) 30%, transparent); color: #a8b8ff; }
.md-spacer { flex: 1; }
.md-body-wrap { display: flex; }
.md-body-wrap textarea { flex: 1; border: none; border-radius: 0; background: rgba(255,255,255,0.05); color: #fff; padding: 12px; font-size: 14px; line-height: 1.6; resize: vertical; min-height: 180px; font-family: 'SF Mono','Fira Code',monospace; }
.md-body-wrap textarea::placeholder { color: var(--text-muted); }
.md-preview { flex: 1; padding: 12px; border-left: 1px solid rgba(255,255,255,0.1); overflow-y: auto; max-height: 350px; min-height: 180px; }
</style>
