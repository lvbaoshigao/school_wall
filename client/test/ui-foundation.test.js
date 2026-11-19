import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, nextTick, ref, shallowRef } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { useFocusTrap } from '../src/composables/useFocusTrap.js'
import { useToast } from '../src/composables/useToast.js'

const renderer = createRenderer({
  createComment: () => ({}), createText: text => ({ text }), createElement: tag => ({ tag }),
  insert: (node, parent) => { node.parent = parent }, remove: () => {},
  setElementText: () => {}, setText: () => {}, setComment: () => {}, patchProp: () => {},
  parentNode: node => node.parent, nextSibling: () => null,
})

function environment() {
  const saved = { document: globalThis.document, window: globalThis.window }
  const handlers = new Map()
  const document = {
    activeElement: null, body: { style: { overflow: 'auto' } },
    addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler) },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler) },
    dispatch(type, event) {
      event.preventDefault ||= () => { event.defaultPrevented = true }
      event.stopImmediatePropagation ||= () => { event.stopped = true }
      for (const handler of [...(handlers.get(type) || [])]) { handler(event); if (event.stopped) break }
      return event
    },
  }
  function element(options = {}) {
    const attributes = new Map(Object.entries(options.attributes || {}))
    const node = {
      tabIndex: options.tabIndex ?? 0, disabled: false, isConnected: true, children: [], ...options,
      querySelectorAll() { return this.children },
      matches(selector) { return selector === ':disabled' && this.disabled },
      closest() { return this.inert || this.hidden ? this : null },
      getClientRects() { return this.hidden ? [] : [{}] },
      hasAttribute(name) { return attributes.has(name) },
      setAttribute(name, value) { attributes.set(name, value) },
      contains(target) { return target === this || this.children.includes(target) },
      focus() { document.activeElement = this; document.dispatch('focusin', { target: this }) },
    }
    return node
  }
  globalThis.document = document
  globalThis.window = { getComputedStyle: node => ({ visibility: node.visibility || 'visible', display: 'block' }) }
  const apps = []
  function mount(children, initial = false) {
    const open = ref(initial)
    const container = element({ tabIndex: -1, children })
    let closes = 0
    const app = renderer.createApp({ setup() { useFocusTrap(open, shallowRef(container), () => { closes++; open.value = false }); return () => null } })
    app.mount({})
    apps.push(app)
    return { open, container, get closes() { return closes }, unmount() { app.unmount(); apps.splice(apps.indexOf(app), 1) } }
  }
  return { document, element, mount, cleanup() { for (const app of [...apps].reverse()) app.unmount(); globalThis.document = saved.document; globalThis.window = saved.window } }
}
const settle = async () => { await nextTick(); await nextTick(); await nextTick() }

test('modal skips disabled, hidden and negative-tabindex controls, wraps Tab and restores focus', async () => {
  const env = environment()
  try {
    const opener = env.element(); opener.focus()
    const first = env.element(), last = env.element()
    const modal = env.mount([env.element({ disabled: true }), env.element({ hidden: true }), env.element({ tabIndex: -1 }), first, last])
    modal.open.value = true; await settle()
    assert.equal(env.document.activeElement, first)
    assert.equal(env.document.body.style.overflow, 'hidden')
    const shift = env.document.dispatch('keydown', { key: 'Tab', shiftKey: true })
    assert.equal(shift.defaultPrevented, true)
    assert.equal(env.document.activeElement, last)
    env.document.dispatch('keydown', { key: 'Tab' })
    assert.equal(env.document.activeElement, first)
    opener.focus()
    assert.equal(env.document.activeElement, first, 'programmatic focus cannot escape the modal')
    env.document.dispatch('keydown', { key: 'Escape' }); await settle()
    assert.equal(modal.closes, 1)
    assert.equal(env.document.activeElement, opener)
    assert.equal(env.document.body.style.overflow, 'auto')
  } finally { env.cleanup() }
})

test('nested modal Escape closes only top layer and retains scroll lock', async () => {
  const env = environment()
  try {
    const opener = env.element(); opener.focus()
    const outerButton = env.element(), innerButton = env.element()
    const outer = env.mount([outerButton]), inner = env.mount([innerButton])
    outer.open.value = true; await settle(); inner.open.value = true; await settle()
    env.document.dispatch('keydown', { key: 'Escape' }); await settle()
    assert.equal(inner.closes, 1); assert.equal(outer.closes, 0)
    assert.equal(env.document.activeElement, outerButton)
    assert.equal(env.document.body.style.overflow, 'hidden')
    outer.open.value = false; await settle()
    assert.equal(env.document.body.style.overflow, 'auto')
    assert.equal(env.document.activeElement, opener)
  } finally { env.cleanup() }
})

