import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import axios from 'axios'
import { createSocialScope } from '../src/components/chat-social/socialState.js'

function storage(values = {}) {
  const data = new Map(Object.entries(values))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Exercise the production Axios interceptors with isolated storage and a controlled network.
async function harness(handle, values = {}, localStorage = storage(values)) {
  const source = await readFile(new URL('../src/api/index.js', import.meta.url), 'utf8')
  const requests = [], redirects = [], listeners = new Map()
  const context = createContext({
    axios, localStorage, sessionStorage: storage(), Blob, TextEncoder, atob,
    window: { location: { pathname: '/', replace: path => redirects.push(path) },
      addEventListener: (name, fn) => listeners.set(name, fn) },
  })
  runInContext(source.replace(/^import .+$/gm, '').replaceAll('export function ', 'function ')
    .replace('export default api', '') + '\nObject.assign(this, { api, restoreSession, clearSessionCookie, getSessionToken, setSessionToken, subscribeSessionChange })', context)
  context.api.defaults.adapter = async config => {
    requests.push(config)
    const result = await handle(config)
    const response = { status: 200, statusText: '', headers: {}, ...result, config }
    if (response.status >= 400) throw new axios.AxiosError('HTTP ' + response.status, 'ERR_BAD_REQUEST', config, {}, response)
    return response
  }
  return { ...context, requests, redirects, localStorage, listeners }
}

test('startup restores from an HttpOnly cookie without a locally stored token and shares the request', async () => {
  const ready = deferred(), response = deferred()
  const h = await harness(config => { ready.resolve(); return response.promise }, { currentWallId: '12' })
  const events = []
  h.subscribeSessionChange(event => events.push(event))
  const first = h.restoreSession(), second = h.restoreSession()
  await ready.promise
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, '/auth/refresh')
  assert.equal(h.requests[0].withCredentials, true)
  assert.equal(h.requests[0].headers['X-Requested-With'], 'school-wall')
  response.resolve({ data: { token: 'restored-token' } })
  assert.equal(await first, 'restored-token')
  assert.equal(await second, 'restored-token')
  assert.equal(h.getSessionToken(), 'restored-token')
  assert.equal(h.localStorage.getItem('token'), 'restored-token')
  assert.equal(h.localStorage.getItem('currentWallId'), '12')
  assert.equal(events[0].resetContext, false)
  await h.restoreSession()
  assert.equal(h.requests.length, 1)
})

test('existing installations keep their local token when starting up', async () => {
  const h = await harness(() => { throw new Error('No network expected') }, { token: 'legacy-token' })
  assert.equal(await h.restoreSession(), 'legacy-token')
  assert.equal(h.requests.length, 0)
})

test('first visit and an expired cookie stay logged out without redirect loops', async () => {
  const h = await harness(() => ({ status: 401, data: { error: 'expired' } }))
  assert.equal(await h.restoreSession(), '')
  assert.equal(await h.restoreSession(), '')
  assert.equal(h.getSessionToken(), '')
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.redirects, [])
})

test('startup can retry after a temporary network failure', async () => {
  let attempts = 0
  const h = await harness(() => {
    if (++attempts === 1) throw new Error('offline')
    return { data: { token: 'online-token' } }
  })
  await assert.rejects(h.restoreSession(), /offline/)
  assert.equal(await h.restoreSession(), 'online-token')
})

test('simultaneous expired API requests share one cookie refresh and retry with the new token', async () => {
  const ready = deferred(), response = deferred()
  const h = await harness(config => {
    if (config.url === '/auth/refresh') { ready.resolve(); return response.promise }
    if (config.headers.Authorization === 'Bearer expired-token') return { status: 401, data: {} }
    return { data: { ok: true } }
  }, { token: 'expired-token', currentWallId: '12' })
  const first = h.api.get('/auth/me'), second = h.api.get('/permissions/me')
  await ready.promise
  response.resolve({ data: { token: 'fresh-token' } })
  const results = await Promise.all([first, second])
  assert.ok(results.every(result => result.data.ok))
  assert.equal(h.requests.filter(config => config.url === '/auth/refresh').length, 1)
  assert.equal(h.getSessionToken(), 'fresh-token')
  assert.equal(h.localStorage.getItem('currentWallId'), '12')
  assert.deepEqual(h.redirects, [])
})

test('an invalid persistent cookie clears the expired local session and redirects once', async () => {
  const h = await harness(() => ({ status: 401, data: {} }), { token: 'expired-token' })
  await assert.rejects(h.api.get('/auth/me'))
  assert.equal(h.getSessionToken(), '')
  assert.deepEqual(h.requests.map(config => config.url), ['/auth/me', '/auth/refresh'])
  assert.deepEqual(h.redirects, ['/login'])
})

