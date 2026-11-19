const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

// Never load initDB(): every fixture is an isolated, in-memory database.
process.env.JWT_SECRET = 'phase2-messages-isolated-test-secret-2026';
const { SECRET, authRequired } = require('../middleware/auth');
const { countAccessibleTreeUnread } = require('../lib/treeAccess');
const routes = Object.fromEntries(['messages', 'friends', 'users', 'walls'].map(name => [name, require('../routes/' + name)]));
let SQL;
let schema;
before(async () => {
  SQL = await initSqlJs();
  const source = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const match = source.match(/wrapper\.exec\(\x60([\s\S]*?)\x60\);/);
  assert.ok(match, 'application schema must be available without opening its database');
  const cidIndex = source.match(/wrapper[.]exec[(]"(CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client_id[^"]+)"/);
  assert.ok(cidIndex, 'production idempotency index must exist');
  schema = match[1] + '\n' + cidIndex[1] + ';';
});

function wrap(sql) {
  return {
    exec(text) { sql.run(text); },
    prepare(text) {
      const all = (...params) => {
        const stmt = sql.prepare(text);
        try {
          if (params.length) stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      };
      return {
        all,
        get(...params) { return all(...params)[0]; },
        run(...params) {
          sql.run(text, params);
          const changes = sql.getRowsModified();
          return { changes, lastInsertRowid: sql.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || 0 };
        },
      };
    },
  };
}

async function fixture(t) {
  const sql = new SQL.Database();
  sql.run(schema);
  const db = wrap(sql);
  for (let id = 1; id <= 8; id++) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,real_name,role) VALUES (?,?,?,?,?,?)')
      .run(id, 'student' + id, 'unused-test-hash', '同学' + id, '隐藏姓名' + id, id === 8 ? 'super_admin' : 'user');
  }
  db.prepare('INSERT INTO walls (id,name,owner_id,require_join_approval) VALUES (?,?,?,?)').run(1, '青禾校园墙', 1, 0);
  db.prepare('INSERT INTO walls (id,name,owner_id,require_join_approval) VALUES (?,?,?,?)').run(2, '另一校园墙', 4, 0);
  for (const [userId, role] of [[1, 'owner'], [2, 'member'], [3, 'tree_hole'], [5, 'tree_hole'], [6, 'admin'], [7, 'member']]) {
    db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,?,'active')").run(userId, role);
  }
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (2,4,'owner','active')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  for (const [name, router] of Object.entries(routes)) app.use('/api/' + name, router);
  app.get('/api/social-tree-badge', authRequired, (req, res) => res.json({ unread: countAccessibleTreeUnread(req) }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); sql.close(); });
  const request = (method, url, body, userId = 2, wallId) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { authorization: 'Bearer ' + jwt.sign({ id: userId, tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '5m' }) };
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (wallId !== undefined) headers['x-wall-id'] = String(wallId);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: '/api' + url, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (err) { reject(new Error(text)); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const message = (sender = 2, receiver = 3, type = 'private', content = '私密内容', wallId = 0, convId = '', assignee = 0) => db.prepare('INSERT INTO messages (sender_id,receiver_id,type,content,wall_id,conversation_id,assignee_id,is_anonymous) VALUES (?,?,?,?,?,?,?,?)').run(sender, receiver, type, content, wallId, convId, assignee, type === 'tree_hole' ? 1 : 0).lastInsertRowid;
  const tree = (convId = 'th_social_case', sender = 2, volunteer = 3, wallId = 1) => { message(sender, volunteer, 'tree_hole', '匿名倾诉内容', wallId, convId, volunteer); return convId; };
  return { db, request, message, tree };
}

function send(request, body = {}, userId = 2, wallId) {
  return request('POST', '/messages', { receiver_id: 3, type: 'private', content: '新的私信', ...body }, userId, wallId);
}

function lastReply(result) { return result.data.messages.at(-1); }

