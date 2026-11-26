import { nextTick, onBeforeUnmount, watch } from 'vue'
import { focusIfActive } from '../utils/focus.js'

const FOCUSABLE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
  '[tabindex]', '[contenteditable="true"]',
].join(',')

// 多层弹窗只响应最上层；共享滚动锁，避免关闭图片预览时解锁下面的确认框。
const traps = []
let previousOverflow = ''

/** 打开时移入焦点，约束 Tab / 程序化焦点，Esc 关闭，关闭后还给触发元素。 */
export function useFocusTrap(isOpen, containerRef, onClose) {
  let lastActive = null
  let active = false
  let generation = 0
  const trap = { focusFirst }
  const isTop = () => traps[traps.length - 1] === trap

  function focusable() {
    const el = containerRef.value
    if (!el) return []
    return Array.from(el.querySelectorAll(FOCUSABLE)).filter(node => {
      if (node.tabIndex < 0 || node.matches(':disabled') || node.closest('[inert], [hidden], [aria-hidden="true"]')) return false
      const style = window.getComputedStyle(node)
      return node.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
  }

  function focusFirst() {
    const el = containerRef.value
    if (!el) return
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    const items = focusable()
    const target = items.find(node => node.hasAttribute('data-focus-initial')) || items[0] || el
    // 长提示框的输入项需要滚入弹窗可视区；其余初始焦点保持页面位置。
    focusIfActive(target, { preventScroll: target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' })
  }

  function onFocusIn(event) {
    // 窗口/文档的焦点边界事件不代表用户把焦点移到了弹窗外。
    if (event.target?.nodeType !== 1) return
    if (isTop() && containerRef.value && !containerRef.value.contains(event.target)) focusFirst()
  }

  function onKeydown(event) {
    if (!isTop()) return
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose?.()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusable()
    const current = document.activeElement
    const index = items.indexOf(current)
    if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
      event.preventDefault()
      if (!items.length) focusFirst()
      else focusIfActive(event.shiftKey ? items[items.length - 1] : items[0], { preventScroll: false })
    }
  }

  function teardown() {
    generation++
    if (!active) return
    const wasTop = isTop()
    active = false
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('focusin', onFocusIn, true)
    const index = traps.indexOf(trap)
    if (index >= 0) traps.splice(index, 1)
    if (!traps.length && document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow
    if (wasTop) {
      if (lastActive?.isConnected) focusIfActive(lastActive)
      else traps[traps.length - 1]?.focusFirst()
    }
    lastActive = null
  }

  watch(isOpen, async open => {
    if (!open) {
      teardown()
      return
    }
    if (active) return
    active = true
    lastActive = document.activeElement
    if (!traps.length) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    traps.push(trap)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('focusin', onFocusIn, true)
    const currentGeneration = ++generation
    await nextTick()
    if (active && currentGeneration === generation && isTop()) focusFirst()
  }, { immediate: true })

  onBeforeUnmount(teardown)
}
