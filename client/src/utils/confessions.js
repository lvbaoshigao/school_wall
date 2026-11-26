const enabled = value => value === true || value === 1

export const confessionRootId = message => Number(message?.confession_root_id || message?.id) || 0
export const canReplyToConfession = message => enabled(message?.allow_replies) && enabled(message?.can_reply) && message?.confession_kind !== 'direct'
export const canRequestConfessionIdentity = (message, userId) => enabled(message?.is_anonymous) && !message?.revealed_sender && !message?.identity_request && Number(message?.receiver_id) === Number(userId) && Number(userId) > 0 && message?.confession_kind !== 'reply'
export const identityStatusLabel = status => ({ pending: '等待写信人处理', approved: '写信人已同意披露身份', rejected: '写信人已拒绝披露身份' })[status] || ''

export function confessionPayload({ receiverId, wallId, direct, title, content, anonymous, allowReplies, clientMessageId }) {
  const payload = { receiver_id: Number(receiverId), wall_id: Number(wallId), client_message_id: clientMessageId }
  if (direct) return { endpoint: '/messages/confessions/direct', payload }
  return {
    endpoint: '/messages',
    payload: { ...payload, type: 'confession', title: title?.trim() || '表白信', content: content?.trimEnd() || '', is_anonymous: !!anonymous, allow_replies: !!allowReplies },
  }
}

export function newConfessionMessageId() {
  return globalThis.crypto?.randomUUID?.() || 'confession-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}