test('initially open empty modal focuses its container and unmount restores its trigger', async () => {
  const env = environment()
  try {
    const opener = env.element(); opener.focus()
    const modal = env.mount([], true); await settle()
    assert.equal(env.document.activeElement, modal.container)
    assert.equal(env.document.dispatch('keydown', { key: 'Tab' }).defaultPrevented, true)
    modal.unmount()
    assert.equal(env.document.activeElement, opener)
    assert.equal(env.document.body.style.overflow, 'auto')
  } finally { env.cleanup() }
})

test('unmounting unopened trap does not unlock another dialog; safe initial control wins', async () => {
  const env = environment()
  try {
    const confirm = env.element(), cancel = env.element({ attributes: { 'data-focus-initial': '' } })
    const modal = env.mount([confirm, cancel]), unopened = env.mount([])
    modal.open.value = true; await settle()
    assert.equal(env.document.activeElement, cancel)
    unopened.unmount()
    assert.equal(env.document.body.style.overflow, 'hidden')
    env.document.dispatch('keydown', { key: 'Escape', isComposing: true }); await settle()
    assert.equal(modal.closes, 0, 'IME Escape does not dismiss a form')
  } finally { env.cleanup() }
})

test('toast expiration pauses and resumes with remaining time; explicit zero remains persistent', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const toast = useToast()
  try {
    const id = toast.info('可读通知', 5000)
    t.mock.timers.tick(4000); toast.pause(id); t.mock.timers.tick(20000)
    assert.equal(toast.toasts.value.some(item => item.id === id), true)
    toast.resume(id); t.mock.timers.tick(999)
    assert.equal(toast.toasts.value.some(item => item.id === id), true)
    t.mock.timers.tick(1)
    assert.equal(toast.toasts.value.some(item => item.id === id), false)
    const persistent = toast.error('持久通知', 0)
    t.mock.timers.tick(100000)
    assert.equal(toast.toasts.value.some(item => item.id === persistent), true)
    toast.remove(persistent)
  } finally { for (const item of [...toast.toasts.value]) toast.remove(item.id); t.mock.timers.reset() }
})

test('default error notification provides eight seconds and dismissal clears its timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const toast = useToast()
  try {
    const id = toast.error('保存失败')
    t.mock.timers.tick(7999)
    assert.equal(toast.toasts.value.some(item => item.id === id), true)
    toast.remove(id); t.mock.timers.tick(10000)
    assert.equal(toast.toasts.value.length, 0)
  } finally { for (const item of [...toast.toasts.value]) toast.remove(item.id); t.mock.timers.reset() }
})

const components = ['App', 'components/Navbar', 'components/AvatarIcon', 'components/BackToTop', 'components/ConfirmModal', 'components/EmptyState', 'components/ErrorState', 'components/Icon', 'components/Lightbox', 'components/PublishFab', 'components/SkeletonCard', 'components/ToastContainer', 'components/TrendingBoard']
test('every shared Vue component compiles its script and template', async () => {
  for (const name of components) {
    const filename = new URL('../src/' + name + '.vue', import.meta.url)
    const source = await readFile(filename, 'utf8')
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [], name)
    const script = compileScript(descriptor, { id: name })
    const template = compileTemplate({ source: descriptor.template.content, filename: filename.pathname, id: name, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [], name)
  }
})

function luminance(hex) {
  const rgb = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
test('shared text and filled-action colors meet WCAG AA body contrast', async () => {
  const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8')
  const root = css.slice(css.indexOf(':root {'), css.indexOf('/* ----- 外观偏好'))
  const light = css.slice(css.indexOf('body.light-theme {'), css.indexOf('/* ----- Reset'))
  const token = (block, name) => block.match(new RegExp('--' + name + ': (#[a-f0-9]{6});', 'i'))?.[1]
  for (const block of [root, light]) {
    const background = token(block, 'surface-raised')
    for (const name of ['text-primary', 'text-secondary', 'text-muted', 'text-link']) {
      const ratio = contrast(token(block, name), background)
      assert.ok(ratio >= 4.5, name + ' contrast ' + ratio.toFixed(2))
    }
    assert.ok(contrast(token(block, 'control-border'), background) >= 3, 'input boundary contrast')
  }
  for (const name of ['accent-1', 'accent-2', 'danger-fill', 'success-fill']) assert.ok(contrast(token(root, name), '#ffffff') >= 4.5, name)
})
