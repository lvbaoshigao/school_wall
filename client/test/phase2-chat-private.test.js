import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import http from 'node:http'
import { ref, computed, reactive } from 'vue'
import { parse, compileTemplate } from '@vue/compiler-sfc'

const pending = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function memoryStorage() {
  const data = new Map()
  return { get length() { return data.size }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data }
}
function chat(custom = {}) {
  const file = new URL('../src/views/ChatRoom.vue', import.meta.url)
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(errors, [])
  const route = { params: { id: '8' } }, store = { user: { id: 7 } }, prefs = reactive({})
  const mounted = [], unmounted = [], watches = [], timers = new Map(), notices = [], requests = []
  const sessionStorage = memoryStorage()
  let timerId = 0
  const api = Object.fromEntries(['get', 'put', 'post', 'delete'].map(method => [method, async (...args) => { requests.push([method, ...args]); return { data: method === 'get' ? { messages: [], hasMore: false } : {} } }]))
  const bindings = {
    ref, computed, watch: (source, callback, options) => { watches.push({ source, callback, options }) },
    useRoute: () => route, useRouter: () => ({ push: async () => {} }), useUserStore: () => store,
    useSettingsStore: () => ({ prefs }), useToast: () => Object.fromEntries(['success', 'error', 'info'].map(key => [key, message => notices.push([key, message])])),
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn), nextTick: fn => Promise.resolve().then(fn), useFocusTrap() {},
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { innerWidth: 1200, innerHeight: 800, sessionStorage, addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }, clearTimeout: id => timers.delete(id), api,
    ...custom,
  }
  const source = descriptor.scriptSetup.content.split('\n').filter(line => !line.startsWith('import ')).join('\n')
  const names = ['messages', 'newMessage', 'loading', 'sending', 'chatUser', 'replyTo', 'outbox', 'loadMessages', 'loadHistory', 'jumpToMessage', 'replyInfo', 'replyUnavailable', 'sendMessage', 'retryMessage', 'editFailedMessage', 'saveDraft', 'restoreDraft', 'clearAccountDrafts', 'openConversation', 'returnToLatest', 'nearBottom', 'newMessagesCount', 'viewingContext', 'hasMore', 'hasMoreAfter', 'historyLoading', 'contextLoading', 'historyDirection', 'historyError', 'loadError', 'highlightedId', 'messagesArea', 'searchQuery', 'searchMessages', 'searchResults', 'searchHasMore', 'searchError', 'searchLoading', 'searchPerformed', 'closeSearch', 'density', 'showTimestamps', 'sendShortcut', 'pollMs', 'startPolling', 'onMessagesScroll', 'validateDraftReply', 'deleteMessage', 'doDeleteMessage', 'revokeMessage', 'doRevokeMessage', 'stopPolling']
  const state = new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '}')(...Object.values(bindings))
  return { ...state, route, store, prefs, sessionStorage, mounted, unmounted, watches, timers, notices, requests, api: bindings.api }
}
function composer(overrides = {}, environment = {}) {
  const { descriptor } = parse(readFileSync(new URL('../src/components/chat-private/PrivateChatComposer.vue', import.meta.url), 'utf8'))
  const props = { modelValue: '草稿', sending: false, disabled: false, sendBlocked: false, shortcut: 'enter', ...overrides }
  const events = []
  const bindings = { ref, computed, watch() {}, nextTick: fn => Promise.resolve().then(fn), onMounted() {}, onBeforeUnmount() {}, defineProps: () => props, defineEmits: () => (...args) => events.push(args), defineExpose() {}, navigator: { maxTouchPoints: 0 }, window: { innerWidth: 1200 }, ...environment }
  const source = descriptor.scriptSetup.content.split('\n').filter(line => !line.startsWith('import ')).join('\n')
  const state = new Function(...Object.keys(bindings), source + '\nreturn {onKeydown, mobileInput, input, resize, insertText}')(...Object.values(bindings))
  return { ...state, props, events }
}
function key(overrides = {}) {
  let prevented = false
  return { key: 'Enter', isComposing: false, keyCode: 13, repeat: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() { prevented = true }, get prevented() { return prevented }, ...overrides }
}
const message = (id, extra = {}) => ({ id, sender_id: 8, receiver_id: 7, content: '消息 ' + id, created_at: '2026-11-19T12:00:00Z', ...extra })

