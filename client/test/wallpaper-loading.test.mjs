import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'

const origin = 'http://wallpaper.test'
const bingPath = '/api/wallpaper/image/' + 'a'.repeat(64) + '.jpg'
const absolute = path => new URL(path, origin).href
const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
const parsed = parse(source)
assert.deepEqual(parsed.errors, [])
const script = compileScript(parsed.descriptor, { id: 'wallpaper-test' })
const template = compileTemplate({ source: parsed.descriptor.template.content, filename: 'App.vue', id: 'wallpaper-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
assert.deepEqual(compileStyle({ source: parsed.descriptor.styles[0].content, filename: 'App.vue', id: 'wallpaper-test', scoped: true }).errors, [])
const renderSource = template.code.replace(/^import[^\n]*\n/gm, line => 'const {' + line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ') + '} = Vue;\n').replace('export function render', 'return function render')
const render = new Function('Vue', renderSource)(Vue)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() {
  for (let index = 0; index < 10; index++) { await Vue.nextTick(); await Promise.resolve() }
}
function harness(t, { enabled = true, wallpaperSource = 'bing', decode = async () => {} } = {}) {
  const requests = [], images = [], mount = [], unmount = [], timers = new Map()
  const settings = Vue.reactive({ prefs: { wallpaper_enabled: enabled, wallpaper_source: wallpaperSource } })
  const api = { get(path, options) { const request = { path, options, ...deferred() }; requests.push(request); return request.promise } }
  class Image {
    complete = false
    naturalWidth = 0
    constructor() { images.push(this) }
    set src(url) { this.url = url }
    get src() { return this.url }
    removeAttribute(name) { if (name === 'src') this.removed = true }
    decode() { return decode(this) }
    load() { this.complete = true; this.naturalWidth = 1920; return this.onload?.() }
    fail() { this.onerror?.() }
  }
  const style = { setProperty() {}, removeProperty() {} }
  const document = { body: { classList: { add() {}, remove() {} } }, documentElement: { dataset: {}, style }, querySelector: () => null, addEventListener() {}, removeEventListener() {} }
  const window = { Image, location: { origin }, innerHeight: 900, innerWidth: 1280, addEventListener() {}, removeEventListener() {}, cancelAnimationFrame() {} }
  const empty = { render: () => null }
  const deps = { ...Vue, window, document, api, AbortController,
    getComputedStyle: () => ({ getPropertyValue: () => '#111' }),
    setTimeout(fn, delay) { const id = Symbol(); timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    useUserStore: () => ({ user: null, token: null, sessionRevision: 0 }), useWallStore: () => ({ currentWallId: null }),
    useSettingsStore: () => settings, useRoute: () => Vue.reactive({ name: 'Home', path: '/' }), readStorage: () => null,
    useToast: () => ({ error() {} }), focusIfActive() {}, provide() {},
    Navbar: empty, ToastContainer: empty, BackToTop: empty, PublishFab: empty,
    onMounted: fn => mount.push(fn), onBeforeUnmount: fn => unmount.push(fn),
  }
  const component = new Function(...Object.keys(deps), script.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return'))(...Object.values(deps))
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  let disposed = false
  function dispose() { if (!disposed) { disposed = true; unmount.forEach(fn => fn()); scope.stop() } }
  t.after(dispose)
  return { state, settings, requests, images, timers, dispose,
    async mount() { for (const fn of mount) await fn(); await settle() },
    async resolve(index, data) { requests[index].resolve({ data }); await settle() },
    async reject(index) { requests[index].reject(new Error('isolated test: offline')); await settle() },
    async load(index = images.length - 1) { await images[index].load(); await settle() },
    async fail(index = images.length - 1) { images[index].fail(); await settle() },
    async renderError() { const target = Vue.markRaw({ src: state.wallpaperUrl.value, currentSrc: state.wallpaperUrl.value }); state.wallpaperImageRef.value = target; state.onWallpaperError({ target }); await settle(); return target },
    async html() { return renderToString(Vue.h({ components: { RouterView: empty }, render: () => render({}, [], {}, Vue.proxyRefs(state)) })) },
  }
}
async function rejectApis(h) { await h.reject(0); await h.reject(1) }
async function readyBing(h) { await h.mount(); await h.resolve(0, { url: bingPath, idx: 0, total: 8 }); await h.load() }

test('Bing background commits only after successful load and decode', async t => {
  const decoding = deferred()
  const h = harness(t, { decode: () => decoding.promise })
  await h.mount()
  assert.equal(h.requests[0].path, '/wallpaper')
  assert.deepEqual(h.requests[0].options.params, { source: 'bing' })
  assert.equal(h.requests[0].options.timeout, 8000)
  await h.resolve(0, { url: bingPath, idx: 0, total: 8 })
  const loading = h.images[0].load()
  await settle()
  assert.equal(h.state.wallpaperUrl.value, '')
  assert.equal(h.state.wallpaperLoaded.value, false)
  decoding.resolve()
  await loading
  await settle()
  assert.equal(h.state.wallpaperUrl.value, absolute(bingPath))
  assert.equal(h.state.wallpaperLoaded.value, true)
  assert.equal(h.state.wallpaperNoticeMessage.value, '')
  assert.equal(h.timers.size, 0)
})

for (const wallpaperSource of ['bing', 'local']) {
  test('server local response respects ' + wallpaperSource + ' preference and announces only fallback', async t => {
    const h = harness(t, { wallpaperSource })
    await h.mount()
    await h.resolve(0, { url: '/rele/3.jpg', source: 'local', fallback: wallpaperSource === 'bing', idx: 2, total: 4 })
    await h.load()
    assert.equal(h.state.wallpaperUrl.value, absolute('/rele/3.jpg'))
    assert.equal(h.settings.prefs.wallpaper_source, wallpaperSource)
    const html = await h.html()
    if (wallpaperSource === 'bing') {
      assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/)
      assert.match(html, /必应壁纸暂不可用，已改用本地壁纸。/)
    } else assert.doesNotMatch(html, /role="status"/)
    assert.match(html, /alt(?:="")? class="wallpaper-img"/)
  })
}

test('Bing JPEG image error falls back to local API before trying shipped candidates', async t => {
  const h = harness(t)
  await h.mount()
  await h.resolve(0, { url: bingPath, source: 'bing' })
  await h.fail()
  assert.deepEqual(h.requests[1].options.params, { source: 'local' })
  await h.resolve(1, { url: '/rele/3.jpg', source: 'local' })
  await h.load()
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/3.jpg'))
  assert.equal(h.state.wallpaperNoticeMessage.value, '必应壁纸暂不可用，已改用本地壁纸。')
  assert.deepEqual(h.images.map(image => image.src), [absolute(bingPath), absolute('/rele/3.jpg')])
})

test('both failed APIs fall back to finite shipped assets and skip a broken first file', async t => {
  const h = harness(t)
  await h.mount()
  await rejectApis(h)
  assert.deepEqual(h.requests.map(request => request.options.params.source), ['bing', 'local'])
  assert.equal(h.images[0].src, absolute('/rele/1.jpg'))
  await h.fail()
  assert.equal(h.images[1].src, absolute('/rele/2.jpg'))
  await h.load()
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/2.jpg'))
  assert.equal(h.state.wallpaperNoticeMessage.value, '壁纸服务暂不可用，已使用内置本地壁纸。')
  assert.equal(h.settings.prefs.wallpaper_enabled, true)
  assert.equal(h.settings.prefs.wallpaper_source, 'bing')
  assert.equal(h.requests.length, 2)
})

test('offline local preference uses static fallback without requesting Bing', async t => {
  const h = harness(t, { wallpaperSource: 'local' })
  await h.mount()
  await h.reject(0)
  await h.load()
  assert.deepEqual(h.requests.map(request => request.options.params.source), ['local'])
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/1.jpg'))
  assert.equal(h.state.wallpaperNoticeMessage.value, '壁纸服务暂不可用，已使用内置本地壁纸。')
  assert.equal(h.settings.prefs.wallpaper_source, 'local')
})

test('all unavailable assets stop once and expose the accessible theme-background notice', async t => {
  const h = harness(t)
  await h.mount()
  await rejectApis(h)
  for (let index = 0; index < 4; index++) await h.fail()
  assert.deepEqual(h.images.map(image => image.src), h.state.localWallpaperFallbacks.map(absolute))
  assert.equal(h.state.wallpaperUrl.value, '')
  assert.equal(h.state.wallpaperLoaded.value, true)
  assert.equal(h.requests.length, 2)
  assert.equal(h.timers.size, 0)
  const html = await h.html()
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(html, /壁纸暂不可用，已显示主题背景。/)
  assert.doesNotMatch(html, /class="wallpaper-img"/)
})

test('unsafe API URLs never load externally and continue to bundled fallback', async t => {
  const h = harness(t)
  await h.mount()
  await h.resolve(0, { url: 'https://outside.invalid/image.jpg' })
  await h.resolve(1, { url: '/rele/%2fprivate.jpg' })
  assert.deepEqual(h.images.map(image => image.src), [absolute('/rele/1.jpg')])
  await h.load()
  for (const url of ['https://outside.invalid/rele/1.jpg', '/rele/.hidden.jpg', '/rele/%5cprivate.jpg', '/rele/%00.jpg', '/rele/1.jpg?token=secret', '/rele/1.jpg#fragment', '/assets/image.jpg', 'data:image/png;base64,eA==']) {
    assert.throws(() => h.state.safeWallpaperUrl(url), /Invalid wallpaper/)
  }
})

test('explicitly disabled wallpaper starts no API or image work and shows no fallback notice', async t => {
  const h = harness(t, { enabled: false })
  await h.mount()
  await h.state.getRandomWallpaper()
  assert.equal(h.requests.length, 0)
  assert.equal(h.images.length, 0)
  assert.equal(h.settings.prefs.wallpaper_enabled, false)
  assert.doesNotMatch(await h.html(), /bg-wallpaper|wallpaper-notice/)
})

test('disabling aborts immediately and late API success or old image events cannot revive wallpaper', async t => {
  const h = harness(t)
  await h.mount()
  h.settings.prefs.wallpaper_enabled = false
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.resolve(0, { url: bingPath })
  const target = Vue.markRaw({ src: absolute(bingPath) })
  h.state.wallpaperImageRef.value = target
  h.state.onWallpaperLoad({ target })
  h.state.onWallpaperError({ target })
  await settle()
  assert.equal(h.state.wallpaperUrl.value, '')
  assert.equal(h.state.wallpaperLoaded.value, false)
  assert.equal(h.state.wallpaperNoticeMessage.value, '')
  assert.equal(h.images.length, 0)
  assert.equal(h.requests.length, 1)
})

test('rapid off/on cancels pending decode and stale completion cannot replace the new image', async t => {
  const decoding = deferred()
  let decodes = 0
  const h = harness(t, { decode: () => ++decodes === 1 ? decoding.promise : Promise.resolve() })
  await h.mount()
  await h.resolve(0, { url: bingPath })
  const oldLoading = h.images[0].load()
  h.settings.prefs.wallpaper_enabled = false
  h.settings.prefs.wallpaper_enabled = true
  assert.equal(h.requests.length, 2, 'same-tick toggles invalidate work synchronously')
  assert.equal(h.images[0].removed, true)
  await h.resolve(1, { url: '/rele/2.jpg' })
  await h.load(1)
  decoding.resolve()
  await oldLoading
  await settle()
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/2.jpg'))
  assert.equal(h.timers.size, 0)
})

test('source switch invalidates an earlier request even when its transport ignores abort', async t => {
  const h = harness(t)
  await h.mount()
  h.settings.prefs.wallpaper_source = 'local'
  assert.equal(h.requests[0].options.signal.aborted, true)
  assert.deepEqual(h.requests[1].options.params, { source: 'local' })
  await h.resolve(1, { url: '/rele/4.png' })
  await h.load()
  await h.resolve(0, { url: bingPath })
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/4.png'))
  assert.equal(h.images.length, 1)
  assert.equal(h.state.wallpaperNoticeMessage.value, '')
})

test('old and detached image events do not cancel a newer rotation or alter its state', async t => {
  const h = harness(t)
  await readyBing(h)
  const target = Vue.markRaw({ src: absolute(bingPath) })
  h.state.wallpaperImageRef.value = target
  const rotation = h.state.getRandomWallpaper(true)
  h.state.onWallpaperError({ target })
  assert.equal(h.requests.length, 2)
  await h.resolve(1, { url: '/rele/2.jpg' })
  await h.load()
  await rotation
  h.state.wallpaperLoaded.value = false
  h.state.onWallpaperLoad({ target: { src: absolute('/rele/2.jpg') } })
  h.state.onWallpaperError({ target })
  assert.equal(h.state.wallpaperLoaded.value, false)
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/2.jpg'))
  assert.equal(h.requests.length, 2)
})

test('render failures exhaust each source and static candidate once without an error retry loop', async t => {
  const h = harness(t)
  await readyBing(h)
  await h.renderError()
  assert.deepEqual(h.requests[1].options.params, { source: 'local' })
  await h.resolve(1, { url: '/rele/1.jpg' })
  await h.load()
  for (let index = 1; index <= 4; index++) {
    assert.equal(h.state.wallpaperUrl.value, absolute(h.state.localWallpaperFallbacks[index - 1]))
    await h.renderError()
    if (index < 4) await h.load()
  }
  assert.equal(h.state.wallpaperUrl.value, '')
  assert.equal(h.state.wallpaperNoticeMessage.value, '壁纸暂不可用，已显示主题背景。')
  assert.equal(h.requests.length, 2)
  assert.equal(h.images.length, 5, 'one Bing plus the four shipped images')
  assert.equal(new Set(h.images.map(image => image.src)).size, 5)
  assert.equal(h.timers.size, 0)
})

test('manual rotation resets the attempt budget and rotates the actual local fallback source', async t => {
  const h = harness(t)
  await h.mount()
  await rejectApis(h)
  await h.load()
  const rotation = h.state.getRandomWallpaper(true)
  assert.deepEqual(h.requests[2].options.params, { source: 'local', idx: 1 })
  await h.resolve(2, { url: '/rele/2.jpg', idx: 1, total: 4 })
  await h.load()
  await rotation
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/2.jpg'))
})

test('failed rotation retains an already visible image and explains the failure', async t => {
  const h = harness(t)
  await readyBing(h)
  const rotation = h.state.getRandomWallpaper(true)
  await h.reject(1)
  await h.reject(2)
  for (let index = 0; index < 4; index++) await h.fail()
  await rotation
  assert.equal(h.state.wallpaperUrl.value, absolute(bingPath))
  assert.equal(h.state.wallpaperNoticeMessage.value, '壁纸加载失败，已保留当前壁纸。')
})

test('image timeout and decode rejection both move forward and release their timers', async t => {
  const h = harness(t, { decode: async image => { if (image.src === absolute('/rele/1.jpg')) throw new Error('bad image decode') } })
  await h.mount()
  await h.resolve(0, { url: bingPath })
  const timer = [...h.timers.values()][0]
  assert.equal(timer.delay, 6000)
  timer.fn()
  await settle()
  await h.resolve(1, { url: '/rele/1.jpg' })
  await h.load()
  assert.equal(h.images.at(-1).src, absolute('/rele/2.jpg'))
  await h.load()
  assert.equal(h.state.wallpaperUrl.value, absolute('/rele/2.jpg'))
  assert.equal(h.timers.size, 0)
})

test('unmount cancels preloading and later load handlers cannot publish wallpaper', async t => {
  const h = harness(t)
  await h.mount()
  await h.resolve(0, { url: bingPath })
  const staleLoad = h.images[0].onload
  h.dispose()
  assert.equal(h.requests[0].options.signal.aborted, true)
  assert.equal(h.timers.size, 0)
  await staleLoad()
  await settle()
  assert.equal(h.state.wallpaperUrl.value, '')
  assert.equal(h.requests.length, 1)
})

const chromium = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(path => path && existsSync(path))
test('Chromium loads and draws every actual shipped fallback image with nonzero dimensions', { skip: !chromium }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-wallpaper-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = ['/rele/1.jpg', '/rele/2.jpg', '/rele/3.jpg', '/rele/4.png']
  const urls = paths.map(path => pathToFileURL(fileURLToPath(new URL('../..' + path, import.meta.url))).href)
  // Only public repository images and an isolated browser profile are accessed.
  const html = '<!doctype html><pre id="results"></pre>' + urls.map(url => '<img src="' + url + '">').join('') + '<script>window.addEventListener("load", () => { try { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const context = canvas.getContext("2d"); const result = [...document.images].map(image => { context.clearRect(0, 0, 1, 1); context.drawImage(image, 0, 0, 1, 1); return { width: image.naturalWidth, height: image.naturalHeight, alpha: context.getImageData(0, 0, 1, 1).data[3] }; }); document.getElementById("results").textContent = JSON.stringify(result); } catch(error) { document.getElementById("results").textContent = JSON.stringify({ error: String(error) }); } })</script>'
  const file = join(directory, 'fixture.html')
  await writeFile(file, html)
  const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(directory, 'profile'), '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const result = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(result, run.stdout)
  const dimensions = JSON.parse(result[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  assert.equal(dimensions.length, 4, JSON.stringify(dimensions))
  assert.deepEqual(dimensions.map(image => [image.width, image.height]), [[1920, 1080], [3840, 2160], [1920, 1080], [1920, 1080]])
  assert.ok(dimensions.every(image => image.alpha === 255), JSON.stringify(dimensions))
})
