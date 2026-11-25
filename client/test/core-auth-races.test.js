import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { createPinia, defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Execute the real store with an in-memory API/session boundary; no browser storage is read.
async function createUserHarness() {
  const source = await readFile(new URL('../src/stores/user.js', import.meta.url), 'utf8')
  let token = ''
  const listeners = new Set()
  const requests = []
  const clearedDrafts = []
  const api = {
    post(path, data) {
      const result = deferred()
      requests.push({ path, data, ...result })
      return result.promise
    },
    get: async () => ({ data: { global: [], walls: {} } }),
    put: async () => ({ data: { token: 'refreshed-token' } }),
  }
  const context = createContext({
    defineStore, ref, computed, onScopeDispose, api,
    postDrafts: { clearUser: userId => clearedDrafts.push(userId), clearAll: () => clearedDrafts.push('all') },
    getSessionToken: () => token,
    setSessionToken(value, { resetContext = true } = {}) {
      const previousToken = token
      token = value
      for (const listener of listeners) listener({ token, previousToken, resetContext })
    },
    subscribeSessionChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getApiErrorMessage: (_error, fallback) => fallback,
  })
  const executable = source.replace(/^import .+$/gm, '').replace('export const useUserStore', 'const useUserStore')
  runInContext(executable + '\nthis.useUserStore = useUserStore', context)
  const store = context.useUserStore(createPinia())
  return { store, api, requests, clearedDrafts, token: () => token }
}

function session(id, token = 'token-' + id) { return { data: { token, user: { id, username: 'user-' + id } } } }
function cancelled(operation) {
  return assert.rejects(operation, error => error.code === 'ERR_CANCELED')
}

test('a slow earlier login cannot replace the latest authenticated account', async () => {
  const h = await createUserHarness()
  const first = h.store.login('alice', 'password')
  const firstCancelled = cancelled(first)
  const second = h.store.login('bob', 'password')
  h.requests[1].resolve(session(2))
  await second
  h.requests[0].resolve(session(1))
  await firstCancelled
  assert.equal(h.store.user.id, 2)
  assert.equal(h.token(), 'token-2')
})

test('logout while login is pending prevents the late response from logging back in', async () => {
  const h = await createUserHarness()
  const login = h.store.login('alice', 'password')
  const rejected = cancelled(login)
  h.store.logout()
  h.requests[0].resolve(session(1))
  await rejected
  assert.equal(h.store.user, null)
  assert.equal(h.token(), '')
})

test('an older registration cannot replace a newer login', async () => {
  const h = await createUserHarness()
  const registration = h.store.register('alice', 'password', 'Alice', '')
  const rejected = cancelled(registration)
  const login = h.store.login('bob', 'password')
  h.requests[1].resolve(session(2))
  await login
  h.requests[0].resolve(session(1))
  await rejected
  assert.equal(h.store.user.id, 2)
})

test('session reset invalidates pending auth even when the token and user are reused', async () => {
  const h = await createUserHarness()
  h.store.acceptSession(session(1, 'same-token').data)
  const login = h.store.login('alice', 'password')
  const rejected = cancelled(login)
  h.store.acceptSession(session(1, 'same-token').data)
  h.requests[0].resolve(session(99, 'old-token'))
  await rejected
  assert.equal(h.store.user.id, 1)
  assert.equal(h.token(), 'same-token')
})

test('password token refresh keeps the current session identity and permits current auth intent', async () => {
  const h = await createUserHarness()
  h.store.acceptSession(session(1).data)
  const revision = h.store.sessionRevision
  const login = h.store.login('bob', 'password')
  await h.store.changePassword('old-password', 'new-password')
  assert.equal(h.store.sessionRevision, revision)
  assert.equal(h.token(), 'refreshed-token')
  h.requests[0].resolve(session(2))
  await login
  assert.equal(h.store.user.id, 2)
})

test('logout clears every wall draft of the authenticated account even outside the composer', async () => {
  const h = await createUserHarness()
  h.store.acceptSession(session(1).data)
  h.clearedDrafts.length = 0
  h.store.logout()
  assert.deepEqual(h.clearedDrafts, [1])
})

test('logout before identity restoration clears only the draft namespace via the storage boundary', async () => {
  const h = await createUserHarness()
  h.store.logout()
  assert.deepEqual(h.clearedDrafts, ['all'])
})

test('password refresh preserves account drafts and does not reset the session revision', async () => {
  const h = await createUserHarness()
  h.store.acceptSession(session(1).data)
  h.clearedDrafts.length = 0
  const revision = h.store.sessionRevision
  await h.store.changePassword('old-password', 'new-password')
  assert.deepEqual(h.clearedDrafts, [])
  assert.equal(h.store.sessionRevision, revision)
})

test('logout during permission loading cancels the login continuation', async () => {
  const h = await createUserHarness()
  const permissionRequest = deferred()
  const permissionStarted = deferred()
  h.api.get = () => { permissionStarted.resolve(); return permissionRequest.promise }
  const login = h.store.login('alice', 'password')
  const rejected = cancelled(login)
  h.requests[0].resolve(session(1))
  await permissionStarted.promise
  h.store.logout()
  permissionRequest.resolve({ data: { global: ['old-permission'], walls: {} } })
  await rejected
  assert.equal(h.store.user, null)
  assert.equal(h.store.can('old-permission'), false)
})

test('password refresh during permission loading does not cancel accepted login', async () => {
  const h = await createUserHarness()
  const permissionRequest = deferred()
  const permissionStarted = deferred()
  h.api.get = () => { permissionStarted.resolve(); return permissionRequest.promise }
  const login = h.store.login('alice', 'password')
  h.requests[0].resolve(session(1))
  await permissionStarted.promise
  await h.store.changePassword('old-password', 'new-password')
  permissionRequest.resolve({ data: { global: [], walls: {} } })
  await login
  assert.equal(h.store.user.id, 1)
  assert.equal(h.token(), 'refreshed-token')
})

test('a failed newer login still prevents an older attempt from silently taking over', async () => {
  const h = await createUserHarness()
  const first = h.store.login('alice', 'password')
  const rejected = cancelled(first)
  const second = h.store.login('bob', 'wrong-password')
  const failed = assert.rejects(second, /wrong password/)
  h.requests[1].reject(new Error('wrong password'))
  await failed
  h.requests[0].resolve(session(1))
  await rejected
  assert.equal(h.store.user, null)
  assert.equal(h.token(), '')
})
