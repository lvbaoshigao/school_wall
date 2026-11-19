import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { safeImageUrl, useMarkdown } from '../src/composables/useMarkdown.js'
import { ref, computed, watch, reactive, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const source = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function setup(name, names, overrides = {}) {
  const calls = [], events = [], mounted = [], cleanup = []
  const route = reactive({ params: { id: '1' }, query: {} })
  const wall = reactive({ currentWallId: 1, canHere: () => false, switchWall(id) { this.currentWallId = id } })
  const router = { push: value => calls.push(['push', value]), replace: value => { calls.push(['replace', value]); return Promise.resolve() } }
  const api = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (...args) => { const d = deferred(); calls.push([method, ...args, d]); return d.promise }]))
  const env = {
    ref, computed, watch, nextTick, reactive, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn), useId: () => 'comment-test',
    useRoute: () => route, useRouter: () => router, useWallStore: () => wall,
    useUserStore: () => ({ isLoggedIn: true, user: { id: 1 }, canInWall: () => false }),
    useSettingsStore: () => ({ prefs: { feed_category: '全部', feed_sort: 'latest', auto_load_images: true }, loaded: true }),
    useToast: () => ({ error() {}, success() {}, info() {} }), useTimeAgo: () => ({ timeAgo: String, fullTime: String }),
    useMarkdown: () => ({ getTextContent: String, getPostImages: () => [], renderMarkdown: String }), safeImageUrl: value => value,
    useFocusTrap() {}, defineOptions() {}, defineProps: () => ({ postId: 1, post: { id: 1, wall_id: 2, liked: false, bookmarked: false, like_count: 0 } }),
    defineEmits: () => (...args) => events.push(args), api, AbortController, URLSearchParams,
    ...overrides,
  }
  const script = parse(source(name)).descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
  const state = new Function(...Object.keys(env), script + '\nreturn { ' + names.join(', ') + ' }')(...Object.values(env))
  return { ...state, calls, events, mounted, cleanup, route, wall, api }
}
const lastRequest = state => state.calls.filter(c => ['get', 'post', 'delete'].includes(c[0])).at(-1)
const response = (posts, total = posts.length, more = {}) => ({ data: { posts, total, ...more } })

