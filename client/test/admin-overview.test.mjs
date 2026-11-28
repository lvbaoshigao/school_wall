import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { getApiErrorMessage } from '../src/api/index.js'
import * as helpers from '../src/utils/adminOverview.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Run the real SFC setup/template with the existing Vue compiler, without adding a DOM dependency.
async function componentHarness(path, bindings = {}, props = {}) {
  const source = await readFile(new URL('../src/' + path, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'admin-overview-test' })
  const lifecycle = { mounted: [], unmount: [] }
  const deps = { ...Vue, ...helpers, count: helpers.formatOverviewCount, getApiErrorMessage,
    onMounted: fn => lifecycle.mounted.push(fn), onBeforeUnmount: fn => lifecycle.unmount.push(fn),
    Icon: { render: () => null }, ...bindings }
  const executable = script.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  const component = new Function(...Object.keys(deps), executable)(...Object.values(deps))
  const events = []
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {}, emit: (...args) => events.push(args) }))
  const compiled = compileTemplate({ source: descriptor.template.content, filename: path, id: 'admin-overview-test', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(compiled.errors, [])
  const code = compiled.code.replace(/^import[^\n]*\n/gm, line => {
    const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
    return 'const {' + names + '} = Vue;\n'
  }).replace('export function render', 'return function render')
  const render = new Function('Vue', code)(Vue)
  return { state, events, source, descriptor,
    mount() { lifecycle.mounted.forEach(fn => fn()) },
    async settle() { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve() },
    render() { return renderToString(Vue.h({ render: () => render({}, [], props, Vue.proxyRefs(state)) })) },
    dispose() { lifecycle.unmount.forEach(fn => fn()); scope.stop() },
  }
}

async function overviewHarness(t, props = {}) {
  const requests = []
  const h = await componentHarness('components/admin/AdminOverview.vue', { api: { get(path, options) {
    const pending = deferred()
    requests.push({ path, options, ...pending })
    return pending.promise
  } } }, { wallId: null, wallName: '', globalScope: true, canNavigate: () => false, ...props })
  t.after(() => h.dispose())
  return { ...h, requests }
}

function payload({ wallId = null, days = 7, posts = 5, users = 12, walls = 1 } = {}) {
  return { schema_version: 1, generated_at: '2026-11-28T09:30:00.000Z',
    scope: { kind: wallId ? 'wall' : 'global', wall_id: wallId, available_wall_count: walls, global_stats: !wallId },
    range: { days, start_date: '2026-11-22', end_date: '2026-11-28', timezone: 'Asia/Shanghai', date_basis: 'server-local', includes_today: true },
    totals: { users, active_users: users, banned_users: 0, walls, active_walls: walls, members: 20, posts, anonymous_posts: 2, comments: 4, votes: 2, likes: 10, announcements: 3, pending: 2 },
    today: { users: users == null ? null : 1, posts: 2, comments: 1, votes: 0, members: 1 },
    daily: Array.from({ length: days }, (_, index) => ({ date: new Date(Date.UTC(2026, 10, 29 - days + index)).toISOString().slice(0, 10), users: users == null ? null : 0, posts: index === days - 1 ? 2 : 0, comments: 0, votes: 0, members: 0 })),
    walls: Array.from({ length: walls }, (_, index) => ({ id: wallId || index + 1, name: '校园墙' + (index + 1), status: 'active', members: 20, pending_members: null, posts, comments: 4, votes: 2, posts_in_range: 2, pending_post_reports: 2, pending_safety_reports: null })),
    walls_meta: { total: walls, limit: 100, truncated: false },
    pending: { members: null, wall_applications: null, post_reports: 2, safety_reports: null, user_reports: null, bug_reports: null, total: 2 },
    todos: [{ key: 'post_reports', title: '待处理帖子举报', count: 2, wall_id: wallId || 1, permission: 'wall.post.report' }],
    todos_meta: { total: 1, limit: 30, truncated: false }, system: null,
  }
}

function respond(request, data = payload()) { request.resolve({ data }) }

test('normalization preserves permission nulls, real zeros and the versioned contract', () => {
  const data = payload({ users: null })
  data.totals.posts = -1
  data.daily[0].comments = '4'
  const valid = helpers.normalizeAdminOverview(data)
  assert.equal(valid.totals.users, null)
  assert.equal(valid.totals.banned_users, 0)
  assert.equal(valid.totals.posts, null)
  assert.equal(valid.daily[0].comments, null)
  assert.equal(valid.daily.length, 7)
  assert.equal(helpers.formatOverviewCount(null), '—')
  assert.equal(helpers.formatOverviewCount(0), '0')
  assert.equal(helpers.normalizeAdminOverview({ ...data, schema_version: 2 }), null)
})

test('trend uses zero baseline, gaps for unavailable values and finite single/empty coordinates', () => {
  const trend = helpers.buildOverviewTrend([{ date: 'a', posts: 0 }, { date: 'b', posts: null }, { date: 'c', posts: 9 }], 'posts')
  assert.equal(trend.total, 9)
  assert.equal(trend.ticks[0].value, 0)
  assert.equal(trend.points[0].y, trend.height - trend.bottom)
  assert.equal(trend.points[1].y, null)
  assert.equal((trend.path.match(/M/g) || []).length, 2)
  for (const rows of [[], [{ date: 'a', posts: 0 }], Array.from({ length: 90 }, (_, index) => ({ date: String(index), posts: 0 }))]) {
    const plotted = helpers.buildOverviewTrend(rows, 'posts')
    assert.doesNotMatch(plotted.path, /NaN|Infinity/)
    assert.ok(plotted.labels.length <= 8)
  }
})

test('initial loading is announced and a global request does not implicitly select the current wall', async t => {
  const h = await overviewHarness(t)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].path, '/admin/overview')
  assert.deepEqual(h.requests[0].options.params, { days: 7 })
  assert.equal(h.state.loading.value, true)
  const html = await h.render()
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /正在加载概览/)
  assert.match(html, /role="status"/)
  assert.doesNotMatch(html, /活动趋势/)
  respond(h.requests[0]); await h.settle()
  assert.equal(h.state.loading.value, false)
})

