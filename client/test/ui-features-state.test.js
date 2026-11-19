import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed } from 'vue'
import { parse, compileTemplate } from '@vue/compiler-sfc'

// Execute the real SFC setup against deterministic API, lifecycle and timer doubles.
// This suite performs no HTTP requests and never opens a database.
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(name, exports, custom = {}) {
  const source = readFileSync(new URL('../src/views/' + name + '.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const mounted = [], unmounted = [], timers = new Map(), intervals = new Map(), watches = []
  let timerId = 0
  const events = new Set(), notices = [], requests = []
  const route = { params: { id: '8', conversationId: 'anonymous-1', code: 'RPT-2026A3B5C7D9' }, query: {}, path: '/friends/search' }
  const wall = { currentWallId: 1, loaded: true, currentWall: { description: '' }, myWalls: [{ id: 1, name: '校园墙' }], canHere: () => true, fetchMyWalls: async () => [], switchWall(id) { this.currentWallId = id } }
  const api = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, async (...args) => { requests.push([method, ...args]); return { data: [] } }]))
  const bindings = {
    ref, computed, watch: (...args) => { watches.push(args) },
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    nextTick: callback => Promise.resolve().then(callback), useRoute: () => route, useRouter: () => ({ push: async () => {} }),
    useUserStore: () => ({ isLoggedIn: true, user: { id: 7 }, can: () => true, fetchPermissions: async () => {} }),
    useWallStore: () => wall, useSettingsStore: () => ({ prefs: { default_anonymous_confession: false } }),
    useToast: () => Object.fromEntries(['success', 'error', 'info', 'warning'].map(kind => [kind, message => notices.push([kind, message])])),
    useTimeAgo: () => ({ timeAgo: value => value }), useMarkdown: () => ({ truncateText: value => value }), useFocusTrap: () => {},
    api, marked: { setOptions() {}, parse: value => value }, DOMPurify: { sanitize: value => value },
    document: { visibilityState: 'visible', addEventListener: name => events.add(name), removeEventListener: name => events.delete(name) },
    window: { innerWidth: 360, innerHeight: 780, getSelection: () => '' }, navigator: {}, location: {},
    setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id),
    setInterval: callback => { intervals.set(++timerId, callback); return timerId }, clearInterval: id => intervals.delete(id),
    ...custom,
  }
  const script = descriptor.scriptSetup.content.split('\n').filter(line => !line.startsWith('import ')).join('\n')
  const result = new Function(...Object.keys(bindings), script + '\nreturn {' + exports.join(',') + '}')(...Object.values(bindings))
  return { ...result, api: bindings.api, route, wall, mounted, unmounted, timers, intervals, events, notices, requests, watches }
}

test('all authorized SFC templates compile with native interactive markup', () => {
  for (const name of ['Chat', 'ChatRoom', 'FindFriends', 'Inbox', 'TreeHoleChat', 'TreeHoleConversations', 'Votes', 'VoteDetail', 'CreateVote', 'WallSelect', 'WriteConfession', 'HelpCounseling', 'BugReport', 'ReportForm', 'ReportStatus', 'Admin']) {
    const source = readFileSync(new URL('../src/views/' + name + '.vue', import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [], name)
    const template = compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: name })
    assert.deepEqual(template.errors, [], name)
  }
})

for (const name of ['ChatRoom', 'TreeHoleChat']) {
  test(name + ' does not restart polling when initial request resolves after unmount', async () => {
    const pending = deferred()
    const page = setup(name, [], { api: { get: () => pending.promise } })
    const initial = page.mounted[0]()
    page.unmounted.forEach(callback => callback())
    pending.resolve({ data: { messages: [] } })
    await initial
    await Promise.resolve()
    assert.equal(page.timers.size, 0)
    assert.equal(page.events.size, 0)
  })
}

test('private chat applies revocation updates even when message ids stay unchanged', async () => {
  let revoked = false
  const page = setup('ChatRoom', ['loadMessages', 'messages'], { api: { get: async url => ({ data: url.startsWith('/auth') ? { nickname: '同学' } : { messages: [{ id: 1, is_revoked: revoked, content: revoked ? '' : '消息' }] } }) } })
  await page.loadMessages()
  revoked = true
  await page.loadMessages(true)
  assert.equal(page.messages.value[0].is_revoked, true)
})

test('private chat ignores a stale response after switching recipient', async () => {
  const first = deferred(), second = deferred()
  const page = setup('ChatRoom', ['loadMessages', 'messages', 'chatUser'], { api: { get: url => url.endsWith('/8') ? first.promise : second.promise } })
  page.chatUser.value = { nickname: '同学' }
  const oldLoad = page.loadMessages()
  page.route.params.id = '9'
  const newLoad = page.loadMessages()
  second.resolve({ data: { messages: [{ id: 9 }] } })
  await newLoad
  first.resolve({ data: { messages: [{ id: 8 }] } })
  await oldLoad
  assert.equal(page.messages.value[0].id, 9)
})