test('a retried request that still returns 401 cannot start a refresh loop', async () => {
  const h = await harness(config => config.url === '/auth/refresh'
    ? { data: { token: 'fresh-token' } } : { status: 401, data: {} }, { token: 'expired-token' })
  await assert.rejects(h.api.get('/auth/me'))
  assert.equal(h.requests.length, 3)
  assert.equal(h.getSessionToken(), '')
  assert.deepEqual(h.redirects, ['/login'])
})

test('refresh server errors keep the local session for a later retry', async () => {
  const h = await harness(config => ({ status: config.url === '/auth/refresh' ? 503 : 401, data: {} }), { token: 'expired-token' })
  await assert.rejects(h.api.get('/auth/me'), error => error.response.status === 503)
  assert.equal(h.getSessionToken(), 'expired-token')
  assert.deepEqual(h.redirects, [])
})

test('wrong login credentials do not attempt cookie recovery or redirect the form', async () => {
  const h = await harness(() => ({ status: 401, data: {} }))
  await assert.rejects(h.api.post('/auth/login', { username: 'alice', password: 'wrong' }))
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.redirects, [])
})

test('logout prevents an in-flight restore from reviving the account and persists across page loads', async () => {
  const ready = deferred(), response = deferred()
  const h = await harness(config => {
    if (config.url === '/auth/refresh') { ready.resolve(); return response.promise }
    return { data: { message: 'logged out' } }
  })
  const restore = h.restoreSession()
  await ready.promise
  h.setSessionToken('')
  await h.clearSessionCookie()
  response.resolve({ data: { token: 'late-token' } })
  assert.equal(await restore, '')
  assert.equal(h.getSessionToken(), '')
  assert.equal(h.requests.at(-1).url, '/auth/logout')
  const reloaded = await harness(() => { throw new Error('Must not restore after logout') }, {}, h.localStorage)
  await reloaded.restoreSession()
  assert.equal(reloaded.requests.length, 0)
  reloaded.setSessionToken('interactive-login')
  assert.equal(h.localStorage.getItem('sessionLoggedOut'), null)
})

test('a late restore or 401 from an earlier account cannot overwrite a new login', async () => {
  const ready = deferred(), response = deferred()
  const h = await harness(config => {
    if (config.url === '/auth/refresh') { ready.resolve(); return response.promise }
    return { status: 401, data: {} }
  }, { token: 'old-token' })
  const request = h.api.get('/auth/me')
  const rejected = assert.rejects(request)
  await ready.promise
  h.setSessionToken('new-account-token')
  response.resolve({ data: { token: 'old-account-restored' } })
  await rejected
  assert.equal(h.getSessionToken(), 'new-account-token')
  assert.deepEqual(h.redirects, [])
})

test('a Cookie for another account never receives a replay of the original API write', async () => {
  const token = id => 'header.' + Buffer.from(JSON.stringify({ id, username: 'user-' + id })).toString('base64url') + '.signature'
  const h = await harness(config => {
    if (config.url === '/auth/refresh') return { data: { token: token(2) } }
    if (config.url === '/auth/logout') return { data: { message: 'logged out' } }
    return { status: 401, data: {} }
  }, { token: token(1) })
  await assert.rejects(h.api.post('/messages', { content: 'only for account one' }))
  assert.equal(h.getSessionToken(), '')
  assert.equal(h.localStorage.getItem('sessionLoggedOut'), '1')
  assert.equal(h.requests.filter(config => config.url === '/messages').length, 1)
  assert.deepEqual(h.redirects, ['/login'])
})

test('chat requests remain current after token renewal and still reject account or wall changes', () => {
  const context = { token: 'expired-token', session: 1, wallId: 12, conversation: 'example' }
  const scope = createSocialScope(() => context)
  const request = scope.request()
  context.token = 'renewed-token'
  assert.equal(request.current(), true)
  context.session++
  assert.equal(request.current(), false)
  const next = scope.request()
  context.wallId = 13
  assert.equal(next.current(), false)
  scope.dispose()
  assert.equal(next.config.signal.aborted, true)
})

test('cookie recovery works when localStorage is unavailable', async () => {
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  const h = await harness(() => ({ data: { token: 'memory-token' } }), {}, blocked)
  await h.restoreSession()
  assert.equal(h.getSessionToken(), 'memory-token')
})