test('wall requests explicitly align query and header; unavailable users are hidden, not reported as zero', async t => {
  const h = await overviewHarness(t, { wallId: 9, wallName: '本墙', globalScope: false })
  assert.deepEqual(h.requests[0].options.params, { days: 7, wall_id: 9 })
  assert.equal(h.requests[0].options.headers['X-Wall-Id'], '9')
  respond(h.requests[0], payload({ wallId: 9, users: null })); await h.settle()
  assert.equal(h.state.summaryCards.value.some(card => card.key === 'users'), false)
  assert.equal(h.state.shownMetrics.value.some(option => option.key === 'users'), false)
  const html = await h.render()
  assert.match(html, /待审成员/)
  assert.match(html, />—</)
  assert.doesNotMatch(html, /新注册用户/)
  assert.doesNotMatch(html, /统计范围/)
})

test('changing wall or range cancels stale work and cannot display another scope response', async t => {
  const h = await overviewHarness(t)
  const original = h.requests[0]
  h.state.days.value = 30
  assert.equal(original.options.signal.aborted, true)
  assert.equal(h.requests[1].options.params.days, 30)
  respond(h.requests[1], payload({ days: 30, posts: 30 })); await h.settle()
  respond(original, payload({ posts: 999 })); await h.settle()
  assert.equal(h.state.overview.value.totals.posts, 30)
  h.state.selectedWallId.value = '2'
  assert.equal(h.state.overview.value, null)
  const filtered = h.requests[2]
  assert.equal(filtered.options.headers['X-Wall-Id'], '2')
  respond(filtered, payload({ wallId: 3, days: 30 })); await h.settle()
  assert.equal(h.state.overview.value, null)
  assert.match(h.state.error.value, /数据格式无效/)
  assert.equal(h.state.loading.value, false)
})

