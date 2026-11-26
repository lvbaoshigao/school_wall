import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import * as helpers from '../src/utils/confessions.js'
import * as accountStats from '../src/utils/accountStatistics.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
const root = (extra = {}) => ({ id: 20, wall_id: 3, type: 'confession', confession_kind: 'letter', confession_root_id: 0, content: '**心意**', receiver_id: 2, is_anonymous: true, allow_replies: false, can_reply: false, ...extra })
const accountOverviewData = (counts = {}) => ({ registered_at: '2020-01-02 03:04:05', counts: { walls_joined: 2, friends: 3, named_posts: 4, comments: 5, bookmarks: 6, votes_participated: 7, ...counts } })

async function harness(name, api, { component = false, message = root(), initialWallId = 3 } = {}) {
  const route = Vue.reactive({ name: name === 'ConfessionDetail' ? 'Inbox' : name, fullPath: '/' + name })
  const user = Vue.reactive({ token: 'user-2', sessionRevision: 0, user: { id: 2 }, isLoggedIn: true })
  const wall = Vue.reactive({ currentWallId: initialWallId, loaded: true, myWalls: [] })
  const hooks = { unmount: [], activate: [], deactivate: [] }
  const timers = new Map(), emitted = [], notices = []
  let timerId = 0
  const scope = Vue.effectScope()
  const bindings = {
    ...Vue, ...helpers, ...accountStats, useId: () => 'confession-test',
    useRoute: () => route, useRouter: () => ({ push: path => emitted.push(['route', path]) }),
    useWallStore: () => wall, useUserStore: () => user,
    useSettingsStore: () => ({ prefs: { default_anonymous_confession: true } }),
    useMarkdown: () => ({ renderMarkdown: text => '<p>' + text + '</p>', truncateText: text => text }),
    useTimeAgo: () => ({ timeAgo: () => '刚刚' }),
    useToast: () => Object.fromEntries(['success', 'error', 'info'].map(key => [key, value => notices.push([key, value])])),
    onBeforeUnmount: callback => hooks.unmount.push(callback),
    onActivated: callback => hooks.activate.push(callback), onDeactivated: callback => hooks.deactivate.push(callback),
    api, getApiErrorMessage: (error, fallback) => error?.response?.status === 404 && error?.response?.data?.error === '接口不存在' ? '服务版本尚未更新，请重启后端服务后重试；刷新网页不能更新后端。' : error?.response?.data?.error || fallback,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id),
    window: { getSelection: () => '' },
    Icon: { render: () => null }, SkeletonCard: { render: () => null }, ConfessionDetail: { render: () => null },
    ConfirmModal: { props: ['show'], setup: (props, { slots }) => () => props.show ? Vue.h('section', slots.default?.()) : null },
  }
  const contextSource = await readFile(new URL('../src/composables/useConfessionContext.js', import.meta.url), 'utf8')
  const contextCode = contextSource.replace(/^import[^\n]*\n/gm, '').replace('export function useConfessionContext', 'function useConfessionContext') + '\nreturn useConfessionContext'
  bindings.useConfessionContext = new Function(...Object.keys(bindings), contextCode)(...Object.values(bindings))
  const path = '../src/' + (component ? 'components/' : 'views/') + name + '.vue'
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id: 'confession-test-' + name })
  const code = script.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  const view = new Function(...Object.keys(bindings), code)(...Object.values(bindings))
  const props = Vue.reactive({ message })
  const state = scope.run(() => view.setup(props, { expose() {}, emit: (...args) => emitted.push(args) }))
  return {
    state, route, user, wall, hooks, timers, emitted, notices, props,
    async render() {
      const template = compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: 'confession-test-' + name, compilerOptions: { bindingMetadata: script.bindings } })
      assert.deepEqual(template.errors, [])
      const code = template.code.replace(/^import[^\n]*\n/gm, line => 'const {' + line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ') + '} = Vue;\n').replace('export function render', 'return function render')
      const render = new Function('Vue', code)(Vue)
      const setup = Vue.proxyRefs(state)
      return renderToString(Vue.h({ components: { RouterLink: { props: ['to'], setup: (props, { slots }) => () => Vue.h('a', { href: props.to }, slots.default?.()) } }, render: () => render({}, [], props, setup) }))
    },
    dispose() { hooks.unmount.forEach(callback => callback()); scope.stop() },
  }
}