test('private chat and composer SFC templates compile', () => {
  for (const relative of ['../src/views/ChatRoom.vue', '../src/components/chat-private/PrivateChatComposer.vue']) {
    const { descriptor, errors } = parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))
    assert.deepEqual(errors, [])
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: relative, id: 'private-phase2' }).errors, [])
  }
})

test('history prepending preserves scroll position and requests pure before page', async () => {
  let request
  const area = { scrollTop: 80, scrollHeight: 300, clientHeight: 100 }
  const page = chat({ api: { get: async (url, config) => { request = config.params; return { data: { messages: [message(1), message(2)], hasMoreBefore: false, next_before_id: 1 } } } }, nextTick: async fn => { area.scrollHeight = 480; fn?.() } })
  page.messages.value = [message(3), message(4)]
  page.messagesArea.value = area
  await page.loadHistory()
  assert.deepEqual(page.messages.value.map(item => item.id), [1, 2, 3, 4])
  assert.equal(area.scrollTop, 260)
  assert.equal(request.before, 3)
  assert.equal(request.mark_read, 0)
  assert.equal(page.hasMore.value, false)
})

test('reference resolves visible author and revoked/unavailable states without stale content', () => {
  const page = chat()
  page.chatUser.value = { nickname: '小林' }
  assert.deepEqual(page.replyInfo({ reply_to_id: 3, reply_to: { id: 3, available: true, content: '原文', is_mine: true } }), { id: 3, available: true, text: '原文', author: '我' })
  assert.equal(page.replyInfo({ reply_to_id: 3, reply_to: { id: 3, available: false, content: '不能展示', is_revoked: true } }).text, '原消息已撤回')
  assert.equal(page.replyInfo({ reply_to_id: 3, reply_to_missing: true, reply_to_content: '旧快照' }).text, '原消息已删除或不可见')
})

test('reference to older message loads bounded pure-read context and highlight', async () => {
  let request
  const page = chat({ api: { get: async (url, config) => { request = config.params; return { data: { messages: [message(40), message(41)], hasMoreBefore: true, hasMoreAfter: true, next_before_id: 40 } } } } })
  page.messages.value = [message(100)]
  await page.jumpToMessage(41)
  assert.equal(request.around_id, 41)
  assert.equal(request.mark_read, 0)
  assert.equal(page.highlightedId.value, 41)
  assert.equal(page.viewingContext.value, true)
  assert.equal(page.hasMoreAfter.value, true)
  assert.deepEqual(page.messages.value.map(item => item.id), [40, 41])
})

test('unavailable reference leaves current timeline intact', async () => {
  const page = chat({ api: { get: async () => { throw { response: { status: 404 } } } } })
  page.messages.value = [message(100)]
  await page.jumpToMessage(1)
  assert.equal(page.messages.value[0].id, 100)
  assert.equal(page.contextLoading.value, false)
  assert.match(page.notices[0][1], /不可见/)
})

test('search uses q and mark_read zero, pages independently from the timeline', async () => {
  const requests = []
  const page = chat({ api: { get: async (url, config) => { requests.push(config.params); return { data: { messages: config.params.before ? [message(1)] : [message(2)], hasMoreBefore: !config.params.before, next_before_id: config.params.before ? 1 : 2 } } } } })
  page.messages.value = [message(100)]
  page.searchQuery.value = '校园'
  await page.searchMessages()
  await page.searchMessages(true)
  assert.deepEqual(page.searchResults.value.map(item => item.id), [2, 1])
  assert.equal(page.messages.value[0].id, 100)
  assert.equal(requests[0].q, '校园')
  assert.equal(requests[0].mark_read, 0)
  assert.equal(requests[1].before, 2)
})