test('refresh retains known data on network failure, supports retry and clears it after denied access', async t => {
  const h = await overviewHarness(t)
  respond(h.requests[0]); await h.settle()
  const refresh = h.state.loadOverview()
  assert.equal(h.state.overview.value.totals.posts, 5)
  h.requests[1].reject({ request: {}, code: 'ECONNABORTED' }); await refresh
  assert.match(h.state.error.value, /超时/)
  assert.match(await h.render(), /保留上次成功加载的数据/)
  const retry = h.state.loadOverview()
  respond(h.requests[2], payload({ posts: 8 })); await retry
  assert.equal(h.state.error.value, '')
  assert.equal(h.state.overview.value.totals.posts, 8)
  const denied = h.state.loadOverview()
  h.requests[3].reject({ response: { status: 403, data: { error: '权限已变更' } } }); await denied
  assert.equal(h.state.overview.value, null)
  assert.equal(h.state.wallChoices.value.length, 0)
  assert.match(await h.render(), /权限已变更/)
})

test('unmount aborts in-flight work and ignores late results or errors', async t => {
  const h = await overviewHarness(t)
  h.dispose()
  assert.equal(h.requests[0].options.signal.aborted, true)
  respond(h.requests[0]); await h.settle()
  assert.equal(h.state.overview.value, null)
  assert.equal(h.state.error.value, '')
  await h.state.loadOverview()
  assert.equal(h.requests.length, 1)
})

