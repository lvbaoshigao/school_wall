// 仅保存消息内容与展示状态；匿名视图不接收或推断对方身份。
export function anonymousMessages(value) {
  if (!Array.isArray(value)) return []
  return value.filter(row => Number.isSafeInteger(Number(row?.id)) && Number(row.id) > 0).map(row => ({
    id: Number(row.id), content: typeof row.content === 'string' ? row.content : '',
    is_mine: row.is_mine === true || row.is_mine === 1,
    is_read: row.is_read === true || row.is_read === 1,
    is_revoked: row.is_revoked === true || row.is_revoked === 1,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  }))
}

export function mergeMessages(previous, incoming) {
  return [...new Map([...previous, ...incoming].map(message => [message.id, message])).values()].sort((a, b) => a.id - b.id)
}

export function pollMilliseconds(value) {
  return (['10', '20', '30', '60'].includes(String(value)) ? Number(value) : 20) * 1000
}

export function shouldSendMessage(event, shortcut = 'enter', mobile = false) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.repeat || event.shiftKey || event.altKey) return false
  const modifier = event.ctrlKey || event.metaKey
  return mobile || shortcut === 'modifier' ? !!modifier : true
}

export function isNearBottom(area, threshold = 96) {
  return !area || area.scrollHeight - area.scrollTop - area.clientHeight <= threshold
}

export function createSocialScope(readContext) {
  let version = 0
  let disposed = false
  const controllers = new Set()
  const signature = () => JSON.stringify(readContext())
  function reset() { version++; for (const controller of controllers) controller.abort(); controllers.clear() }
  return {
    reset,
    dispose() { disposed = true; reset() },
    request() {
      const context = readContext()
      const key = JSON.stringify(context)
      const ownVersion = version
      const controller = new AbortController()
      controllers.add(controller)
      const headers = {}
      if (context.token) headers.Authorization = 'Bearer ' + context.token
      if (context.wallId) headers['X-Wall-Id'] = context.wallId
      return {
        config: { signal: controller.signal, headers },
        current: () => !disposed && !controller.signal.aborted && version === ownVersion && key === signature(),
        cancel: () => controller.abort(),
        release: () => controllers.delete(controller),
      }
    },
  }
}
