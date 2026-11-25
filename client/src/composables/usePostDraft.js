import { computed, ref, watch, onScopeDispose } from 'vue'
import { postDraftKey, hasPostDraft, postDrafts } from '../utils/postDrafts.js'

export function usePostDraft({ userStore, wallStore, fields, defaults, storage = postDrafts }) {
  const draftStatus = ref('empty')
  let activeScope = null
  let restoring = false
  let submitted = false
  const snapshot = () => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Array.isArray(field.value) ? [...field.value] : field.value]))
  const hasDraft = computed(() => hasPostDraft(snapshot()))

  function readScope() {
    const scope = { userId: userStore.user?.id, wallId: wallStore.currentWallId, revision: userStore.sessionRevision }
    return userStore.isLoggedIn && postDraftKey(scope) ? scope : null
  }
  function isCurrentScope(scope) {
    const current = readScope()
    return !!scope && !!current && scope.revision === current.revision && postDraftKey(scope) === postDraftKey(current)
  }
  function maySave(scope) {
    // A wall switch may save the previous wall; a session change must never recreate a cleared draft.
    return scope && userStore.isLoggedIn && scope.userId === userStore.user?.id && scope.revision === userStore.sessionRevision
  }
  function save() {
    if (restoring || submitted || !maySave(activeScope)) return
    const draft = snapshot()
    draftStatus.value = !storage.save(activeScope, draft) ? 'unavailable' : hasPostDraft(draft) ? 'saved' : 'empty'
  }
  function apply(value) {
    restoring = true
    try { for (const [key, field] of Object.entries(fields)) field.value = Array.isArray(value[key]) ? [...value[key]] : value[key] }
    finally { restoring = false }
  }

  watch(() => {
    const scope = readScope()
    return scope ? scope.revision + ':' + postDraftKey(scope) : ''
  }, () => {
    save()
    activeScope = readScope()
    submitted = false
    const restored = activeScope ? storage.load(activeScope) : { ok: true, draft: null }
    apply(restored.draft || defaults())
    draftStatus.value = !restored.ok ? 'unavailable' : restored.draft ? 'restored' : 'empty'
  }, { immediate: true, flush: 'sync' })

  watch(Object.values(fields), () => {
    if (restoring) return
    submitted = false
    save()
  }, { deep: true, flush: 'sync' })
  onScopeDispose(save)

  function captureDraft() {
    return activeScope && isCurrentScope(activeScope) ? { scope: { ...activeScope }, draft: snapshot() } : null
  }
  function completeDraft(captured) {
    if (!captured || !maySave(captured.scope)) return
    const ok = storage.remove(captured.scope, captured.draft)
    if (isCurrentScope(captured.scope) && JSON.stringify(snapshot()) === JSON.stringify(captured.draft)) {
      submitted = true
      draftStatus.value = ok ? 'empty' : 'unavailable'
    }
  }
  function discardDraft() {
    const ok = storage.remove(activeScope)
    apply(defaults())
    submitted = false
    draftStatus.value = ok ? 'empty' : 'unavailable'
  }

  return { draftStatus, hasDraft, captureDraft, completeDraft, discardDraft, isCurrentScope }
}
