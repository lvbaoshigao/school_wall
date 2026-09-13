<script setup>
import { ref, watch, nextTick } from 'vue'
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

const inputRef = ref(null)
const inputVal = ref(props.promptValue)
const modalRef = ref(null)

// 之前只有 role="dialog" 而没有真正的焦点管理：Esc 关不掉、Tab 会跑到弹层背后、
// 打开时焦点停在触发按钮上。统一接到 useFocusTrap（与 Home 的话题抽屉同一套实现）。
useFocusTrap(() => props.show, modalRef, () => onCancel())

watch(() => props.show, (v) => {
  if (v) {
    inputVal.value = props.promptValue
    // prompt 模式优先聚焦输入框；非 prompt 模式由 focus trap 聚焦第一个按钮
    if (props.prompt) nextTick(() => inputRef.value?.focus())
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
      <div class="confirm-modal glass-strong" role="dialog" aria-modal="true" :aria-label="title">
        <h3 class="confirm-title">{{ title }}</h3>
        <p v-if="message" class="confirm-message">{{ message }}</p>

        <slot />

        <div v-if="prompt" class="form-group">
          <input
            ref="inputRef"
            v-model="inputVal"
            :placeholder="promptPlaceholder"
            @keyup.enter="onConfirm"
          />
        </div>

        <div class="confirm-actions">
          <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="onConfirm">
            {{ confirmText }}
          </button>
          <button class="btn btn-secondary" @click="onCancel">{{ cancelText }}</button>
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
  z-index: 9999;
}
.confirm-modal {
  padding: 24px;
  border-radius: var(--radius-lg);
  width: 90%;
  max-width: 380px;
  outline: none;
}
.confirm-title {
  font-size: 18px;
  margin-bottom: 12px;
}
.confirm-message {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
  margin-bottom: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 16px;
}
.form-group { margin-bottom: 12px; }
.form-group input { width: 100%; }
</style>