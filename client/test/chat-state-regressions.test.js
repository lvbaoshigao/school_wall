import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

// Exercise the actual SFC setup and template with Vue's existing compiler.
// Network, lifecycle and browser services are controlled; no DOM or extra dependency is needed.
async function loadView(name, api, options = {}) {
  const source = await readFile(new URL('../src/views/' + name + '.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id: 'chat-regression-' + name })
  const route = { params: { id: '2' }, query: {} }
  const user = { user: { id: 1 }, can: () => true }
  const wall = { currentWallId: 3, canHere: () => true, myWalls: [], currentWall: null }
  const storage = memoryStorage()
  const lifecycle = []
  const timers = new Map()
  const notifications = []
  const renderedSlots = []
  let timerId = 0
  const ConfirmModal = {
    props: ['show', 'title'],
    setup(props, { slots }) {
      return () => {
        if (!props.show) return null
        const children = slots.default?.() || []
        renderedSlots.push({ title: props.title, children })
        return Vue.h('section', children)
      }
    },
  }
  const bindings = {
    ...Vue,
    onMounted: () => {},
    onBeforeUnmount: callback => lifecycle.push(callback),
    useRoute: () => route, useRouter: () => ({ push() {} }),
    useUserStore: () => user, useWallStore: () => wall,
    useSettingsStore: () => ({ prefs: {} }),
    useToast: () => Object.fromEntries(['success', 'error', 'info', 'warning'].map(kind => [kind, text => notifications.push({ kind, text })])),
    useFocusTrap() {}, useMarkdown: () => ({ truncateText: value => value }),
    api, marked: { setOptions() {}, parse: value => value }, DOMPurify: { sanitize: value => value },
    Icon: { render: () => null }, ConfirmModal, SkeletonCard: {}, PrivateChatComposer: {},
    window: { sessionStorage: storage }, document: { visibilityState: options.visible ? 'visible' : 'hidden', addEventListener() {}, removeEventListener() {} },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId },
    clearTimeout: id => timers.delete(id), clearInterval() {},
  }
  const scope = Vue.effectScope()
  const code = script.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), code)(...Object.values(bindings))
  const state = scope.run(() => component.setup({}, { expose() {} }))
  return {
    state, route, user, wall, storage, timers, notifications, renderedSlots,
    async render() {
      const compiled = compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: 'chat-regression-' + name, compilerOptions: { bindingMetadata: script.bindings } })
      assert.deepEqual(compiled.errors, [])
      const code = compiled.code.replace(/^import[^\n]*\n/gm, line => {
        const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).replace(/ as /g, ': ')
        return 'const {' + names + '} = Vue;\n'
      }).replace('export function render', 'return function render')
      const render = new Function('Vue', code)(Vue)
      const setup = Vue.proxyRefs(state)
      return renderToString(Vue.h({ render: () => render({}, [], {}, setup) }))
    },
    dispose() { lifecycle.forEach(callback => callback()); scope.stop() },
  }
}

const page = (ids, extra = {}) => ({ data: { messages: ids.map(id => ({ id, sender_id: 2, content: 'message ' + id })), ...extra } })

test('locating a message cancels pagination without leaving history locked or restarting polling from the old finally', async t => {
  const older = deferred()
  const around = deferred()
  let oldSignal
  const view = await loadView('ChatRoom', { get: (_path, config) => {
    if (config.params.around_id) return around.promise
    if (config.params.before === 100) { oldSignal = config.signal; return older.promise }
    return Promise.resolve(page([10, 15]))
  } }, { visible: true })
  t.after(() => view.dispose())
  const chat = view.state
  chat.messages.value = page([100]).data.messages
  chat.oldestCursor = 100
  const loadingOlder = chat.loadHistory()
  assert.equal(chat.historyLoading.value, true)
  const locating = chat.jumpToMessage(20)
  assert.equal(oldSignal.aborted, true)
  older.resolve(page([80, 90])) // The server can finish despite an aborted client signal.
  await loadingOlder
  assert.equal(chat.historyLoading.value, false)
  assert.equal(chat.contextLoading.value, true)
  assert.equal(view.timers.size, 0, 'an obsolete finally must not restart the poll timer')
  around.resolve(page([20], { hasMoreBefore: true, next_before_id: 20 }))
  await locating
  assert.equal(chat.contextLoading.value, false)
  await chat.loadHistory()
  assert.deepEqual(chat.messages.value.map(row => row.id), [10, 15, 20])
})