test('stale search response cannot replace newer query results', async () => {
  const old = pending(), current = pending()
  const page = chat({ api: { get: (url, config) => config.params.q === '旧' ? old.promise : current.promise } })
  page.searchQuery.value = '旧'
  const first = page.searchMessages()
  page.searchQuery.value = '新'
  const second = page.searchMessages()
  current.resolve({ data: { messages: [message(2)] } })
  await second
  old.resolve({ data: { messages: [message(1)] } })
  await first
  assert.equal(page.searchResults.value[0].id, 2)
})

test('polling while reading history leaves scroll untouched and shows incoming count once', async () => {
  let rows = [message(1)]
  const page = chat({ api: { get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: rows } }) } })
  await page.loadMessages()
  page.nearBottom.value = false
  const area = { scrollTop: 27, scrollHeight: 900, clientHeight: 300 }
  page.messagesArea.value = area
  rows = [message(1), message(2)]
  await page.loadMessages(true)
  await page.loadMessages(true)
  assert.equal(area.scrollTop, 27)
  assert.equal(page.newMessagesCount.value, 1)
})

test('polling in around context does not append latest messages across a history gap', async () => {
  let latest = [message(100)]
  const page = chat({ api: { get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: latest } }) } })
  await page.loadMessages()
  page.messages.value = [message(20), message(21)]
  page.viewingContext.value = true
  latest = [message(100), message(101)]
  await page.loadMessages(true)
  assert.deepEqual(page.messages.value.map(item => item.id), [20, 21])
  assert.equal(page.newMessagesCount.value, 1)
  assert.equal(page.hasMoreAfter.value, true)
})

test('burst of new messages fetches after cursor before merging latest page', async () => {
  let initial = true
  const requests = []
  const page = chat({ api: { get: async (url, config) => {
    if (url.startsWith('/auth')) return { data: { nickname: '同学' } }
    requests.push(config.params)
    if (initial) return { data: { messages: [message(1)] } }
    if (config.params.after) return { data: { messages: Array.from({ length: 79 }, (_, i) => message(i + 2)), hasMoreAfter: false, next_after_id: 80 } }
    return { data: { messages: Array.from({ length: 40 }, (_, i) => message(i + 41)) } }
  } } })
  await page.loadMessages()
  initial = false
  page.nearBottom.value = false
  await page.loadMessages(true)
  assert.equal(page.messages.value.length, 80)
  assert.equal(requests.at(-1).after, 1)
  assert.equal(requests.at(-1).mark_read, 0)
})

test('in-flight send keeps newly edited draft and blocks duplicate click', async () => {
  const network = pending(), requests = []
  const page = chat({ api: { post: (url, payload) => { requests.push(payload); return network.promise }, get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: [] } }) } })
  page.loading.value = false
  page.newMessage.value = '第一条'
  const send = page.sendMessage()
  page.newMessage.value = '正在写下一条'
  await page.sendMessage()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].content, '第一条')
  network.resolve({ data: { id: 9 } })
  await send
  assert.equal(page.newMessage.value, '正在写下一条')
  assert.equal(page.outbox.value.length, 0)
  assert.ok(requests[0].client_message_id)
})

test('network failure retries exact same immutable payload and client id', async () => {
  const requests = []
  let failure = true
  const page = chat({ api: { post: async (url, payload) => { requests.push({ ...payload }); if (failure) throw Error('connection lost'); return { data: { id: 12, deduplicated: true } } }, get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: [] } }) } })
  page.loading.value = false
  page.newMessage.value = '请确认收到了吗'
  await page.sendMessage()
  const failed = page.outbox.value[0]
  assert.equal(failed.status, 'failed')
  page.newMessage.value = '新的草稿'
  failure = false
  await page.retryMessage(failed)
  assert.deepEqual(requests[1], requests[0])
  assert.equal(page.outbox.value.length, 0)
  assert.equal(page.newMessage.value, '新的草稿')
})

test('polling reconciles a lost acknowledgement by the sender client message id', async () => {
  let confirmed = []
  const page = chat({ api: { post: async () => { throw Error('lost acknowledgement') }, get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: confirmed } }) } })
  page.loading.value = false
  page.newMessage.value = '网络慢'
  await page.sendMessage()
  const id = page.outbox.value[0].client_message_id
  confirmed = [message(11, { sender_id: 7, receiver_id: 8, client_message_id: id })]
  await page.loadMessages(true)
  assert.equal(page.outbox.value.length, 0)
})