test('direct payload cannot carry anonymous, title, content, or reply flags; letter preserves Markdown indentation', () => {
  const input = { receiverId: 2, wallId: 3, direct: true, title: 'hidden', content: 'hidden', anonymous: true, allowReplies: true, clientMessageId: 'retry-id' }
  const direct = helpers.confessionPayload(input)
  assert.equal(direct.endpoint, '/messages/confessions/direct')
  assert.deepEqual(direct.payload, { receiver_id: 2, wall_id: 3, client_message_id: 'retry-id' })
  const letter = helpers.confessionPayload({ ...input, direct: false, content: '    code\n', allowReplies: false })
  assert.equal(letter.payload.content, '    code')
  assert.equal(letter.payload.allow_replies, false)
})

test('reply and identity permissions fail closed for missing or false flags and never allow direct replies', () => {
  assert.equal(helpers.canReplyToConfession(root()), false)
  assert.equal(helpers.canReplyToConfession(root({ allow_replies: true, can_reply: true })), true)
  assert.equal(helpers.canReplyToConfession(root({ allow_replies: true, can_reply: false })), false)
  assert.equal(helpers.canReplyToConfession(root({ allow_replies: true, can_reply: true, confession_kind: 'direct' })), false)
  assert.equal(helpers.canRequestConfessionIdentity(root(), 2), true)
  for (const changed of [{ receiver_id: 3 }, { identity_request: { status: 'rejected' } }, { revealed_sender: { id: 1 } }, { is_anonymous: false }, { confession_kind: 'reply' }]) assert.equal(helpers.canRequestConfessionIdentity(root(changed), 2), false)
})

test('direct composer hides title and content and sends only the explicit direct contract', async t => {
  const posts = []
  const view = await harness('WriteConfession', { post: async (...args) => { posts.push(args); return { data: {} } } }); t.after(view.dispose)
  view.state.direct.value = true
  view.state.selectedUser.value = { id: 8, nickname: '收信人' }
  view.state.title.value = 'hidden'; view.state.content.value = 'hidden'
  const html = await view.render()
  assert.doesNotMatch(html, /id="confession-title"|id="confession-content"/)
  assert.match(html, /实名直接表白/)
  await view.state.submit()
  assert.equal(posts[0][0], '/messages/confessions/direct')
  assert.deepEqual(Object.keys(posts[0][1]).sort(), ['client_message_id', 'receiver_id', 'wall_id'])
  assert.equal(view.state.success.value, true)
})

test('failed letter submit retains draft and idempotency key, while switching walls rejects the old success', async t => {
  const pending = deferred(), posts = []
  const view = await harness('WriteConfession', { post: (...args) => { posts.push(args); return posts.length === 1 ? Promise.reject(new Error('offline')) : pending.promise } }); t.after(view.dispose)
  view.state.selectedUser.value = { id: 8 }
  view.state.content.value = '    indented code'
  await view.state.submit()
  assert.equal(view.state.content.value, '    indented code')
  assert.equal(view.state.loading.value, false)
  const retry = view.state.submit()
  assert.equal(posts[0][1].client_message_id, posts[1][1].client_message_id)
  view.wall.currentWallId = 9
  assert.equal(posts[1][2].signal.aborted, true)
  pending.resolve({ data: {} }); await retry
  assert.equal(view.state.success.value, false)
  assert.equal(view.state.selectedUser.value, null)
  assert.equal(view.timers.size, 0)
})

test('recipient search ignores a response after the account changes', async t => {
  const pending = deferred(); let config
  const view = await harness('WriteConfession', { get: (_path, options) => { config = options; return pending.promise } }); t.after(view.dispose)
  view.state.searchQuery.value = '收信人'; await settle()
  const search = [...view.timers.values()][0]()
  view.user.token = 'another-account'; view.user.sessionRevision++
  pending.resolve({ data: [{ id: 8 }] }); await search
  assert.equal(config.signal.aborted, true)
  assert.deepEqual(view.state.searchResults.value, [])
})

test('identity modal keeps optional Markdown text on cancel/failure and sends only after confirmation', async t => {
  const posts = []
  const view = await harness('ConfessionDetail', { get: async () => ({ data: { confession: root({ is_read: 1 }), messages: [] } }), post: async (...args) => { posts.push(args); throw new Error('offline') } }, { component: true }); t.after(view.dispose)
  await settle()
  view.state.openIdentityConfirm()
  view.state.identityMessage.value = '    附言代码'
  assert.equal(posts.length, 0)
  view.state.showIdentityConfirm.value = false
  view.state.openIdentityConfirm()
  assert.equal(view.state.identityMessage.value, '    附言代码')
  await view.state.requestIdentity()
  assert.deepEqual(posts[0][1], { message: '    附言代码', confirmed: true })
  assert.equal(view.state.identityMessage.value, '    附言代码')
  assert.match(view.state.actionError.value, /失败/)
  assert.equal(view.state.canRequestIdentity.value, true)
})

