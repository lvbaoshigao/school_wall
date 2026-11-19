import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed, reactive, watch, nextTick, effectScope } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const source = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
const flush = async () => { await nextTick(); await nextTick(); await nextTick() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function setup({ storage = {}, initialized = true, mode = 'system', wallpaper = false, viewport = true } = {}) {
  const mounted = [], cleanup = [], provided = new Map(), values = new Map(), events = new Map(), frames = new Map(), calls = [], notices = []
  let nextFrame = 0, editing = false
  const listen = (prefix, name, callback) => events.set(prefix + name, callback)
  const unlisten = (prefix, name) => events.delete(prefix + name)
  const classes = new Set()
  const root = { dataset: {}, style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) } }
  const document = { documentElement: root, activeElement: { matches: () => editing }, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, querySelector: () => ({ setAttribute() {} }), addEventListener: (name, callback) => listen('document:', name, callback), removeEventListener: name => unlisten('document:', name) }
  const media = { matches: false, addEventListener: (name, callback) => listen('media:', name, callback), removeEventListener: name => unlisten('media:', name) }
  const visualViewport = { height: 812, width: 390, offsetTop: 0, scale: 1, addEventListener: (name, callback) => listen('viewport:', name, callback), removeEventListener: name => unlisten('viewport:', name) }
  const window = { innerHeight: 812, innerWidth: 390, visualViewport: viewport ? visualViewport : undefined, matchMedia: () => media, location: { origin: 'http://localhost' }, addEventListener: (name, callback) => listen('window:', name, callback), removeEventListener: name => unlisten('window:', name), requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame }, cancelAnimationFrame: id => frames.delete(id) }
  const route = reactive({ name: 'Home', path: '/', params: {}, query: {} })
  const user = reactive({ isLoggedIn: false, token: '', sessionRevision: 1, user: { id: 1 } })
  const wall = reactive({ currentWallId: 1, fetchMyWalls: async () => true })
  const settings = reactive({ themeModeInitialized: initialized, prefs: { theme_mode: mode, wallpaper_enabled: wallpaper }, async setThemeMode(value) { calls.push(['saveTheme', value]); settings.prefs.theme_mode = value; settings.themeModeInitialized = true; return true }, loadSettings: async () => true })
  const api = { get: path => { const request = deferred(); calls.push(['get', path, request]); return request.promise } }
  const env = { ref, computed, reactive, watch, nextTick, onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => cleanup.push(callback), provide: (key, value) => provided.set(key, value), useRoute: () => route, useUserStore: () => user, useWallStore: () => wall, useSettingsStore: () => settings, useToast: () => ({ error: value => notices.push(value) }), readStorage: key => storage[key] ?? null, api, window, document, URL, getComputedStyle: () => ({ getPropertyValue: () => classes.has('light-theme') ? '#f1f5f0' : '#142521' }) }
  const scope = effectScope()
  const script = parse(source('App.vue')).descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
  const state = scope.run(() => new Function(...Object.keys(env), script + '\nreturn { currentTheme, themeMode, setThemeMode, toggleTheme, themeSaving, wallpaperEnabled, wallpaperUrl, getRandomWallpaper, updateViewport, scheduleViewport, cacheScope, isConversationLayout, isSettingsLayout }')(...Object.values(env)))
  return { ...state, settings, user, wall, route, root, classes, values, events, frames, window, visualViewport, media, calls, notices, provided, mounted, setEditing: value => { editing = value }, dispose() { cleanup.forEach(callback => callback()); scope.stop() } }
}

test('phase2 preserves legacy explicit theme while preference source initializes and follows live system changes', async () => {
  const state = setup({ initialized: false, storage: { theme: 'dark' } })
  try {
    assert.equal(state.currentTheme.value, 'dark')
    assert.equal(state.calls.length, 0, 'initialization never writes preferences')
    assert.equal(state.provided.get('theme').current, state.currentTheme)
    assert.equal(state.provided.get('theme').mode, state.themeMode)
    assert.equal(state.provided.get('theme').setMode, state.setThemeMode)
    state.settings.themeModeInitialized = true; await flush()
    assert.equal(state.currentTheme.value, 'light', 'explicit server system mode takes precedence after initialization')
    await state.mounted[0]()
    state.events.get('media:change')({ matches: true }); await flush()
    assert.equal(state.currentTheme.value, 'dark')
    state.settings.prefs.theme_mode = 'light'; await flush()
    state.events.get('media:change')({ matches: true }); await flush()
    assert.equal(state.currentTheme.value, 'light', 'manual mode ignores system changes')
  } finally { state.dispose() }
})

