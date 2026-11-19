import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia, defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'

const root = new URL('../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')
const storage = () => {
  const entries = new Map()
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) }
}
function evaluate(path, bindings, exports) {
  const code = source(path).replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ').replace(/^export default api$/m, '').replaceAll('import.meta.hot', 'false')
  return new Function(...Object.keys(bindings), code + '\nreturn { ' + exports.join(', ') + ' }')(...Object.values(bindings))
}
function fixture() {
  globalThis.localStorage = storage()
  globalThis.sessionStorage = storage()
  const redirects = []
  const events = new Map()
  globalThis.window = { location: { pathname: '/', replace: path => redirects.push(path) }, addEventListener: (key, listener) => events.set(key, listener) }
  const api = { interceptors: { request: { use: callback => { api.request = callback } }, response: { use: (ok, fail) => { api.failure = fail } } }, get: async () => ({ data: {} }), put: async () => ({ data: {} }), post: async () => ({ data: {} }) }
  const apiExports = evaluate('src/api/index.js', { axios: { create: () => api } }, ['getSessionToken', 'setRequestWallId', 'setSessionToken', 'subscribeSessionChange', 'getApiErrorMessage', 'readStorage', 'writeStorage', 'getUsernameError', 'getPasswordError'])
  setActivePinia(createPinia())
  const bindings = { defineStore, acceptHMRUpdate, ref, computed, onScopeDispose, api, ...apiExports }
  const { useUserStore } = evaluate('src/stores/user.js', bindings, ['useUserStore'])
  const { useWallStore } = evaluate('src/stores/wall.js', { ...bindings, useUserStore }, ['useWallStore'])
  const { useSettingsStore } = evaluate('src/stores/settings.js', { ...bindings, useUserStore, useWallStore }, ['useSettingsStore'])
  return { api, ...apiExports, useUserStore, useWallStore, useSettingsStore, redirects, events }
}
const rejected = (api, status, url, token, data = {}) => api.failure({ response: { status, data }, config: { url, headers: token ? { Authorization: 'Bearer ' + token } : {} } })

test('explicit wall context survives and wall path supplies its own context', () => {
  const f = fixture()
  f.setRequestWallId(3)
  assert.equal(f.api.request({ url: '/posts/9', headers: { 'X-Wall-Id': 42 } }).headers['X-Wall-Id'], 42)
  assert.equal(f.api.request({ url: '/walls/7/members', headers: {} }).headers['X-Wall-Id'], '7')
  localStorage.setItem('currentWallId', '9')
  assert.equal(f.api.request({ url: '/posts', headers: {} }).headers['X-Wall-Id'], '3', 'another tab cannot silently change the wall of this page')
  f.setRequestWallId('3junk')
  assert.equal(f.api.request({ url: '/posts', headers: {} }).headers['X-Wall-Id'], undefined)
})

test('incorrect login password remains on form without clearing an existing session', async () => {
  const f = fixture(); f.setSessionToken('current')
  await assert.rejects(rejected(f.api, 401, '/auth/login', 'current'))
  assert.equal(f.getSessionToken(), 'current')
  assert.deepEqual(f.redirects, [])
})

test('current 401 clears account permissions wall and preferences together', async () => {
  const f = fixture(); f.setSessionToken('current')
  const user = f.useUserStore(); const wall = f.useWallStore(); const settings = f.useSettingsStore()
  user.user = { id: 1 }; user.perms = { global: ['global.moderate'], walls: {} }
  wall.myWalls = [{ id: 5, member_status: 'active' }]; wall.loaded = true; wall.setCurrentWall(5)
  settings.prefs.feed_sort = 'hot'; settings.loaded = true
  await assert.rejects(rejected(f.api, 401, '/auth/me', 'current'))
  assert.equal(user.token, ''); assert.equal(user.user, null); assert.equal(user.can('global.moderate'), false)
  assert.equal(wall.currentWallId, null); assert.deepEqual(wall.myWalls, []); assert.equal(wall.loaded, false)
  assert.equal(settings.prefs.feed_sort, 'latest'); assert.equal(settings.loaded, false)
  assert.equal(user.sessionRevision, 1); assert.deepEqual(f.redirects, ['/login'])
})

test('outdated request 401 cannot clear a freshly rotated password token', async () => {
  const f = fixture(); f.setSessionToken('old'); const user = f.useUserStore(); user.user = { id: 1 }
  f.setSessionToken('new', { resetContext: false })
  await assert.rejects(rejected(f.api, 401, '/messages', 'old'))
  assert.equal(user.token, 'new'); assert.equal(user.user.id, 1); assert.equal(user.sessionRevision, 0)
  assert.deepEqual(f.redirects, [])
})