test('changing conversation isolates pending send, new draft and send lock', async () => {
  const network = pending()
  const page = chat({ api: { post: () => network.promise, get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: [] } }) } })
  await page.openConversation()
  page.newMessage.value = '发给8'
  const send = page.sendMessage()
  page.route.params.id = '9'
  await page.openConversation()
  page.newMessage.value = '9的草稿'
  assert.equal(page.sending.value, false)
  network.resolve({ data: { id: 10 } })
  await send
  assert.equal(page.newMessage.value, '9的草稿')
  assert.equal(page.messages.value.length, 0)
})

test('session drafts stay isolated by account and conversation and clear on logout', async () => {
  const page = chat()
  await page.openConversation()
  page.newMessage.value = '仅给8的草稿'
  page.saveDraft()
  page.route.params.id = '9'
  await page.openConversation()
  assert.equal(page.newMessage.value, '')
  page.newMessage.value = '仅给9的草稿'
  page.saveDraft()
  page.route.params.id = '8'
  await page.openConversation()
  assert.equal(page.newMessage.value, '仅给8的草稿')
  page.clearAccountDrafts(7)
  assert.equal(page.sessionStorage.length, 0)
})

test('revoked selected source prevents sending without losing the draft', async () => {
  const page = chat()
  page.loading.value = false
  page.messages.value = [message(4, { is_revoked: true })]
  page.replyTo.value = message(4)
  page.newMessage.value = '继续编辑的内容'
  await page.sendMessage()
  assert.equal(page.replyUnavailable.value, true)
  assert.equal(page.newMessage.value, '继续编辑的内容')
  assert.equal(page.requests.length, 0)
})

test('restored quote validates unavailable original using pure-read context', async () => {
  const requests = []
  const page = chat({ api: { get: async (url, config) => { requests.push(config.params); throw { response: { status: 404 } } } } })
  page.replyTo.value = message(4)
  await page.validateDraftReply()
  assert.equal(page.replyUnavailable.value, true)
  assert.equal(requests[0].mark_read, 0)
  assert.equal(requests[0].around_id, 4)
})

test('deleting one message removes only that local row and invalidates quoted content', async () => {
  const page = chat()
  page.messages.value = [message(4), message(5, { reply_to_id: 4, reply_to_content: '旧快照' })]
  page.deleteMessage(page.messages.value[0])
  await page.doDeleteMessage()
  assert.deepEqual(page.messages.value.map(item => item.id), [5])
  assert.equal(page.replyInfo(page.messages.value[0]).available, false)
  assert.notEqual(page.replyInfo(page.messages.value[0]).text, '旧快照')
  assert.deepEqual(page.requests[0].slice(0, 2), ['delete', '/messages/4'])
})

test('chat preferences are reactive with safe defaults and configured poll cadence', () => {
  const page = chat()
  assert.equal(page.density.value, 'comfortable')
  assert.equal(page.showTimestamps.value, true)
  assert.equal(page.sendShortcut.value, 'enter')
  assert.equal(page.pollMs.value, 20000)
  Object.assign(page.prefs, { chat_density: 'compact', chat_show_timestamps: false, chat_send_shortcut: 'modifier', chat_poll_interval: '60' })
  assert.equal(page.density.value, 'compact')
  assert.equal(page.showTimestamps.value, false)
  assert.equal(page.sendShortcut.value, 'modifier')
  page.startPolling()
  assert.equal([...page.timers.values()].at(-1).ms, 60000)
})

test('composer uses Enter on desktop, modifier shortcut, and newline on mobile', () => {
  const page = composer()
  const enter = key()
  page.onKeydown(enter)
  assert.equal(enter.prevented, true)
  assert.deepEqual(page.events, [['send']])
  page.props.shortcut = 'modifier'
  page.onKeydown(key())
  page.onKeydown(key({ ctrlKey: true }))
  assert.equal(page.events.length, 2)
  page.mobileInput.value = true
  page.props.shortcut = 'enter'
  const mobileEnter = key()
  page.onKeydown(mobileEnter)
  assert.equal(mobileEnter.prevented, false)
  assert.equal(page.events.length, 2)
})