test('returning to latest rejects an old history response and its finally cannot unlock a newer page', async t => {
  const older = deferred()
  const newerPage = deferred()
  let beforeCalls = 0
  const view = await loadView('ChatRoom', { get: (_path, config) => {
    if (config.params.before) return ++beforeCalls === 1 ? older.promise : newerPage.promise
    return Promise.resolve(page([200], { hasMore: true, next_before_id: 200 }))
  } }, { visible: true })
  t.after(() => view.dispose())
  const chat = view.state
  chat.chatUser.value = { nickname: '同学' }
  chat.messages.value = page([100]).data.messages
  chat.oldestCursor = 100
  const first = chat.loadHistory()
  await chat.returnToLatest()
  assert.equal(view.timers.size, 1, 'latest-message loading must resume polling after cancelling history')
  const second = chat.loadHistory()
  assert.equal(beforeCalls, 2, 'return-to-latest must release the old busy flag immediately')
  older.resolve(page([80, 90]))
  await first
  assert.equal(chat.historyLoading.value, true, 'the new request still owns the busy flag')
  assert.equal(view.timers.size, 0, 'the old finally must not restart polling during a newer page')
  assert.deepEqual(chat.messages.value.map(row => row.id), [200])
  newerPage.resolve(page([180, 190]))
  await second
  assert.equal(chat.historyLoading.value, false)
  assert.deepEqual(chat.messages.value.map(row => row.id), [180, 190, 200])
})

test('returning to latest also invalidates an unfinished reply-context request', async t => {
  const around = deferred()
  let signal
  const view = await loadView('ChatRoom', { get: (_path, config) => {
    if (config.params.around_id) { signal = config.signal; return around.promise }
    return Promise.resolve(page([200]))
  } }, { visible: true })
  t.after(() => view.dispose())
  const chat = view.state
  chat.chatUser.value = { nickname: '同学' }
  const locating = chat.jumpToMessage(20)
  await chat.returnToLatest()
  assert.equal(signal.aborted, true)
  assert.equal(view.timers.size, 1, 'return-to-latest resumes polling after cancelling context loading')
  const pollingTimers = [...view.timers.keys()]
  around.resolve(page([20]))
  await locating
  assert.deepEqual([...view.timers.keys()], pollingTimers, 'the old context finally must not replace the current poll timer')
  assert.equal(chat.contextLoading.value, false)
  assert.equal(chat.viewingContext.value, false)
  assert.deepEqual(chat.messages.value.map(row => row.id), [200])
})

test('a failed history page keeps its cursor and can be retried', async t => {
  let attempts = 0
  const view = await loadView('ChatRoom', { get: async () => {
    if (++attempts === 1) throw new Error('offline')
    return page([80, 90], { hasMore: true, next_before_id: 80 })
  } })
  t.after(() => view.dispose())
  const chat = view.state
  chat.messages.value = page([100]).data.messages
  chat.oldestCursor = 100
  await chat.loadHistory()
  assert.match(chat.historyError.value, /重试/)
  assert.equal(chat.historyLoading.value, false)
  assert.equal(chat.oldestCursor, 100)
  await chat.loadHistory()
  assert.equal(chat.historyError.value, '')
  assert.deepEqual(chat.messages.value.map(row => row.id), [80, 90, 100])
})

test('private message retry reuses its client id and reconciles a single confirmed message', async t => {
  const posts = []
  let delivered
  const view = await loadView('ChatRoom', {
    post: async (_path, body) => {
      posts.push(body)
      if (posts.length === 1) throw new Error('delivery acknowledgement lost')
      delivered = { id: 21, sender_id: 1, content: body.content, client_message_id: body.client_message_id }
      return { data: { message_item: delivered } }
    },
    get: async () => ({ data: { messages: [delivered] } }),
  })
  t.after(() => view.dispose())
  const chat = view.state
  chat.loading.value = false
  chat.chatUser.value = { nickname: '同学' }
  chat.draftOwner = { accountId: '1', peerId: '2' }
  chat.newMessage.value = '保留的消息'
  await chat.sendMessage()
  assert.equal(chat.outbox.value[0].status, 'failed')
  const record = chat.outbox.value[0]
  await chat.retryMessage(record)
  assert.equal(posts.length, 2)
  assert.equal(posts[0].client_message_id, posts[1].client_message_id)
  assert.equal(posts[1].content, '保留的消息')
  assert.equal(chat.outbox.value.length, 0)
  assert.equal(chat.messages.value.length, 1)
})