test('full-size sent pages resolve references in bounded batches without persisted cache reuse', async t => {
  const { request, message, db } = await fixture(t);
  const sources = Array.from({ length: 500 }, (_, i) => message(3, 2, 'private', '原文' + i));
  for (const source of sources) {
    const id = message(2, 3, 'private', '回复');
    db.prepare('UPDATE messages SET reply_to_id=?,reply_to_content=? WHERE id=?').run(source, '过期缓存', id);
  }
  const sent = await request('GET', '/messages/sent');
  assert.equal(sent.status, 200);
  assert.equal(sent.data.length, 500);
  assert.equal(sent.data.every(m => m.reply_to.available && m.reply_to.content.startsWith('原文')), true);
  assert.doesNotMatch(JSON.stringify(sent.data), /过期缓存/);
});

test('empty history and exact page boundaries report accurate cursors', async t => {
  const { request, message } = await fixture(t);
  const empty = await request('GET', '/messages/conversation/3?mark_read=0');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.messages, []);
  assert.equal(empty.data.hasMore, false);
  assert.equal(empty.data.next_before_id, null);
  const ids = [message(), message()];
  const exact = await request('GET', '/messages/conversation/3?limit=2&mark_read=0');
  assert.deepEqual(exact.data.messages.map(m => m.id), ids);
  assert.equal(exact.data.hasMore, false);
  assert.equal(exact.data.next_before_id, ids[0]);
  assert.equal(exact.data.next_after_id, ids[1]);
});

test('before and after cursors return contiguous visible pages without false hasMore', async t => {
  const { request, message, db } = await fixture(t);
  const ids = Array.from({ length: 6 }, (_, i) => message(i % 2 ? 3 : 2, i % 2 ? 2 : 3, 'private', '消息' + i));
  db.prepare('UPDATE messages SET receiver_deleted=1 WHERE id=?').run(ids[1]);
  const latest = await request('GET', '/messages/conversation/3?limit=2&mark_read=0');
  assert.deepEqual(latest.data.messages.map(m => m.id), ids.slice(4));
  assert.equal(latest.data.hasMoreBefore, true);
  const older = await request('GET', '/messages/conversation/3?limit=2&mark_read=0&before=' + latest.data.next_before_id);
  assert.deepEqual(older.data.messages.map(m => m.id), ids.slice(2, 4));
  const oldest = await request('GET', '/messages/conversation/3?limit=2&mark_read=0&before=' + older.data.next_before_id);
  assert.deepEqual(oldest.data.messages.map(m => m.id), [ids[0]]);
  assert.equal(oldest.data.hasMore, false);
  const incremental = await request('GET', '/messages/conversation/3?limit=2&mark_read=0&after=' + ids[0]);
  assert.deepEqual(incremental.data.messages.map(m => m.id), ids.slice(2, 4));
  assert.equal(incremental.data.hasMore, true);
  const tail = await request('GET', '/messages/conversation/3?limit=2&mark_read=0&after=' + incremental.data.next_after_id);
  assert.deepEqual(tail.data.messages.map(m => m.id), ids.slice(4));
  assert.equal(tail.data.hasMore, false);
});

test('around contexts include only the authorized anchor and fill windows at both ends', async t => {
  const { request, message, db } = await fixture(t);
  const ids = Array.from({ length: 7 }, () => message());
  const middle = await request('GET', '/messages/conversation/3?limit=5&mark_read=0&around_id=' + ids[3]);
  assert.deepEqual(middle.data.messages.map(m => m.id), ids.slice(1, 6));
  assert.equal(middle.data.hasMoreBefore, true);
  assert.equal(middle.data.hasMoreAfter, true);
  for (const anchor of [ids[0], ids.at(-1)]) {
    const page = await request('GET', '/messages/conversation/3?limit=5&mark_read=0&around_id=' + anchor);
    assert.equal(page.data.messages.length, 5);
    assert.ok(page.data.messages.some(m => m.id === anchor));
  }
  const foreign = message(4, 7);
  assert.equal((await request('GET', '/messages/conversation/3?around_id=' + foreign)).status, 404);
  db.prepare('UPDATE messages SET sender_deleted=1 WHERE id=?').run(ids[3]);
  assert.equal((await request('GET', '/messages/conversation/3?around_id=' + ids[3])).status, 404);
  const treeId = message(2, 3, 'tree_hole', '匿名内容', 1, 'th_context', 3);
  assert.equal((await request('GET', '/messages/conversation/3?around_id=' + treeId)).status, 404);
});

