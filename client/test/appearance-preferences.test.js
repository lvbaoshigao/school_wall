import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createPinia, defineStore, disposePinia } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import { SETTINGS_ITEMS, searchSettings } from '../src/components/settings/catalog.js'

const require = createRequire(import.meta.url)
const backend = require('../../server/lib/prefs.js')
const storeSource = await readFile(new URL('../src/stores/settings.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8')

// Exercise the real store and validators, replacing only the API/session/DOM boundary.
function settingsHarness(t, stored = {}) {
  const properties = {}
  const root = { dataset: {}, style: { setProperty: (key, value) => { properties[key] = value } } }
  const api = {
    get: async () => ({ data: { prefs: stored, storedKeys: Object.keys(stored) } }),
    put: async (_path, data) => ({ data: { prefs: data.prefs } }),
    post: async (_path, data) => ({ data: { prefs: backend.resetPrefs(stored, data.scope) } }),
  }
  const executable = storeSource.replace(/^import .+$/gm, '').replace(/^export /gm, '').replace(/^if \(import\.meta\.hot\).+$/gm, '')
  const factory = new Function('defineStore', 'ref', 'computed', 'onScopeDispose', 'api', 'getSessionToken', 'subscribeSessionChange', 'getApiErrorMessage', 'readStorage', 'writeStorage', 'useUserStore', 'useWallStore', 'document', executable + '\nreturn { useSettingsStore, PREFERENCE_SCHEMA, ACCENTS, validatePreferencePatch, parsePreferenceImport, preferenceDefaults }')
  const module = factory(defineStore, ref, computed, onScopeDispose, api, () => 'appearance-test-session', () => () => {}, (_error, fallback) => fallback, () => null, () => {}, () => ({ isLoggedIn: true }), () => ({ canHere: () => true }), { documentElement: root })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  return { ...module, store: module.useSettingsStore(pinia), root, properties, api }
}

function luminance(hex) {
  const rgb = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

test('front and back preference contracts agree, including default enabled liquid glass and appearance reset', t => {
  const h = settingsHarness(t)
  assert.deepEqual(Object.keys(h.PREFERENCE_SCHEMA).sort(), Object.keys(backend.PREF_SCHEMA).sort())
  for (const [key, spec] of Object.entries(h.PREFERENCE_SCHEMA)) {
    const server = backend.PREF_SCHEMA[key]
    assert.equal(spec.type, server.type, key)
    assert.equal(spec.def, server.def, key)
    assert.deepEqual(spec.values, server.values, key)
  }
  assert.equal(h.store.prefs.liquid_glass, true)
  assert.equal(h.root.dataset.liquidGlass, 'on', 'first render applies defaults without waiting for login')
  assert.equal(backend.mergePrefs({}).liquid_glass, true)
  assert.equal(backend.mergePrefs({ liquid_glass: 'false' }).liquid_glass, true)
  assert.equal(backend.mergePrefs({ liquid_glass: false }).liquid_glass, false)
  assert.equal(h.preferenceDefaults('appearance').liquid_glass, true)
  assert.equal(backend.resetPrefs({ liquid_glass: false }, 'appearance').liquid_glass, true)
  assert.ok(backend.getPrefsSchema().scopes.appearance.includes('liquid_glass'))
  assert.equal(backend.getPrefsSchema().schema.liquid_glass.scope, 'appearance')
})

test('legacy accounts gain enabled glass; explicit false survives loading and import/export', async t => {
  const legacy = settingsHarness(t, { reduce_motion: true })
  await legacy.store.loadSettings()
  assert.equal(legacy.store.prefs.liquid_glass, true)
  assert.equal(legacy.root.dataset.reduceMotion, 'on')
  const h = settingsHarness(t, { liquid_glass: false })
  assert.equal(await h.store.loadSettings(), true)
  assert.equal(h.root.dataset.liquidGlass, 'off')
  const exported = h.store.exportPreferences()
  assert.equal(exported.prefs.liquid_glass, false)
  assert.equal(h.parsePreferenceImport(JSON.stringify(exported)).liquid_glass, false)
  assert.throws(() => h.validatePreferencePatch({ liquid_glass: 'false' }), /偏好值无效/)
  assert.deepEqual(backend.sanitizePrefs({ liquid_glass: 'false' }), {})
  assert.deepEqual(backend.sanitizePrefs({ liquid_glass: false }), { liquid_glass: false })
  assert.equal(await h.store.importPreferences(JSON.stringify({ format: 'school-wall-preferences', version: 1, prefs: { liquid_glass: true } })), true)
  assert.equal(h.root.dataset.liquidGlass, 'on')
})

test('glass switches save, roll back after a failed save, and reset with appearance only', async t => {
  const h = settingsHarness(t)
  assert.equal(await h.store.setPref('liquid_glass', false), true)
  assert.equal(h.root.dataset.liquidGlass, 'off')
  h.api.put = async () => { throw new Error('offline') }
  assert.equal(await h.store.setPref('liquid_glass', true), false)
  assert.equal(h.store.prefs.liquid_glass, false)
  assert.equal(h.root.dataset.liquidGlass, 'off')
  assert.equal(h.store.saveStatus, 'error')
  assert.equal(await h.store.resetPreferences('appearance'), true)
  assert.equal(h.root.dataset.liquidGlass, 'on')
  const item = SETTINGS_ITEMS.find(item => item.key === 'liquid_glass')
  assert.equal(item.section, 'appearance')
  assert.equal(item.type, 'bool')
  assert.ok(searchSettings(SETTINGS_ITEMS, '液态玻璃').some(item => item.key === 'liquid_glass'))
})

test('every brand accent keeps white primary labels above AA contrast in default, hover, and pressed states', async t => {
  const h = settingsHarness(t)
  for (const accent of h.ACCENTS) {
    await h.store.setPref('accent', accent.key)
    assert.equal(h.properties['--accent-1'], accent.c1, 'brand color is unchanged')
    assert.equal(h.properties['--btn-fill'], accent.button)
    for (const fill of [accent.button, accent.buttonHover]) {
      assert.ok(1.05 / (luminance(fill) + 0.05) >= 4.5, accent.key + ' default/hover contrast')
      const pressed = '#' + fill.slice(1).match(/../g).map(value => Math.round(parseInt(value, 16) * 0.976 + 255 * 0.024).toString(16).padStart(2, '0')).join('')
      assert.ok(1.05 / (luminance(pressed) + 0.05) >= 4.5, accent.key + ' pressed contrast')
    }
  }
})

const chromium = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(path => path && existsSync(path))

async function browserStyles(t, { width = 1280, reducedMotion = false, forceSolid = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-appearance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsView = await readFile(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  const modal = await readFile(new URL('../src/components/ConfirmModal.vue', import.meta.url), 'utf8')
  const scopedStyles = [settingsView, modal].map(source => source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] || '').join('\n')
  // Force the existing system transparency rule to match to verify its cascade in both themes.
  const globalStyles = forceSolid ? css.replace('@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)', '@media all') : css
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + globalStyles + '\n' + scopedStyles + '</style></head><body><section id="card" class="glass">内容</section><section id="strong" class="glass-strong">面板</section><header id="masthead" class="settings-masthead">设置</header><div class="confirm-overlay"><section id="modal" class="confirm-modal glass-strong">确认</section></div><button id="primary" class="btn btn-primary">主要操作</button><button id="secondary" class="btn btn-secondary">次要操作</button><button id="small" class="btn btn-secondary btn-sm">小按钮</button><button id="disabled" class="btn btn-primary" disabled>不可用</button><a id="link" class="btn btn-primary" href="#">链接按钮</a><pre id="results"></pre><script>' + String.raw`
  const snapshots = [];
  const root = document.documentElement;
  function style(id) {
    const el = document.getElementById(id), s = getComputedStyle(el);
    return { background: s.backgroundColor, image: s.backgroundImage, filter: s.backdropFilter, shadow: s.boxShadow, color: s.color, minHeight: s.minHeight, radius: s.borderRadius, transition: s.transitionDuration, animation: s.animationDuration, outline: s.outlineStyle, outlineWidth: s.outlineWidth };
  }
  for (const light of [false, true]) for (const liquid of ['on', 'off']) for (const blur of ['on', 'off']) for (const contrast of ['off', 'on']) {
    document.body.classList.toggle('light-theme', light);
    Object.assign(root.dataset, { liquidGlass: liquid, blur, highContrast: contrast, reduceMotion: 'off' });
    document.body.offsetWidth;
    document.getAnimations().forEach(animation => { try { animation.finish(); } catch {} });
    snapshots.push({ light, liquid, blur, contrast, card: style('card'), strong: style('strong'), masthead: style('masthead'), modal: style('modal'), primary: style('primary'), secondary: style('secondary'), small: style('small'), disabled: style('disabled'), link: style('link') });
  }
  root.dataset.reduceMotion = 'on';
  root.dataset.focusRing = 'always';
  document.getElementById('primary').focus();
  const manualReduced = { primary: style('primary'), modal: style('modal') };
  // Headless windows can be inactive; inspect the parsed focus preference rule rather than OS focus delivery.
  const focusRule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule.selectorText?.includes("data-focus-ring=\"always\"") && rule.selectorText.includes(':focus'));
  const focusPreference = { outline: focusRule?.style.getPropertyValue('outline'), priority: focusRule?.style.getPropertyPriority('outline') };
  parent.document.getElementById('results').textContent = JSON.stringify({ snapshots, manualReduced, focusPreference, viewportWidth: innerWidth, systemReduced: matchMedia('(prefers-reduced-motion: reduce)').matches });
  ` + '</script></body></html>'
  const file = join(directory, 'fixture.html')
  // Chromium desktop windows clamp to 500px; an iframe supplies a real 375px CSS viewport.
  const fixture = width < 500 ? '<!doctype html><pre id="results"></pre><iframe style="width:' + width + 'px;height:900px;border:0" srcdoc="' + html.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>' : html
  await writeFile(file, fixture)
  const flags = ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=' + width + ',900', '--dump-dom']
  if (reducedMotion) flags.push('--force-prefers-reduced-motion=reduce')
  flags.push(pathToFileURL(file).href)
  const run = spawnSync(chromium, flags, { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const result = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(result, 'browser fixture must publish computed styles')
  return JSON.parse(result[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
}

for (const width of [1280, 375]) {
  test('actual browser panel cascade and buttons remain readable at width ' + width, { skip: !chromium }, async t => {
    const result = await browserStyles(t, { width })
    assert.equal(result.viewportWidth, width, 'browser must use the requested CSS viewport')
    assert.equal(result.snapshots.length, 16)
    for (const sample of result.snapshots) {
      const solid = sample.blur === 'off' || sample.contrast === 'on'
      for (const name of ['card', 'strong', 'masthead', 'modal']) {
        if (solid) {
          assert.equal(sample[name].filter, 'none', JSON.stringify({ width, name, sample }))
          assert.match(sample[name].background, /^rgb\(/, name + ' is opaque in both themes')
        } else {
          assert.match(sample[name].filter, /blur\(/, name + ' keeps the existing frosted surface')
        }
      }
      assert.ok(parseFloat(sample.primary.minHeight) >= 44)
      assert.equal(sample.primary.color, 'rgb(255, 255, 255)')
      assert.equal(sample.link.color, sample.primary.color)
      assert.equal(sample.link.background, sample.primary.background)
      assert.equal(sample.disabled.shadow, 'none')
      if (sample.liquid === 'off' || solid) assert.match(sample.card.shadow, /rgba\(0, 0, 0, 0\)/, 'decorative edge highlight is removed')
      else assert.doesNotMatch(sample.card.shadow, /rgba\(0, 0, 0, 0\) 0px 1px/, 'liquid edge highlight is present')
    }
    assert.equal(result.manualReduced.primary.transition, '0s')
    assert.equal(result.manualReduced.modal.animation, '0s')
    assert.equal(result.focusPreference.outline, '2px solid var(--focus-ring)')
    assert.equal(result.focusPreference.priority, 'important')
  })
}

test('system motion and transparency fallbacks override enhanced surfaces in both themes', { skip: !chromium }, async t => {
  const result = await browserStyles(t, { reducedMotion: true, forceSolid: true })
  assert.equal(result.systemReduced, true)
  for (const sample of result.snapshots) {
    assert.equal(sample.primary.transition, '0s')
    assert.equal(sample.modal.animation, '0s')
    assert.equal(sample.card.filter, 'none')
    assert.equal(sample.modal.filter, 'none')
    assert.match(sample.card.background, /^rgb\(/)
  }
})
