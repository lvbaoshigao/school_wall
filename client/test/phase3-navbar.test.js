import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const read = path => readFile(new URL('../src/' + path, import.meta.url), 'utf8')
function rule(source, selector) {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, 'missing CSS selector: ' + selector)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open + 1)
  assert.ok(open > start && close > open, 'malformed CSS selector: ' + selector)
  return source.slice(open + 1, close)
}

test('phase3 navbar and app SFC compile with native Vue templates', async () => {
  for (const path of ['components/Navbar.vue', 'App.vue']) {
    const source = await read(path)
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [], path)
    const script = compileScript(descriptor, { id: path })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [], path)
  }
})

test('nav shell is one centered 1180px translucent capsule with a tinted edge and backdrop blur', async () => {
  const source = await read('components/Navbar.vue')
  const styles = source.slice(source.indexOf('<style scoped>'))
  const shell = rule(styles, '.nav-inner {')
  const rail = rule(styles, '.navbar {')
  assert.ok(shell.includes('max-width: var(--navbar-shell-width)'))
  assert.ok(shell.includes('border-radius: var(--radius-pill)'))
  assert.ok(shell.includes('background: var(--surface-nav)'))
  assert.ok(shell.includes('inset 0 1px 0 var(--navbar-shell-highlight)'))
  assert.ok(shell.includes('overflow: visible'))
  assert.ok(shell.includes('backdrop-filter: var(--nav-glass-filter)'))
  assert.ok(rail.includes('pointer-events: none'))
  assert.ok(!rail.includes('backdrop-filter'))
  const global = await read('styles/global.css')
  assert.ok(global.includes('--navbar-shell-width: 1180px'))
  assert.ok(global.includes('--navbar-shell-side-gap: 12px'))
})

test('navigation features remain reachable, named and responsive', async () => {
  const source = await read('components/Navbar.vue')
  for (const required of [
    'aria-label="主导航"',
    'currentWall?.name', '选择校园墙', '切换校园墙',
    'settingsStore.visibleNav', 'nav-search-shortcut',
    '@media (max-width: 1120px)', '@media (min-width: 1121px) { .mobile-menu { display: none; } }',
    "go('/settings')", "go('/profile')", 'openAnnouncements', 'changeWallpaper', "go('/search')", "emit('toggle-theme')", 'logout()',
    'aria-current=', "isActive(item) ? 'page' : undefined",
  ]) assert.ok(source.includes(required), 'missing existing navigation feature/semantics: ' + required)
})

test('capsule height and safe area remain synchronized with app and chat clearance', async () => {
  const global = await read('styles/global.css'), app = await read('App.vue'), nav = await read('components/Navbar.vue')
  assert.ok(global.includes('--app-header-height: calc(var(--safe-area-top) + var(--app-nav-height) + var(--navbar-shell-top-gap))'))
  assert.ok(nav.includes('padding: var(--safe-area-top) max(var(--navbar-shell-side-gap)'))
  assert.ok(app.includes('padding: calc(var(--app-header-height) + var(--page-top-gap))'))
  assert.ok(app.includes('padding-top: calc(var(--app-header-height) + var(--conversation-gap))'))
  assert.ok(nav.includes('max-height: max(0px, calc(var(--visual-viewport-height) - var(--visual-viewport-offset-top) - var(--app-header-height) - 16px))'))
})

test('solid contrast fallbacks and keyboard-focus support remain present', async () => {
  const source = await read('components/Navbar.vue'), global = await read('styles/global.css')
  for (const required of ["html[data-high-contrast='on'] .navbar .nav-inner", '@media (prefers-reduced-transparency: reduce)', '.navbar :focus-visible', 'pointer-events: auto', 'box-shadow: var(--navbar-shell-shadow)']) assert.ok(source.includes(required), required)
  assert.ok(global.includes('@media (forced-colors: active)'))
})
