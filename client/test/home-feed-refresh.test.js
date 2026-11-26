import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { effectScope, reactive, ref, computed, watch, nextTick } from 'vue'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Execute the page's actual setup and lifecycle callbacks with reactive store doubles.
async function home() {
  const source = await readFile(new URL('../src/views/Home.vue', import.meta.url), 'utf8')
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .+$/gm, '')
  const lifecycle = { mounted: [], activated: [], deactivated: [], unmount: [] }
  const requests = []
  const wall = reactive({ currentWallId: 10, lastPublishedPost: null })
  const settings = reactive({ loaded: false, prefs: { feed_category: '全部', feed_sort: 'latest' } })
  const api = { get(url, options) {
    if (url.startsWith('/walls/')) return Promise.resolve({ data: { id: wall.currentWallId } })
    const result = deferred()
    requests.push({ url, options, ...result })
    return result.promise
  } }
  const dependencies = { ref, computed, watch, api, AbortController,
    onMounted: fn => lifecycle.mounted.push(fn), onActivated: fn => lifecycle.activated.push(fn),
    onDeactivated: fn => lifecycle.deactivated.push(fn), onBeforeUnmount: fn => lifecycle.unmount.push(fn),
    useRouter: () => ({ push() {} }), useWallStore: () => wall, useSettingsStore: () => settings,
    useTimeAgo: () => ({ timeAgo: value => value }), useFocusTrap() {},
    window: { innerWidth: 1200, addEventListener() {}, removeEventListener() {} },
  }
  const scope = effectScope()
  const page = scope.run(() => new Function(...Object.keys(dependencies), script + '\nreturn { posts, total, page, loading, activeCategory, sortMode, switchCategory, switchSort, loadPosts }')(...Object.values(dependencies)))
  return { page, wall, settings, requests,
    mount() { lifecycle.mounted.forEach(fn => fn()); lifecycle.activated.forEach(fn => fn()) },
    activate() { lifecycle.activated.forEach(fn => fn()) },
    deactivate() { lifecycle.deactivated.forEach(fn => fn()) },
    async settle() { await Promise.resolve(); await nextTick(); await Promise.resolve() },
    dispose() { lifecycle.unmount.forEach(fn => fn()); scope.stop() },
  }
}
const result = (id = 1) => ({ data: { posts: [{ id }], total: 1, categories: ['分享'] } })

test('cached Home fetches once on first activation and again when returning', async t => {
  const h = await home(); t.after(() => h.dispose())
  h.mount()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(result(1)); await h.settle()
  assert.equal(h.page.posts.value[0].id, 1)
  h.deactivate(); h.activate()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(result(2)); await h.settle()
  assert.equal(h.page.posts.value[0].id, 2)
})

test('publication resets cached category, hot sorting and pagination to show the new post', async t => {
  const h = await home(); t.after(() => h.dispose())
  h.mount(); h.requests[0].resolve(result()); await h.settle()
  h.page.switchCategory('求助')
  h.requests[1].resolve(result()); await h.settle()
  h.page.switchSort('hot')
  h.requests[2].resolve(result()); await h.settle()
  h.page.page.value = 4
  h.deactivate()
  h.wall.lastPublishedPost = { wallId: 10 }
  h.activate()
  const request = h.requests.at(-1)
  const params = new URL(request.url, 'https://local.invalid').searchParams
  assert.equal(params.get('page'), '1')
  assert.equal(params.has('category'), false)
  assert.equal(params.has('sort'), false)
  assert.equal(h.page.activeCategory.value, '全部')
  assert.equal(h.page.sortMode.value, 'latest')
  request.resolve(result(99)); await h.settle()
  assert.equal(h.page.posts.value[0].id, 99)
  h.settings.prefs.feed_category = '求助'
  h.settings.loaded = true; await h.settle()
  assert.equal(h.page.activeCategory.value, '全部', 'late preference cannot hide a new publication')
})

test('an old request cannot replace a refreshed feed after deactivation', async t => {
  const h = await home(); t.after(() => h.dispose())
  h.mount()
  const previous = h.requests[0]
  h.deactivate()
  assert.equal(previous.options.signal.aborted, true)
  h.activate()
  h.requests[1].resolve(result(2)); await h.settle()
  previous.resolve(result(1)); await h.settle()
  assert.equal(h.page.posts.value[0].id, 2)
  assert.equal(h.page.loading.value, false)
})

test('switching walls while Home is cached does not fetch until it is active', async t => {
  const h = await home(); t.after(() => h.dispose())
  h.mount(); h.requests[0].resolve(result()); await h.settle()
  h.deactivate()
  h.wall.currentWallId = 20; await h.settle()
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.page.posts.value, [])
  h.activate()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(result(20)); await h.settle()
  assert.equal(h.page.posts.value[0].id, 20)
})

test('a consumed publication does not reset later user filters on ordinary navigation', async t => {
  const h = await home(); t.after(() => h.dispose())
  h.wall.lastPublishedPost = { wallId: 10 }
  h.mount(); h.requests[0].resolve(result()); await h.settle()
  h.page.switchCategory('讨论')
  h.requests[1].resolve(result()); await h.settle()
  h.deactivate(); h.activate()
  const params = new URL(h.requests.at(-1).url, 'https://local.invalid').searchParams
  assert.equal(params.get('category'), '讨论')
  h.requests.at(-1).resolve(result()); await h.settle()
})