test('draft text is restored only for its account and peer, and previous-account drafts can be cleared', async t => {
  const view = await loadView('ChatRoom', { get: async path => path.startsWith('/auth/') ? { data: { nickname: '同学' } } : page([]) })
  t.after(() => view.dispose())
  const chat = view.state
  await chat.openConversation()
  chat.newMessage.value = '写给乙的草稿'
  view.route.params.id = '3'
  await chat.openConversation()
  assert.equal(chat.newMessage.value, '')
  chat.newMessage.value = '写给丙的草稿'
  view.route.params.id = '2'
  await chat.openConversation()
  assert.equal(chat.newMessage.value, '写给乙的草稿')
  view.user.user.id = 9
  await chat.openConversation()
  assert.equal(chat.newMessage.value, '')
  chat.clearAccountDrafts(1)
  assert.equal(view.storage.getItem('school_wall:private-draft:v1:1:2'), null)
  assert.equal(view.storage.getItem('school_wall:private-draft:v1:1:3'), null)
})

async function adminView(t) {
  const requests = []
  const view = await loadView('Admin', {
    put: async (path, body) => { requests.push({ path, body }); return { data: { message: '已处理' } } },
    post: async (path, body) => { requests.push({ path, body }); return { data: { message: '已封禁' } } },
    get: async () => ({ data: [] }),
  })
  t.after(() => view.dispose())
  return { ...view, requests }
}

test('the warning dialog submits the selected report id, action and warning text', async t => {
  const view = await adminView(t)
  const admin = view.state
  admin.reportFeedback.value = '上次的处理反馈'
  await admin.reviewUserReport(17, 'warn')
  assert.equal(admin.showWarnConfirm.value, true)
  admin.warnText.value = ' 请保持友善交流 '
  await admin.doReviewUserReport()
  assert.deepEqual(view.requests, [{ path: '/admin/user-reports/17/review', body: { action: 'warn', warning_text: '请保持友善交流', feedback: '' } }])
})

test('the timed ban dialog submits the chosen report and duration', async t => {
  const view = await adminView(t)
  await view.state.reviewUserReport(23, 'ban')
  view.state.banReportDuration.value = '60'
  await view.state.doReviewUserReport()
  assert.deepEqual(view.requests, [{ path: '/admin/user-reports/23/review', body: { action: 'ban', duration: 60, feedback: '' } }])
})

test('invalid timed ban durations do not silently turn into a different ban', async t => {
  const view = await adminView(t)
  for (const duration of ['', '0', '-1', '1.5', '60minutes', '525601']) {
    await view.state.reviewUserReport(23, 'ban')
    view.state.banReportDuration.value = duration
    await view.state.doReviewUserReport()
  }
  assert.equal(view.requests.length, 0)
})

function descendants(nodes) {
  return nodes.flatMap(node => [node, ...(Array.isArray(node.children) ? descendants(node.children) : [])])
}

test('wall ban dialog renders editable duration and reason fields wired into the real submission', async t => {
  const view = await adminView(t)
  await view.state.banMember({ user_id: 8, nickname: '同学' })
  await view.render()
  const dialog = view.renderedSlots.find(slot => slot.title === '禁入本墙')
  assert.ok(dialog, 'the wall ban dialog is rendered')
  const fields = descendants(dialog.children)
  const duration = fields.find(node => node.type === 'input' && node.props.type === 'number')
  const reason = fields.find(node => node.type === 'textarea')
  assert.ok(duration, 'the administrator can edit the duration')
  assert.ok(reason, 'the required reason has an editable field')
  duration.props['onUpdate:modelValue']('90')
  reason.props['onUpdate:modelValue'](' 多次发布辱骂内容 ')
  await view.state.doBanMember()
  assert.deepEqual(view.requests, [{ path: '/walls/3/members/8/ban', body: { duration: 90, reason: '多次发布辱骂内容' } }])
})

test('wall ban validation preserves zero as permanent and rejects invalid durations', async t => {
  const view = await adminView(t)
  for (const duration of ['', '-1', '1.5', '60minutes', '525601']) {
    await view.state.banMember({ user_id: 8 })
    view.state.banDuration.value = duration
    view.state.banReason.value = '原因'
    await view.state.doBanMember()
  }
  assert.equal(view.requests.length, 0)
  await view.state.banMember({ user_id: 8 })
  view.state.banDuration.value = '0'
  view.state.banReason.value = '原因'
  await view.state.doBanMember()
  assert.equal(view.requests[0].body.duration, 0)
})