test('search is literal, paginated, scoped and never reads stale quote caches', async t => {
  const { request, message, db } = await fixture(t);
  const id = message(3, 2, 'private', '字面100%_\\答案');
  message(3, 2, 'private', '普通100xyz答案');
  message(4, 7, 'private', '字面100%_\\答案');
  const needle = encodeURIComponent('%_\\');
  const search = await request('GET', '/messages/conversation/3?mark_read=0&q=' + needle);
  assert.equal(search.status, 200);
  assert.deepEqual(search.data.messages.map(m => m.id), [id]);
  const quoted = message(2, 3, 'private', '其他文字');
  db.prepare('UPDATE messages SET reply_to_id=?,reply_to_content=? WHERE id=?').run(id, '绝不能搜索缓存', quoted);
  assert.deepEqual((await request('GET', '/messages/conversation/3?mark_read=0&q=' + encodeURIComponent('绝不能搜索缓存'))).data.messages, []);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(id).is_read, 0);
  assert.deepEqual((await request('GET', '/messages/conversation/3?mark_read=0&q=' + encodeURIComponent("' OR 1=1 --"))).data.messages, []);
});

test('history rejects malformed parameters and incompatible query modes', async t => {
  const { request } = await fixture(t);
  for (const query of ['limit=0', 'limit=201', 'limit[]=2', 'before=1x', 'after=-1', 'around_id=0', 'before=1&after=2', 'before=1&around_id=2', 'after=1&q=x', 'around_id=1&q=x', 'q[]=%25', 'q=', 'q=' + 'a'.repeat(101), 'mark_read=false', 'mark_read[]=0']) {
    assert.equal((await request('GET', '/messages/conversation/3?' + query)).status, 400, query);
  }
});

test('mark_read=0 is side-effect free and default reads mark only the visible page', async t => {
  const { request, message, db } = await fixture(t);
  const ids = [message(3, 2), message(3, 2), message(3, 2)];
  const pure = await request('GET', '/messages/conversation/3?limit=1&mark_read=0');
  assert.equal(pure.data.unreadMarked, 0);
  assert.equal(db.prepare('SELECT SUM(is_read) AS n FROM messages').get().n, 0);
  const read = await request('GET', '/messages/conversation/3?limit=1');
  assert.equal(read.data.unreadMarked, 1);
  assert.equal(read.data.messages[0].is_read, 1);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(ids[0]).is_read, 0);
});

test('conversation summaries include legitimate nonfriends without exposing tree or private profile data', async t => {
  const { request, message, db, tree } = await fixture(t);
  const outsider = message(4, 2, 'private', '历史私聊仍可见');
  const latest = message(3, 2, 'private', '最新对话');
  tree('th_summary_secret');
  message(2, 5, 'confession', '不能当私聊摘要', 1);
  message(4, 7, 'private', '两个陌生人的聊天');
  db.prepare("UPDATE users SET contact_qq='private-contact',show_contact=0 WHERE id=4").run();
  const response = await request('GET', '/messages/conversations');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.conversations.map(c => c.user_id), [3, 4]);
  assert.deepEqual(response.data.conversations.map(c => c.last_message_id), [latest, outsider]);
  assert.equal(response.data.conversations[1].can_send, false);
  assert.equal(response.data.conversations[0].unread_count, 1);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(latest).is_read, 0);
  assert.doesNotMatch(JSON.stringify(response.data), /th_summary_secret|不能当私聊|陌生人|private-contact|隐藏姓名/);
  assert.deepEqual(Object.keys(response.data.conversations[0].other_user).sort(), ['available', 'avatar', 'id', 'nickname']);
});

