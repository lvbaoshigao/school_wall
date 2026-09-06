import { ref } from 'vue'

/**
 * 全局 Toast 通知系统
 * 替代项目中所有 alert() 调用
 *
 * 使用方式：
 *   import { useToast } from '@/composables/useToast'
 *   const toast = useToast()
 *   toast.success('操作成功')
 */

// 模块级共享状态
export const toasts = ref([])
let nextId = 0

function addToast(message, type = 'info', duration = 3000) {
  const id = ++nextId
  toasts.value.push({ id, message, type })
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration)
  }
  return id
}

function removeToast(id) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}

export function useToast() {
  return {
    toasts,
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur),
    warning: (msg, dur) => addToast(msg, 'warning', dur),
    info: (msg, dur) => addToast(msg, 'info', dur),
    remove: removeToast,
  }
}
