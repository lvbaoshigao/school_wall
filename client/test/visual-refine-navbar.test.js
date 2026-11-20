import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, ref, reactive, watch, effectScope } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const settingsSource = readFileSync(new URL('../src/stores/settings.js', import.meta.url), 'utf8')
const navStart = settingsSource.indexOf('export const NAV_ITEMS = [')
const navEnd = settingsSource.indexOf('\n]', navStart) + 2
const NAV_ITEMS = new Function(settingsSource.slice(navStart, navEnd).replace('export ', '') + '; return NAV_ITEMS')()

const source = readFileSync(new URL('../src/components/Navbar.vue', import.meta.url), 'utf8')
function setup() {
  const scope = effectScope(), cleanups = []
  const settings = reactive({ visibleNav: NAV_ITEMS.map(item => ({ ...item })), nav: { search: true }, tools: {}, prefs: {} })
  const route = reactive({ path: '/', fullPath: '/', name: 'Home' })
  const environment = {
    computed, ref, watch,
    onMounted() {}, onUnmounted: callback => cleanups.push(callback),
    defineProps: () => ({ theme: 'light' }), defineEmits: () => () => {},
    useUserStore: () => ({ isLoggedIn: true, user: { id: 1 }, can: () => false }),
    useWallStore: () => ({ myWalls: [], canHere: () => false }),
    useSettingsStore: () => settings,
    useRouter: () => ({ currentRoute: { value: route }, push() {} }),
    useMarkdown: () => ({}), useToast: () => ({}), useFocusTrap() {},
    api: {}, clearInterval() {}, setInterval() {},
  }
  const script = parse(source).descriptor.scriptSetup.content.split(String.fromCharCode(10)).filter(line => !line.startsWith('import ')).join(String.fromCharCode(10))
  const state = scope.run(() => new Function(...Object.keys(environment), script + String.fromCharCode(10) + 'return { primaryNav, secondaryNav, moreActive, toggleNavMenu, onNavKeydown, disableLeavingPanel, showMenu, showWallMenu, showMobileMenu, openDropdown, showSearchMenu }')(...Object.values(environment)))
  return { ...state, settings, route, dispose() { scope.stop() } }
}

test('refined navbar compiles all transition-wrapped disclosures', () => {
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'navbar-refine' })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'Navbar.vue', id: 'navbar-refine', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  assert.equal(descriptor.template.content.split('<Transition name="nav-scale"').length - 1, 6)
})

test('fully enabled navigation partitions destinations without dropping or duplicating them', () => {
  const state = setup()
  try {
    assert.deepEqual(state.primaryNav.value.map(item => item.key), ['home', 'publish', 'chat', 'inbox'])
    assert.deepEqual(state.secondaryNav.value.map(item => item.key), ['votes', 'treehole', 'bookmarks', 'help'])
    const groups = [...state.primaryNav.value, ...state.secondaryNav.value].map(item => item.key)
    assert.equal(new Set(groups).size, groups.length)
    assert.deepEqual([...groups].sort(), NAV_ITEMS.filter(item => item.type !== 'search').map(item => item.key).sort())
    state.settings.visibleNav = NAV_ITEMS.filter(item => item.key === 'help' || item.key === 'inbox')
    assert.deepEqual(state.primaryNav.value.map(item => item.key), ['inbox'])
    assert.deepEqual(state.secondaryNav.value.map(item => item.key), ['help'])
  } finally { state.dispose() }
})

test('More state identifies nested auxiliary destinations and preserves core current state', () => {
  const state = setup()
  try {
    assert.equal(state.moreActive.value, false)
    state.route.path = '/help/report'; assert.equal(state.moreActive.value, true)
    state.route.path = '/bookmarks'; assert.equal(state.moreActive.value, true)
    state.route.path = '/chat/2'; assert.equal(state.moreActive.value, false)
  } finally { state.dispose() }
})

test('opening More closes other disclosures and retains Escape and ArrowDown behavior', () => {
  const state = setup()
  try {
    state.showWallMenu.value = true; state.showMenu.value = true; state.showSearchMenu.value = true
    state.toggleNavMenu('more')
    assert.equal(state.openDropdown.value, 'more')
    assert.equal(state.showWallMenu.value, false); assert.equal(state.showMenu.value, false); assert.equal(state.showSearchMenu.value, false)
    let focused = '', prevented = 0
    const wrapper = { querySelector: selector => ({ focus: () => { focused = selector } }) }
    const target = { closest: () => wrapper, matches: () => true }
    state.onNavKeydown({ key: 'ArrowDown', target, preventDefault: () => prevented++ })
    assert.equal(focused, '.dropdown button')
    state.onNavKeydown({ key: 'Escape', target, preventDefault: () => prevented++ })
    assert.equal(state.openDropdown.value, ''); assert.equal(focused, 'button, input'); assert.equal(prevented, 2)
  } finally { state.dispose() }
})

test('closing panels become inert while opacity and scale animate independently of search positioning', () => {
  const state = setup()
  try {
    const attrs = new Map()
    state.disableLeavingPanel({ setAttribute: (name, value) => attrs.set(name, value) })
    assert.equal(attrs.has('inert'), true)
    assert.ok(source.includes('transition: opacity 0.16s var(--ease), scale 0.16s var(--ease)'))
    assert.ok(source.includes('.nav-scale-enter-from, .nav-scale-leave-to { opacity: 0; scale: 0.94; }'))
    assert.ok(source.includes('transform: translateX(-50%)'))
    assert.ok(source.includes('.wall-dropdown { transform-origin: top left; }'))
    assert.ok(source.includes('.search-dropdown { transform-origin: top center; }'))
    assert.ok(source.includes('.account-dropdown, .more-dropdown { transform-origin: top right; }'))
    assert.ok(source.includes('.mobile-menu { transform-origin: top center; }'))
    assert.equal(source.includes('dropIn'), false)
  } finally { state.dispose() }
})

test('equal bounded wings keep a fixed search track and comfortable button groups', () => {
  assert.ok(source.includes('grid-template-columns: minmax(0, 1fr) 216px minmax(0, 1fr)'))
  assert.ok(source.includes('.nav-primary-links { display: flex; align-items: center; gap: 6px;'))
  assert.ok(source.includes('gap: 16px;'))
  assert.ok(source.includes('v-for="item in primaryNav"'))
  assert.ok(source.includes('v-for="item in secondaryNav"'))
  assert.ok(source.includes('v-for="item in settingsStore.visibleNav"'), 'mobile retains the complete preference-driven list')
  assert.ok(source.includes('id="nav-more-menu"'))
})