test('summary pages, deletion flags and availability are based only on viewer-visible messages', async t => {
  const { request, message, db } = await fixture(t);
  const hiddenLast = message(3, 2, 'private', '最早可见');
  message(4, 2);
  message(5, 2);
  const hidden = message(3, 2, 'private', '应隐藏的最新');
  db.prepare('UPDATE messages SET receiver_deleted=1 WHERE id=?').run(hidden);
  const first = await request('GET', '/messages/conversations?limit=2');
  assert.equal(first.data.hasMore, true);
  assert.deepEqual(first.data.conversations.map(c => c.user_id), [5, 4]);
  const last = await request('GET', '/messages/conversations?limit=2&before=' + first.data.next_before_id);
  assert.equal(last.data.hasMore, false);
  assert.equal(last.data.conversations[0].last_message_id, hiddenLast);
  db.prepare("UPDATE users SET status='banned' WHERE id=3").run();
  const unavailable = (await request('GET', '/messages/conversations')).data.conversations.find(c => c.user_id === 3);
  assert.equal(unavailable.other_user.available, false);
  assert.equal(unavailable.can_send, false);
  assert.equal(unavailable.other_user.nickname, '用户暂不可用');
  for (const query of ['limit=101', 'before=3x', 'limit[]=2']) assert.equal((await request('GET', '/messages/conversations?' + query)).status, 400);
});

test('new replies expose a stable safe object and legacy aliases', async t => {
  const { request, message } = await fixture(t);
  const id = message(3, 2, 'private', '可引用的原文');
  const result = await send(request, { reply_to_id: id });
  assert.equal(result.status, 200);
  const reply = result.data.message_item;
  assert.equal(reply.reply_to.available, true);
  assert.equal(reply.reply_to.id, id);
  assert.equal(reply.reply_to.is_mine, false);
  assert.equal(reply.reply_to.sender_id, 3);
  assert.equal(reply.reply_to.content, '可引用的原文');
  assert.equal(reply.reply_to_sender_name, '同学3');
  assert.equal(reply.reply_to_content, reply.reply_to.content);
  assert.equal(reply.reply_to_missing, false);
});

test('deleted quote sources disappear dynamically for one side in every message reader', async t => {
  const { request, message, db } = await fixture(t);
  const source = message(3, 2, 'private', '不应再显示的引用');
  const sent = await send(request, { reply_to_id: source });
  await request('DELETE', '/messages/' + source);
  for (const response of [
    await request('GET', '/messages/conversation/3?mark_read=0'),
    await request('GET', '/messages/sent'),
  ]) {
    const rows = Array.isArray(response.data) ? response.data : response.data.messages;
    const quoted = rows.find(m => m.id === sent.data.id);
    assert.equal(quoted.reply_to.available, false);
    assert.equal(quoted.reply_to_missing, true);
    assert.equal(quoted.reply_to_content, '');
    assert.equal(quoted.reply_to.sender_id, null);
  }
  const summary = await request('GET', '/messages/conversations');
  assert.equal(summary.data.conversations[0].last_message.reply_to_content, '');
  const otherSide = await request('GET', '/messages/inbox', undefined, 3);
  assert.equal(otherSide.data.messages.find(m => m.id === sent.data.id).reply_to.available, true);
  assert.equal(db.prepare('SELECT reply_to_content FROM messages WHERE id=?').get(sent.data.id).reply_to_content, '不应再显示的引用');
});

test('revocation and poisoned legacy quote caches never disclose old or foreign text', async t => {
  const { request, message, db } = await fixture(t);
  const source = message(3, 2, 'private', '撤回后的秘密');
  const reply = await send(request, { reply_to_id: source });
  await request('PUT', '/messages/' + source + '/revoke', {}, 3);
  const revoked = lastReply(await request('GET', '/messages/conversation/3?mark_read=0'));
  assert.equal(revoked.id, reply.data.id);
  assert.equal(revoked.reply_to.available, false);
  assert.equal(revoked.reply_to_revoked, true);
  assert.equal(revoked.reply_to.content, '');
  const sources = [message(7, 2, 'private', '别人的会话'), message(2, 3, 'private', '别的墙', 2), message(2, 3, 'confession', '别的类型', 1)];
  for (const foreign of sources) {
    const id = message(2, 3, 'private', '被污染的历史');
    db.prepare('UPDATE messages SET reply_to_id=?,reply_to_content=? WHERE id=?').run(foreign, '持久化越权缓存', id);
    const shown = lastReply(await request('GET', '/messages/conversation/3?mark_read=0'));
    assert.equal(shown.reply_to_content, '');
    assert.equal(shown.reply_to.available, false);
  }
});