test('identity approval is the only source of disclosed sender and pending requests disable a second request', async t => {
  const view = await harness('ConfessionDetail', { get: async () => ({ data: { confession: root({ is_read: 1 }), messages: [] } }), post: async () => ({ data: { request: { id: 7, status: 'pending' } } }) }, { component: true }); t.after(view.dispose)
  await settle(); await view.state.requestIdentity()
  assert.equal(view.state.canRequestIdentity.value, false)
  assert.equal(view.state.confession.value.revealed_sender, undefined)
  assert.match(await view.render(), /等待写信人处理/)
  view.state.confession.value = root({ revealed_sender: { id: 1, nickname: '已同意的写信人' }, identity_request: { status: 'approved' } })
  assert.match(await view.render(), /已同意的写信人/)
})

test('closed replies hide the reply form; allowed replies use root endpoint and preserve failure text', async t => {
  const posts = []
  const view = await harness('ConfessionDetail', { get: async () => ({ data: { confession: root({ is_read: 1 }), messages: [] } }), post: async (...args) => { posts.push(args); throw new Error('offline') } }, { component: true }); t.after(view.dispose)
  await settle()
  assert.doesNotMatch(await view.render(), /发送回复/)
  view.state.confession.value = root({ allow_replies: true, can_reply: true })
  assert.match(await view.render(), /发送回复/)
  view.state.replyContent.value = '    reply code'
  await view.state.sendReply()
  assert.equal(posts[0][0], '/messages/confessions/20/replies')
  assert.equal(posts[0][1].content, '    reply code')
  assert.equal(posts[0][1].receiver_id, undefined)
  assert.equal(view.state.replyContent.value, '    reply code')
})

test('thread marks only visible received messages read with explicit wall context', async t => {
  const puts = []
  const view = await harness('ConfessionDetail', { get: async () => ({ data: { confession: root(), messages: [{ id: 21, receiver_id: 2, is_read: 0 }, { id: 22, receiver_id: null, is_read: 0 }] } }), put: async (...args) => { puts.push(args); return {} } }, { component: true }); t.after(view.dispose)
  await settle()
  assert.deepEqual(puts[0][1], { ids: [20, 21] })
  assert.equal(puts[0][2].headers['X-Wall-Id'], 3)
  assert.deepEqual(view.emitted.find(event => event[0] === 'read'), ['read', [20, 21]])
})

test('route departure and KeepAlive deactivation abort pending work and activation reloads Inbox', async t => {
  let reads = 0
  const view = await harness('Inbox', { get: async path => { reads++; return { data: path.endsWith('/inbox') ? { messages: [], unreadCounts: {}, totalUnread: 0 } : path.endsWith('/approvals') ? {} : { requests: [] } } } }); t.after(view.dispose)
  await settle(); const initial = reads
  view.route.name = 'Home'; view.route.fullPath = '/'
  view.hooks.deactivate.forEach(fn => fn()); await settle()
  assert.equal(reads, initial)
  view.route.name = 'Inbox'; view.route.fullPath = '/Inbox'
  view.hooks.activate.forEach(fn => fn()); await settle()
  assert.equal(reads, initial + 3)
})

test('statistics ignores out-of-order filters and resets selected details across a wall change', async t => {
  const first = deferred(), second = deferred(); let lists = 0
  const view = await harness('ConfessionStats', { get: async (path, config) => {
    if (path.endsWith('/auth/statistics')) return { data: accountOverviewData() }
    assert.equal(config.params.wall_id, 3)
    if (path.endsWith('/stats')) return { data: { anonymous: 2, named: 1, total: 3 } }
    return ++lists === 1 ? first.promise : second.promise
  } }); t.after(view.dispose)
  view.state.showDetails('1'); view.state.showDetails('0')
  second.resolve({ data: { messages: [root({ id: 50, is_anonymous: false })], total: 1, page: 1, hasMore: false } }); await settle()
  first.resolve({ data: { messages: [root({ id: 40 })], total: 2, page: 1, hasMore: false } }); await settle()
  assert.equal(view.state.messages.value[0].id, 50)
  view.state.selected.value = 50
  view.wall.currentWallId = 4
  assert.equal(view.state.selected.value, null)
  assert.deepEqual(view.state.messages.value, [])
})