test('global ban keeps verified token for appeals and records real restriction', async () => {
  const f = fixture(); f.setSessionToken('valid')
  await assert.rejects(rejected(f.api, 403, '/posts', 'valid', { code: 'BANNED', scope: 'global', banLevel: 'post', permanent: false, until: '2027-01-01' }))
  assert.equal(f.getSessionToken(), 'valid')
  assert.equal(JSON.parse(sessionStorage.getItem('banInfo')).banLevel, 'post')
  assert.deepEqual(f.redirects, ['/banned'])
})

test('temporary restore failure retains credentials and can be retried', async () => {
  const f = fixture(); f.setSessionToken('valid'); const user = f.useUserStore()
  f.api.get = async () => { throw { request: {}, code: 'ERR_NETWORK' } }
  assert.equal(await user.fetchUser(), null); assert.equal(user.token, 'valid'); assert.match(user.restoreError, /网络/)
  f.api.get = async path => ({ data: path === '/auth/me' ? { id: 1, nickname: '同学' } : { global: [], walls: {} } })
  await user.fetchUser(); assert.equal(user.user.nickname, '同学'); assert.equal(user.restoreError, '')
})

test('late profile response cannot restore account after logout', async () => {
  const f = fixture(); f.setSessionToken('valid'); const user = f.useUserStore()
  let resolve
  f.api.get = () => new Promise(done => { resolve = done })
  const request = user.fetchUser(); user.logout(); resolve({ data: { id: 9 } }); await request
  assert.equal(user.user, null); assert.equal(user.token, '')
})

test('pending and banned walls remain listed but cannot become current wall', async () => {
  const f = fixture(); f.setSessionToken('valid'); const wall = f.useWallStore()
  f.api.get = async () => ({ data: [{ id: 1, member_status: 'pending' }, { id: 2, member_status: 'banned' }, { id: 3, member_status: 'active' }] })
  await wall.fetchMyWalls(); assert.equal(wall.myWalls.length, 3); assert.equal(wall.currentWallId, 3)
  assert.equal(wall.switchWall(1), false); assert.equal(wall.currentWallId, 3)
  assert.equal(wall.switchWall('3junk'), false); assert.equal(wall.currentWallId, 3)
  assert.equal(wall.switchWall(99), false); assert.equal(wall.currentWallId, 3)
})

test('wall network failure preserves known walls without declaring first load successful', async () => {
  const f = fixture(); f.setSessionToken('valid'); const wall = f.useWallStore()
  f.api.get = async () => { throw { request: {} } }
  await wall.fetchMyWalls(); assert.equal(wall.loaded, false); assert.match(wall.loadError, /网络/)
  f.api.get = async () => ({ data: [{ id: 3, member_status: 'active' }] }); await wall.fetchMyWalls()
  f.api.get = async () => { throw { request: {} } }; await wall.fetchMyWalls()
  assert.equal(wall.currentWallId, 3); assert.equal(wall.myWalls.length, 1)
})

test('failed preferences roll back and report failure instead of false success', async () => {
  const f = fixture(); f.setSessionToken('valid'); const settings = f.useSettingsStore()
  f.api.put = async () => { throw { request: {} } }
  assert.equal(await settings.setPref('feed_sort', 'hot'), false)
  assert.equal(settings.prefs.feed_sort, 'latest'); assert.match(settings.saveError, /网络/)
  f.api.put = async () => ({ data: {} })
  assert.equal(await settings.setPref('feed_sort', 'hot'), true); assert.equal(settings.prefs.feed_sort, 'hot')
})

test('preference saves serialize and failed later change restores persisted value', async () => {
  const f = fixture(); f.setSessionToken('valid'); const settings = f.useSettingsStore()
  const calls = []
  f.api.put = async (path, payload) => { calls.push(payload.prefs.feed_sort); if (calls.length === 2) throw { request: {} }; return { data: {} } }
  const first = settings.setPref('feed_sort', 'hot'); const second = settings.setPref('feed_sort', 'latest')
  assert.equal(await first, true); assert.equal(await second, false)
  assert.deepEqual(calls, ['hot', 'latest']); assert.equal(settings.prefs.feed_sort, 'hot')
})

test('cross-tab logout clears reactive stores', () => {
  const f = fixture(); f.setSessionToken('valid'); const user = f.useUserStore(); user.user = { id: 1 }
  f.events.get('storage')({ key: 'token', newValue: null, storageArea: localStorage })
  assert.equal(user.token, ''); assert.equal(user.user, null)
})

test('username and unicode password boundaries match server rules', () => {
  const f = fixture()
  assert.notEqual(f.getUsernameError('ab'), ''); assert.notEqual(f.getUsernameError('abc\n'), '')
  assert.equal(f.getUsernameError('同学123'), '')
  assert.notEqual(f.getPasswordError('12345'), ''); assert.equal(f.getPasswordError('123456'), '')
  assert.notEqual(f.getPasswordError('密'.repeat(342)), ''); assert.equal(f.getPasswordError('密'.repeat(341)), '')
})
