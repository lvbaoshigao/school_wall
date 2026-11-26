import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as Vue from 'vue'
import { focusIfActive } from '../src/utils/focus.js'

// Exercise the real composable with Vue's watcher/nextTick ordering and a small DOM double.
async function page() {
  const calls = []
  const listeners = new Map()
  const doc = {
    visibilityState: 'visible', focused: true, activeElement: null,
    body: { style: { overflow: 'auto' } }, hasFocus() { return this.focused },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  function element(name, { children = [], initial = false, disabled = false, connected = true, tagName = 'BUTTON' } = {}) {
    const attrs = new Set(initial ? ['data-focus-initial'] : [])
    return {
      name, tagName, nodeType: 1, ownerDocument: doc, isConnected: connected, tabIndex: 0, lastFocusOptions: null,
      focus(options) { calls.push(name); this.lastFocusOptions = options; doc.activeElement = this },
      contains(target) { return target === this || children.some(node => node.contains(target)) },
      querySelectorAll() { return children },
      hasAttribute(attr) { return attrs.has(attr) }, setAttribute(attr) { attrs.add(attr) },
      matches(selector) { return selector === ':disabled' && disabled }, closest() { return null },
      getClientRects() { return [{}] },
    }
  }
  const cleanups = []
  const source = await readFile(new URL('../src/composables/useFocusTrap.js', import.meta.url), 'utf8')
  const code = source.replace(/^import[^\n]*\n/gm, '').replace('export function useFocusTrap', 'function useFocusTrap') + '\nreturn useFocusTrap'
  const useFocusTrap = new Function('nextTick', 'onBeforeUnmount', 'watch', 'document', 'window', 'focusIfActive', code)(Vue.nextTick, fn => cleanups.push(fn), Vue.watch, doc, { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) }, focusIfActive)
  const scope = Vue.effectScope()
  const opener = element('opener')
  doc.activeElement = opener
  function modal(name) {
    const first = element(name + '-first')
    const preferred = element(name + '-preferred', { initial: true, tagName: 'INPUT' })
    const last = element(name + '-last')
    const container = element(name, { children: [first, preferred, last] })
    const open = Vue.ref(false)
    scope.run(() => useFocusTrap(open, Vue.shallowRef(container), () => { open.value = false }))
    return { open, container, first, preferred, last }
  }
  async function settle() { await Vue.nextTick(); await Vue.nextTick() }
  function dispatch(type, fields = {}) {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true }, ...fields }
    for (const fn of listeners.get(type) || []) { fn(event); if (event.stopped) break }
    return event
  }
  return { doc, calls, listeners, opener, element, modal, settle, dispatch, dispose() { cleanups.forEach(fn => fn()); scope.stop() } }
}

test('foreground modal keeps initial focus, Tab wrapping, Escape and focus restoration', async t => {
  const p = await page(); t.after(p.dispose)
  const m = p.modal('confirm')
  m.open.value = true; await p.settle()
  assert.equal(p.doc.activeElement, m.preferred)
  assert.equal(m.preferred.lastFocusOptions.preventScroll, false, 'prompt field scrolls into view')
  assert.equal(p.doc.body.style.overflow, 'hidden')
  p.doc.activeElement = m.last
  assert.equal(p.dispatch('keydown', { key: 'Tab' }).prevented, true)
  assert.equal(p.doc.activeElement, m.first)
  assert.equal(m.first.lastFocusOptions.preventScroll, false, 'Tab wrapping scrolls to the focused control')
  p.doc.activeElement = m.first
  p.dispatch('keydown', { key: 'Tab', shiftKey: true })
  assert.equal(p.doc.activeElement, m.last)
  const outside = p.element('outside')
  p.doc.activeElement = outside
  p.dispatch('focusin', { target: outside })
  assert.equal(p.doc.activeElement, m.preferred)
  p.dispatch('keydown', { key: 'Escape' }); await p.settle()
  assert.equal(m.open.value, false)
  assert.equal(p.doc.activeElement, p.opener)
  assert.equal(p.doc.body.style.overflow, 'auto')
  assert.equal(p.listeners.get('focusin').size, 0)
})

for (const mode of ['hidden', 'unfocused']) {
  test(mode + ' page does not take focus on modal open, focusin or close', async t => {
    const p = await page(); t.after(p.dispose)
    const m = p.modal('confirm')
    if (mode === 'hidden') p.doc.visibilityState = 'hidden'
    else p.doc.focused = false
    m.open.value = true; await p.settle()
    assert.deepEqual(p.calls, [], 'nextTick must not focus a background page')
    p.dispatch('focusin', { target: p.opener })
    assert.deepEqual(p.calls, [], 'focus containment must not steal window focus')
    m.open.value = false; await p.settle()
    assert.deepEqual(p.calls, [], 'closing/unmounting in the background must not restore focus')
    assert.equal(p.doc.body.style.overflow, 'auto')
    p.doc.visibilityState = 'visible'; p.doc.focused = true; await p.settle()
    assert.deepEqual(p.calls, [], 'skipped background focus must not be queued for later')
  })
}

test('minimizing after the open watcher runs cancels its pending initial focus', async t => {
  const p = await page(); t.after(p.dispose)
  const m = p.modal('confirm')
  m.open.value = true
  await Vue.nextTick(() => { p.doc.visibilityState = 'hidden'; p.doc.focused = false })
  await p.settle()
  assert.deepEqual(p.calls, [])
})

test('Document and Window focusin targets do not redirect focus or throw', async t => {
  const p = await page(); t.after(p.dispose)
  const m = p.modal('confirm')
  m.open.value = true; await p.settle(); p.calls.length = 0
  p.dispatch('focusin', { target: { nodeType: 9 } })
  p.dispatch('focusin', { target: {} })
  assert.deepEqual(p.calls, [])
})

test('nested modal cleanup restores focus only in an active document', async t => {
  const p = await page(); t.after(p.dispose)
  const outer = p.modal('outer'); outer.open.value = true; await p.settle()
  const inner = p.modal('inner'); inner.open.value = true; await p.settle()
  assert.equal(p.doc.activeElement, inner.preferred)
  inner.open.value = false; await p.settle()
  assert.equal(p.doc.activeElement, outer.preferred)
  assert.equal(p.doc.body.style.overflow, 'hidden')
  inner.open.value = true; await p.settle(); p.calls.length = 0
  p.doc.focused = false; inner.open.value = false; await p.settle()
  assert.deepEqual(p.calls, [])
  p.doc.focused = true
  p.dispatch('focusin', { target: p.opener })
  assert.equal(p.doc.activeElement, outer.preferred, 'foreground containment still works after returning')
})

test('focusIfActive rejects detached elements and background documents', () => {
  let count = 0
  const doc = { visibilityState: 'visible', hasFocus: () => true, activeElement: null }
  const el = { isConnected: true, ownerDocument: doc, focus() { count++; doc.activeElement = this } }
  assert.equal(focusIfActive(el), true)
  el.isConnected = false; assert.equal(focusIfActive(el), false)
  el.isConnected = true; doc.visibilityState = 'hidden'; assert.equal(focusIfActive(el), false)
  doc.visibilityState = 'visible'; doc.hasFocus = () => false; assert.equal(focusIfActive(el), false)
  assert.equal(focusIfActive(null), false)
  assert.equal(count, 1)
})
