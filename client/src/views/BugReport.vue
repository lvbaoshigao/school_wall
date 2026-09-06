<script setup>
import { ref } from 'vue'
import api from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const toast = useToast()
const title = ref('')
const content = ref('')
const images = ref([])
const uploading = ref(false)
const submitting = ref(false)
const success = ref(false)

function pickImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/gif,image/webp'
  input.multiple = false
  input.onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { toast.error('图片不能超过2MB'); return }
    if (images.value.length >= 9) { toast.error('最多上传9张图片'); return }

    uploading.value = true
    try {
      const reader = new FileReader()
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await api.post('/upload/bug-image', { image: dataUrl })
      images.value.push(res.data.url)
    } catch (e) {
      toast.error(e.response?.data?.error || '上传失败')
    } finally {
      uploading.value = false
    }
  }
  input.click()
}

function removeImage(idx) {
  images.value.splice(idx, 1)
}

async function submit() {
  if (!title.value.trim()) { toast.error('请填写标题'); return }
  if (!content.value.trim()) { toast.error('请填写反馈内容'); return }
  submitting.value = true
  try {
    await api.post('/bug-reports', {
      title: title.value.trim(),
      content: content.value.trim(),
      images: images.value,
    })
    success.value = true
  } catch (e) {
    toast.error(e.response?.data?.error || '提交失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="success" class="success-state">
    <div class="icon"><Icon name="check-circle" :size="40" /></div>
    <h3>反馈已提交</h3>
    <p class="text-muted">感谢你的反馈，我们会尽快处理</p>
  </div>
  <div v-else class="bug-report-form">
    <div class="form-group">
      <label>标题</label>
      <input v-model="title" type="text" placeholder="简要描述问题" maxlength="100" />
    </div>
    <div class="form-group">
      <label>详细描述</label>
      <textarea v-model="content" placeholder="请详细描述你遇到的问题..." rows="4" maxlength="5000"></textarea>
      <div class="char-count">{{ content.length }}/5000</div>
    </div>
    <div class="form-group">
      <label>截图（可选，最多 9 张）</label>
      <div class="image-list">
        <div v-for="(url, idx) in images" :key="url" class="image-preview">
          <img :src="url" alt="" />
          <button class="remove-btn" @click="removeImage(idx)" aria-label="删除图片"><Icon name="close" :size="14" /></button>
        </div>
        <button v-if="images.length < 9" class="add-image-btn" :disabled="uploading" @click="pickImage">
          <Icon name="image" :size="20" />
          <span>{{ uploading ? '上传中…' : '添加截图' }}</span>
        </button>
      </div>
    </div>
    <button class="btn btn-primary" :disabled="!title.trim() || !content.trim() || submitting" @click="submit">
      {{ submitting ? '提交中…' : '提交反馈' }}
    </button>
  </div>
</template>

<style scoped>
.success-state { text-align: center; padding: 24px; }
.success-state .icon { margin-bottom: 12px; color: var(--success); }
.success-state h3 { font-size: 18px; margin-bottom: 8px; }

.bug-report-form { display: flex; flex-direction: column; gap: 14px; }
.form-group label { font-size: 14px; font-weight: 600; margin-bottom: 4px; display: block; }
.char-count { font-size: 12px; color: var(--text-muted); text-align: right; margin-top: 2px; }
textarea { resize: vertical; min-height: 100px; }

.image-list { display: flex; flex-wrap: wrap; gap: 8px; }
.image-preview { position: relative; width: 80px; height: 80px; border-radius: var(--radius-sm); overflow: hidden; }
.image-preview img { width: 100%; height: 100%; object-fit: cover; }
.remove-btn {
  position: absolute; top: 2px; right: 2px;
  background: rgba(0,0,0,0.6); border: none; color: #fff;
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.add-image-btn {
  width: 80px; height: 80px;
  border: 2px dashed var(--border); border-radius: var(--radius-sm);
  background: var(--bg-input); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; color: var(--text-muted); font-size: 11px;
}
.add-image-btn:hover { border-color: var(--accent-line); color: var(--text-primary); }
.add-image-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>