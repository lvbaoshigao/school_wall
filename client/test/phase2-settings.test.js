import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia, defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed, reactive, watch, nextTick, onScopeDispose, effectScope } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { SETTINGS_SECTIONS, buildSettingsCatalog, resolveSettingsSection, searchSettings } from '../src/components/settings/catalog.js'

const require = createRequire(import.meta.url)
const serverPrefs = require('../../server/lib/prefs.js')
const root = new URL('../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await nextTick() }
function fixture(options = {}) {
  let token = options.token ?? 'account-a'
  const storage = new Map(Object.entries(options.local || {}))
  const listeners = []
  const calls = []
  const api = {
    get: async path => { calls.push({ method: 'get', path }); return { data: { prefs: {} } } },
    put: async (path, body) => { calls.push({ method: 'put', path, body }); return { data: { prefs: body.prefs } } },
    post: async (path, body) => { calls.push({ method: 'post', path, body }); return { data: {} } },
  }
  const user = reactive({ isLoggedIn: !!token, sessionRevision: 0, user: { id: 1, real_name: '', allow_search_by_id: 1, allow_search_by_username: 1, allow_search_by_nickname: 1, allow_search_by_real_name: 0, allow_discover: 1 }, async updateProfile(data) { calls.push({ method: 'profile', body: data }); Object.assign(user.user, data) }, logout() { changeSession('') } })
  const useUserStore = () => user
  const wall = { canHere: () => false }
  const bindings = { defineStore, acceptHMRUpdate, ref, computed, onScopeDispose, api, readStorage: key => storage.get(key) ?? null, writeStorage: (key, value) => { if (value == null) storage.delete(key); else storage.set(key, String(value)) }, useUserStore, useWallStore: () => wall, getSessionToken: () => token, subscribeSessionChange: fn => { listeners.push(fn); return () => {} }, getApiErrorMessage: (error, fallback) => error.response?.data?.error || error.message || fallback }
  const code = source('src/stores/settings.js').replace(/^import .*$/gm, '').replace(/export (const|function) /g, '$1 ').replaceAll('import.meta.hot', 'false')
  const exported = new Function(...Object.keys(bindings), code + '\nreturn { useSettingsStore, PREF_SCHEMA, PREFERENCE_SCHEMA, NAV_ITEMS, PREFERENCE_GROUPS, preferenceDefaults, validatePreferencePatch, parsePreferenceImport }')(...Object.values(bindings))
  setActivePinia(createPinia())
  const store = exported.useSettingsStore()
  function changeSession(nextToken, resetContext = true) { const previousToken = token; token = nextToken; user.isLoggedIn = !!nextToken; if (resetContext) user.sessionRevision++; listeners.forEach(fn => fn({ token, previousToken, resetContext })) }
  return { ...exported, store, api, calls, user, wall, storage, changeSession }
}
function mountPage(f, query = {}, hash = '') {
  const scope = effectScope()
  const route = reactive({ query, hash })
  const router = { replace: async next => { route.query = { ...next.query }; route.hash = next.hash || '' }, push: async () => {} }
  const toast = { success() {}, error() {}, info() {} }
  const code = parse(source('src/views/Settings.vue')).descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
  const bindings = { ref, inject: () => ({ current: ref('light') }), computed, watch, nextTick, onMounted: () => {}, onUnmounted: () => {}, useRoute: () => route, useRouter: () => router, useSettingsStore: () => f.store, NAV_ITEMS: f.NAV_ITEMS, PREFERENCE_GROUPS: f.PREFERENCE_GROUPS, parsePreferenceImport: f.parsePreferenceImport, useWallStore: () => f.wall, useUserStore: () => f.user, useToast: () => toast, SETTINGS_SECTIONS, buildSettingsCatalog, resolveSettingsSection, searchSettings, api: f.api, getApiErrorMessage: (error, fallback) => error.message || fallback, writeStorage: () => {} }
  const page = scope.run(() => new Function(...Object.keys(bindings), code + '\nreturn { activeSection, search, results, resultCount, visibleGroups, currentSection, searchInput, sectionHeading, chooseSection, clearSearch, saveSetting, retryOperation, accountError, actionError, readImport, pendingImport, confirmation, confirmAction, resetScope, askReset, importPreview, valueFor, disabledReason, scopeLabels }')(...Object.values(bindings)))
  return { page, route, stop: () => scope.stop() }
}

const envelope = prefs => JSON.stringify({ format: 'school-wall-preferences', version: 1, prefs })

test('front and server schemas have identical 39 keys defaults values and reset scopes', () => {
  const f = fixture()
  assert.equal(Object.keys(f.PREFERENCE_SCHEMA).length, 39)
  assert.deepEqual(Object.keys(f.PREFERENCE_SCHEMA).sort(), Object.keys(serverPrefs.PREF_SCHEMA).sort())
  for (const [key, spec] of Object.entries(f.PREFERENCE_SCHEMA)) {
    assert.equal(spec.def, serverPrefs.PREF_SCHEMA[key].def, key)
    assert.equal(spec.type, serverPrefs.PREF_SCHEMA[key].type, key)
    if (spec.values) assert.deepEqual(spec.values, serverPrefs.PREF_SCHEMA[key].values, key)
  }
  for (const [scope, keys] of Object.entries(serverPrefs.PREF_SCOPES)) assert.deepEqual(Object.keys(f.preferenceDefaults(scope)).sort(), [...keys].sort(), scope)
})

test('catalog covers seven categories and every editable preference exactly once', () => {
  const f = fixture(); const items = buildSettingsCatalog(f.NAV_ITEMS)
  assert.equal(SETTINGS_SECTIONS.length, 7)
  const preferenceKeys = items.filter(item => item.type !== 'action' && item.source !== 'privacy').map(item => item.key)
  assert.equal(new Set(preferenceKeys).size, 39)
  assert.deepEqual(preferenceKeys.sort(), Object.keys(f.PREFERENCE_SCHEMA).sort())
  assert.ok(SETTINGS_SECTIONS.every(section => items.some(item => item.section === section.id)))
})

test('search matches category labels descriptions and choice labels across categories', () => {
  const f = fixture(); const items = buildSettingsCatalog(f.NAV_ITEMS)
  assert.deepEqual(searchSettings(items, '聊天  频率').map(item => item.key), ['chat_poll_interval'])
  assert.ok(searchSettings(items, 'MARKDOWN').some(item => item.key === 'default_markdown'))
  assert.deepEqual(searchSettings(items, 'Ctrl').map(item => item.key), ['chat_send_shortcut'])
  assert.equal(searchSettings(items, '').length, items.length)
  assert.equal(searchSettings(items, '不存在的项目xyz').length, 0)
  assert.equal(searchSettings(items, ['chat']).length, items.length)
})

test('only allowlisted query and decoded hash select a category', () => {
  assert.equal(resolveSettingsSection('chat', '#appearance'), 'chat')
  assert.equal(resolveSettingsSection(['chat'], '#settings-appearance'), 'appearance')
  assert.equal(resolveSettingsSection(undefined, '#%63hat'), 'chat')
  assert.equal(resolveSettingsSection('__proto__', '#%E0%A4%A'), 'account')
  assert.equal(resolveSettingsSection('https://evil.invalid', '#%3Cscript%3E'), 'account')
})

test('page navigation clears search and updates safe section without reload', async () => {
  const f = fixture(); const m = mountPage(f, { section: 'chat', q: 'Enter' })
  try {
    assert.equal(m.page.activeSection.value, 'chat'); assert.equal(m.page.resultCount.value, 1)
    await m.page.chooseSection('appearance')
    assert.equal(m.page.search.value, ''); assert.equal(m.route.query.section, 'appearance')
    assert.equal(m.page.visibleGroups.value.length, 1); assert.equal(m.page.visibleGroups.value[0].id, 'appearance')
    await m.page.chooseSection('javascript:bad'); assert.equal(m.route.query.section, 'appearance')
    m.page.search.value = '不存在的设置xyz'; assert.equal(m.page.visibleGroups.value.length, 0)
    let focused = false; m.page.searchInput.value = { focus: () => { focused = true } }
    m.page.clearSearch(); await nextTick(); assert.equal(focused, true); assert.equal(m.page.search.value, '')
  } finally { m.stop() }
})

test('bulk saves expose saving and saved states with one request', async () => {
  const f = fixture(); let resolve
  f.api.put = (path, body) => new Promise(done => { f.calls.push({ path, body }); resolve = done })
  const request = f.store.setPrefs({ chat_density: 'compact', chat_show_timestamps: false })
  assert.equal(f.store.saving, true); assert.equal(f.store.saveStatus, 'saving')
  await tick(); assert.equal(f.store.prefs.chat_density, 'compact')
  resolve({ data: { prefs: { chat_density: 'compact', chat_show_timestamps: false } } })
  assert.equal(await request, true); assert.equal(f.calls.length, 1); assert.equal(f.store.saving, false); assert.equal(f.store.saveStatus, 'saved'); assert.ok(f.store.lastSavedAt)
})

test('bulk failures atomically restore changed fields and report error', async () => {
  const f = fixture(); f.api.put = async () => { throw new Error('网络不可用') }
  assert.equal(await f.store.setPrefs({ chat_density: 'compact', accent: 'rose', home: false }), false)
  assert.equal(f.store.prefs.chat_density, 'comfortable'); assert.equal(f.store.prefs.accent, 'teal'); assert.equal(f.store.nav.home, true)
  assert.equal(f.store.saveStatus, 'error'); assert.equal(f.store.saving, false); assert.match(f.store.saveError, /网络/)
})

test('strict bulk validation rejects token privacy inherited names and coercion without requests', async () => {
  const f = fixture()
  for (const input of [{ token: 'secret' }, { allow_discover: true }, { chat_show_timestamps: 'false' }, { chat_poll_interval: 20 }, { theme_mode: 'purple' }, JSON.parse('{"__proto__":{"polluted":true}}'), [], {}]) assert.equal(await f.store.setPrefs(input), false)
  assert.equal(f.calls.length, 0); assert.equal({}.polluted, undefined)
})

test('queued saves preserve ordering and retry after a failed predecessor', async () => {
  const f = fixture(); const values = []
  f.api.put = async (path, body) => { values.push(body.prefs.chat_density); if (values.length === 1) throw new Error('first failed'); return { data: { prefs: body.prefs } } }
  const first = f.store.setPref('chat_density', 'compact'); const second = f.store.setPref('chat_density', 'comfortable')
  assert.equal(await first, false); assert.equal(await second, true)
  assert.deepEqual(values, ['compact', 'comfortable']); assert.equal(f.store.saveStatus, 'saved'); assert.equal(f.store.prefs.chat_density, 'comfortable')
})

test('load and save share a queue so late loading cannot overwrite a newer edit', async () => {
  const f = fixture(); let resolve
  f.api.get = () => new Promise(done => { resolve = done })
  const load = f.store.loadSettings(); await tick()
  const save = f.store.setPref('chat_density', 'compact')
  assert.equal(f.store.prefs.chat_density, 'comfortable')
  resolve({ data: { prefs: { chat_density: 'comfortable' } } })
  assert.equal(await load, true); assert.equal(await save, true); assert.equal(f.store.prefs.chat_density, 'compact')
})

test('logout discards queued and late saves and clears all save feedback', async () => {
  const f = fixture(); let resolve; let count = 0
  f.api.put = () => { count++; return new Promise(done => { resolve = done }) }
  const first = f.store.setPref('chat_density', 'compact'); const second = f.store.setPref('theme_mode', 'dark')
  await tick(); f.changeSession('account-b')
  resolve({ data: { prefs: { chat_density: 'compact' } } })
  assert.equal(await first, false); assert.equal(await second, false)
  assert.equal(count, 1); assert.equal(f.store.prefs.chat_density, 'comfortable'); assert.equal(f.store.prefs.theme_mode, 'system'); assert.equal(f.store.saveStatus, 'idle'); assert.equal(f.store.saving, false)
})

test('same-account token rotation keeps queued saves usable and never leaves saving stuck', async () => {
  const f = fixture()
  const request = f.store.setPref('chat_show_timestamps', false)
  f.changeSession('rotated', false)
  assert.equal(await request, true); assert.equal(f.store.prefs.chat_show_timestamps, false); assert.equal(f.store.saving, false)
})

test('reading reset uses scope API and excludes publishing and account privacy', async () => {
  const f = fixture(); f.store.prefs.default_anonymous_post = true; f.store.prefs.feed_sort = 'hot'; f.user.user.allow_discover = 0
  assert.equal(await f.store.resetPreferences('reading'), true)
  assert.deepEqual(f.calls[0], { method: 'post', path: '/auth/prefs/reset', body: { scope: 'reading' } })
  assert.equal(f.store.prefs.feed_sort, 'latest'); assert.equal(f.store.prefs.default_anonymous_post, true); assert.equal(f.user.user.allow_discover, 0)
})

test('reset fallback only handles missing legacy endpoint and writes selected scope', async () => {
  const f = fixture(); f.api.post = async () => { throw { response: { status: 404 } } }
  assert.equal(await f.store.resetPreferences('chat'), true)
  assert.deepEqual(Object.keys(f.calls[0].body.prefs).sort(), Object.keys(f.preferenceDefaults('chat')).sort())
  f.calls.length = 0; f.api.post = async () => { throw { response: { status: 500 }, message: 'server failed' } }
  assert.equal(await f.store.resetPreferences('all'), false); assert.equal(f.calls.length, 0)
  assert.equal(await f.store.resetPreferences('account'), false)
})

test('preference import strictly rejects malformed envelopes and sensitive or invalid fields', () => {
  const f = fixture()
  for (const text of ['{bad', JSON.stringify({ format: 'other', version: 1, prefs: { home: false } }), JSON.stringify({ format: 'school-wall-preferences', version: 2, prefs: { home: false } }), JSON.stringify({ format: 'school-wall-preferences', version: 1, token: 'secret', prefs: { home: false } }), envelope({ token: 'secret' }), envelope({ allow_search_by_id: false }), envelope({ chat_show_timestamps: 0 }), envelope({ chat_poll_interval: '5' }), envelope([]), envelope({}), ' '.repeat(65537)]) assert.throws(() => f.parsePreferenceImport(text))
})

test('export contains only allowlisted values and valid import uses one bulk save', async () => {
  const f = fixture(); f.user.user.token = 'do-not-export'
  const exported = f.store.exportPreferences()
  assert.equal(Object.keys(exported.prefs).length, 39); assert.equal(JSON.stringify(exported).includes('do-not-export'), false); assert.equal('allow_discover' in exported.prefs, false)
  assert.equal(await f.store.importPreferences(envelope({ theme_mode: 'dark', chat_poll_interval: '60' })), true)
  assert.equal(f.calls.length, 1); assert.equal(f.store.prefs.theme_mode, 'dark'); assert.equal(f.store.prefs.chat_poll_interval, '60')
})

test('import UI validates and previews before confirmed persistence', async () => {
  const f = fixture(); const m = mountPage(f, { section: 'data' })
  try {
    const input = { files: [{ size: 100, text: async () => envelope({ chat_density: 'compact' }) }], value: 'file.json' }
    await m.page.readImport({ target: input })
    assert.equal(f.calls.length, 0); assert.equal(input.value, ''); assert.equal(m.page.confirmation.value.kind, 'import')
    assert.equal(m.page.importPreview.value[0].name, '聊天消息密度')
    await m.page.confirmAction(); assert.equal(f.calls.length, 1); assert.equal(f.store.prefs.chat_density, 'compact')
    await m.page.readImport({ target: { files: [{ size: 65537, text: async () => envelope({ home: true }) }], value: '' } })
    assert.match(m.page.actionError.value, /64KB/); assert.equal(f.calls.length, 1)
  } finally { m.stop() }
})

test('privacy field failure can be retried without entering bulk preference reset data', async () => {
  const f = fixture(); const m = mountPage(f)
  try {
    const item = buildSettingsCatalog(f.NAV_ITEMS).find(item => item.key === 'allow_discover')
    f.user.updateProfile = async () => { throw new Error('network failed') }
    await m.page.saveSetting(item, false); assert.match(m.page.accountError.value, /network/); assert.equal(f.user.user.allow_discover, 1)
    f.user.updateProfile = async data => { Object.assign(f.user.user, data) }
    await m.page.retryOperation.value(); assert.equal(f.user.user.allow_discover, 0); assert.equal(m.page.retryOperation.value, null)
    assert.equal(m.page.disabledReason({ key: 'allow_search_by_real_name', source: 'privacy' }).includes('真实姓名'), true)
    assert.equal('allow_discover' in f.preferenceDefaults('all'), false)
  } finally { m.stop() }
})

test('new settings components and view compile to native interactive templates', () => {
  for (const filename of ['src/views/Settings.vue', 'src/components/settings/SettingControl.vue']) {
    const { descriptor, errors } = parse(source(filename), { filename }); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ source: descriptor.template.content, filename, id: filename, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [], filename)
  }
})