test('composer preserves IME confirmation Shift newline and key repeat', () => {
  const page = composer()
  for (const changes of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }]) {
    const event = key(changes)
    page.onKeydown(event)
    assert.equal(event.prevented, false)
  }
  assert.equal(page.events.length, 0)
})

test('composer autosizes within its scrolling bound and keeps editing while sending', () => {
  const page = composer({ sending: true })
  page.input.value = { scrollHeight: 400, style: {} }
  page.resize()
  assert.equal(page.input.value.style.height, '160px')
  assert.equal(page.input.value.style.overflowY, 'auto')
  page.onKeydown(key())
  assert.equal(page.events.length, 0)
  assert.equal(page.props.disabled, false)
})

test('private frontend integrates around search quote and idempotent retry with real routes in memory', async t => {
  const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url))
  const express = serverRequire('express')
  const jwt = serverRequire('jsonwebtoken')
  const initSqlJs = serverRequire('sql.js')
  process.env.JWT_SECRET = 'phase2-chat-private-memory-test-secret'
  const { SECRET } = serverRequire('./middleware/auth')
  const messagesRouter = serverRequire('./routes/messages')
  const SQL = await initSqlJs()
  const sql = new SQL.Database()
  const source = readFileSync(new URL('../../server/db.js', import.meta.url), 'utf8')
  const schema = source.match(/wrapper\.exec\(\x60([\s\S]*?)\x60\);/)
  assert.ok(schema, 'schema read does not initialize or open the application database')
  sql.run(schema[1])
  sql.run("CREATE UNIQUE INDEX IF NOT EXISTS phase2_private_cid ON messages(sender_id,client_message_id) WHERE client_message_id IS NOT NULL AND client_message_id<>''")
  const db = {
    prepare(text) {
      const all = (...params) => {
        const stmt = sql.prepare(text)
        try { if (params.length) stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows }
        finally { stmt.free() }
      }
      return { all, get: (...params) => all(...params)[0], run(...params) { sql.run(text, params); return { changes: sql.getRowsModified(), lastInsertRowid: sql.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || 0 } } }
    },
    exec(text) { sql.run(text) },
  }
  for (const id of [7, 8]) db.prepare('INSERT INTO users(id,username,password_hash,nickname,role) VALUES (?,?,?,?,?)').run(id, 'phase2-student-' + id, 'not-used', '同学' + id, 'user')
  db.prepare('INSERT INTO walls(id,name,owner_id) VALUES (1,?,7)').run('隔离测试校园墙')
  for (const id of [7, 8]) db.prepare("INSERT INTO wall_members(wall_id,user_id,wall_role,status) VALUES (1,?,'member','active')").run(id)
  for (let id = 1; id <= 85; id++) db.prepare("INSERT INTO messages(id,sender_id,receiver_id,type,content,wall_id) VALUES (?,?,?,'private',?,0)").run(id, id % 2 ? 8 : 7, id % 2 ? 7 : 8, id === 3 ? '课表原消息' : '历史消息' + id)
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.db = db; next() })
  app.get('/api/auth/user/:id', (req, res) => res.json({ nickname: '同学' + req.params.id }))
  app.use('/api/messages', messagesRouter)
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); sql.close() })
  const request = (method, route, body, config = {}) => new Promise((resolve, reject) => {
    const query = new URLSearchParams(Object.entries(config.params || {}).map(([key, value]) => [key, String(value)]))
    const headers = { authorization: 'Bearer ' + jwt.sign({ id: 7, tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '5m' }) }
    const payload = body === undefined ? null : JSON.stringify(body)
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: '/api' + route + (query.size ? '?' + query : ''), headers }, res => {
      let text = ''
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => {
        try { const data = JSON.parse(text); if (res.statusCode >= 400) reject({ response: { status: res.statusCode, data } }); else resolve({ data }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject); req.end(payload)
  })
  let loseFirstAcknowledgement = true
  const api = {
    get: (url, config) => request('GET', url, undefined, config),
    post: async (url, body) => { const result = await request('POST', url, body); if (loseFirstAcknowledgement) { loseFirstAcknowledgement = false; throw Error('simulated acknowledgement loss after commit') } return result },
    put: (url, body) => request('PUT', url, body), delete: url => request('DELETE', url),
  }
  const page = chat({ api })
  await page.openConversation()
  assert.equal(page.messages.value.length, 40)
  assert.equal(page.messages.value[0].id, 46)
  await page.jumpToMessage(3)
  assert.ok(page.messages.value.some(item => item.id === 3))
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=3').get().is_read, 0, 'around does not mark hidden history read')
  page.searchQuery.value = '课表'
  await page.searchMessages()
  assert.equal(page.searchResults.value[0].id, 3)
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=3').get().is_read, 0, 'search remains pure read')
  page.replyTo.value = message(3, { content: '课表原消息' })
  page.newMessage.value = '关于课表的回复'
  await page.sendMessage()
  assert.equal(page.outbox.value[0].status, 'failed')
  const failed = page.outbox.value[0]
  await page.retryMessage(failed)
  assert.equal(page.outbox.value.length, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_id=7 AND content='关于课表的回复'").get().n, 1)
  const received = await api.get('/messages/conversation/8', { params: { mark_read: 0 } })
  const reply = received.data.messages.find(item => item.content === '关于课表的回复')
  assert.equal(reply.reply_to.id, 3)
  assert.equal(reply.reply_to.available, true)
  assert.equal(reply.reply_to.content, '课表原消息')
  page.deleteMessage(page.messages.value.find(item => item.id === 3))
  await page.doDeleteMessage()
  const afterDeletion = await api.get('/messages/conversation/8', { params: { mark_read: 0 } })
  assert.equal(afterDeletion.data.messages.find(item => item.id === reply.id).reply_to.available, false)
})

test('logout cleanup remains active after navigating away and preserves non-chat storage', () => {
  const source = readFileSync(new URL('../src/composables/usePrivateChatDraftCleanup.js', import.meta.url), 'utf8').split('\n').filter(line => !line.startsWith('import ') && !line.includes('import.meta.hot')).join('\n').replace('export function', 'function')
  const store = memoryStorage()
  let sessionChange
  let subscriptions = 0
  store.setItem('school_wall:private-draft:v1:7:8', 'private draft')
  store.setItem('unrelated-preference', 'keep')
  new Function('getSessionToken', 'subscribeSessionChange', 'globalThis', source)(() => 'active-session', callback => { subscriptions++; sessionChange = callback; return () => {} }, { sessionStorage: store })
  sessionChange({ token: 'renewed', previousToken: 'active-session', resetContext: false })
  assert.equal(store.length, 2, 'same account token renewal keeps drafts')
  sessionChange({ token: '', previousToken: 'renewed', resetContext: true })
  assert.equal(store.getItem('school_wall:private-draft:v1:7:8'), null)
  assert.equal(store.getItem('unrelated-preference'), 'keep')
  assert.equal(subscriptions, 1)
})

test('locally revoked original overrides an older available nested quote snapshot', () => {
  const page = chat()
  page.messages.value = [message(4, { is_revoked: true, content: '' })]
  const quote = page.replyInfo({ reply_to_id: 4, reply_to: { id: 4, available: true, content: 'stale private quote', is_mine: false } })
  assert.equal(quote.available, false)
  assert.equal(quote.text, '原消息已撤回')
})

test('emoji insertion never exceeds the message limit or splits an emoji', () => {
  const page = composer({ modelValue: '字'.repeat(1999) })
  page.insertText('😊')
  assert.equal(page.events.length, 0)
})

test('failed later-history retry keeps after direction instead of loading older records', async () => {
  const requests = []
  let fail = true
  const page = chat({ api: { get: async (url, config) => { requests.push(config.params); if (fail) throw Error('network'); return { data: { messages: [message(3)], hasMoreAfter: false } } } } })
  page.messages.value = [message(1), message(2)]
  await page.loadHistory('after')
  assert.equal(page.historyDirection.value, 'after')
  fail = false
  await page.loadHistory(page.historyDirection.value)
  assert.equal(requests[1].after, 2)
  assert.deepEqual(page.messages.value.map(item => item.id), [1, 2, 3])
})



