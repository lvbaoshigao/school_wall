import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, reactive, ref } from 'vue'
import { createPostDraftStorage, normalizePostDraft, postDraftKey } from '../src/utils/postDrafts.js'
import { usePostDraft } from '../src/composables/usePostDraft.js'

function memoryStorage() {
  const data = new Map()
  return {
    get length() { return data.size }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  }
}
const defaults = () => ({ content: '', category: '分享', customCategory: '', useCustomCategory: false, isAnonymous: false, isMarkdown: false, images: [] })
const draft = (content, extra = {}) => ({ ...defaults(), content, ...extra })
const scopeA = { userId: 1, wallId: 10 }
const scopeB = { userId: 1, wallId: 20 }

function composer(storage, identity = reactive({ user: { id: 1 }, isLoggedIn: true, sessionRevision: 0 }), wall = reactive({ currentWallId: 10 })) {
  const scope = effectScope()
  const fields = Object.fromEntries(Object.entries(defaults()).map(([key, value]) => [key, ref(value)]))
  const state = scope.run(() => usePostDraft({ userStore: identity, wallStore: wall, fields, defaults, storage }))
  return { scope, fields, state, identity, wall }
}

test('draft storage restores text, formatting, anonymity and local attachments by account and wall', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage(), now: () => 100 })
  storage.save(scopeA, draft('Wall A', { isAnonymous: true, isMarkdown: true, images: ['/uploads/post/image.jpg'] }))
  storage.save(scopeB, draft('Wall B'))
  storage.save({ userId: 2, wallId: 10 }, draft('Other account'))
  assert.deepEqual(storage.load(scopeA).draft, draft('Wall A', { isAnonymous: true, isMarkdown: true, images: ['/uploads/post/image.jpg'] }))
  assert.equal(storage.load(scopeB).draft.content, 'Wall B')
  assert.equal(storage.load({ userId: 2, wallId: 10 }).draft.content, 'Other account')
  assert.equal(storage.load({ userId: 3, wallId: 10 }).draft, null)
})

test('blank content removes the draft and invalid scope never writes a guest or shared draft', () => {
  const mock = memoryStorage()
  const storage = createPostDraftStorage({ storage: mock })
  storage.save(scopeA, draft('text'))
  storage.save(scopeA, defaults())
  assert.equal(storage.load(scopeA).draft, null)
  for (const userId of [null, '', 0, -1, '1:2', {}, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(postDraftKey({ userId, wallId: 10 }), '')
    assert.equal(storage.save({ userId, wallId: 10 }, draft('text')), false)
  }
  assert.equal(mock.length, 0)
})

test('corrupt, oversized and expired storage is discarded safely', () => {
  const mock = memoryStorage()
  let now = 100
  const storage = createPostDraftStorage({ storage: mock, now: () => now })
  for (const raw of ['{broken', 'x'.repeat(32769), JSON.stringify({ version: 1, savedAt: 50, draft: { content: 12 } })]) {
    mock.setItem(postDraftKey(scopeA), raw)
    assert.equal(storage.load(scopeA).draft, null)
    assert.equal(mock.getItem(postDraftKey(scopeA)), null)
  }
  storage.save(scopeA, draft('expired'))
  now += 8 * 24 * 60 * 60 * 1000
  assert.equal(storage.load(scopeA).draft, null)
})

test('draft normalization strips untrusted attachments and only persists supported editor fields', () => {
  const value = normalizePostDraft(draft('text', { token: 'never-save', images: [
    '/uploads/post/image.jpg', 'data:image/png;base64,private', 'https://external.invalid/image.png',
    '/uploads/../private', '/uploads/%2e%2e/private', '/api/auth/export',
  ] }))
  assert.deepEqual(value.images, ['/uploads/post/image.jpg'])
  assert.equal(Object.hasOwn(value, 'token'), false)
  assert.equal(normalizePostDraft(draft('x'.repeat(2001))), null)
})

test('clearing an account removes all its wall drafts and leaves other accounts and storage alone', () => {
  const mock = memoryStorage()
  const storage = createPostDraftStorage({ storage: mock })
  storage.save(scopeA, draft('a'))
  storage.save(scopeB, draft('b'))
  storage.save({ userId: 11, wallId: 10 }, draft('other'))
  mock.setItem('unrelated', 'keep')
  assert.equal(storage.clearUser(1), true)
  assert.equal(storage.load(scopeA).draft, null)
  assert.equal(storage.load(scopeB).draft, null)
  assert.equal(storage.load({ userId: 11, wallId: 10 }).draft.content, 'other')
  assert.equal(mock.getItem('unrelated'), 'keep')
})

test('clearing unresolved identity removes all draft scopes while preserving unrelated storage', () => {
  const mock = memoryStorage()
  const storage = createPostDraftStorage({ storage: mock })
  storage.save(scopeA, draft('user one'))
  storage.save({ userId: 2, wallId: 10 }, draft('user two'))
  mock.setItem('unrelated', 'keep')
  assert.equal(storage.clearAll(), true)
  assert.equal(storage.load(scopeA).draft, null)
  assert.equal(storage.load({ userId: 2, wallId: 10 }).draft, null)
  assert.equal(mock.getItem('unrelated'), 'keep')
})

test('reactive wall switching saves the old scope before restoring the new scope', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Wall A text'
  c.fields.isAnonymous.value = true
  c.wall.currentWallId = 20
  assert.equal(c.fields.content.value, '')
  assert.equal(c.fields.isAnonymous.value, false)
  c.fields.content.value = 'Wall B text'
  c.wall.currentWallId = 10
  assert.equal(c.fields.content.value, 'Wall A text')
  assert.equal(c.fields.isAnonymous.value, true)
  assert.equal(c.state.draftStatus.value, 'restored')
  assert.equal(storage.load(scopeB).draft.content, 'Wall B text')
  c.scope.stop()
})