test('guest theme initializes from local mode and persists without authenticated requests', async () => {
  const f = fixture({ token: '', local: { theme: 'dark' } })
  assert.equal(f.store.prefs.theme_mode, 'dark'); assert.equal(f.store.themeModeInitialized, true)
  assert.equal(await f.store.setThemeMode('light'), true); assert.equal(f.store.prefs.theme_mode, 'light'); assert.equal(f.storage.get('theme_mode'), 'light'); assert.equal(f.calls.length, 0)
  assert.equal(await f.store.setPref('theme_mode', 'system'), true); assert.equal(f.storage.get('theme_mode'), 'system'); assert.equal(f.calls.length, 0)
  assert.equal(await f.store.setThemeMode('invalid'), false)
})

test('legacy theme migrates once only when server explicitly marks theme as unstored', async () => {
  const f = fixture({ local: { theme: 'dark' } })
  f.api.get = async () => ({ data: { prefs: { theme_mode: 'system' }, storedKeys: [] } })
  assert.equal(await f.store.loadSettings(), true); assert.equal(f.store.prefs.theme_mode, 'dark'); assert.equal(f.store.themeModeInitialized, true)
  assert.deepEqual(f.calls[0], { method: 'put', path: '/auth/prefs', body: { prefs: { theme_mode: 'dark' } } })
  f.api.get = async () => ({ data: { prefs: { theme_mode: 'dark' }, storedKeys: ['theme_mode'] } })
  await f.store.loadSettings(); assert.equal(f.calls.length, 1)
})

test('explicit server system choice wins over legacy local dark and metadata absence never guesses', async () => {
  for (const data of [{ prefs: { theme_mode: 'system' }, storedKeys: ['theme_mode'] }, { prefs: { theme_mode: 'system' } }]) {
    const f = fixture({ local: { theme: 'dark' } }); f.api.get = async () => ({ data })
    await f.store.loadSettings(); assert.equal(f.store.prefs.theme_mode, 'system'); assert.equal(f.calls.length, 0); assert.equal(f.storage.get('theme_mode'), 'system')
  }
})

test('failed server theme change restores locally persisted mode and keeps current-account readiness', async () => {
  const f = fixture({ local: { theme_mode: 'light' } }); f.api.put = async () => { throw new Error('offline') }
  assert.equal(await f.store.setThemeMode('dark'), false); assert.equal(f.store.prefs.theme_mode, 'light'); assert.equal(f.storage.get('theme_mode'), 'light'); assert.equal(f.store.themeModeInitialized, true)
})

