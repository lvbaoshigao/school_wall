const PREFIX = 'school-wall:post-draft:v1:'
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

function positiveId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]*$/.test(String(value))) return ''
  return Number.isSafeInteger(Number(value)) ? String(Number(value)) : ''
}

export function postDraftKey(scope) {
  const user = positiveId(scope?.userId)
  const wall = positiveId(scope?.wallId)
  return user && wall ? PREFIX + user + ':' + wall : ''
}

export function normalizePostDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.content !== 'string' || value.content.length > 2000 ||
      typeof value.category !== 'string' || value.category.length > 20 ||
      typeof value.customCategory !== 'string' || value.customCategory.length > 20 ||
      !['useCustomCategory', 'isAnonymous', 'isMarkdown'].every(key => typeof value[key] === 'boolean') ||
      !Array.isArray(value.images) || value.images.length > 9) return null
  // Only completed local uploads belong in a draft; never persist File/base64 data.
  const images = value.images.filter(url => typeof url === 'string' && url.length <= 2048 &&
    /^\/uploads\/[a-zA-Z0-9_./%-]+$/.test(url) && !url.includes('..') && !/%(?:2e|2f|5c)/i.test(url))
  return { content: value.content, category: value.category, customCategory: value.customCategory,
    useCustomCategory: value.useCustomCategory, isAnonymous: value.isAnonymous, isMarkdown: value.isMarkdown, images }
}

export function hasPostDraft(draft) {
  return !!draft && !!(draft.content.trim() || draft.customCategory.trim() || draft.images.length)
}

// Storage is lazy and injectable so private/blocked storage never interrupts editing.
export function createPostDraftStorage({ storage = () => globalThis.sessionStorage, now = Date.now } = {}) {
  function access() {
    const target = typeof storage === 'function' ? storage() : storage
    if (!target) throw new Error('Draft storage unavailable')
    return target
  }

  function load(scope) {
    const key = postDraftKey(scope)
    if (!key) return { ok: true, draft: null }
    try {
      const target = access()
      const text = target.getItem(key)
      if (!text) return { ok: true, draft: null }
      let record
      try { record = text.length <= 32768 ? JSON.parse(text) : null } catch {}
      const draft = normalizePostDraft(record?.draft)
      if (record?.version !== 1 || !Number.isFinite(record.savedAt) || now() - record.savedAt > MAX_AGE ||
          record.savedAt > now() || !hasPostDraft(draft)) {
        target.removeItem(key)
        return { ok: true, draft: null }
      }
      return { ok: true, draft, savedAt: record.savedAt }
    } catch { return { ok: false, draft: null } }
  }

  function save(scope, value) {
    const key = postDraftKey(scope)
    const draft = normalizePostDraft(value)
    if (!key || !draft) return false
    try {
      const target = access()
      if (!hasPostDraft(draft)) target.removeItem(key)
      else target.setItem(key, JSON.stringify({ version: 1, savedAt: now(), draft }))
      return true
    } catch { return false }
  }

  function remove(scope, expectedDraft) {
    const key = postDraftKey(scope)
    if (!key) return true
    try {
      // A completed old request must not erase a newer edit in the same scope.
      if (expectedDraft) {
        const current = load(scope)
        if (!current.ok) return false
        if (current.draft && JSON.stringify(current.draft) !== JSON.stringify(normalizePostDraft(expectedDraft))) return true
      }
      access().removeItem(key)
      return true
    } catch { return false }
  }

  function clearPrefix(prefix) {
    try {
      const target = access()
      const keys = Array.from({ length: target.length }, (_, index) => target.key(index)).filter(key => key?.startsWith(prefix))
      for (const key of keys) target.removeItem(key)
      return true
    } catch { return false }
  }
  function clearUser(userId) {
    const id = positiveId(userId)
    return id ? clearPrefix(PREFIX + id + ':') : true
  }

  return { load, save, remove, clearUser, clearAll: () => clearPrefix(PREFIX) }
}

export const postDrafts = createPostDraftStorage()
