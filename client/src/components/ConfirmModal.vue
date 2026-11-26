<script setup>
import { ref, watch, useId } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '确认' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: { type: Boolean, default: false },
  /** 输入框模式（替代 prompt） */
  prompt: { type: Boolean, default: false },
  promptValue: { type: String, default: '' },
  promptPlaceholder: { type: String, default: '' },
})

const emit = defineEmits(['confirm', 'cancel', 'update:show', 'update:promptValue'])

const inputVal = ref(props.promptValue)
const modalRef = ref(null)
const fieldId = useId()

// 之前只有 role="dialog" 而没有真正的焦点管理：Esc 关不掉、Tab 会跑到弹层背后、
// 打开时焦点停在触发按钮上。统一接到 useFocusTrap（与 Home 的话题抽屉同一套实现）。
useFocusTrap(() => props.show, modalRef, () => onCancel())

watch(() => props.show, (v) => {
  if (v) {
    inputVal.value = props.promptValue
    // 初始焦点统一由 useFocusTrap 按 data-focus-initial 选择，避免重复抢焦点。
  }
})

function onConfirm() {
  if (props.prompt) {
    emit('update:promptValue', inputVal.value)
  }
  emit('confirm')
  emit('update:show', false)
}

function onCancel() {
  emit('cancel')
  emit('update:show', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="confirm-overlay" @click.self="onCancel">
      <div ref="modalRef" tabindex="-1" class="confirm-modal glass-strong" role="dialog" aria-modal="true" :aria-label="title" :aria-describedby="message ? fieldId + '-message' : undefined">
        <h3 class="confirm-title">{{ title }}</h3>
        <p v-if="message" :id="fieldId + '-message'" class="confirm-message">{{ message }}</p>

        <slot />

        <div v-if="prompt" class="form-group">
          <label :for="fieldId" class="sr-only">{{ promptPlaceholder || title }}</label>
          <input
            :id="fieldId"
            :data-focus-initial="prompt ? '' : undefined"
            v-model="inputVal"
            :placeholder="promptPlaceholder"
            @keydown.enter="!$event.isComposing && onConfirm()"
          />
        </div>

        <div class="confirm-actions">
          <button type="button" class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="onConfirm">
            {{ confirmText }}
          </button>
          <button type="button" :data-focus-initial="!prompt ? '' : undefined" class="btn btn-secondary" @click="onCancel">{{ cancelText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: var(--z-modal);
  padding: var(--space-4);
}
.confirm-modal {
  padding: 24px;
  border-radius: var(--radius-lg);
  width: 100%;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  background: var(--surface-raised);
  max-width: 380px;
  outline: none;
}
.confirm-title {
  font-size: var(--font-lg);
  margin-bottom: 12px;
}
.confirm-message {
  font-size: var(--font-base);
  line-height: 1.6;
  color: var(--text-secondary);
  margin-bottom: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
.confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 16px;
}
.form-group { margin-bottom: 12px; }
.form-group input { width: 100%; }
</style>