test('quote creation rejects hidden, anonymous, cross-party and cross-wall sources', async t => {
  const { request, message, db } = await fixture(t);
  const ids = [message(4, 7), message(3, 2, 'private', '墙不符', 2), message(2, 3)];
  db.prepare('UPDATE messages SET sender_deleted=1 WHERE id=?').run(ids[2]);
  for (const id of ids) assert.equal((await send(request, { reply_to_id: id })).status, 403);
  const anonymous = message(3, 2, 'confession', '匿名原文', 1);
  db.prepare('UPDATE messages SET is_anonymous=1 WHERE id=?').run(anonymous);
  assert.equal((await send(request, { type: 'confession', reply_to_id: anonymous }, 2, 1)).status, 403);
});

test('client message IDs deduplicate normalized payloads and preserve old clients', async t => {
  const { request, db } = await fixture(t);
  const first = await send(request, { content: '  同一请求  ', title: ' 标题 ', client_message_id: 'draft:one' });
  const retry = await send(request, { content: '同一请求', title: '标题', client_message_id: 'draft:one' });
  assert.equal(first.status, 200);
  assert.equal(first.data.deduplicated, false);
  assert.equal(retry.data.deduplicated, true);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(retry.data.client_message_id, 'draft:one');
  assert.equal(retry.data.message_item.id, first.data.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  await send(request);
  await send(request);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
});

test('idempotency conflicts cannot change receiver, text, title, type, wall or quote', async t => {
  const { request, message, db } = await fixture(t);
  const quote = message(3, 2);
  const first = await send(request, { client_message_id: 'payload:fixed' });
  for (const change of [{ receiver_id: 7 }, { content: '不同内容' }, { title: '不同标题' }, { type: 'confession' }, { reply_to_id: quote }]) {
    const conflict = await send(request, { client_message_id: 'payload:fixed', ...change }, 2, 1);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'CLIENT_MESSAGE_CONFLICT');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_message_id=?').get('payload:fixed').n, 1);
  assert.equal((await send(request, { client_message_id: 'payload:fixed' })).data.id, first.data.id);
});

test('sender-scoped IDs remain distinct and concurrent retries insert exactly once', async t => {
  const { request, db } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => send(request, { client_message_id: 'parallel:one' })));
  assert.equal(results.every(r => r.status === 200), true);
  assert.equal(new Set(results.map(r => r.data.id)).size, 1);
  assert.equal(results.filter(r => !r.data.deduplicated).length, 1);
  const other = await send(request, { receiver_id: 2, client_message_id: 'parallel:one' }, 3);
  assert.equal(other.status, 200);
  assert.notEqual(other.data.id, results[0].data.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_message_id=?').get('parallel:one').n, 2);
  assert.throws(() => db.prepare("INSERT INTO messages (sender_id,receiver_id,type,content,client_message_id) VALUES (2,3,'private','duplicate','parallel:one')").run(), /UNIQUE/);
});