test('failed statistics page retains page cursor for correct retry and can recover', async t => {
  let attempts = 0
  const view = await harness('ConfessionStats', { get: async (path, config) => {
    if (path.endsWith('/auth/statistics')) return { data: accountOverviewData() }
    if (path.endsWith('/stats')) return { data: { anonymous: 0, named: 0, total: 20 } }
    if (++attempts === 1) throw new Error('offline')
    return { data: { messages: [], total: 20, page: config.params.page, hasMore: false } }
  } }); t.after(view.dispose)
  await view.state.loadDetails(2)
  assert.equal(view.state.requestedPage.value, 2)
  assert.match(view.state.listError.value, /失败/)
  await view.state.loadDetails(view.state.requestedPage.value)
  assert.equal(view.state.page.value, 2)
  assert.equal(view.state.listError.value, '')
})

test('an account without a wall can open system Inbox without an invalid empty wall header', async t => {
  const calls = []
  const view = await harness('Inbox', { get: async (path, config) => { calls.push([path, config]); return { data: path.endsWith('/inbox') ? { messages: [{ id: 1, type: 'system' }] } : path.endsWith('/approvals') ? {} : { requests: [] } } } }); t.after(view.dispose)
  await settle()
  calls.length = 0
  view.wall.currentWallId = null
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(calls.some(([path]) => path.endsWith('/identity-requests')), false)
  assert.equal(calls.every(([, config]) => !config.headers), true)
  assert.equal(view.state.messages.value[0].type, 'system')
})

test('identity confirmation can send an optional empty note successfully', async t => {
  const posts = []
  const view = await harness('ConfessionDetail', { get: async () => ({ data: { confession: root({ is_read: 1 }), messages: [] } }), post: async (...args) => { posts.push(args); return { data: { request: { id: 7, status: 'pending' } } } } }, { component: true }); t.after(view.dispose)
  await settle()
  await view.state.requestIdentity()
  assert.deepEqual(posts[0][1], { message: '', confirmed: true })
  assert.equal(view.state.canRequestIdentity.value, false)
})

test('Inbox author decisions use confirmation intent and stale account responses cannot disclose UI state', async t => {
  const decision = deferred(), puts = []
  const item = { id: 7, message_id: 20, wall_id: 3, status: 'pending', is_author: true, requester: { id: 2, nickname: '收信人' } }
  const view = await harness('Inbox', { get: async path => ({ data: path.endsWith('/inbox') ? { messages: [] } : path.endsWith('/approvals') ? {} : { requests: [item] } }), put: (...args) => { puts.push(args); return decision.promise } }); t.after(view.dispose)
  await settle()
  view.state.prepareIdentityDecision(item, true)
  assert.equal(puts.length, 0)
  const response = view.state.decideIdentity()
  assert.deepEqual(puts[0][1], { decision: 'approve' })
  view.user.sessionRevision++
  decision.resolve({ data: { request: { ...item, status: 'approved' } } }); await response
  assert.equal(view.notices.length, 0)
  assert.equal(view.state.identityRequests.value.some(request => request.status === 'approved'), false)
})

test('account overview dates preserve SQLite local time and safely reject invalid or future values', () => {
  const date = accountStats.parseRegisteredAt('2020-01-02 03:04:05')
  assert.ok(date instanceof Date)
  assert.equal(date.getHours(), 3)
  assert.equal(accountStats.parseRegisteredAt('2020-02-30 03:04:05'), null)
  assert.equal(accountStats.joinedDays('invalid date'), null)
  assert.equal(accountStats.joinedDays('2099-01-01 00:00:00', Date.now()), null)
  assert.equal(accountStats.joinedDays('2020-01-02 00:00:00', date.getTime()), 1)
  assert.equal(accountStats.joinedDays('2020-01-02 00:00:00', date.getTime() + 86400000), 2)
})

test('account overview normalization requires every non-negative integer field', () => {
  assert.deepEqual(accountStats.normalizeAccountOverview(accountOverviewData()), accountOverviewData())
  for (const value of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(accountStats.normalizeAccountOverview(accountOverviewData({ friends: value })), null)
  }
  assert.equal(accountStats.normalizeAccountOverview({ ...accountOverviewData(), registered_at: 7 }), null)
})