test('all scoped Vue scripts and templates compile', () => {
  for (const name of ['views/Home.vue', 'views/Search.vue', 'views/Bookmarks.vue', 'views/PostDetail.vue', 'views/CreatePost.vue', 'components/PostCard.vue', 'components/CommentBox.vue']) {
    const { descriptor, errors } = parse(source(name))
    assert.deepEqual(errors, [], name)
    const script = compileScript(descriptor, { id: name })
    const result = compileTemplate({ source: descriptor.template.content, filename: name, id: name, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(result.errors, [], name)
  }
})

test('search keeps latest response and clearing invalidates in-flight work', async () => {
  const s = setup('views/Search.vue', ['doSearch', 'clearSearch', 'posts', 'loading', 'searched', 'error', 'searchedQuery'])
  const a = s.doSearch('课程'); const first = lastRequest(s)
  const b = s.doSearch('活动'); const second = lastRequest(s)
  second.at(-1).resolve(response([{ id: 2 }], 1)); await b
  first.at(-1).resolve(response([{ id: 1 }], 1)); await a
  assert.equal(s.posts.value[0].id, 2)
  const c = s.doSearch('图书馆'); const third = lastRequest(s)
  s.clearSearch()
  third.at(-1).resolve(response([{ id: 3 }])); await c
  assert.deepEqual(s.posts.value, []); assert.equal(s.searched.value, false); assert.equal(s.loading.value, false)
})

test('search rejects array query parameters safely and preserves retry state', async () => {
  const s = setup('views/Search.vue', ['doSearch', 'posts', 'loading', 'searchedQuery', 'error', 'validation'])
  await s.doSearch(['ab', 'cd'])
  assert.match(s.validation.value, /2–50/)
  const pending = s.doSearch('社团'); lastRequest(s).at(-1).reject(new Error('offline')); await pending
  assert.match(s.error.value, /搜索失败/); assert.equal(s.searchedQuery.value, '社团'); assert.equal(s.loading.value, false)
})

test('feed ignores stale categories and stale wall metadata', async () => {
  const s = setup('views/Home.vue', ['loadPosts', 'loadWallInfo', 'posts', 'loading', 'wallInfo', 'onPostDeleted', 'total'])
  const a = s.loadPosts(1, '分享'); const first = lastRequest(s)
  const b = s.loadPosts(1, '求助'); const second = lastRequest(s)
  second.at(-1).resolve(response([{ id: 2 }], 1)); await b
  first.at(-1).resolve(response([{ id: 1 }], 1)); await a
  assert.equal(s.posts.value[0].id, 2)
  const meta = s.loadWallInfo(); const req = lastRequest(s)
  s.wall.currentWallId = 3
  req.at(-1).resolve({ data: { id: 1, name: 'Old wall' } }); await meta
  assert.equal(s.wallInfo.value, null)
  s.total.value = 0; s.onPostDeleted(99); assert.equal(s.total.value, 0)
  s.cleanup.forEach(fn => fn())
})

test('bookmark removal refreshes a valid page and ignores stale responses', async () => {
  const s = setup('views/Bookmarks.vue', ['loadBookmarks', 'posts', 'total', 'page', 'onBookmarkChanged', 'loading'])
  const a = s.loadBookmarks(1); const first = lastRequest(s)
  const b = s.loadBookmarks(2); const second = lastRequest(s)
  second.at(-1).resolve(response([{ id: 21, bookmarked: true }], 21)); await b
  first.at(-1).resolve(response([{ id: 1 }], 21)); await a
  assert.equal(s.posts.value[0].id, 21)
  s.onBookmarkChanged({ id: 21, bookmarked: false })
  const refresh = lastRequest(s)
  assert.equal(refresh[2].params.page, 1)
  refresh.at(-1).resolve(response([{ id: 1 }], 20)); await nextTick(); await nextTick()
  assert.equal(s.total.value, 20); assert.equal(s.page.value, 1)
})

test('post actions prevent duplicate writes and use each post wall context', async () => {
  const s = setup('components/PostCard.vue', ['toggleLike', 'toggleBookmark', 'isLiking', 'isBookmarking', 'goToDetail'])
  const a = s.toggleLike(); const b = s.toggleLike(); assert.equal(s.calls.filter(c => c[0] === 'post').length, 1)
  assert.equal(lastRequest(s)[3].headers['X-Wall-Id'], 2)
  lastRequest(s).at(-1).resolve({ data: {} }); await a; await b
  const c = s.toggleBookmark(); const d = s.toggleBookmark(); assert.equal(s.calls.filter(c => c[0] === 'post').length, 2)
  lastRequest(s).at(-1).resolve({ data: {} }); await c; await d
  assert.equal(s.events.find(e => e[0] === 'bookmark-changed')[1].bookmarked, true)
  s.goToDetail(); assert.equal(s.wall.currentWallId, 2)
  assert.match(source('components/PostCard.vue'), /@keydown.enter.self=/)
  assert.match(source('components/PostCard.vue'), /@keydown.space.self.prevent=/)
})

test('comment submission is single-flight and does not erase a newer draft', async () => {
  const s = setup('components/CommentBox.vue', ['content', 'submit', 'submitting', 'error'])
  s.content.value = '第一条评论'
  const a = s.submit(); const b = s.submit(); assert.equal(s.calls.length, 1)
  s.content.value = '发送期间新写的草稿'
  lastRequest(s).at(-1).resolve({ data: { id: 9, post_id: 1 } }); await a; await b
  assert.equal(s.content.value, '发送期间新写的草稿'); assert.equal(s.events.length, 1)
  const c = s.submit(); lastRequest(s).at(-1).reject(new Error('offline')); await c
  assert.match(s.error.value, /内容已保留/); assert.equal(s.content.value, '发送期间新写的草稿')
})

test('unmounted comment responses never emit into the next post', async () => {
  const s = setup('components/CommentBox.vue', ['content', 'submit'])
  s.content.value = '旧帖子评论'
  const a = s.submit(); const req = lastRequest(s)
  s.cleanup.forEach(fn => fn())
  req.at(-1).resolve({ data: { id: 2, post_id: 1 } }); await a
  assert.equal(s.events.length, 0)
})

test('publishing accepts images only and revalidates confirmation path', async () => {
  const s = setup('views/CreatePost.vue', ['content', 'images', 'uploading', 'doSubmit', 'error', 'loading', 'validatePost'])
  s.images.value = ['/uploads/one.jpg']
  const payload = s.validatePost(); assert.equal(payload.content, '[img]/uploads/one.jpg[/img]')
  const a = s.doSubmit(); const b = s.doSubmit(); assert.equal(s.calls.filter(c => c[0] === 'post').length, 1)
  lastRequest(s).at(-1).resolve({ data: {} }); await a; await b
  s.content.value = 'x'.repeat(2000)
  assert.equal(s.validatePost(), null); assert.match(s.error.value, /合计不能超过/)
  s.content.value = ''; s.uploading.value = true
  await s.doSubmit(); assert.match(s.error.value, /正在上传/)
})

test('unsupported and corrupt image files leave uploading recoverable', async () => {
  class BrokenReader { readAsDataURL() { this.onerror() } }
  const s = setup('views/CreatePost.vue', ['handleImageUpload', 'uploading', 'error', 'images'], { FileReader: BrokenReader })
  await s.handleImageUpload({ target: { value: 'chosen', files: [{ type: 'image/svg+xml', name: 'bad.svg', size: 10 }] } })
  assert.equal(s.uploading.value, false); assert.match(s.error.value, /有效的/)
  await s.handleImageUpload({ target: { value: 'chosen', files: [{ type: 'image/png', name: 'bad.png', size: 10 }] } })
  assert.equal(s.uploading.value, false); assert.match(s.error.value, /上传失败/); assert.deepEqual(s.images.value, [])
})

test('detail ignores previous route responses and paginates unique comments', async () => {
  const s = setup('views/PostDetail.vue', ['loadPost', 'post', 'comments', 'commentsTotal', 'commentsPage', 'loadComments', 'onCommentAdded', 'loading'])
  const first = lastRequest(s)
  s.route.params.id = '2'; await nextTick(); const second = lastRequest(s)
  second.at(-1).resolve({ data: { post: { id: 2, wall_id: 1, comment_count: 3 }, comments: [{ id: 1, post_id: 2 }], comments_total: 3 } }); await nextTick(); await nextTick()
  first.at(-1).resolve({ data: { post: { id: 1 }, comments: [] } }); await nextTick(); await nextTick()
  assert.equal(s.post.value.id, 2)
  const more = s.loadComments(); assert.equal(lastRequest(s)[2].params.comments_page, 2)
  lastRequest(s).at(-1).resolve({ data: { post: { comment_count: 3 }, comments: [{ id: 1 }, { id: 2 }, { id: 3 }], comments_total: 3, comments_page: 2 } }); await more
  assert.deepEqual(s.comments.value.map(c => c.id), [1, 2, 3])
  s.onCommentAdded({ id: 4, post_id: 2 }); assert.equal(lastRequest(s)[2].params.comments_page, 1)
  lastRequest(s).at(-1).resolve({ data: { comments: [{ id: 1 }], comments_total: 4, comments_page: 1 } }); await nextTick(); await nextTick()
  assert.equal(s.commentsPage.value, 1); assert.equal(s.commentsTotal.value, 4)
  s.cleanup.forEach(fn => fn())
})

test('invalid dates do not display Invalid Date', () => {
  const code = source('composables/useTimeAgo.js').replace(/^import .*$/gm, '').replace('export function', 'function')
  const useTimeAgo = new Function('useSettingsStore', code + '\nreturn useTimeAgo')(() => ({ prefs: {} }))
  const time = useTimeAgo()
  for (const value of ['invalid', undefined, {}, new Date('invalid')]) { assert.equal(time.timeAgo(value), ''); assert.equal(time.fullTime(value), '') }
  assert.notEqual(time.fullTime(0), '')
})

test('attachment URLs reject script data protocol-relative and traversal sources', () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,evil', '//evil.invalid/a.png', '/api/users', '/uploads/../api/users', '/uploads/%2e%2e/api', 'https://u:p@evil.invalid/a.png', 'https:\\evil.invalid/a.png']) assert.equal(safeImageUrl(url), '', url)
  assert.equal(safeImageUrl('/uploads/valid.jpg'), '/uploads/valid.jpg')
  const { getPostImages, truncateText } = useMarkdown()
  assert.deepEqual(getPostImages('[img]data:image/png,bad[/img][img]/uploads/a.jpg[/img]'), ['/uploads/a.jpg'])
  assert.equal(getPostImages({}).length, 0)
  assert.equal(truncateText('😀校园故事', 1), '😀…')
})

