<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import api, { readStorage, writeStorage, getApiErrorMessage } from '../api'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'

const router = useRouter()
const userStore = useUserStore()
const toast = useToast()

// 由 api 拦截器在收到 code:'BANNED' 的 403 时写入
const info = ref({ scope: 'global', reason: '', permanent: false, until: '', remainingMinutes: 0, error: '', banLevel: 'login' })
// 这个页面的数据只来自 sessionStorage（api 拦截器收到 403 BANNED 时写入）。
// 换标签页、重开浏览器、直接访问 /banned 都会拿不到 —— 必须把「没数据」和
// 「确实是永久封禁」区分开，否则任何一次封禁都会被显示成永久。
const hasInfo = ref(false)
const now = ref(Date.now())
let timer = null

const appealText = ref('')
const appealSent = ref(false)
const appealing = ref(false)

onMounted(() => {
  try {
    const raw = readStorage('banInfo', 'sessionStorage')
    if (raw) {
      const saved = JSON.parse(raw)
      if (saved && typeof saved === 'object' && ['wall', 'global'].includes(saved.scope)) {
        info.value = { ...info.value, ...saved }
        hasInfo.value = true
      }
    }
  } catch {}
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => clearInterval(timer))

const isWallScope = computed(() => info.value.scope === 'wall')

const untilText = computed(() => {
  if (!hasInfo.value) return '未知'
  if (info.value.permanent) return '永久'
  if (!info.value.until) return '未知'
  const date = new Date(String(info.value.until).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? '未知，请联系管理员确认' : date.toLocaleString('zh-CN')
})

// 倒计时；归零后提示可以重新登录（后端会在下次请求时自动解封）
const remaining = computed(() => {
  if (!hasInfo.value || info.value.permanent || !info.value.until) return null
  const diff = new Date(String(info.value.until).replace(' ', 'T')).getTime() - now.value
  if (Number.isNaN(diff) || diff <= 0) return null
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return d > 0 ? `${d} 天 ${h} 小时 ${m} 分` : (h > 0 ? `${h} 小时 ${m} 分 ${s} 秒` : `${m} 分 ${s} 秒`)
})

const expired = computed(() => hasInfo.value && !info.value.permanent && !!info.value.until && Number.isFinite(new Date(String(info.value.until).replace(' ', 'T')).getTime()) && new Date(String(info.value.until).replace(' ', 'T')).getTime() <= now.value)

const banLevelLabel = computed(() => {
  const labels = { login: '禁止登录', post: '禁止发帖', chat: '禁止聊天', all: '全部禁止' }
  return labels[info.value.banLevel] || '禁止登录'
})

async function submitAppeal() {
  if (appealing.value || appealSent.value || !userStore.isLoggedIn) return
  if (!appealText.value.trim()) { toast.error('请填写申诉理由'); return }
  appealing.value = true
  try {
    await api.post('/auth/appeal', { reason: appealText.value.trim() })
    appealSent.value = true
    toast.success('申诉已提交')
  } catch (e) {
    toast.error(getApiErrorMessage(e, '申诉提交失败，请稍后重试'))
  } finally {
    appealing.value = false
  }
}

async function backToLogin() {
  writeStorage('banInfo', null, 'sessionStorage')
  await userStore.logout()
  await router.push('/login')
}

function backToWalls() {
  writeStorage('banInfo', null, 'sessionStorage')
  router.push('/walls')
}
</script>

<template>
  <div class="banned-page">
    <section class="banned-card glass-strong" aria-labelledby="ban-title">
      <div class="banned-icon"><Icon name="ban" :size="40" /></div>

      <h1 id="ban-title" class="banned-title">
        {{ !hasInfo ? '无法获取限制详情' : isWallScope ? '该校园墙暂时无法访问' : '账号使用受到限制' }}
      </h1>

      <p class="banned-sub text-muted">
        {{ isWallScope
          ? '这只影响这一个校园墙，你可以切换到其它校园墙继续使用。'
          : '在封禁解除前，你无法使用本站功能。' }}
      </p>

      <p v-if="!hasInfo" class="no-info">
        当前会话里没有本次封禁的详细信息（换过标签页或重开过浏览器都会这样）。
        请重新登录一次，系统会重新告知封禁级别与解封时间。
      </p>

      <dl class="banned-detail">
        <div class="detail-row">
          <dt>封禁原因</dt>
          <dd>{{ info.reason || '管理员未填写原因' }}</dd>
        </div>
        <div class="detail-row">
          <dt>封禁级别</dt>
          <dd>{{ banLevelLabel }}</dd>
        </div>
        <div class="detail-row">
          <dt>解封时间</dt>
          <dd>{{ untilText }}</dd>
        </div>
        <div v-if="remaining" class="detail-row">
          <dt>剩余时长</dt>
          <dd class="countdown">{{ remaining }}</dd>
        </div>
      </dl>

      <p v-if="expired" class="ok-msg">封禁时间已到，现在可以重新登录了。</p>

      <!-- 申诉表单 -->
      <form v-if="hasInfo && !isWallScope && !appealSent && userStore.isLoggedIn" class="appeal-section" :aria-busy="appealing" @submit.prevent="submitAppeal">
        <label for="ban-appeal" class="banned-appeal text-muted">申诉理由</label>
        <p id="appeal-help" class="text-muted">请说明情况，最多1000字。每10分钟可提交一次。</p>
        <textarea id="ban-appeal" aria-describedby="appeal-help" required v-model="appealText" placeholder="请详细说明申诉理由..." rows="3" maxlength="1000" class="appeal-input"></textarea>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="!appealText.trim() || appealing">
          {{ appealing ? '提交中...' : '提交申诉' }}
        </button>
      </form>
      <p v-else-if="appealSent" class="ok-msg" role="status">申诉已提交，请等待管理员处理。</p>

      <p v-else class="banned-appeal text-muted">
        如果你认为这是误判，请通过站内举报或联系管理员申诉。
      </p>

      <div class="banned-actions">
        <button v-if="isWallScope" class="btn btn-primary" @click="backToWalls">切换校园墙</button>
        <button class="btn" :class="isWallScope ? 'btn-secondary' : 'btn-primary'" @click="backToLogin">
          返回登录页
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.no-info {
  margin-bottom: 14px; padding: 10px 12px;
  border-radius: var(--radius-sm); font-size: 13px; line-height: 1.7;
  color: var(--text-secondary);
  background: var(--bg-input); border: 1px solid var(--border);
}
.banned-page {
  min-height: 70vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  animation: riseIn 0.45s var(--ease) both;
}

.banned-card {
  width: 100%;
  max-width: 460px;
  padding: var(--space-6) var(--space-5);
  border-radius: var(--radius-lg);
  text-align: center;
}

.banned-icon { color: var(--danger-light, #ff8f8f); margin-bottom: var(--space-3); }
.banned-title { font-size: 21px; margin-bottom: var(--space-2); }
.banned-sub { font-size: 14px; line-height: 1.6; margin-bottom: var(--space-5); }

.banned-detail {
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
}
.detail-row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  font-size: 14px;
}
.detail-row + .detail-row { border-top: 1px solid var(--border); }
.detail-row dt { flex-shrink: 0; width: 72px; color: var(--text-muted); }
.detail-row dd { flex: 1; word-break: break-word; }
.countdown { font-variant-numeric: tabular-nums; color: var(--warning-light); }

.banned-appeal { font-size: 13px; line-height: 1.6; margin-bottom: var(--space-4); }

.appeal-section {
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
}
.appeal-input {
  width: 100%;
  margin: var(--space-2) 0;
  font-size: 14px;
  resize: vertical;
  min-height: 80px;
}

.banned-actions { display: flex; gap: var(--space-2); justify-content: center; flex-wrap: wrap; }
.banned-title { font-size: 1.5rem; line-height: 1.4; }
.banned-detail, .appeal-section { background: var(--bg-input); }
.banned-card { border-top: 3px solid var(--accent-1); }
.appeal-section label { display: block; font-weight: 600; color: var(--text-primary); }
#appeal-help { font-size: .8rem; line-height: 1.7; }
@media (prefers-reduced-motion: reduce) { .banned-page { animation: none; } }
</style>
