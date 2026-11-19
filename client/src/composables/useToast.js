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
const timers = new Map()

function resumeToast(id) {
  const timer = timers.get(id)
  if (!timer || timer.handle) return
  timer.started = Date.now()
  timer.handle = setTimeout(() => removeToast(id), timer.remaining)
}

function pauseToast(id) {
  const timer = timers.get(id)
  if (!timer?.handle) return
  clearTimeout(timer.handle)
  timer.handle = null
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.started))
}

function addToast(message, type = 'info', duration = type === 'error' ? 8000 : 5000) {
  const id = ++nextId
  toasts.value.push({ id, message: String(message ?? ''), type })
  if (Number.isFinite(duration) && duration > 0) {
    timers.set(id, { remaining: duration, started: 0, handle: null })
    resumeToast(id)
  }
  return id
}

function removeToast(id) {
  clearTimeout(timers.get(id)?.handle)
  timers.delete(id)
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
    pause: pauseToast,
    resume: resumeToast,
  }
}