test('rendered overview has a labelled SVG, data table, scoped actions, escaped names and pagination', async t => {
  const h = await overviewHarness(t, { canNavigate: todo => todo.key === 'post_reports' })
  const data = payload({ walls: 12 })
  data.walls[0].name = '<img src=x onerror=alert(1)>'
  data.todos_meta.truncated = true
  data.todos_meta.total = 40
  data.walls_meta.truncated = true
  data.walls_meta.total = 130
  data.system = { uptime_seconds: 90061, memory: { rss_bytes: 10485760, heap_used_bytes: 1048576 }, database: { temporary: true, dirty: true }, visits: { window_minutes: 60, visitors: 4, requests: 12, identity_limit: 50000, bounded: true } }
  respond(h.requests[0], data); await h.settle()
  assert.equal(h.state.visibleWalls.value.length, 10)
  assert.equal(h.state.wallPageCount.value, 2)
  let html = await h.render()
  assert.match(html, /role="img" aria-label="新增帖子/)
  assert.match(html, /<table>/)
  assert.match(html, /scope="col"/)
  assert.match(html, /scope="row"/)
  assert.match(html, /aria-label="去处理待处理帖子举报"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /共 40 组/)
  assert.match(html, /共 130 个/)
  assert.match(html, /1 天 1 小时 1 分钟/)
  assert.match(html, /4 个访问标识/)
  assert.match(html, /12 次已追踪 API 请求/)
  assert.match(html, /标识上限 50,000/)
  assert.match(html, /达到上限时可能低估/)
  assert.match(html, /不等于独立用户数/)
  assert.match(html, /服务重启后重置/)
  h.state.wallPage.value = 2
  html = await h.render()
  assert.equal(h.state.visibleWalls.value.length, 2)
  assert.match(html, /校园墙12/)
  assert.doesNotMatch(html, /<h5>校园墙2</)
})

test('empty authorized queues and all-zero trend use explicit empty states', async t => {
  const h = await overviewHarness(t)
  const data = payload({ walls: 0 })
  data.daily.forEach(row => { row.posts = 0 })
  data.todos = []
  data.pending.post_reports = 0
  data.pending.total = 0
  respond(h.requests[0], data); await h.settle()
  const html = await h.render()
  assert.match(html, /此时段暂无新增帖子/)
  assert.match(html, /当前权限范围内暂无待办事项/)
  assert.match(html, /当前权限范围内暂无校园墙统计/)
  assert.doesNotMatch(html, /NaN|Infinity|undefined/)
})

test('styles compile with theme tokens, mobile stacking, chart overflow and visible keyboard focus', async t => {
  const h = await overviewHarness(t)
  const css = h.descriptor.styles[0].content
  const result = compileStyle({ source: css, filename: 'AdminOverview.vue', id: 'admin-overview-test', scoped: true })
  assert.deepEqual(result.errors, [])
  assert.match(css, /@media \(max-width: 600px\)/)
  assert.match(css, /\.system-grid \{ grid-template-columns: 1fr;/)
  assert.match(css, /\.trend-chart-wrap \{[^}]*overflow-x: auto/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /var\(--text-primary\)/)
  assert.doesNotMatch(h.source, /v-html|chart\.js|echarts/)
})

async function adminHarness(t, global = [], walls = {}) {
  const user = Vue.reactive({ user: { id: 1 }, token: 'one', sessionRevision: 0, perms: { global, walls },
    can(permission) { return this.perms.global.includes(permission) },
    canInWall(permission, id) { return (this.perms.walls[id] || this.perms.global).includes(permission) },
  })
  const wall = Vue.reactive({ currentWallId: 1, currentWall: { id: 1, name: '一墙' }, myWalls: [{ id: 1 }, { id: 2 }],
    canHere(permission) { return user.canInWall(permission, this.currentWallId) },
    setCurrentWall(id) { this.currentWallId = id; return true },
  })
  const requests = []
  const h = await componentHarness('views/Admin.vue', {
    useUserStore: () => user, useWallStore: () => wall, useRoute: () => ({ query: {} }),
    api: { get: async path => { requests.push(path); return { data: [] } } },
    useToast: () => ({ error() {}, success() {} }), useFocusTrap() {}, useMarkdown: () => ({}),
    ConfirmModal: { render: () => null },
  })
  t.after(() => h.dispose())
  return { ...h, user, wall, requests }
}

test('overview entry and default follow server stats permissions, preserving business-only access', async t => {
  const global = await adminHarness(t, ['global.dashboard'])
  assert.equal(global.state.hasOverview.value, true)
  assert.equal(global.state.hasGlobalPanel.value, true)
  global.mount()
  assert.equal(global.state.activePanel.value, 'overview')
  const wall = await adminHarness(t, [], { 1: ['wall.stats.view'] })
  assert.equal(wall.state.hasGlobalOverview.value, false)
  wall.mount()
  assert.equal(wall.state.activePanel.value, 'overview')
  const business = await adminHarness(t, ['global.bug.handle'])
  assert.equal(business.state.hasOverview.value, false)
  business.mount()
  assert.equal(business.state.activePanel.value, 'bugReports')
  const visitor = await adminHarness(t)
  visitor.mount()
  assert.equal(visitor.state.activePanel.value, '')
})

test('legacy global statistics label account status and registration counts accurately', async t => {
  const h = await adminHarness(t, ['global.moderate'])
  h.state.activePanel.value = 'gStats'
  h.state.gStats.value = { users: { total: 12, active: 10, banned: 2 }, walls: { total: 1, pendingApps: 0 }, posts: { total: 4, today: 0 }, comments: 0, todayNewUsers: 0 }
  const html = await h.render()
  assert.match(html, /正常状态 10/)
  assert.match(html, /今日注册/)
  assert.doesNotMatch(html, /活跃|注册趋势上升/)
})

test('permission/session/wall context invalidates overview and todo links cannot jump into unrelated walls', async t => {
  const h = await adminHarness(t, ['global.moderate'], { 1: ['wall.stats.view', 'wall.post.report'], 2: ['wall.stats.view', 'wall.post.report'] })
  h.mount()
  const originalKey = h.state.overviewContextKey.value
  h.user.sessionRevision++
  assert.notEqual(h.state.overviewContextKey.value, originalKey)
  assert.equal(h.state.overviewTodoPanel({ key: 'post_reports', wall_id: 99 }), '')
  assert.equal(h.state.overviewTodoPanel({ key: '__proto__', wall_id: 1 }), '')
  assert.equal(h.state.overviewTodoPanel({ key: 'post_reports', wall_id: 2 }), 'postReports')
  h.state.openOverviewTodo({ key: 'post_reports', wall_id: 2 })
  await h.settle()
  assert.equal(h.wall.currentWallId, 2)
  assert.equal(h.state.activePanel.value, 'postReports')
  h.state.switchPanel('overview')
  h.user.perms = { global: [], walls: {} }
  assert.equal(h.state.hasOverview.value, false)
  assert.notEqual(h.state.activePanel.value, 'overview')
})


const chromium = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(path => path && existsSync(path))

async function browserOverview(t, width) {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-admin-overview-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  const vueUrl = moduleUrl(await readFile(new URL('../node_modules/vue/dist/vue.runtime.esm-browser.prod.js', import.meta.url), 'utf8'))
  const helpersUrl = moduleUrl(await readFile(new URL('../src/utils/adminOverview.js', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../src/components/admin/AdminOverview.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const id = 'data-v-overview-browser'
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'AdminOverview.vue', id, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  let css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8')
  for (const style of descriptor.styles) css += compileStyle({ source: style.content, filename: 'AdminOverview.vue', id, scoped: true }).code
  const fixtureData = payload({ walls: 12 })
  fixtureData.walls[0].name = '这是一个用于检查窄屏换行的非常非常非常长的校园墙名称'
  const runner = 'import * as Vue from ' + JSON.stringify(vueUrl) + ';\nimport * as helpers from ' + JSON.stringify(helpersUrl) + ';\n' +
    'try { const result = await (' + overviewBrowserCases.toString() + ')(Vue, helpers, ' + JSON.stringify({ script: script.content, template: template.code, id }) + ', ' + JSON.stringify(fixtureData) + '); parent.document.getElementById("results").textContent = JSON.stringify(result) } catch (error) { parent.document.getElementById("results").textContent = JSON.stringify({ error: error.stack }) }'
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body><main style="max-width:780px;padding:16px;margin:auto"><div id="app"></div></main><script type="module" src="' + moduleUrl(runner) + '"></script></body></html>'
  const fixture = '<!doctype html><pre id="results"></pre><iframe style="width:' + width + 'px;height:900px;border:0" srcdoc="' + html.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>'
  const file = join(directory, 'fixture.html')
  await writeFile(file, fixture)
  const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=1500', pathToFileURL(file).href], { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const match = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(match, 'browser must finish overview checks: ' + run.stderr + run.stdout.slice(-1000))
  const result = JSON.parse(match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  assert.equal(result.error, undefined, result.error)
  return result
}

async function overviewBrowserCases(Vue, helpers, compiled, data) {
  const requests = [], events = []
  let fail = false
  const api = { get(_path, options) {
    requests.push(options.params)
    if (fail) return Promise.reject({ response: { status: 503, data: { error: '暂时离线' } } })
    return Promise.resolve({ data: { ...data, range: { ...data.range, days: options.params.days } } })
  } }
  const deps = { ...Vue, ...helpers, count: helpers.formatOverviewCount, api, getApiErrorMessage: error => error.response?.data?.error || '错误', Icon: { render: () => null } }
  const factory = compiled.script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  const component = new Function(...Object.keys(deps), factory)(...Object.values(deps))
  const renderCode = compiled.template.replace(/^import[^\n]*\n/gm, line => {
    const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
    return 'const {' + names + '} = Vue;\n'
  }).replace('export function render', 'return function render')
  component.render = new Function('Vue', renderCode)(Vue)
  component.__scopeId = compiled.id
  const app = Vue.createApp(component, { globalScope: true, canNavigate: () => true, onNavigate: todo => events.push(todo.key) })
  app.mount('#app')
  async function settle() { for (let index = 0; index < 5; index++) { await Vue.nextTick(); await Promise.resolve() } }
  await settle()
  const snapshots = []
  for (const light of [false, true]) {
    document.body.classList.toggle('light-theme', light)
    const overview = document.querySelector('.overview')
    const chart = document.querySelector('.trend-chart-wrap')
    snapshots.push({ light, width: innerWidth, rootWidth: overview.getBoundingClientRect().width, documentWidth: document.documentElement.scrollWidth,
      cards: getComputedStyle(document.querySelector('.summary-grid')).gridTemplateColumns.split(' ').length,
      chartScrollable: chart.scrollWidth > chart.clientWidth,
      controlHeights: [...document.querySelectorAll('.overview-controls select, .refresh-button')].map(node => node.getBoundingClientRect().height),
      chartLabel: document.querySelector('svg[role="img"]').getAttribute('aria-label'),
    })
  }
  const range = [...document.querySelectorAll('label')].find(node => node.textContent.includes('趋势时段')).querySelector('select')
  range.value = '30'
  range.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  document.querySelector('.todo-list button').click()
  document.querySelector('.trend-details summary').click()
  const tableVisible = document.querySelector('.trend-details').open
  fail = true
  document.querySelector('.refresh-button').click()
  await settle()
  const failedRefresh = Boolean(document.querySelector('[role="alert"]')) && document.querySelector('.overview').textContent.includes('保留上次成功加载的数据')
  fail = false
  document.querySelector('[role="alert"] button').click()
  await settle()
  const retrySucceeded = !document.querySelector('[role="alert"]')
  app.unmount()
  return { snapshots, requests, events, tableVisible, failedRefresh, retrySucceeded }
}

for (const width of [1280, 375]) {
  test('real Chromium overview stays within ' + width + 'px, supports labelled controls and retry in both themes', { skip: !chromium }, async t => {
    const result = await browserOverview(t, width)
    for (const snapshot of result.snapshots) {
      assert.equal(snapshot.width, width)
      assert.ok(snapshot.documentWidth <= width, JSON.stringify(snapshot))
      assert.ok(snapshot.controlHeights.every(height => height >= 44), JSON.stringify(snapshot))
      assert.match(snapshot.chartLabel, /新增帖子/)
      if (width === 375) { assert.equal(snapshot.cards, 2); assert.equal(snapshot.chartScrollable, true) }
    }
    assert.equal(result.requests[1].days, 30)
    assert.deepEqual(result.events, ['post_reports'])
    assert.equal(result.tableVisible, true)
    assert.equal(result.failedRefresh, true)
    assert.equal(result.retrySucceeded, true)
  })
}


// Mount the actual App + Navbar + Admin hierarchy, not a component inside a fixed-width mock main.
// The column flex container's cross-axis sizing is part of this regression.
async function browserAdminShell(t, width) {
  const directory = await mkdtemp(join(tmpdir(), 'school-wall-admin-shell-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  const vueUrl = moduleUrl(await readFile(new URL('../node_modules/vue/dist/vue.runtime.esm-browser.prod.js', import.meta.url), 'utf8'))
  const helperUrl = moduleUrl(await readFile(new URL('../src/utils/adminOverview.js', import.meta.url), 'utf8'))
  const components = {}
  let css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8')
  for (const [name, path] of [['Icon', 'components/Icon.vue'], ['Overview', 'components/admin/AdminOverview.vue'], ['Admin', 'views/Admin.vue'], ['Navbar', 'components/Navbar.vue'], ['App', 'App.vue']]) {
    const { descriptor, errors } = parse(await readFile(new URL('../src/' + path, import.meta.url), 'utf8'))
    assert.deepEqual(errors, [])
    const id = 'data-v-admin-shell-' + name.toLowerCase()
    const script = compileScript(descriptor, { id })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    components[name] = { script: script.content, template: template.code, id }
    for (const style of descriptor.styles) {
      const compiled = compileStyle({ source: style.content, filename: path, id, scoped: style.scoped })
      assert.deepEqual(compiled.errors, [])
      css += compiled.code
    }
  }
  const script = 'import * as Vue from ' + JSON.stringify(vueUrl) + ';\nimport * as helpers from ' + JSON.stringify(helperUrl) + ';\n' +
    'try { const result = await (' + adminShellBrowserCases.toString() + ')(Vue, helpers, ' + JSON.stringify(components) + ', ' + JSON.stringify(payload()) + '); parent.document.getElementById("results").textContent = JSON.stringify(result) } catch (error) { parent.document.getElementById("results").textContent = JSON.stringify({ error: error.stack }) }'
  const page = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body><div id="app"></div><script type="module" src="' + moduleUrl(script) + '"></script></body></html>'
  const fixture = '<!doctype html><pre id="results"></pre><iframe style="width:' + width + 'px;height:900px;border:0" srcdoc="' + page.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>'
  const path = join(directory, 'fixture.html')
  await writeFile(path, fixture)
  const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=1500', pathToFileURL(path).href], { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  const match = run.stdout.match(/<pre id="results">([^<]+)<\/pre>/)
  assert.ok(match, 'full admin shell browser fixture must finish: ' + run.stderr + run.stdout.slice(-1000))
  const result = JSON.parse(match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  assert.equal(result.error, undefined, result.error)
  return result
}

async function adminShellBrowserCases(Vue, helpers, compiled, data) {
  function createComponent(name, bindings) {
    const source = compiled[name]
    const script = source.script.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
    const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
    const render = source.template.replace(/^import[^\n]*\n/gm, line => {
      const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
      return 'const {' + names + '} = Vue;\n'
    }).replace('export function render', 'return function render')
    component.render = new Function('Vue', render)(Vue)
    component.__scopeId = source.id
    return component
  }
  const empty = { render: () => null }
  const route = Vue.reactive({ path: '/admin', fullPath: '/admin', name: 'Admin', query: {} })
  const user = Vue.reactive({ token: 'isolated-test', sessionRevision: 0, user: { id: 1, role: 'super_admin', nickname: '测试管理员' }, perms: { global: ['global.moderate', 'global.dashboard'], walls: {} }, isLoggedIn: true,
    can: () => true, canInWall: () => true, fetchUser: async () => {},
  })
  const wall = Vue.reactive({ currentWallId: 1, currentWall: { id: 1, name: '真实管理外壳验证墙', wall_role: 'owner' }, myWalls: [{ id: 1, name: '真实管理外壳验证墙' }], loaded: true,
    canHere: () => true, fetchMyWalls: async () => {},
  })
  const settings = Vue.reactive({ themeModeInitialized: true, prefs: { theme_mode: 'dark', wallpaper_enabled: false, unread_interval: '0' }, tools: { theme: true, wallpaper: false }, nav: { search: true },
    visibleNav: [{ key: 'home', path: '/', label: '校园动态' }, { key: 'publish', path: '/post/create', label: '发布' }, { key: 'chat', path: '/chat', label: '聊天' }, { key: 'inbox', path: '/inbox', label: '收件箱' }], loadSettings: async () => {},
  })
  const api = { get: async (path, options) => path === '/admin/overview'
    ? { data: { ...data, range: { ...data.range, days: options.params.days } } } : { data: {} } }
  const shared = { ...Vue, ...helpers, count: helpers.formatOverviewCount, api, getApiErrorMessage: (_error, fallback) => fallback,
    useUserStore: () => user, useWallStore: () => wall, useSettingsStore: () => settings,
    useRoute: () => route, useRouter: () => ({ currentRoute: Vue.ref(route), push() {} }),
    useToast: () => ({ error() {}, success() {} }), useFocusTrap() {},
    useMarkdown: () => ({ renderMarkdown: value => value, renderPlainText: value => value, truncateText: value => value }),
    observeScrollProgress: () => () => {}, readStorage: () => null, focusIfActive() {},
    AvatarIcon: empty, ConfirmModal: empty, ToastContainer: empty, BackToTop: empty, PublishFab: empty,
  }
  shared.Icon = createComponent('Icon', shared)
  const Overview = createComponent('Overview', shared)
  const Admin = createComponent('Admin', { ...shared, defineAsyncComponent: () => Overview })
  const Navbar = createComponent('Navbar', shared)
  const App = createComponent('App', { ...shared, Navbar })
  const app = Vue.createApp(App)
  app.component('router-view', { setup(_props, { slots }) { return () => slots.default({ Component: Admin, route }) } })
  app.mount('#app')
  for (let index = 0; index < 12; index++) { await Vue.nextTick(); await Promise.resolve() }
  const snapshots = []
  for (const light of [false, true]) {
    document.body.classList.toggle('light-theme', light)
    const rect = selector => {
      const node = document.querySelector(selector), bounds = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { width: bounds.width, left: bounds.left, right: bounds.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, alignItems: style.alignItems, direction: style.flexDirection }
    }
    const sidebar = document.querySelector('.admin-sidebar'), chart = document.querySelector('.trend-chart-wrap')
    sidebar.scrollLeft = sidebar.scrollWidth
    chart.scrollLeft = chart.scrollWidth
    snapshots.push({ light, width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      main: rect('.main-content'), layout: rect('.admin-layout'), sidebar: rect('.admin-sidebar'), panel: rect('.admin-panel'), overview: rect('.overview'),
      sidebarScrolled: sidebar.scrollLeft, chartScrolled: chart.scrollLeft,
      documentOverflow: getComputedStyle(document.documentElement).overflowX, bodyOverflow: getComputedStyle(document.body).overflowX,
      contentVisible: Boolean(document.querySelector('.summary-grid .metric-value') && document.querySelector('.trend-chart') && document.querySelector('.wall-card')),
    })
  }
  app.unmount()
  return { snapshots }
}

for (const width of [375, 1280]) {
  test('real App/Navbar/Admin shell contains overview and local scroll areas at ' + width + 'px', { skip: !chromium }, async t => {
    const { snapshots } = await browserAdminShell(t, width)
    t.diagnostic(JSON.stringify({ viewport: width, themes: snapshots.map(state => ({ light: state.light, documentWidth: state.documentWidth, bodyWidth: state.bodyWidth, layoutWidth: state.layout.width, panelWidth: state.panel.width, sidebarScroll: state.sidebarScrolled, chartScroll: state.chartScrolled })) }))
    for (const state of snapshots) {
      assert.equal(state.width, width)
      assert.equal(state.contentVisible, true)
      assert.ok(state.documentWidth <= width, JSON.stringify(state))
      assert.ok(state.bodyWidth <= width, JSON.stringify(state))
      assert.ok(state.panel.right <= state.main.right + 1, JSON.stringify(state))
      assert.ok(state.overview.width <= state.panel.width + 1, JSON.stringify(state))
      assert.notEqual(state.documentOverflow, 'hidden')
      assert.notEqual(state.bodyOverflow, 'hidden')
      if (width === 375) {
        assert.equal(state.layout.direction, 'column')
        assert.ok(Math.abs(state.panel.width - state.layout.width) <= 1, JSON.stringify(state))
        assert.ok(state.sidebarScrolled > 0, 'management navigation remains locally scrollable')
        assert.ok(state.chartScrolled > 0, 'wide trend remains locally scrollable')
      } else assert.equal(state.layout.direction, 'row')
    }
  })
}
