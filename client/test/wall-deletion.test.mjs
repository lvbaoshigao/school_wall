import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { createPinia, defineStore } from 'pinia'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { getApiErrorMessage } from '../src/api/index.js'
import { focusIfActive } from '../src/utils/focus.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const wallOne = { id: 1, name: '校园一墙', member_status: 'active', wall_role: 'owner', status: 'active' }
const wallTwo = { id: 2, name: '校园二墙', member_status: 'active', status: 'active' }
const countKeys = ['members', 'wall_applications', 'ban_logs', 'posts', 'comments', 'likes', 'bookmarks', 'messages', 'announcements', 'votes', 'vote_options', 'vote_records', 'reports', 'post_reports', 'user_reports', 'user_permissions', 'attachments', 'deletable_attachments', 'retained_attachments']
function preview(wall = wallOne) {
  const counts = Object.fromEntries(countKeys.map((key, index) => [key, index]))
  counts.deletable_attachments = 0
  counts.retained_attachments = counts.attachments
  return { wall: { ...wall }, counts, warnings: ['成员账号、好友与账号偏好会保留'], can_delete: true }
}
async function settle() { for (let index = 0; index < 7; index++) { await Vue.nextTick(); await Promise.resolve() } }
const adminSource = await readFile(new URL('../src/views/Admin.vue', import.meta.url), 'utf8')
const parsed = parse(adminSource)
assert.deepEqual(parsed.errors, [])
const script = compileScript(parsed.descriptor, { id: 'data-v-wall-deletion-test' })
const template = compileTemplate({ source: parsed.descriptor.template.content, filename: 'Admin.vue', id: 'data-v-wall-deletion-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
function factory(compiled, deps) {
  return new Function(...Object.keys(deps), compiled.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return'))(...Object.values(deps))
}
function renderFactory(code, vue = Vue) {
  const executable = code.replace(/^import[^\n]*\n/gm, line => {
    const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
    return 'const {' + names + '} = Vue;\n'
  }).replace('export function render', 'return function render')
  return new Function('Vue', executable)(vue)
}
async function wallHarness(user, initial = [wallOne, wallTwo]) {
  const source = await readFile(new URL('../src/stores/wall.js', import.meta.url), 'utf8')
  const requests = [], selected = []
  const api = { get(path) { const request = deferred(); requests.push({ path, ...request }); return request.promise } }
  const deps = { ...Vue, defineStore, api, readStorage: () => null, setRequestWallId: id => selected.push(id), getSessionToken: () => 'one', subscribeSessionChange: () => () => {}, getApiErrorMessage, useUserStore: () => user }
  const useWallStore = new Function(...Object.keys(deps), source.replace(/^import[^\n]*\n/gm, '').replace('export const useWallStore', 'const useWallStore') + '\nreturn useWallStore')(...Object.values(deps))
  const pinia = createPinia()
  const store = useWallStore(pinia)
  store.myWalls = initial.map(wall => ({ ...wall }))
  store.loaded = true
  store.setCurrentWall(initial[0]?.id ?? null)
  return { store, requests, selected, dispose() { store.$dispose(); pinia._e.stop() } }
}
async function adminHarness(t, { global = ['global.wall.manage'], initial = [wallOne, wallTwo] } = {}) {
  const user = Vue.reactive({ user: { id: 9, role: 'user' }, token: 'one', sessionRevision: 0, perms: { global, walls: { 1: ['wall.edit'], 2: ['wall.stats.view'] } },
    can(permission) { return this.perms.global.includes(permission) },
    canInWall(permission, id) { return (this.perms.walls[id] || this.perms.global).includes(permission) },
    permissionRefreshes: 0, async fetchPermissions() { this.permissionRefreshes++ },
  })
  const wall = await wallHarness(user, initial)
  const requests = [], deletes = [], traps = [], notifications = [], mounted = [], unmount = []
  const api = {
    get(path, options) { const request = deferred(); requests.push({ path, options, ...request }); return request.promise },
    delete(path, options) { const request = deferred(); deletes.push({ path, options, ...request }); return request.promise },
  }
  const empty = { render: () => null }
  const deps = { ...Vue, api, getApiErrorMessage, focusIfActive, useUserStore: () => user, useWallStore: () => wall.store, useRoute: () => ({ query: {} }),
    useToast: () => Object.fromEntries(['error', 'success', 'warning'].map(kind => [kind, message => notifications.push({ kind, message })])),
    useMarkdown: () => ({}), useFocusTrap: (...args) => traps.push(args), ConfirmModal: empty, Icon: empty, defineAsyncComponent: () => empty,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmount.push(fn),
  }
  const component = factory(script.content, deps)
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  const render = renderFactory(template.code)
  let adminDisposed = false
  function disposeAdmin() {
    if (adminDisposed) return
    adminDisposed = true
    unmount.forEach(fn => fn())
    scope.stop()
  }
  t.after(() => { disposeAdmin(); wall.dispose() })
  return { state, user, wall: wall.store, wallRequests: wall.requests, requests, deletes, traps, notifications, settle, disposeAdmin,
    render() { return renderToString(Vue.h({ render: () => render({}, [], {}, Vue.proxyRefs(state)) })) },
  }
}
async function openPreview(h, wall = wallOne, data = preview(wall)) {
  h.state.openWallDeletion(wall)
  const request = h.requests.at(-1)
  assert.equal(request.path, '/walls/admin/' + wall.id + '/deletion-preview')
  request.resolve({ data })
  await settle()
}
function confirm(h, name = wallOne.name) {
  h.state.wallDeletionName.value = name
  h.state.wallDeletionPassword.value = 'current-secret'
  h.state.wallDeletionAcknowledged.value = true
}

test('wall management permission alone exposes the navigation entry without wall membership and responds to revocation', async t => {
  const source = await readFile(new URL('../src/components/Navbar.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const compiled = compileScript(descriptor, { id: 'wall-management-navigation-test' })
  const user = Vue.reactive({ token: 'one', sessionRevision: 0, user: { id: 9 }, isLoggedIn: true,
    permissions: ['global.wall.manage'], can(permission) { return this.permissions.includes(permission) },
  })
  const deps = { ...Vue, useUserStore: () => user, useWallStore: () => ({ currentWallId: null, currentWall: null, myWalls: [], canHere: () => false }),
    useSettingsStore: () => ({ prefs: { unread_interval: '0' }, visibleNav: [] }),
    useRouter: () => ({ currentRoute: Vue.ref({ fullPath: '/walls', path: '/walls' }) }),
    useMarkdown: () => ({}), useToast: () => ({}), useFocusTrap() {}, observeScrollProgress() {},
    onMounted() {}, onUnmounted() {}, Icon: { render: () => null }, AvatarIcon: { render: () => null },
  }
  const component = factory(compiled.content, deps)
  const scope = Vue.effectScope()
  t.after(() => scope.stop())
  const state = scope.run(() => component.setup({}, { expose() {}, emit() {} }))
  assert.equal(state.canOpenAdmin.value, true)
  user.permissions = []
  assert.equal(state.canOpenAdmin.value, false)
  user.permissions = ['wall.edit']
  assert.equal(state.canOpenAdmin.value, false)
})

test('wall owner receives no global deletion entry or API access without global.wall.manage', async t => {
  const h = await adminHarness(t, { global: [] })
  h.state.activePanel.value = 'allWalls'
  h.state.allWalls.value = [wallOne]
  h.state.openWallDeletion(wallOne)
  await h.state.loadAllWalls()
  assert.equal(h.state.showWallDeletion.value, false)
  assert.equal(h.requests.length, 0)
  assert.doesNotMatch(await h.render(), /wall-delete-trigger/)
  const admin = await adminHarness(t)
  admin.state.activePanel.value = 'allWalls'
  admin.state.allWalls.value = [wallOne]
  assert.match(await admin.render(), /wall-delete-trigger/)
})

test('deletion requires complete valid impact counts, exact name, current password and irreversible acknowledgment', async t => {
  const h = await adminHarness(t)
  h.state.openWallDeletion(wallOne)
  confirm(h)
  assert.equal(h.state.canDeleteWall.value, false)
  await h.state.doDeleteWall()
  assert.equal(h.deletes.length, 0)
  const invalid = preview()
  delete invalid.counts.messages
  h.requests[0].resolve({ data: invalid })
  await settle()
  assert.equal(h.state.wallDeletionPreview.value, null)
  assert.match(h.state.wallDeletionError.value, /格式无效/)
  const retry = h.state.loadWallDeletionPreview()
  h.requests[1].resolve({ data: preview() })
  await retry
  confirm(h, ' ' + wallOne.name)
  assert.equal(h.state.canDeleteWall.value, false)
  confirm(h)
  assert.equal(h.state.canDeleteWall.value, true)
  h.state.wallDeletionAcknowledged.value = false
  assert.equal(h.state.canDeleteWall.value, false)
  h.state.wallDeletionAcknowledged.value = true
  h.state.wallDeletionPassword.value = ''
  assert.equal(h.state.canDeleteWall.value, false)
  for (const bad of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    const data = preview(); data.counts.posts = bad
    assert.equal(h.state.validWallDeletionPreview(data, 1), false)
  }
  assert.equal(h.state.validWallDeletionPreview(preview(), 2), false)
  assert.equal(h.state.validWallDeletionPreview({ ...preview(), can_delete: false }, 1), false)
  const html = await h.render()
  assert.match(html, /无法撤销或恢复/)
  assert.match(html, /成员账号会保留/)
  assert.match(html, /保留附件（不删除）/)
  assert.match(html, /autocomplete="current-password"/)
  assert.equal(h.state.WALL_DELETION_COUNTS.length, countKeys.length)
})

test('preview failure can retry, cancel clears secrets and a late preview cannot repopulate another dialog', async t => {
  const h = await adminHarness(t)
  h.state.openWallDeletion(wallOne)
  h.requests[0].reject({ response: { status: 503, data: { error: '暂不可用' } } })
  await settle()
  assert.equal(h.state.wallDeletionError.value, '暂不可用')
  const retry = h.state.loadWallDeletionPreview()
  h.state.wallDeletionPassword.value = 'clear-this'
  const request = h.requests[1]
  h.state.closeWallDeletion()
  assert.equal(request.options.signal.aborted, true)
  assert.equal(h.state.wallDeletionPassword.value, '')
  h.state.openWallDeletion(wallTwo)
  request.resolve({ data: preview() })
  await retry
  assert.equal(h.state.wallDeletionPreview.value, null)
  h.requests[2].resolve({ data: preview(wallTwo) })
  await settle()
  assert.equal(h.state.wallDeletionPreview.value.wall.id, 2)
  h.state.wallDeletionPassword.value = 'clear-with-escape'
  const trap = h.traps.find(([isOpen]) => isOpen())
  assert.ok(trap)
  trap[2]()
  assert.equal(h.state.showWallDeletion.value, false)
  assert.equal(h.state.wallDeletionPassword.value, '')
})

test('request locks duplicate submission and dismissal, sends axios DELETE data, allows password correction', async t => {
  const h = await adminHarness(t)
  await openPreview(h)
  confirm(h)
  const request = h.state.doDeleteWall()
  await h.state.doDeleteWall()
  h.state.closeWallDeletion()
  h.state.openWallDeletion(wallTwo)
  assert.equal(h.deletes.length, 1)
  assert.equal(h.state.showWallDeletion.value, true)
  assert.equal(h.state.wallDeletionTarget.value.id, 1)
  assert.equal(h.state.wallDeletionBusy.value, true)
  assert.deepEqual(h.deletes[0].options, { data: { confirm_name: wallOne.name, password: 'current-secret' } })
  h.deletes[0].reject({ response: { status: 403, data: { error: '当前密码不正确', code: 'PASSWORD_INVALID' } } })
  await request
  assert.equal(h.state.wallDeletionBusy.value, false)
  assert.equal(h.state.wallDeletionPassword.value, '')
  assert.equal(h.state.wallDeletionError.value, '当前密码不正确')
  assert.equal(h.state.showWallDeletion.value, true)
  assert.equal(h.wall.myWalls.length, 2)
  confirm(h)
  assert.equal(h.state.canDeleteWall.value, true)
})

test('an uncertain deletion result requires a fresh preview instead of inviting a destructive retry', async t => {
  for (const failure of [
    { request: {}, message: 'connection lost' },
    { code: 'ECONNABORTED', message: 'request timed out' },
    { code: 'ERR_CANCELED', message: 'request canceled' },
    { response: { status: 502, data: { error: 'gateway unavailable' } } },
  ]) {
    const h = await adminHarness(t)
    await openPreview(h)
    confirm(h)
    const deletion = h.state.doDeleteWall()
    h.deletes[0].reject(failure)
    await deletion
    assert.match(h.state.wallDeletionError.value, /未能确认删除结果/)
    assert.match(h.state.wallDeletionError.value, /可能已经完成删除/)
    assert.equal(h.state.wallDeletionPreview.value, null)
    assert.equal(h.state.wallDeletionPassword.value, '')
    assert.equal(h.state.wallDeletionName.value, '')
    assert.equal(h.state.wallDeletionAcknowledged.value, false)
    assert.equal(h.state.showWallDeletion.value, true)
    assert.equal(h.wall.myWalls.length, 2, 'an unknown result does not pretend that deletion committed')
    assert.equal(h.deletes.length, 1, 'destructive requests are never retried automatically')
    assert.equal(h.requests.length, 1, 'reconciliation waits for a deliberate preview refresh')
    confirm(h)
    await h.state.doDeleteWall()
    assert.equal(h.deletes.length, 1, 'entering credentials again cannot bypass the fresh-preview requirement')
    const refresh = h.state.loadWallDeletionPreview()
    h.requests[1].resolve({ data: preview() })
    await refresh
    assert.equal(h.state.canDeleteWall.value, false, 'fresh server state still requires a new confirmation')
    confirm(h)
    assert.equal(h.state.canDeleteWall.value, true)
  }
})

test('successful deletion clears selected wall, cached permissions and publish context then refreshes walls and permissions', async t => {
  const h = await adminHarness(t)
  h.wall.markPostPublished(1)
  h.state.activePanel.value = 'allWalls'
  h.state.allWalls.value = [wallOne, wallTwo]
  const oldWalls = h.wall.fetchMyWalls()
  await openPreview(h)
  confirm(h)
  const deletion = h.state.doDeleteWall()
  h.deletes[0].resolve({ data: { deleted_wall_id: 1, counts: preview().counts, warnings: ['1 个附件文件本次保留，需在独立存储清理流程中核对'] } })
  await settle()
  assert.equal(h.wall.currentWallId, 2)
  assert.equal(h.wall.lastPublishedPost, null)
  assert.equal(h.user.perms.walls[1], undefined)
  assert.deepEqual(h.user.perms.walls[2], ['wall.stats.view'])
  assert.equal(h.state.wallDeletionPassword.value, '')
  assert.equal(h.state.showWallDeletion.value, false)
  assert.equal(h.user.permissionRefreshes, 1)
  assert.equal(h.wallRequests.length, 2, 'post-delete refresh must not reuse pre-delete request')
  h.wallRequests[0].resolve({ data: [wallOne, wallTwo] })
  await oldWalls
  assert.deepEqual(h.wall.myWalls.map(wall => wall.id), [2])
  h.wallRequests[1].resolve({ data: [wallTwo] })
  await settle()
  for (const request of h.requests.filter(request => request.path === '/walls/admin/all')) request.resolve({ data: [wallTwo] })
  await deletion
  assert.deepEqual(h.state.allWalls.value.map(wall => wall.id), [2])
  assert.deepEqual(h.state.wallDeletionResultWarnings.value, ['1 个附件文件本次保留，需在独立存储清理流程中核对'])
  assert.deepEqual(h.wall.lastWallDeletion.warnings, ['1 个附件文件本次保留，需在独立存储清理流程中核对'])
  assert.equal(h.wall.lastWallDeletion.wallId, 1)
  assert.equal(h.wall.lastWallDeletion.focusAllWalls, true)
  assert.equal('password' in h.wall.lastWallDeletion, false)
  assert.equal('confirm_name' in h.wall.lastWallDeletion, false)
  assert.match(await h.render(), /墙数据已永久删除/)
})

test('last wall deletion clears request context even if list refresh fails', async t => {
  const h = await adminHarness(t, { initial: [wallOne] })
  await openPreview(h)
  confirm(h)
  const operation = h.state.doDeleteWall()
  h.deletes[0].resolve({ data: { deleted_wall_id: 1, warnings: [] } })
  await settle()
  assert.equal(h.wall.currentWallId, null)
  assert.equal(h.wall.currentWall, null)
  assert.equal(h.wall.hasWall, false)
  h.wallRequests[0].reject({ request: {}, message: 'offline' })
  await settle()
  h.requests.filter(request => request.path === '/walls/admin/all').forEach(request => request.resolve({ data: [] }))
  await operation
  assert.equal(h.wall.currentWallId, null)
  assert.ok(h.notifications.some(item => item.kind === 'warning'))
  h.state.activePanel.value = 'allWalls'
  assert.match(await h.render(), /当前没有可用校园墙/)
})

test('revoking global permission or changing session clears dialog and ignores stale preview/list/deletion responses', async t => {
  const h = await adminHarness(t)
  const loading = h.state.loadAllWalls()
  h.state.openWallDeletion(wallOne)
  h.state.wallDeletionPassword.value = 'secret'
  h.user.perms.global = []
  assert.equal(h.state.showWallDeletion.value, false)
  assert.equal(h.state.wallDeletionPassword.value, '')
  h.requests[0].resolve({ data: [wallOne] })
  h.requests[1].resolve({ data: preview() })
  await loading; await settle()
  assert.deepEqual(h.state.allWalls.value, [])
  assert.equal(h.state.wallDeletionPreview.value, null)
  const next = await adminHarness(t)
  await openPreview(next)
  confirm(next)
  const deletion = next.state.doDeleteWall()
  next.user.sessionRevision++
  next.deletes[0].resolve({ data: { deleted_wall_id: 1, warnings: [] } })
  await deletion
  assert.equal(next.wall.myWalls.length, 2, 'old session cannot mutate new account state')
  assert.equal(next.user.permissionRefreshes, 0)
  assert.equal(next.state.wallDeletionPassword.value, '')
})

test('successful deletion after Admin unmount still clears and refreshes same-session wall context without restoring focus', async t => {
  const h = await adminHarness(t)
  h.state.activePanel.value = 'allWalls'
  await openPreview(h)
  confirm(h)
  const deletion = h.state.doDeleteWall()
  h.disposeAdmin()
  h.deletes[0].resolve({ data: { warnings: ['附件文件本次保留，需在独立存储清理流程中核对'] } })
  await settle()
  assert.equal(h.wall.currentWallId, 2)
  assert.deepEqual(h.wall.myWalls.map(wall => wall.id), [2])
  assert.equal(h.user.permissionRefreshes, 1)
  assert.equal(h.wallRequests.length, 1, 'same-session wall refresh starts after route unmount')
  assert.equal(h.wall.lastWallDeletion, null, 'a route leave before success must not steal focus on a later visit')
  h.wallRequests[0].resolve({ data: [wallTwo] })
  await deletion
  assert.equal(h.requests.filter(request => request.path === '/walls/admin/all').length, 0, 'disposed component does not restart panel loading')
})

test('selected-wall deletion stores warnings before wall selection changes and consumes once per session', async t => {
  const h = await adminHarness(t)
  const changes = []
  const stop = Vue.watch(() => h.wall.currentWallId, id => {
    if (id === 2) changes.push(h.wall.lastWallDeletion?.wallId)
  }, { flush: 'sync' })
  h.wall.removeDeletedWall(1, { warnings: ['附件文件本次保留，需在独立存储清理流程中核对'], focusAllWalls: true })
  stop()
  assert.deepEqual(changes, [1], 'result must exist before currentWallId changes')
  assert.equal(h.wall.currentWallId, 2)
  assert.deepEqual(h.wall.consumeLastWallDeletion().warnings, ['附件文件本次保留，需在独立存储清理流程中核对'])
  assert.equal(h.wall.consumeLastWallDeletion(), null, 'the restoration marker is one-shot')
  h.wall.removeDeletedWall(2, { warnings: ['next session only'], focusAllWalls: true })
  h.user.sessionRevision++
  assert.equal(h.wall.consumeLastWallDeletion(), null, 'a stale session cannot consume prior deletion feedback')
  h.wall.removeDeletedWall(1, { warnings: ['reset me'], focusAllWalls: true })
  h.wall.reset()
  assert.equal(h.wall.lastWallDeletion, null, 'store reset clears in-memory deletion feedback')
})

test('removing a nonselected wall preserves selection and unrelated per-wall permissions', async t => {
  const h = await adminHarness(t)
  assert.equal(h.wall.removeDeletedWall(0), false)
  assert.equal(h.wall.removeDeletedWall(2), true)
  assert.equal(h.wall.currentWallId, 1)
  assert.deepEqual(h.user.perms.global, ['global.wall.manage'])
  assert.deepEqual(h.user.perms.walls[1], ['wall.edit'])
  assert.equal(h.user.perms.walls[2], undefined)
})

const chromium = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(path => path && existsSync(path))
async function browserDeletion(t, width) {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-deletion-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  const vueUrl = moduleUrl(await readFile(new URL('../node_modules/vue/dist/vue.runtime.esm-browser.prod.js', import.meta.url), 'utf8'))
  const focusSource = await readFile(new URL('../src/utils/focus.js', import.meta.url), 'utf8')
  const trapSource = await readFile(new URL('../src/composables/useFocusTrap.js', import.meta.url), 'utf8')
  let css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8')
  for (const style of parsed.descriptor.styles) {
    const compiled = compileStyle({ source: style.content, filename: 'Admin.vue', id: 'data-v-wall-deletion-test', scoped: style.scoped })
    assert.deepEqual(compiled.errors, [])
    css += compiled.code
  }
  const data = preview({ ...wallOne, name: '一所用于验证窄屏完整名称换行的校园墙名称以及附加文字' })
  const compiled = { script: script.content, template: template.code, focus: focusSource, trap: trapSource, id: 'data-v-wall-deletion-test' }
  const runner = 'import * as Vue from ' + JSON.stringify(vueUrl) + ';\n' +
    'try { const result = await (' + deletionBrowserCases.toString() + ')(Vue, ' + JSON.stringify(compiled) + ', ' + JSON.stringify(data) + '); parent.document.getElementById("results").textContent = JSON.stringify(result) } catch (error) { parent.document.getElementById("results").textContent = JSON.stringify({error: error.stack}) }'
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body><main style="max-width:900px;padding:16px;margin:auto"><div id="app"></div></main><script type="module" src="' + moduleUrl(runner) + '"></script></body></html>'
  const fixture = '<!doctype html><pre id="results"></pre><iframe style="width:' + width + 'px;height:640px;border:0" srcdoc="' + html.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>'
  const path = join(directory, 'fixture.html')
  await writeFile(path, fixture)
  const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=2000', pathToFileURL(path).href], { encoding: 'utf8', timeout: 20000, maxBuffer: 6 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const match = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(match, 'deletion browser checks must finish: ' + run.stderr + run.stdout.slice(-1200))
  const result = JSON.parse(match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  assert.equal(result.error, undefined, result.error)
  return result
}

async function deletionBrowserCases(Vue, compiled, data) {
  const empty = { render: () => null }
  const user = Vue.reactive({ token: 'test-session', sessionRevision: 0, user: { id: 1, role: 'user' }, perms: { global: ['global.wall.manage'], walls: {} },
    can(permission) { return this.perms.global.includes(permission) }, canInWall() { return false }, async fetchPermissions() {},
  })
  let available = [{ ...data.wall }]
  const wall = Vue.reactive({ currentWallId: data.wall.id, currentWall: data.wall, myWalls: [...available], loadError: '', canHere: () => false,
    removeDeletedWall(id) { this.myWalls = this.myWalls.filter(item => item.id !== id); this.currentWallId = null; this.currentWall = null },
    async fetchMyWalls() { this.myWalls = [...available] },
  })
  const deletions = []
  const api = { get: async path => ({ data: path.endsWith('deletion-preview') ? data : [...available] }),
    delete(path, options) { return new Promise((resolve, reject) => deletions.push({ path, options, resolve, reject })) },
  }
  const focusIfActive = new Function(compiled.focus.replace('export function', 'function') + '\nreturn focusIfActive')()
  const trapDeps = { ...Vue, focusIfActive }
  const useFocusTrap = new Function(...Object.keys(trapDeps), compiled.trap.replace(/^import[^\n]*\n/gm, '').replace('export function', 'function') + '\nreturn useFocusTrap')(...Object.values(trapDeps))
  const deps = { ...Vue, api, focusIfActive, useFocusTrap, useUserStore: () => user, useWallStore: () => wall, useRoute: () => ({ query: { panel: 'allWalls' } }),
    getApiErrorMessage: (error, fallback) => error.response?.data?.error || fallback, useToast: () => ({ error() {}, success() {}, warning() {} }),
    useMarkdown: () => ({}), Icon: empty, ConfirmModal: empty, defineAsyncComponent: () => empty,
  }
  const component = new Function(...Object.keys(deps), compiled.script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return'))(...Object.values(deps))
  const render = compiled.template.replace(/^import[^\n]*\n/gm, line => {
    const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
    return 'const {' + names + '} = Vue;\n'
  }).replace('export function render', 'return function render')
  component.render = new Function('Vue', render)(Vue)
  component.__scopeId = compiled.id
  const app = Vue.createApp(component)
  app.mount('#app')
  async function settle() { for (let index = 0; index < 8; index++) { await Vue.nextTick(); await Promise.resolve() } }
  await settle()
  const opener = document.querySelector('.wall-delete-trigger')
  opener.focus(); opener.click(); await settle()
  const first = document.querySelector('[aria-label="取消永久删除"]')
  const dialog = document.querySelector('.wall-delete-modal')
  const initialFocus = document.activeElement === first
  const labelledDialog = dialog.getAttribute('aria-labelledby') === 'wall-delete-title' && dialog.getAttribute('aria-describedby') === 'wall-delete-warning'
  function fill(selector, value) {
    const node = document.querySelector(selector)
    if (node.type === 'checkbox') { node.checked = value; node.dispatchEvent(new Event('change', { bubbles: true })) }
    else { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })) }
  }
  fill('#wall-delete-name', ' ' + data.wall.name)
  fill('#wall-delete-password', 'password')
  fill('.wall-delete-ack input', true)
  await settle()
  const submit = document.querySelector('.wall-delete-actions button[type="submit"]')
  const exactNameRequired = submit.disabled
  fill('#wall-delete-name', data.wall.name); await settle()
  const ready = !submit.disabled
  submit.focus()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  const tabWrapped = document.activeElement === first
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  const shiftTabWrapped = document.activeElement === submit
  opener.focus()
  const contained = dialog.contains(document.activeElement)
  const snapshots = []
  for (const light of [false, true]) {
    document.body.classList.toggle('light-theme', light)
    document.querySelector('#wall-delete-password').focus()
    const bounds = dialog.getBoundingClientRect()
    const actionBounds = submit.getBoundingClientRect()
    const passwordBounds = document.querySelector('#wall-delete-password').getBoundingClientRect()
    snapshots.push({ light, width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      dialog: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      submit: { top: actionBounds.top, bottom: actionBounds.bottom }, password: { top: passwordBounds.top, bottom: passwordBounds.bottom },
      scrollable: document.querySelector('.wall-delete-content').scrollHeight > document.querySelector('.wall-delete-content').clientHeight,
      controlHeights: [...dialog.querySelectorAll('button, input:not([type="checkbox"])')].map(node => node.getBoundingClientRect().height),
    })
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  const escapeClosed = !document.querySelector('.wall-delete-modal') && document.activeElement === opener
  opener.click(); await settle()
  const passwordClearedOnCancel = document.querySelector('#wall-delete-password').value === ''
  fill('#wall-delete-name', data.wall.name); fill('#wall-delete-password', 'wrong-password'); fill('.wall-delete-ack input', true); await settle()
  const form = document.querySelector('.wall-delete-modal')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  const busyLocked = deletions.length === 1 && Boolean(document.querySelector('.wall-delete-modal')) && document.querySelector('.wall-delete-actions button').disabled
  deletions[0].reject({ response: { status: 403, data: { error: '密码不正确' } } }); await settle()
  const retryable = document.querySelector('.wall-delete-error').textContent.includes('密码不正确') && document.querySelector('#wall-delete-password').value === ''
  fill('#wall-delete-password', 'correct-password'); await settle()
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
  available = []
  deletions[1].resolve({ data: { deleted_wall_id: data.wall.id, warnings: ['附件文件本次保留，需在独立存储清理流程中核对'] } }); await settle()
  const success = !document.querySelector('.wall-delete-modal') && wall.currentWallId === null && document.body.textContent.includes('暂无校园墙') && document.body.textContent.includes('附件文件本次保留，需在独立存储清理流程中核对')
  const successFocus = document.activeElement?.getAttribute('aria-label') === '全部校园墙管理'
  const requestBody = deletions[1].options.data
  app.unmount()
  return { initialFocus, labelledDialog, exactNameRequired, ready, tabWrapped, shiftTabWrapped, contained, snapshots, escapeClosed, passwordClearedOnCancel, busyLocked, retryable, success, successFocus, requestBody }
}
for (const width of [1280, 375, 320]) {
  test('real Chromium deletion dialog traps keyboard and fits ' + width + 'px in both themes', { skip: !chromium }, async t => {
    const result = await browserDeletion(t, width)
    for (const key of ['initialFocus', 'labelledDialog', 'exactNameRequired', 'ready', 'tabWrapped', 'shiftTabWrapped', 'contained', 'escapeClosed', 'passwordClearedOnCancel', 'busyLocked', 'retryable', 'success', 'successFocus']) assert.equal(result[key], true, key + ': ' + JSON.stringify(result))
    for (const snapshot of result.snapshots) {
      assert.ok(snapshot.documentWidth <= width, JSON.stringify(snapshot))
      assert.ok(snapshot.dialog.left >= 0 && snapshot.dialog.right <= width && snapshot.dialog.top >= 0 && snapshot.dialog.bottom <= snapshot.height, JSON.stringify(snapshot))
      assert.ok(snapshot.submit.top >= snapshot.dialog.top && snapshot.submit.bottom <= snapshot.dialog.bottom, JSON.stringify(snapshot))
      assert.ok(snapshot.password.top >= snapshot.dialog.top && snapshot.password.bottom <= snapshot.dialog.bottom, JSON.stringify(snapshot))
      assert.ok(snapshot.controlHeights.every(height => height >= 44), JSON.stringify(snapshot))
      assert.equal(snapshot.scrollable, true)
    }
    assert.equal(result.requestBody.password, 'correct-password')
    assert.equal(result.requestBody.confirm_name.startsWith(' '), false)
  })
}

async function browserShellDeletion(t, width) {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-shell-deletion-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  const vueUrl = moduleUrl(await readFile(new URL('../node_modules/vue/dist/vue.runtime.esm-browser.prod.js', import.meta.url), 'utf8'))
  const focus = (await readFile(new URL('../src/utils/focus.js', import.meta.url), 'utf8')).replace('export function focusIfActive', 'function focusIfActive') + '\nreturn focusIfActive'
  const components = {}
  for (const [name, path] of [['Admin', 'views/Admin.vue'], ['App', 'App.vue']]) {
    const { descriptor, errors } = parse(await readFile(new URL('../src/' + path, import.meta.url), 'utf8'))
    assert.deepEqual(errors, [])
    const id = 'data-v-shell-delete-' + name.toLowerCase()
    const script = compileScript(descriptor, { id })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    components[name] = { script: script.content, template: template.code, id }
  }
  const runner = 'import * as Vue from ' + JSON.stringify(vueUrl) + ';\n' +
    'try { const result = await (' + shellDeletionBrowserCases.toString() + ')(Vue, ' + JSON.stringify(components) + ', ' + JSON.stringify(focus) + '); parent.document.getElementById("results").textContent = JSON.stringify(result) } catch (error) { parent.document.getElementById("results").textContent = JSON.stringify({error:error.stack}) }'
  const page = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="' + moduleUrl(runner) + '"></script></body></html>'
  const fixture = '<!doctype html><pre id="results"></pre><iframe style="width:' + width + 'px;height:900px;border:0" srcdoc="' + page.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>'
  const path = join(directory, 'fixture.html')
  await writeFile(path, fixture)
  const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(path).href], { encoding: 'utf8', timeout: 25000, maxBuffer: 6 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const match = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(match, 'real App shell deletion scenario must finish: ' + run.stderr + run.stdout.slice(-1200))
  const result = JSON.parse(match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  assert.equal(result.error, undefined, result.error)
  return result
}

async function shellDeletionBrowserCases(Vue, compiled, focusSource) {
  const countKeys = ['members', 'wall_applications', 'ban_logs', 'posts', 'comments', 'likes', 'bookmarks', 'messages', 'announcements', 'votes', 'vote_options', 'vote_records', 'reports', 'post_reports', 'user_reports', 'user_permissions', 'attachments', 'deletable_attachments', 'retained_attachments']
  const wallOne = { id: 1, name: '真实壳删墙验证一', member_status: 'active', wall_role: 'owner', status: 'active' }
  const wallTwo = { id: 2, name: '真实壳删墙验证二', member_status: 'active', status: 'active' }
  const warnings = ['壳测试：附件文件本次保留，需在独立存储清理流程中核对']
  const shellCounts = Object.fromEntries(countKeys.map((key, index) => [key, index]))
  shellCounts.deletable_attachments = 0
  shellCounts.retained_attachments = shellCounts.attachments
  const previewData = { can_delete: true, wall: wallOne, counts: shellCounts, warnings: [], } 
  const empty = { render: () => null }
  const route = Vue.reactive({ path: '/admin', fullPath: '/admin?panel=allWalls', name: 'Admin', query: { panel: 'allWalls' } })
  let wallRefreshes = 0, permissionRefreshes = 0, adminMounts = 0, adminUnmounts = 0
  let remaining = [wallOne, wallTwo]
  const user = Vue.reactive({ token: 'shell-test-session', sessionRevision: 0, user: { id: 81, role: 'admin' }, perms: { global: ['global.wall.manage', 'global.dashboard'], walls: {} }, isLoggedIn: true,
    can(permission) { return this.perms.global.includes(permission) }, canInWall() { return false },
    async fetchUser() {}, async fetchPermissions() { permissionRefreshes++ },
  })
  const wall = Vue.reactive({ currentWallId: 1, currentWall: wallOne, myWalls: [wallOne, wallTwo], loaded: true, loadError: '', lastWallDeletion: null,
    canHere() { return false }, async fetchMyWalls() { wallRefreshes++; return this.myWalls },
    consumeLastWallDeletion() {
      const result = this.lastWallDeletion
      this.lastWallDeletion = null
      if (!result || result.sessionRevision !== user.sessionRevision || result.userId !== user.user.id) return null
      return result
    },
    removeDeletedWall(id, result) {
      this.lastWallDeletion = result?.focusAllWalls ? { wallId: id, warnings: result.warnings, focusAllWalls: true, sessionRevision: user.sessionRevision, userId: user.user.id } : null
      this.myWalls = this.myWalls.filter(item => item.id !== id)
      if (this.currentWallId === id) {
        this.currentWallId = this.myWalls[0]?.id ?? null
        this.currentWall = this.myWalls[0] ?? null
      }
      return true
    },
  })
  const settings = Vue.reactive({ themeModeInitialized: true, prefs: { theme_mode: 'dark', wallpaper_enabled: false, wallpaper_source: 'bing', unread_interval: '0' }, loadSettings: async () => {}, visibleNav: [] })
  const deletes = []
  const api = {
    get(path) {
      if (path.endsWith('/deletion-preview')) return Promise.resolve({ data: previewData })
      if (path === '/walls/admin/all') return Promise.resolve({ data: remaining })
      if (path === '/walls') return Promise.resolve({ data: wall.myWalls })
      return Promise.resolve({ data: {} })
    },
    delete(path, options) { return new Promise((resolve, reject) => deletes.push({ path, options, resolve, reject })) },
  }
  function component(name, bindings) {
    const item = compiled[name]
    const script = item.script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
    const instance = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
    const renderCode = item.template.replace(/^import[^\n]*\n/gm, line => {
      const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
      return 'const {' + names + '} = Vue;\n'
    }).replace('export function render', 'return function render')
    instance.render = new Function('Vue', renderCode)(Vue)
    instance.__scopeId = item.id
    return instance
  }
  const shared = { ...Vue, api, getApiErrorMessage: error => error?.response?.data?.error || '请求失败',
    useUserStore: () => user, useWallStore: () => wall, useSettingsStore: () => settings, useRoute: () => route,
    useToast: () => ({ error() {}, success() {}, warning() {} }), useMarkdown: () => ({ renderMarkdown: value => value, renderPlainText: value => value, truncateText: value => value }), useFocusTrap() {},
    readStorage: () => null, focusIfActive: new Function(focusSource)(), Icon: empty, ConfirmModal: empty,
    Navbar: empty, ToastContainer: empty, BackToTop: empty, PublishFab: empty,
    defineAsyncComponent: () => empty,
  }
  const Admin = component('Admin', { ...shared,
    onMounted(fn) { Vue.onMounted(() => { adminMounts++; fn() }) },
    onBeforeUnmount(fn) { Vue.onBeforeUnmount(() => { adminUnmounts++; fn() }) },
  })
  const App = component('App', { ...shared, Navbar: empty })
  const app = Vue.createApp(App)
  app.component('router-view', { setup(_props, { slots }) { return () => slots.default({ Component: Admin, route }) } })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  app.mount('#app')
  async function settle() { for (let index = 0; index < 16; index++) { await Vue.nextTick(); await Promise.resolve() } }
  await settle()
  const opener = document.querySelector('.wall-delete-trigger')
  if (!opener) throw new Error('initial Admin allWalls panel did not render')
  opener.click(); await settle()
  const name = document.querySelector('#wall-delete-name')
  const password = document.querySelector('#wall-delete-password')
  const ack = document.querySelector('.wall-delete-ack input')
  name.value = wallOne.name; name.dispatchEvent(new Event('input', { bubbles: true }))
  password.value = 'shell-only-secret'; password.dispatchEvent(new Event('input', { bubbles: true }))
  ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  const form = document.querySelector('.wall-delete-modal')
  const submit = form?.querySelector('button[type="submit"]')
  if (!submit || submit.disabled) throw new Error('valid deletion confirmation did not enable submit')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  if (deletes.length !== 1) throw new Error('expected one permanent deletion request')
  const requestBody = deletes[0].options.data
  remaining = [wallTwo]
  deletes[0].resolve({ data: { warnings } })
  await settle()
  const warningVisible = [...document.querySelectorAll('.wall-delete-warning')].some(node => node.textContent.includes(warnings[0]))
  const focusRestored = document.activeElement?.getAttribute('aria-label') === '全部校园墙管理'
  const result = { width: innerWidth, wallId: wall.currentWallId, warningVisible, focusRestored, adminMounts, adminUnmounts,
    wallRefreshes, permissionRefreshes, requestBody, resultAfterRestore: wall.lastWallDeletion }
  app.unmount()
  return result
}

for (const width of [375, 1280]) {
  test('real App keep-alive shell restores delete warning and focus after selected-wall removal at ' + width + 'px', { skip: !chromium }, async t => {
    const result = await browserShellDeletion(t, width)
    assert.equal(result.wallId, 2, JSON.stringify(result))
    assert.equal(result.warningVisible, true, JSON.stringify(result))
    assert.equal(result.focusRestored, true, JSON.stringify(result))
    assert.ok(result.adminMounts >= 2 && result.adminUnmounts >= 1, JSON.stringify(result))
    assert.ok(result.wallRefreshes >= 2 && result.permissionRefreshes >= 1, JSON.stringify(result))
    assert.equal(result.requestBody.confirm_name, '真实壳删墙验证一')
    assert.equal(result.requestBody.password, 'shell-only-secret')
    assert.equal(result.resultAfterRestore, null, 'the restored result is consumed exactly once')
  })
}