test('anonymous chat reports by conversation without exposing a user id', async () => {
  let payload
  const page = setup('TreeHoleChat', ['doReport', 'canReport', 'reportReason', 'chatMessages'], { api: { post: async (url, body) => { payload = body; return { data: {} } } } })
  page.canReport.value = true
  page.reportReason.value = '不当发言'
  page.chatMessages.value = [{ id: 1, is_mine: false }, { id: 2, is_mine: true }]
  await page.doReport()
  assert.equal(payload.conversation_id, 'anonymous-1')
  assert.equal('reported_user_id' in payload, false)
  assert.deepEqual(payload.selected_message_ids, [1])
})

test('inbox category mark-all preserves other category counts and prevents duplicates', async () => {
  const refresh = deferred(), submit = deferred()
  let writes = 0
  const page = setup('Inbox', ['markAllRead', 'messages', 'activeFilter', 'unreadCounts', 'totalUnread', 'loading'], { api: { put: () => { writes++; return submit.promise }, get: () => refresh.promise } })
  page.loading.value = false
  page.activeFilter.value = 'private'
  page.messages.value = [{ id: 1, type: 'private', is_read: 0 }]
  page.unreadCounts.value = { private: 2, system: 5 }
  page.totalUnread.value = 7
  const first = page.markAllRead()
  await page.markAllRead()
  submit.resolve({ data: {} })
  await Promise.resolve()
  assert.equal(page.totalUnread.value, 5)
  assert.equal(writes, 1)
  refresh.resolve({ data: { messages: [], unreadCounts: { private: 0, system: 5 }, totalUnread: 5 } })
  await first
  assert.equal(page.totalUnread.value, 5)
})

test('inbox repeated mark-read only decrements once', async () => {
  const pending = deferred()
  let writes = 0
  const page = setup('Inbox', ['markRead', 'unreadCounts', 'totalUnread'], { api: { put: () => { writes++; return pending.promise } } })
  page.unreadCounts.value = { private: 2, system: 4 }
  page.totalUnread.value = 6
  const message = { id: 1, type: 'private', is_read: 0 }
  const first = page.markRead(message)
  await page.markRead(message)
  pending.resolve({ data: {} })
  await first
  assert.equal(writes, 1)
  assert.equal(page.totalUnread.value, 5)
})

test('inbox latest filter response wins even if old request ignores abort', async () => {
  const first = deferred(), second = deferred()
  const page = setup('Inbox', ['loadInbox', 'activeFilter', 'messages'], { api: { get: (url, config) => config.params.type === 'private' ? first.promise : second.promise } })
  page.activeFilter.value = 'private'
  const old = page.loadInbox()
  page.activeFilter.value = 'system'
  const latest = page.loadInbox()
  second.resolve({ data: { messages: [{ id: 2 }], unreadCounts: {}, totalUnread: 0 } })
  await latest
  first.resolve({ data: { messages: [{ id: 1 }], unreadCounts: {}, totalUnread: 0 } })
  await old
  assert.equal(page.messages.value[0].id, 2)
})

test('deleting a sent message updates sent list without reducing recipient unread counts', async () => {
  const page = setup('Inbox', ['activeTab', 'sentMessages', 'messages', 'deleteMsg', 'doDeleteMsg', 'unreadCounts', 'totalUnread'])
  page.activeTab.value = 'sent'
  page.sentMessages.value = [{ id: 1, type: 'private', is_read: 0 }]
  page.messages.value = [{ id: 2 }]
  page.unreadCounts.value = { private: 3 }
  page.totalUnread.value = 3
  page.deleteMsg(page.sentMessages.value[0])
  await page.doDeleteMsg()
  assert.equal(page.sentMessages.value.length, 0)
  assert.equal(page.messages.value.length, 1)
  assert.equal(page.totalUnread.value, 3)
})

test('create vote blocks expired and duplicate options before any request', async () => {
  const page = setup('CreateVote', ['submit', 'title', 'options', 'endAt', 'error'])
  page.title.value = '校园活动'
  page.options.value = [' 活动一 ', '活动一']
  await page.submit()
  assert.match(page.error.value, /重复/)
  page.options.value = ['活动一', '活动二']
  page.endAt.value = '2020-01-01T12:00'
  await page.submit()
  assert.match(page.error.value, /晚于/)
  assert.equal(page.requests.length, 0)
})

test('create vote sends an unambiguous ISO deadline and locks concurrent submissions', async () => {
  const pending = deferred()
  const payloads = []
  const page = setup('CreateVote', ['submit', 'title', 'options', 'endAt'], { api: { post: (url, body) => { payloads.push(body); return pending.promise } } })
  page.title.value = '校园活动'
  page.options.value = [' 活动一 ', '活动二']
  page.endAt.value = '2099-01-01T12:00'
  const first = page.submit()
  await page.submit()
  assert.equal(payloads.length, 1)
  assert.match(payloads[0].end_at, /Z$/)
  assert.deepEqual(payloads[0].options, ['活动一', '活动二'])
  pending.resolve({ data: {} })
  await first
})