test('phase2 local theme_mode outranks legacy theme and all switching uses settings store', async () => {
  const state = setup({ initialized: false, storage: { theme_mode: 'system', theme: 'dark' } })
  try {
    assert.equal(state.currentTheme.value, 'light')
    assert.equal(await state.setThemeMode('invalid'), false)
    assert.equal(state.calls.length, 0)
    assert.equal(await state.toggleTheme(), true); await flush()
    assert.deepEqual(state.calls[0], ['saveTheme', 'dark'])
    assert.equal(state.currentTheme.value, 'dark')
    await state.setThemeMode('system'); await flush()
    assert.equal(state.currentTheme.value, 'light')
  } finally { state.dispose() }
})

test('phase2 concurrent theme switching is locked and failed store save remains observable', async () => {
  const state = setup()
  try {
    const pending = deferred()
    state.settings.setThemeMode = () => pending.promise
    const first = state.setThemeMode('dark')
    assert.equal(state.themeSaving.value, true)
    assert.equal(await state.setThemeMode('light'), false)
    pending.resolve(false)
    assert.equal(await first, false)
    assert.equal(state.themeSaving.value, false)
    assert.equal(state.notices.length, 1)
  } finally { state.dispose() }
})

test('phase2 wallpaper disabled prevents requests and rejects stale enabled response', async () => {
  const state = setup()
  try {
    await state.mounted[0]()
    assert.equal(state.calls.length, 0)
    state.settings.prefs.wallpaper_enabled = true; await flush()
    assert.equal(state.calls[0][1], '/wallpaper')
    state.settings.prefs.wallpaper_enabled = false; await flush()
    state.calls[0][2].resolve({ data: { url: '/wallpapers/test.jpg' } }); await flush()
    assert.equal(state.wallpaperUrl.value, '')
    assert.equal(state.wallpaperEnabled.value, false)
  } finally { state.dispose() }
})

test('phase2 measured viewport distinguishes keyboard occlusion from pinch zoom and cleans listeners', async () => {
  const state = setup()
  await state.mounted[0]()
  assert.equal(state.values.get('--visual-viewport-height'), '812px')
  state.setEditing(true)
  Object.assign(state.visualViewport, { height: 390, width: 390, offsetTop: 40 })
  state.updateViewport()
  assert.equal(state.values.get('--keyboard-inset-bottom'), '382px')
  assert.equal(state.root.dataset.keyboardOpen, 'on')
  state.visualViewport.scale = 2; state.updateViewport()
  assert.equal(state.values.get('--keyboard-inset-bottom'), '0px')
  assert.equal(state.root.dataset.keyboardOpen, 'off')
  state.scheduleViewport(); state.scheduleViewport()
  assert.equal(state.frames.size, 1, 'viewport updates batch into one frame')
  state.dispose()
  assert.equal(state.events.size, 0)
  assert.equal(state.frames.size, 0)
  assert.equal(state.values.size, 0)
})

test('phase2 fallback viewport and account/wall cache scope preserve isolation', async () => {
  const state = setup({ viewport: false })
  try {
    await state.mounted[0]()
    assert.equal(state.values.get('--visual-viewport-height'), '812px')
    const original = state.cacheScope.value
    state.route.params.id = '2'; await flush()
    assert.equal(state.cacheScope.value, original, 'ordinary route changes retain same session cache')
    state.wall.currentWallId = 2
    assert.notEqual(state.cacheScope.value, original)
    state.route.name = 'ChatRoom'; await flush()
    assert.equal(state.isConversationLayout.value, true)
    assert.equal(state.root.dataset.appLayout, 'conversation')
    state.user.sessionRevision++
    assert.match(state.cacheScope.value, /^2:/)
  } finally { state.dispose() }
})

test('phase2 responsive SFC scripts and templates compile', () => {
  for (const name of ['App.vue', 'components/Navbar.vue', 'components/PublishFab.vue', 'views/Home.vue', 'views/PostDetail.vue', 'views/Votes.vue']) {
    const { descriptor, errors } = parse(source(name)); assert.deepEqual(errors, [], name)
    const script = compileScript(descriptor, { id: name })
    const template = compileTemplate({ source: descriptor.template.content, filename: name, id: name, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [], name)
  }
})