test('leaving then remounting the composer restores the session draft', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const first = composer(storage)
  first.fields.content.value = 'After refresh'
  first.fields.customCategory.value = '图书馆'
  first.fields.useCustomCategory.value = true
  first.scope.stop()
  const second = composer(storage)
  assert.equal(second.fields.content.value, 'After refresh')
  assert.equal(second.fields.customCategory.value, '图书馆')
  assert.equal(second.fields.useCustomCategory.value, true)
  second.scope.stop()
})

test('logout clears editor state and disposal cannot resurrect a removed account draft', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Private draft'
  c.identity.isLoggedIn = false
  storage.clearUser(c.identity.user.id)
  c.identity.user = null
  c.identity.sessionRevision++
  assert.equal(c.fields.content.value, '')
  c.scope.stop()
  assert.equal(storage.load(scopeA).draft, null)
})

test('account reset isolates the new editor even if the same user id logs in again', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Old account draft'
  const captured = c.state.captureDraft()
  storage.clearUser(1)
  c.identity.user = null
  c.identity.sessionRevision++
  c.identity.user = { id: 2 }
  assert.equal(c.fields.content.value, '')
  c.fields.content.value = 'New account draft'
  assert.equal(c.state.isCurrentScope(captured.scope), false)
  c.state.completeDraft(captured)
  assert.equal(storage.load({ userId: 2, wallId: 10 }).draft.content, 'New account draft')
  c.scope.stop()
})

test('successful submission clears its own draft and unmount does not recreate it', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Published draft'
  c.state.completeDraft(c.state.captureDraft())
  assert.equal(storage.load(scopeA).draft, null)
  c.scope.stop()
  assert.equal(storage.load(scopeA).draft, null)
})

test('late submission only clears the submitted scope and preserves a later edit', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Published wall A'
  const submitted = c.state.captureDraft()
  c.wall.currentWallId = 20
  c.fields.content.value = 'New wall B draft'
  c.state.completeDraft(submitted)
  assert.equal(storage.load(scopeA).draft, null)
  assert.equal(storage.load(scopeB).draft.content, 'New wall B draft')
  c.fields.content.value = 'Original text'
  const previous = c.state.captureDraft()
  c.fields.content.value = 'Newer text in same wall'
  c.state.completeDraft(previous)
  assert.equal(storage.load(scopeB).draft.content, 'Newer text in same wall')
  c.scope.stop()
})

test('an old publish response cannot clear identical text after the same account logs in again', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Identical text'
  const submitted = c.state.captureDraft()
  c.identity.isLoggedIn = false
  storage.clearUser(1)
  c.identity.user = null
  c.identity.sessionRevision++
  c.identity.user = { id: 1 }
  c.identity.isLoggedIn = true
  c.fields.content.value = 'Identical text'
  c.state.completeDraft(submitted)
  assert.equal(storage.load(scopeA).draft.content, 'Identical text')
  assert.equal(c.state.draftStatus.value, 'saved')
  c.scope.stop()
})

test('explicit discard clears saved content and resets editor defaults', () => {
  const storage = createPostDraftStorage({ storage: memoryStorage() })
  const c = composer(storage)
  c.fields.content.value = 'Discard me'
  c.fields.images.value.push('/uploads/post/photo.jpg')
  c.state.discardDraft()
  assert.equal(c.fields.content.value, '')
  assert.deepEqual(c.fields.images.value, [])
  assert.equal(c.state.hasDraft.value, false)
  c.scope.stop()
  assert.equal(storage.load(scopeA).draft, null)
})

test('blocked access and quota failures never block editing or submission cleanup', () => {
  for (const storage of [
    createPostDraftStorage({ storage: () => { throw new Error('blocked') } }),
    createPostDraftStorage({ storage: { ...memoryStorage(), setItem() { throw new Error('quota exceeded') } } }),
  ]) {
    const c = composer(storage)
    assert.doesNotThrow(() => { c.fields.content.value = 'Still editable' })
    assert.equal(c.state.draftStatus.value, 'unavailable')
    assert.equal(c.fields.content.value, 'Still editable')
    assert.doesNotThrow(() => c.state.completeDraft(c.state.captureDraft()))
    assert.doesNotThrow(() => c.state.discardDraft())
    c.scope.stop()
  }
})
