// 后台标签页、最小化窗口或浏览器工具栏持有焦点时，不主动争抢焦点。
export function focusIfActive(element, options = { preventScroll: true }) {
  const doc = element?.ownerDocument
  if (!element?.isConnected || doc?.visibilityState !== 'visible' || !doc.hasFocus()) return false
  element.focus(options)
  return doc.activeElement === element
}
