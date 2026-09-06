<script setup>
import { toasts } from '../composables/useToast'
import Icon from './Icon.vue'

function removeToast(id) {
  const idx = toasts.value.findIndex(t => t.id === id)
  if (idx >= 0) toasts.value.splice(idx, 1)
}

// 提示类型对应的图标；颜色之外再给一个形状差异，色觉障碍下也能区分
const icons = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' }
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast-item"
          :class="'toast-' + t.type"
          @click="removeToast(t.id)"
        >
          <Icon class="toast-icon" :name="icons[t.type] || 'info'" :size="17" />
          <span class="toast-message">{{ t.message }}</span>
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
  z-index: 10000;
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
  padding: 12px 20px;
  border-radius: var(--radius-md);
  font-size: 14px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  pointer-events: auto;
  max-width: 400px;
}

.toast-success { background: rgba(46, 213, 115, 0.92); border: 1px solid rgba(46, 213, 115, 0.5); color: #fff; }
.toast-error { background: rgba(255, 107, 107, 0.92); border: 1px solid rgba(255, 107, 107, 0.5); color: #fff; }
.toast-warning { background: rgba(255, 184, 76, 0.92); border: 1px solid rgba(255, 184, 76, 0.5); color: #1a1a2e; }
.toast-info { background: color-mix(in srgb, var(--accent-1) 92%, transparent); border: 1px solid color-mix(in srgb, var(--accent-1) 50%, transparent); color: #fff; }

.toast-icon { flex-shrink: 0; }
.toast-message { line-height: 1.4; }

.toast-enter-active { transition: all 0.3s ease; }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { opacity: 0; transform: translateY(-12px) scale(0.95); }
.toast-leave-to { opacity: 0; transform: translateY(-8px) scale(0.9); }
</style>