test('idempotent retries never revive sender-hidden, receiver-hidden or revoked messages', async t => {
  const { request, db } = await fixture(t);
  const hidden = await send(request, { client_message_id: 'hidden:one' });
  await request('DELETE', '/messages/' + hidden.data.id);
  assert.equal((await send(request, { client_message_id: 'hidden:one' })).status, 409);
  assert.equal(db.prepare('SELECT sender_deleted FROM messages WHERE id=?').get(hidden.data.id).sender_deleted, 1);
  const receiverHidden = await send(request, { client_message_id: 'receiver:hidden' });
  await request('DELETE', '/messages/' + receiverHidden.data.id, undefined, 3);
  const acknowledged = await send(request, { client_message_id: 'receiver:hidden' });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.data.deduplicated, true);
  assert.equal(db.prepare('SELECT receiver_deleted FROM messages WHERE id=?').get(receiverHidden.data.id).receiver_deleted, 1);
  assert.equal(Object.hasOwn(acknowledged.data.message_item, 'receiver_deleted'), false);
  const revoked = await send(request, { client_message_id: 'revoked:one' });
  await request('PUT', '/messages/' + revoked.data.id + '/revoke', {});
  assert.equal((await send(request, { client_message_id: 'revoked:one' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
});

test('retries acknowledge committed writes after quote access changes without leaking the source', async t => {
  const { request, message, db } = await fixture(t);
  const source = message(3, 2);
  const body = { client_message_id: 'quote:retry', reply_to_id: source };
  const first = await send(request, body);
  await request('DELETE', '/messages/' + source);
  const retry = await send(request, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(retry.data.message_item.reply_to.available, false);
  assert.equal(retry.data.message_item.reply_to_content, '');
  db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (3,2,'blocked')").run();
  assert.equal((await send(request, body)).data.deduplicated, true);
  assert.equal((await send(request, { client_message_id: 'a-new-write' })).status, 403);
});

test('invalid client IDs are rejected and only the sender receives its reconciliation nonce', async t => {
  const { request } = await fixture(t);
  for (const cid of ['', 'a'.repeat(129), '含中文', 'has space', [], {}, 3]) assert.equal((await send(request, { client_message_id: cid })).status, 400);
  const sent = await send(request, { client_message_id: 'nonce:private' });
  const mine = await request('GET', '/messages/conversation/3?mark_read=0');
  assert.equal(mine.data.messages.find(m => m.id === sent.data.id).client_message_id, 'nonce:private');
  const theirs = await request('GET', '/messages/conversation/2?mark_read=0', undefined, 3);
  assert.equal(theirs.data.messages.find(m => m.id === sent.data.id).client_message_id, null);
});

test('tree pagination is opt in, side-effect free when requested and retains anonymous metadata', async t => {
  const { request, tree, message, db } = await fixture(t);
  const conv = tree('th_phase2_history');
  for (let i = 0; i < 4; i++) message(2, 3, 'tree_hole', '倾诉' + i, 1, conv, 3);
  const page = await request('GET', '/messages/tree-hole/' + conv + '?limit=2&mark_read=0', undefined, 3);
  assert.equal(page.status, 200);
  assert.equal(page.data.messages.length, 2);
  assert.equal(page.data.hasMore, true);
  assert.equal(page.data.conversation_id, conv);
  assert.equal(page.data.other_user_id, null);
  assert.equal(page.data.is_initiator, false);
  assert.equal(Object.hasOwn(page.data.messages[0], 'sender_id'), false);
  assert.equal(db.prepare('SELECT SUM(is_read) AS n FROM messages').get().n, 0);
  const earlier = await request('GET', '/messages/tree-hole/' + conv + '?limit=2&mark_read=0&before=' + page.data.next_before_id, undefined, 3);
  assert.equal(earlier.data.messages.length, 2);
  assert.equal(earlier.data.messages.at(-1).id < page.data.messages[0].id, true);
  const legacy = await request('GET', '/messages/tree-hole/' + conv + '?mark_read=0', undefined, 3);
  assert.equal(legacy.data.messages.length, 5);
  assert.equal(legacy.data.hasMore, false);
});

test('literal search pages remain scoped and report exact matching boundaries', async t => {
  const { request, message } = await fixture(t);
  const ids = [message(3, 2, 'private', '检索%词'), message(2, 3, 'private', '检索%词'), message(3, 2, 'private', '检索%词')];
  message(3, 2, 'private', '不匹配');
  const query = '?mark_read=0&limit=2&q=' + encodeURIComponent('检索%词');
  const first = await request('GET', '/messages/conversation/3' + query);
  assert.deepEqual(first.data.messages.map(m => m.id), ids.slice(1));
  assert.equal(first.data.hasMore, true);
  const last = await request('GET', '/messages/conversation/3' + query + '&before=' + first.data.next_before_id);
  assert.deepEqual(last.data.messages.map(m => m.id), [ids[0]]);
  assert.equal(last.data.hasMore, false);
});

test('revoking a reply also removes its own quoted preview for both participants', async t => {
  const { request, message } = await fixture(t);
  const source = message(3, 2, 'private', '被引用的原文');
  const sent = await send(request, { reply_to_id: source });
  await request('PUT', '/messages/' + sent.data.id + '/revoke', {});
  const shown = lastReply(await request('GET', '/messages/conversation/3?mark_read=0'));
  assert.equal(shown.is_revoked, 1);
  assert.equal(shown.reply_to.available, false);
  assert.equal(shown.reply_to_content, '');
  const incoming = await request('GET', '/messages/inbox', undefined, 3);
  assert.equal(incoming.data.messages.find(m => m.id === sent.data.id).reply_to_content, '');
});

test('an incoming reply never restores a viewer-hidden original via cached preview', async t => {
  const { request, message } = await fixture(t);
  const source = message(2, 3, 'private', '我已隐藏的原文');
  const reply = await send(request, { receiver_id: 2, reply_to_id: source }, 3);
  await request('DELETE', '/messages/' + source);
  const inbox = await request('GET', '/messages/inbox');
  const quoted = inbox.data.messages.find(m => m.id === reply.data.id);
  assert.equal(quoted.reply_to.available, false);
  assert.equal(quoted.reply_to_content, '');
  assert.equal(quoted.reply_to_sender_id, null);
});

test('anonymous confession retries keep sender attribution private and include wall in their key payload', async t => {
  const { request, db } = await fixture(t);
  const body = { client_message_id: 'confession:anonymous', type: 'confession', is_anonymous: true };
  const first = await send(request, body, 2, 1);
  assert.equal(first.status, 200);
  const retry = await send(request, body, 2, 1);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(retry.data.deduplicated, true);
  assert.equal((await send(request, body, 2, 2)).status, 409);
  assert.equal((await send(request, { ...body, is_anonymous: false }, 2, 1)).status, 409);
  const inbox = await request('GET', '/messages/inbox?type=confession', undefined, 3);
  assert.equal(inbox.data.messages[0].sender_id, null);
  assert.equal(inbox.data.messages[0].client_message_id, null);
  assert.equal(inbox.data.messages[0].link, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('global chat bans still reject idempotent replay before route processing', async t => {
  const { request, db } = await fixture(t);
  await send(request, { client_message_id: 'global-ban:retry' });
  db.prepare("UPDATE users SET status='banned',ban_level='chat' WHERE id=2").run();
  assert.equal((await send(request, { client_message_id: 'global-ban:retry' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('unsupported summary and anonymous cursor modes fail explicitly', async t => {
  const { request, tree } = await fixture(t);
  const conv = tree('th_phase2_invalid_mode');
  for (const query of ['after=1', 'around_id=1', 'q=x']) {
    assert.equal((await request('GET', '/messages/conversations?' + query)).status, 400);
    assert.equal((await request('GET', '/messages/tree-hole/' + conv + '?limit=2&' + query)).status, 400);
  }
});

test('tree page reads mark only returned rows and global closure state survives hidden anchors', async t => {
  const { request, tree, message, db } = await fixture(t);
  const conv = tree('th_phase2_close');
  message(2, 3, 'tree_hole', '第二条倾诉', 1, conv, 3);
  await request('GET', '/messages/tree-hole/' + conv + '?limit=1', undefined, 3);
  assert.equal(db.prepare('SELECT SUM(is_read) AS n FROM messages').get().n, 1);
  await request('POST', '/messages/tree-hole/' + conv + '/close', {});
  const close = db.prepare('SELECT MAX(id) AS id FROM messages').get().id;
  const earlier = await request('GET', '/messages/tree-hole/' + conv + '?limit=1&before=' + close + '&mark_read=0');
  assert.equal(earlier.data.is_closed, true);
  assert.equal(earlier.data.is_initiator, true);
  for (const query of ['before=1', 'limit=0', 'limit=201', 'limit=2&before=x', 'limit=2&mark_read=false']) assert.equal((await request('GET', '/messages/tree-hole/' + conv + '?' + query)).status, 400);
});