test('vote deadline reacts to the clock and rejects a late confirmation', async () => {
  const ClockDate = class extends Date { static now() { return new Date('2030-01-01T00:00:00Z').getTime() } }
  const page = setup('VoteDetail', ['vote', 'now', 'isEnded', 'doVote', 'selectedOption', 'loading'], { Date: ClockDate })
  page.loading.value = false
  page.vote.value = { id: 3, end_at: '2030-01-01T00:00:00Z', options: [], voted: null }
  page.now.value = new Date('2029-12-31T23:59:59Z').getTime()
  assert.equal(page.isEnded.value, false)
  page.selectedOption.value = 1
  page.now.value += 1000
  assert.equal(page.isEnded.value, true)
  await page.doVote()
  assert.equal(page.requests.length, 0)
})

test('vote submission is locked and stays voted if result refresh fails', async () => {
  const pending = deferred()
  let writes = 0
  const page = setup('VoteDetail', ['vote', 'selectedOption', 'loading', 'doVote'], { api: { post: () => { writes++; return pending.promise }, get: async () => { throw Error('network') } } })
  page.vote.value = { id: 1, end_at: '', voted: null, options: [] }
  page.loading.value = false
  page.selectedOption.value = 2
  const first = page.doVote()
  await page.doVote()
  pending.resolve({ data: {} })
  await first
  await page.doVote()
  assert.equal(writes, 1)
  assert.equal(page.vote.value.voted, 2)
})

for (const name of ['BugReport', 'ReportForm']) {
  test(name + ' blocks submission while evidence is still uploading', async () => {
    const page = setup(name, ['submit', 'uploading', ...(name === 'BugReport' ? ['title', 'content'] : ['content', 'reportTypes', 'agreed'])])
    page.uploading.value = true
    page.content.value = '问题的详细描述'
    if (name === 'BugReport') page.title.value = '问题反馈'
    else { page.reportTypes.value = ['校园霸凌行为']; page.agreed.value = true }
    await page.submit()
    assert.equal(page.requests.length, 0)
  })
}

test('partial anonymous conversation deletion retains only failed ids for retry', async () => {
  const page = setup('TreeHoleConversations', ['deleteSelected', 'selectedIds', 'myConversations'], { api: { delete: async url => { if (url.endsWith('/bad')) throw Error('network'); return { data: {} } } } })
  page.selectedIds.value = new Set(['good', 'bad'])
  page.myConversations.value = [{ conversation_id: 'good' }, { conversation_id: 'bad' }]
  await page.deleteSelected()
  assert.deepEqual([...page.selectedIds.value], ['bad'])
  assert.equal(page.myConversations.value[0].conversation_id, 'bad')
})

test('administrator permission scope ignores stale response and blocks saving while loading', async () => {
  const first = deferred(), second = deferred()
  let saves = 0
  const page = setup('Admin', ['loadPermData', 'savePerms', 'permUser', 'permScope', 'permData', 'permChoice', 'permLoading'], { api: { get: (url, config) => config.params.wall_id === 1 ? first.promise : second.promise, put: async () => { saves++; return { data: {} } } } })
  page.permUser.value = { id: 10 }
  page.permScope.value = 1
  const old = page.loadPermData()
  page.permScope.value = 2
  const latest = page.loadPermData()
  await page.savePerms()
  assert.equal(saves, 0)
  second.resolve({ data: { wall_role: 'member', overrides: [{ perm: 'wall.post.delete', effect: 'deny' }] } })
  await latest
  first.resolve({ data: { wall_role: 'owner', overrides: [{ perm: 'wall.post.delete', effect: 'grant' }] } })
  await old
  assert.equal(page.permChoice.value['wall.post.delete'], 'deny')
  assert.equal(page.permData.value.wall_role, 'member')
  assert.equal(page.permLoading.value, false)
})

test('inbox read finishing after refresh reconciles totals instead of decrementing twice', async () => {
  const pending = deferred()
  const page = setup('Inbox', ['markRead', 'loadInbox', 'unreadCounts', 'totalUnread'], { api: {
    put: () => pending.promise,
    get: async () => ({ data: { messages: [], unreadCounts: { private: 1 }, totalUnread: 1 } }),
  } })
  page.unreadCounts.value = { private: 2 }
  page.totalUnread.value = 2
  const write = page.markRead({ id: 1, type: 'private', is_read: 0 })
  await page.loadInbox()
  pending.resolve({ data: {} })
  await write
  assert.equal(page.totalUnread.value, 1)
})

test('administrator evidence accepts signed array or JSON URLs and survives malformed data', () => {
  const page = setup('Admin', ['reportImages'])
  const signed = '/uploads/bug-reports/evidence.png?ticket=short-lived'
  assert.deepEqual(page.reportImages([signed]), [signed])
  assert.deepEqual(page.reportImages(JSON.stringify([signed])), [signed])
  assert.deepEqual(page.reportImages('{invalid'), [])
  assert.deepEqual(page.reportImages({}), [])
  assert.deepEqual(page.reportImages(['https://external.invalid/image.png']), [])
})