test('statistics SFC renders account metrics and current-wall confession summaries independently', async t => {
  let overviewConfig
  const view = await harness('ConfessionStats', { get: async (path, config) => {
    if (path.endsWith('/auth/statistics')) { overviewConfig = config; return { data: accountOverviewData({ walls_joined: 8 }) } }
    if (path.endsWith('/stats')) return { data: { anonymous: 2, named: 1, total: 3 } }
    return { data: { messages: [], total: 0, page: 1, hasMore: false } }
  } }); t.after(view.dispose)
  await settle()
  const html = await view.render()
  assert.equal(overviewConfig.params, undefined)
  assert.equal(overviewConfig.headers, undefined)
  assert.match(html, /<h2>统计信息/)
  assert.match(html, /账号概览/)
  assert.match(html, /账号 ID：2/)
  assert.match(html, /加入校园墙/)
  assert.match(html, /实名发帖/)
  assert.match(html, /参与投票/)
  assert.match(html, /匿名发帖不归属于账号/)
  assert.match(html, /表白统计（当前校园墙）/)
  assert.match(html, /收到表白总共/)
})

test('account overview failure leaves confession statistics usable and retry recovers', async t => {
  let accountAttempts = 0
  const view = await harness('ConfessionStats', { get: async path => {
    if (path.endsWith('/auth/statistics')) {
      if (++accountAttempts === 1) throw new Error('offline')
      return { data: accountOverviewData() }
    }
    if (path.endsWith('/stats')) return { data: { anonymous: 2, named: 1, total: 3 } }
    return { data: { messages: [], total: 0, page: 1, hasMore: false } }
  } }); t.after(view.dispose)
  await settle()
  assert.equal(view.state.overview.value, null)
  assert.match(view.state.overviewError.value, /失败/)
  assert.equal(view.state.stats.value.total, 3)
  await view.state.loadOverview()
  assert.equal(view.state.overview.value.counts.friends, 3)
  assert.equal(view.state.overviewError.value, '')
})

test('statistics account overview ignores stale responses after session identity changes', async t => {
  const old = deferred(), fresh = deferred(); let attempts = 0
  const view = await harness('ConfessionStats', { get: path => {
    if (path.endsWith('/auth/statistics')) return ++attempts === 1 ? old.promise : fresh.promise
    if (path.endsWith('/stats')) return Promise.resolve({ data: { anonymous: 0, named: 0, total: 0 } })
    return Promise.resolve({ data: { messages: [], total: 0, page: 1, hasMore: false } })
  } }); t.after(view.dispose)
  const oldSignal = view.state.overviewRequest.signal
  view.user.user.id = 9
  assert.equal(oldSignal.aborted, true)
  fresh.resolve({ data: accountOverviewData({ friends: 9 }) }); await settle()
  old.resolve({ data: accountOverviewData({ friends: 1 }) }); await settle()
  assert.equal(view.state.overview.value.counts.friends, 9)
})

test('statistics with no wall keeps global account overview and offers wall selection without redirecting', async t => {
  const calls = []
  const view = await harness('ConfessionStats', { get: async (path, config) => {
    calls.push([path, config])
    if (path.endsWith('/auth/statistics')) return { data: accountOverviewData() }
    throw new Error('wall endpoints must not run without a wall')
  } }, { initialWallId: null }); t.after(view.dispose)
  await settle()
  const html = await view.render()
  assert.equal(calls.filter(([path]) => path.endsWith('/auth/statistics')).length, 1)
  assert.equal(calls.some(([path]) => path.includes('/messages/confessions/')), false)
  assert.match(html, /账号概览/)
  assert.match(html, /选择校园墙/)
  assert.match(html, /href="\/walls"/)
  assert.match(html, /账号概览不受影响/)
  assert.doesNotMatch(html, /href="\/login"/)
})

test('legacy account-statistics endpoint error uses shared restart-backend guidance', async t => {
  const view = await harness('ConfessionStats', { get: async path => {
    if (path.endsWith('/auth/statistics')) throw { response: { status: 404, data: { error: '接口不存在' } } }
    if (path.endsWith('/stats')) return { data: { anonymous: 0, named: 0, total: 0 } }
    return { data: { messages: [], total: 0, page: 1, hasMore: false } }
  } }); t.after(view.dispose)
  await settle()
  assert.match(view.state.overviewError.value, /重启后端服务/)
  assert.match(await view.render(), /刷新网页不能更新后端/)
})
