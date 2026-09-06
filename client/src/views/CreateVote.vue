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
  if (!title.value.trim()) {
    error.value = '请填写标题'
    return
  }

  const validOptions = options.value.filter(o => o.trim())
  if (validOptions.length < 2) {
    error.value = '至少需要2个有效选项'
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
      end_at: endAt.value || ''
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
    <button class="btn btn-secondary btn-sm mb-2" @click="router.push('/')"><Icon name="chevron-left" :size="15" />返回</button>

    <div class="create-card glass-strong">
      <h2>创建投票</h2>
      <p class="text-muted mb-3">发起一个投票让大家参与</p>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <div class="form-group">
        <label>投票标题</label>
        <input v-model="title" placeholder="你想问什么？" maxlength="100" />
      </div>

      <div class="form-group">
        <label>描述 <span class="text-muted">(可选)</span></label>
        <textarea v-model="description" placeholder="补充说明..." rows="2" maxlength="500"></textarea>
      </div>

      <div class="form-group">
        <label>选项</label>
        <div class="options-list">
          <div v-for="(opt, index) in options" :key="index" class="option-row">
            <span class="option-number">{{ index + 1 }}</span>
            <input v-model="options[index]" :placeholder="'选项 ' + (index + 1)" maxlength="50" />
            <button v-if="options.length > 2" class="btn-icon" @click="removeOption(index)" aria-label="删除该选项"><Icon name="close" :size="14" /></button>
          </div>
        </div>
        <button v-if="options.length < 10" class="btn btn-secondary btn-sm mt-2" @click="addOption">+ 添加选项</button>
      </div>

      <div class="form-group">
        <label>截止时间 <span class="text-muted">(可选，不填则永久有效)</span></label>
        <input type="datetime-local" v-model="endAt" />
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
        <button class="btn btn-secondary" @click="router.push('/')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.create-card { padding: 28px; }
.create-card h2 { font-size: 22px; margin-bottom: 4px; }

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
  color: #d4c5b0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
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
  color: #ff6b6b;
  font-size: 12px;
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
  color: #ffb8b8;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  margin-bottom: 16px;
}
</style>
