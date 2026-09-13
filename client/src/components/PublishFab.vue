<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useFocusTrap } from '../composables/useFocusTrap'
import Icon from './Icon.vue'

// 全局发布浮动按钮：
// 原信息架构里「发帖 / 表白 / 发起投票」全部埋在顶栏「发布」下拉里，
// 移动端汉堡菜单里更是要两跳才能到。FAB 把三类创作入口收敛到一步直达。
const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const open = ref(false)
const panelRef = ref(null)

useFocusTrap(open, panelRef, () => { open.value = false })

// 这些页面本身就是创作页或不需要 FAB（登录/注册/聊天室输入区会被挡住）
const hiddenRoutes = new Set([
  'Login', 'Register', 'WallSelect', 'ChatRoom', 'TreeHoleChat',
  'CreatePost', 'CreateVote', 'WriteConfession', 'Banned', 'Admin',
])
const visible = computed(() => userStore.isLoggedIn && !hiddenRoutes.has(route.name))

// 路由切换时收起，避免面板悬在新页面上
watch(() => route.fullPath, () => { open.value = false })

const actions = [
  { label: '发帖', icon: 'edit', path: '/post/create', desc: '分享 / 吐槽 / 求助' },
  { label: '表白', icon: 'heart', path: '/confession/write', desc: '对 TA 说句心里话' },
  { label: '发起投票', icon: 'chart', path: '/vote/create', desc: '征集大家的意见' },
]

function go(path) {
  open.value = false
  router.push(path)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="fab-root">
      <Transition name="fab-fade">
        <div v-if="open" class="fab-overlay" @click="open = false"></div>
      </Transition>

      <Transition name="fab-pop">
        <div
          v-if="open"
          ref="panelRef"
          class="fab-panel glass-strong"
          role="menu"
          aria-label="发布新内容"
          tabindex="-1"
        >
          <button
            v-for="a in actions"
            :key="a.path"
            class="fab-item"
            role="menuitem"
            @click="go(a.path)"
          >
            <span class="fab-item-icon"><Icon :name="a.icon" :size="17" /></span>
            <span class="fab-item-text">
              <span class="fab-item-label">{{ a.label }}</span>
              <span class="fab-item-desc">{{ a.desc }}</span>
            </span>
          </button>
        </div>
      </Transition>

      <button
        class="fab-btn"
        :class="{ active: open }"
        :aria-expanded="open"
        aria-haspopup="menu"
        aria-label="发布新内容"
        title="发布新内容"
        @click="open = !open"
      >
        <Icon name="plus" :size="24" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.fab-root {
  position: fixed;
  right: 20px;
  bottom: 24px;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-3);
}

.fab-btn {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  border: 1px solid var(--btn-ring);
  background: var(--btn-fill);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--btn-shadow-hover);
  transition: transform 0.25s var(--ease), box-shadow 0.25s var(--ease), background 0.25s var(--ease);
}
.fab-btn:hover {
  transform: translateY(-2px) scale(1.05);
  background: var(--btn-fill-hover);
}
.fab-btn:active { transform: scale(0.96); }
.fab-btn.active :deep(.icon) {
  transform: rotate(45deg);
}
.fab-btn :deep(.icon) {
  transition: transform 0.25s var(--ease);
}
.fab-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
}

.fab-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: -1;
}

.fab-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: var(--radius-lg);
  min-width: 200px;
  outline: none;
}

.fab-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.2s var(--ease);
}
.fab-item:hover { background: var(--bg-card-hover); }
.fab-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.fab-item-icon {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
}

.fab-item-text { display: flex; flex-direction: column; gap: 1px; }
.fab-item-label { font-size: var(--font-base); font-weight: 600; }
.fab-item-desc { font-size: var(--font-xs); color: var(--text-muted); }

/* 动画 */
.fab-fade-enter-active, .fab-fade-leave-active { transition: opacity 0.2s var(--ease); }
.fab-fade-enter-from, .fab-fade-leave-to { opacity: 0; }

.fab-pop-enter-active { transition: opacity 0.22s var(--ease), transform 0.22s var(--ease); }
.fab-pop-leave-active { transition: opacity 0.15s var(--ease), transform 0.15s var(--ease); }
.fab-pop-enter-from, .fab-pop-leave-to { opacity: 0; transform: translateY(10px) scale(0.96); }

/* 与 BackToTop 错开：BackToTop 在右下 24px 附近时 FAB 上移 */
@media (max-width: 600px) {
  .fab-root { right: 16px; bottom: 20px; }
  .fab-btn { width: 50px; height: 50px; }
}
</style>
