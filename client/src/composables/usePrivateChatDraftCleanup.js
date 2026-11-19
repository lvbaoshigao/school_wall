import { getSessionToken, subscribeSessionChange } from '../api'

const PREFIX = 'school_wall:private-draft:v1:'

// The module stays loaded across route changes so logout on another page also clears drafts.
// A single session subscription avoids retaining a component or its messages after unmount.
export function clearPrivateChatDrafts(storage) {
  try {
    const target = storage || globalThis.sessionStorage
    for (let index = (target?.length || 0) - 1; index >= 0; index--) {
      const key = target.key(index)
      if (key?.startsWith(PREFIX)) target.removeItem(key)
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
}

const unsubscribe = subscribeSessionChange(({ token, previousToken, resetContext }) => {
  if (resetContext && token !== previousToken) clearPrivateChatDrafts()
})
if (!getSessionToken()) clearPrivateChatDrafts()
if (import.meta.hot) import.meta.hot.dispose(unsubscribe)
