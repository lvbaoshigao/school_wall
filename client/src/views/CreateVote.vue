<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import api from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()
const userStore = useUserStore()

const title = ref('')
const description = ref('')
const options = ref(['', ''])
const isAnonymous = ref(false)
const endAt = ref('')
const loading = ref(false)
const error = ref('')

function addOption() {
  if (options.value.length >= 10) {
    error.value = '选项最多10个'
    return
  }
  options.value.push('')
}

function removeOption(index) {
  if (options.value.length <= 2) {
    error.value = '至少需要2个选项'
    return
  }
  options.value.splice(index, 1)
}

async function submit() {
  if (loading.value) return
  if (!title.value.trim()) {
    error.value = '请填写标题'
    return
  }

  const validOptions = options.value.map(o => o.trim()).filter(Boolean)
  if (validOptions.length < 2) {
    error.value = '至少需要2个有效选项'
    return
  }

  if (new Set(validOptions).size !== validOptions.length) { error.value = '选项内容不能重复'; return }
  if (endAt.value && (!Number.isFinite(new Date(endAt.value).getTime()) || new Date(endAt.value).getTime() <= Date.now())) {
    error.value = '截止时间需要晚于当前时间'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await api.post('/votes', {
      title: title.value.trim(),
      description: description.value.trim(),
      options: validOptions,
      is_anonymous: isAnonymous.value,
      end_at: endAt.value ? new Date(endAt.value).toISOString() : ''
    })
    router.push('/votes')
  } catch (e) {
    error.value = e.response?.data?.error || '创建失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="create-page">
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/votes')"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="create-card glass-strong">
      <h2>创建投票</h2>
      <p class="text-muted mb-3">发起一个投票让大家参与</p>

      <div v-if="error" class="error-msg" role="alert">{{ error }}</div>

      <div class="form-group">
        <label for="vote-title">投票标题</label>
        <input id="vote-title" v-model="title" placeholder="你想问什么？" maxlength="100" />
      </div>

      <div class="form-group">
        <label for="vote-description">描述 <span class="text-muted">(可选)</span></label>
        <textarea id="vote-description" v-model="description" placeholder="补充说明..." rows="2" maxlength="500"></textarea>
      </div>

      <div class="form-group">
        <label>选项</label>
        <div class="options-list">
          <div v-for="(opt, index) in options" :key="index" class="option-row">
            <span class="option-number">{{ index + 1 }}</span>
            <input :aria-label="'选项 ' + (index + 1)" v-model="options[index]" :placeholder="'选项 ' + (index + 1)" maxlength="50" />
            <button v-if="options.length > 2" class="btn-icon" @click="removeOption(index)" aria-label="删除该选项"><Icon name="close" :size="14" /></button>
          </div>
        </div>
        <button v-if="options.length < 10" class="btn btn-secondary btn-sm mt-2" @click="addOption">+ 添加选项</button>
      </div>

      <div class="form-group">
        <label for="vote-deadline">截止时间 <span class="text-muted">(可选，不填则永久有效)</span></label>
        <input id="vote-deadline" type="datetime-local" v-model="endAt" />
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="isAnonymous" />
          匿名投票（不显示创建者信息）
        </label>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" :disabled="loading || !title.trim()" @click="submit">
          {{ loading ? '创建中...' : '创建投票' }}
        </button>
        <button class="btn btn-secondary" @click="router.push('/votes')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.create-card { padding: 28px; }
.create-card h2 { font-size: 1.375rem; margin-bottom: 4px; }

.options-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.option-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.option-number {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(169, 155, 134, 0.2);
  color: var(--text-link);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  flex-shrink: 0;
}

.option-row input {
  flex: 1;
}

.btn-icon {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 107, 107, 0.2);
  color: var(--danger);
  font-size: 0.75rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-icon:hover {
  background: rgba(255, 107, 107, 0.3);
}

textarea { resize: vertical; }

.form-actions { display: flex; gap: 12px; }

.error-msg {
  background: rgba(255,107,107,0.2);
  border: 1px solid rgba(255,107,107,0.3);
  color: var(--danger-light);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  margin-bottom: 16px;
}

/* 与校园墙主题保持一致，并为状态反馈留出可读空间。 */
.state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px; margin: 12px 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--text-primary); line-height: 1.6; }
.option-row input { min-width: 0; }
.btn-icon { min-width: 44px; min-height: 44px; }
.form-actions { flex-wrap: wrap; }
@media (max-width: 480px) { .create-card { padding: 20px 16px; } }
</style>
