<script setup>
import { useToast } from '../composables/useToast'
import Icon from './Icon.vue'

const { toasts, remove: removeToast, pause, resume } = useToast()
function resumeIfIdle(event, id) {
  if (event.currentTarget.contains(document.activeElement) || event.currentTarget.matches(':hover')) return
  resume(id)
}

// 提示类型对应的图标；颜色之外再给一个形状差异，色觉障碍下也能区分
const icons = { success: 'check-circle', error: 'x-circle', warning: 'alert-triangle', info: 'info' }
</script>

<template>
  <Teleport to="body">
    <!-- role="status" + aria-live="polite"：此前整块容器没有任何语义，
         屏幕阅读器完全感知不到「已收藏 / 发送失败」这类操作反馈。
         用 polite 而非 assertive，避免连续操作时把正在朗读的内容反复打断。 -->
    <div class="toast-container" role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast-item"
          :class="'toast-' + t.type"
          @mouseenter="pause(t.id)"
          @mouseleave="resumeIfIdle($event, t.id)"
          @focusin="pause(t.id)"
          @focusout="resumeIfIdle($event, t.id)"
        >
          <Icon class="toast-icon" :name="icons[t.type] || 'info'" :size="17" />
          <span class="toast-message">{{ t.message }}</span>
          <button type="button" class="toast-close" aria-label="关闭通知" @click="removeToast(t.id)"><Icon name="close" :size="16" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-toast);
  width: min(28rem, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 16px;
  width: 100%;
  background: var(--surface-raised);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 14px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md);
  pointer-events: auto;
  max-width: 400px;
}

.toast-success { border-left: 4px solid var(--success); }
.toast-error { border-left: 4px solid var(--danger); }
.toast-warning { border-left: 4px solid var(--warning); }
.toast-info { border-left: 4px solid var(--text-link); }
.toast-success .toast-icon { color: var(--success); }
.toast-error .toast-icon { color: var(--danger); }
.toast-warning .toast-icon { color: var(--warning); }

.toast-icon { flex-shrink: 0; }
.toast-message { line-height: var(--leading-normal); min-width: 0; overflow-wrap: anywhere; flex: 1; }
.toast-close { width: 44px; height: 44px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--radius-sm); color: var(--text-secondary); background: transparent; cursor: pointer; }
.toast-close:hover { background: var(--bg-input); }

.toast-enter-active { transition: all 0.3s ease; }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { opacity: 0; transform: translateY(-12px) scale(0.95); }
.toast-leave-to { opacity: 0; transform: translateY(-8px) scale(0.9); }
</style>
