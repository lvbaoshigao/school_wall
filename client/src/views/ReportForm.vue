<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import Icon from '../components/Icon.vue'
import { useToast } from '../composables/useToast'

const router = useRouter()
const toast = useToast()
const reportTypes = ref([])
const content = ref('')
const isAnonymous = ref(false)
const agreed = ref(false)
const loading = ref(false)
const error = ref('')
const success = ref(false)
const trackingCode = ref('')
const images = ref([])
const uploading = ref(false)

const availableTypes = ['校园霸凌行为', '校内抽烟行为']

function toggleType(type) {
  const idx = reportTypes.value.indexOf(type)
  if (idx >= 0) reportTypes.value.splice(idx, 1)
  else reportTypes.value.push(type)
}

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
      const res = await api.post('/upload/image', { image: dataUrl })
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
  error.value = ''
  if (reportTypes.value.length === 0) { error.value = '请选择至少一种举报类型'; return }
  if (!content.value.trim()) { error.value = '请填写举报详情'; return }
  if (content.value.length > 5000) { error.value = '内容不能超过5000字'; return }
  if (!agreed.value) { error.value = '请勾选保证信息真实'; return }

  loading.value = true
  try {
    const res = await api.post('/reports', {
      report_types: reportTypes.value,
      content: content.value.trim(),
      images: images.value,
      is_anonymous: isAnonymous.value,
      agreed: true
    })
    trackingCode.value = res.data.tracking_code
    success.value = true
  } catch (e) {
    error.value = e.response?.data?.error || '提交失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="report-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div v-if="success" class="success-card glass-strong">
      <div class="success-icon"><Icon name="check-circle" :size="40" /></div>
      <h2>举报已提交</h2>
      <div class="tracking-code-box">
        <p class="tracking-label">你的追踪码</p>
        <div class="tracking-code">{{ trackingCode }}</div>
      </div>
      <p class="text-muted">请妥善保存此追踪码，可在首页搜索栏输入追踪码查询处理进度</p>
      <div class="action-btns">
        <button class="btn btn-primary" @click="router.push(`/report/status/${trackingCode}`)">查看状态</button>
        <button class="btn btn-secondary" @click="router.push('/')">返回首页</button>
      </div>
    </div>

    <div v-else class="report-card glass-strong">
      <h2>举报</h2>
      <p class="text-muted mb-3">维护校园安全环境</p>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <div class="warning-notice">
        本举报通道仅受理校园霸凌、校内抽烟等严重违规行为。<strong>不受理其他学生偷偷带手机等小事举报。</strong>请如实填写信息，虚假举报将承担相应责任。
      </div>

      <div class="form-group">
        <label>举报类型 <span class="required">*</span></label>
        <div class="type-checkboxes">
          <label v-for="type in availableTypes" :key="type" class="type-checkbox" :class="{ active: reportTypes.includes(type) }">
            <input type="checkbox" :checked="reportTypes.includes(type)" @change="toggleType(type)" />
            {{ type }}
          </label>
        </div>
      </div>

      <div class="form-group">
        <label>举报详情 <span class="required">*</span></label>
        <textarea
          v-model="content"
          placeholder="请详细描述你所举报的事件，包括时间、地点、涉及人员等信息..."
          rows="6"
          maxlength="5000"
        ></textarea>
        <div class="char-count">{{ content.length }}/5000</div>
      </div>

      <div class="form-group">
        <label>图片证据（可选，最多 9 张）</label>
        <div class="image-list">
          <div v-for="(url, idx) in images" :key="url" class="image-preview">
            <img :src="url" alt="" />
            <button class="remove-btn" @click="removeImage(idx)" aria-label="删除图片"><Icon name="close" :size="14" /></button>
          </div>
          <button v-if="images.length < 9" class="add-image-btn" :disabled="uploading" @click="pickImage">
            <Icon name="image" :size="20" />
            <span>{{ uploading ? '上传中…' : '添加图片' }}</span>
          </button>
        </div>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="isAnonymous" />
          匿名举报（管理员不会看到你的身份信息）
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-label agree-label">
          <input type="checkbox" v-model="agreed" />
          我保证所填写信息真实准确，愿意为此承担责任
        </label>
      </div>

      <button
        class="btn btn-primary"
        style="width: 100%"
        :disabled="loading || !agreed || reportTypes.length === 0 || !content.trim()"
        @click="submit"
      >
        {{ loading ? '提交中…' : '确认举报' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.report-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.report-card, .success-card { padding: 28px; }
.report-card h2 { font-size: 22px; margin-bottom: 4px; }

.success-card { text-align: center; padding: 48px 28px; }
.success-icon { display: flex; justify-content: center; color: var(--success-light, #7bed9f); margin-bottom: 16px; }

.tracking-code-box {
  background: rgba(46, 213, 115, 0.1);
  border: 2px solid rgba(46, 213, 115, 0.3);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin: 20px 0;
}
.tracking-label { font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
.tracking-code { font-size: 32px; font-weight: 800; letter-spacing: 3px; color: #b8ffb8; font-family: monospace; }

.action-btns { display: flex; gap: 12px; justify-content: center; margin-top: 20px; }

.warning-notice {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.25);
  color: var(--text-primary);
  padding: 14px 18px;
  border-radius: var(--radius-md);
  font-size: 14px;
  margin-bottom: 20px;
  line-height: 1.6;
}
.warning-notice strong { color: #ffb8b8; }

.type-checkboxes { display: flex; gap: 12px; flex-wrap: wrap; }
.type-checkbox {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  border: 2px solid rgba(255,255,255,0.15);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
  font-size: 14px;
  color: var(--text-secondary);
}
.type-checkbox.active {
  border-color: rgba(255,107,107,0.5);
  background: rgba(255,107,107,0.1);
  color: #ffb8b8;
}
.type-checkbox input { width: 16px; height: 16px; accent-color: #ff6b6b; }

textarea { resize: vertical; min-height: 150px; }
.char-count { text-align: right; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.required { color: #ff6b6b; }

.agree-label { font-weight: 600; color: var(--text-primary); }

.image-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
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

.error-msg {
  background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3);
  color: #ffb8b8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 16px;
}
</style>
