import { nextTick, onBeforeUnmount, watch } from 'vue'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 弹层焦点管理：打开时把焦点移入容器并锁在里面，Esc 关闭，关闭后焦点还给触发元素。
 *
 * @param {import('vue').Ref<boolean>} isOpen  控制显隐的响应式布尔值
 * @param {import('vue').Ref<HTMLElement|null>} containerRef  弹层根元素的模板 ref
 * @param {() => void} onClose  请求关闭时调用（Esc）
 */
export function useFocusTrap(isOpen, containerRef, onClose) {
  let lastActive = null

  function focusable() {
    const el = containerRef.value
    if (!el) return []
    return Array.from(el.querySelectorAll(FOCUSABLE)).filter(n => n.offsetParent !== null)
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose?.()
      return
    }
    if (e.key !== 'Tab') return

    const items = focusable()
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    // 在首尾之间循环，避免焦点跑到弹层背后的页面上
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function teardown() {
    document.removeEventListener('keydown', onKeydown, true)
  }

  watch(isOpen, async (open) => {
    if (open) {
      lastActive = document.activeElement
      document.addEventListener('keydown', onKeydown, true)
      await nextTick()
      const items = focusable()
      ;(items[0] || containerRef.value)?.focus?.()
    } else {
      teardown()
      // 关闭后把焦点还给打开它的按钮，否则焦点会掉到 <body>
      lastActive?.focus?.()
      lastActive = null
    }
  })

  onBeforeUnmount(teardown)
}
