'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-confessions-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'confession-integration-only-secret';
delete process.env.KEEP_DB;
const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { migrateConfessions } = require('../lib/confessions');
let db, server, baseUrl;

before(async () => {
  db = await initDB({ deferInitialSave: true });
  const app = express();
  app.use(require('../lib/apiV1').apiV1Middleware());
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  for (const table of ['confession_identity_requests', 'messages', 'friends', 'user_permissions', 'wall_members', 'walls', 'users']) db.exec('DELETE FROM ' + table);
  for (const [id, nickname] of [[1, '秘密作者'], [2, '收信人'], [3, '同墙旁观者'], [4, '另一墙用户']]) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,avatar,real_name,contact_qq) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'confession-' + id, 'unused-hash', nickname, '/avatar-' + id, '隐藏真实姓名-' + id, '隐藏QQ-' + id);
  }
  for (const id of [1, 2, 3]) db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,1)').run(id, 'confession-wall-' + id);
  for (const wallId of [1, 2]) {
    for (const userId of [1, 2, 3]) db.prepare("INSERT INTO wall_members (wall_id,user_id,status) VALUES (?,?,'active')").run(wallId, userId);
  }
  db.prepare("INSERT INTO wall_members (wall_id,user_id,status) VALUES (3,4,'active')").run();
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (db) { db.dirty = false; db.db.close(); }
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('school-wall-confessions-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(userId, route, { method = 'GET', body, wall = 1, versioned = false, authenticated = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authenticated) headers.authorization = 'Bearer ' + jwt.sign({ id: userId, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  if (wall !== null) headers['x-wall-id'] = String(wall);
  const response = await fetch(baseUrl + (versioned ? '/api/v1' : '/api') + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.headers.get('content-type')?.startsWith('application/gzip')
    ? JSON.parse(require('node:zlib').gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'))
    : await response.json();
  return { status: response.status, body: payload };
}

async function letter(options = {}, author = 1) {
  const result = await request(author, '/messages', { method: 'POST', body: {
    type: 'confession', receiver_id: 2, title: '一封信', content: '    Markdown缩进正文', is_anonymous: true, allow_replies: true, ...options,
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.id;
}

const reply = (user, id, content = '回复', extra = {}) => request(user, '/messages/confessions/' + id + '/replies', { method: 'POST', body: { content, ...extra } });
const apply = (id, extra = {}, user = 2) => request(user, '/messages/confessions/' + id + '/identity-requests', { method: 'POST', body: { confirmed: true, ...extra } });
const decide = (id, decision = 'approve', user = 1, options = {}) => request(user, '/messages/confessions/identity-requests/' + id, { method: 'PUT', body: { decision }, ...options });
const thread = (user, id, suffix = '', options = {}) => request(user, '/messages/confessions/' + id + '/thread' + suffix, options);

test('幂等迁移保留旧信，将历史引用标识为回复，重复运行不重置授权或申请', async () => {
  const SQL = await require('sql.js')();
  const sql = new SQL.Database();
  const legacy = {
    exec: value => sql.run(value),
    prepare: value => ({
      all: (...params) => { const stmt = sql.prepare(value); try { stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); } },
    }),
  };
  sql.run("PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE walls(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); INSERT INTO walls VALUES(1)");
  sql.run("CREATE TABLE messages(id INTEGER PRIMARY KEY,sender_id INTEGER,receiver_id INTEGER,wall_id INTEGER,type TEXT,content TEXT,reply_to_id INTEGER DEFAULT 0,receiver_deleted INTEGER DEFAULT 0,is_revoked INTEGER DEFAULT 0)");
  sql.run("INSERT INTO messages(id,sender_id,receiver_id,wall_id,type,content,reply_to_id) VALUES (1,1,2,1,'confession','old',0),(2,2,1,1,'confession','reply',1),(3,1,2,1,'confession','nested reply',2)");
  migrateConfessions(legacy);
  sql.run('UPDATE messages SET allow_replies=1 WHERE id=1');
  migrateConfessions(legacy);
  assert.deepEqual(legacy.prepare('SELECT id,content,confession_kind,confession_root_id,allow_replies FROM messages ORDER BY id').all(), [
    { id: 1, content: 'old', confession_kind: 'letter', confession_root_id: 0, allow_replies: 1 },
    { id: 2, content: 'reply', confession_kind: 'reply', confession_root_id: 1, allow_replies: 0 },
    { id: 3, content: 'nested reply', confession_kind: 'reply', confession_root_id: 1, allow_replies: 0 },
  ]);
  assert.equal(legacy.prepare('PRAGMA table_info(messages)').all().filter(row => row.name === 'allow_replies').length, 1);
  assert.equal(legacy.prepare('PRAGMA foreign_keys').all()[0].foreign_keys, 1);
  sql.run('INSERT INTO confession_identity_requests(message_id,wall_id,requester_id,author_id) VALUES(1,1,2,1)');
  for (const deletion of ['DELETE FROM messages WHERE id=1', 'DELETE FROM users WHERE id=1', 'DELETE FROM users WHERE id=2', 'DELETE FROM walls WHERE id=1']) {
    sql.run('SAVEPOINT verify_migrated_cascade');
    sql.run(deletion);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').all()[0].c, 0, deletion);
    assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
    sql.run('ROLLBACK TO SAVEPOINT verify_migrated_cascade');
    sql.run('RELEASE SAVEPOINT verify_migrated_cascade');
  }
  sql.close();
  const id = await letter();
  const submitted = await apply(id);
  migrateConfessions(db);
  migrateConfessions(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 1);
  assert.equal(db.prepare('SELECT id FROM confession_identity_requests').get().id, submitted.body.request.id);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('回复默认关闭，专用与旧发送路径都强制403，原信正文保留Markdown缩进', async () => {
  const sent = await request(1, '/messages', { method: 'POST', body: { type: 'confession', receiver_id: 2, content: '    code', is_anonymous: false } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message_item.allow_replies, false);
  assert.equal(sent.body.message_item.can_reply, false);
  assert.equal(sent.body.message_item.content, '    code');
  assert.equal((await reply(2, sent.body.id)).status, 403);
  assert.equal((await reply(1, sent.body.id)).status, 403);
  assert.equal((await request(2, '/messages', { method: 'POST', body: { type: 'confession', receiver_id: 1, content: '绕过', reply_to_id: sent.body.id, allow_replies: true } })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1);
  const inbox = await request(2, '/messages/inbox?type=confession');
  assert.equal(inbox.body.messages[0].allow_replies, false);
  assert.equal((await request(1, '/messages', { method: 'POST', body: { type: 'confession', receiver_id: 2, content: '信', allow_replies: 1 } })).status, 400);
});

test('匿名双方回复脱敏包括回执、发件箱、引用和分页，ID重试不会重复发送', async () => {
  const id = await letter({ client_message_id: 'letter-client-secret' });
  const first = await reply(2, id, '    收件人回复', { client_message_id: 'reply-once' });
  assert.equal(first.status, 200);
  assert.equal(first.body.message_item.receiver_id, null);
  assert.equal(first.body.message_item.receiver_nickname, null);
  assert.equal(first.body.message_item.content, '    收件人回复');
  assert.equal(first.body.message_item.reply_to_sender_id, null);
  const retried = await reply(2, id, '    收件人回复', { client_message_id: 'reply-once' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.id, first.body.id);
  assert.equal(retried.body.deduplicated, true);
  assert.equal((await reply(2, id, '不同内容', { client_message_id: 'reply-once' })).status, 409);
  const second = await reply(1, id, '匿名作者回信', { client_message_id: 'author-client-secret' });
  assert.equal(second.status, 200);
  assert.equal(second.body.message_item.is_anonymous, 1);
  await reply(2, id, '第三条');
  const read = await thread(2, id, '?limit=2');
  assert.equal(read.status, 200);
  assert.equal(read.body.hasMore, true);
  assert.equal(read.body.confession.sender_id, null);
  assert.equal(read.body.confession.sender_nickname, null);
  assert.equal(read.body.confession.sender_avatar, null);
  assert.equal(read.body.confession.link, '');
  assert.equal(read.body.confession.client_message_id, null);
  const authorReply = read.body.messages.find(row => row.id === second.body.id);
  assert.equal(authorReply.sender_id, null);
  assert.equal(authorReply.sender_nickname, null);
  assert.equal(authorReply.sender_avatar, null);
  assert.equal(authorReply.client_message_id, null);
  assert.equal(authorReply.link, '');
  assert.equal(authorReply.is_mine, false);
  assert.equal(authorReply.confession_root_id, id);
  const earlier = await thread(2, id, '?limit=2&before=' + read.body.next_before_id);
  assert.equal(earlier.body.hasMore, false);
  assert.deepEqual(earlier.body.messages.map(row => row.id), [first.body.id]);
  const sent = (await request(2, '/messages/sent')).body.find(row => row.id === first.body.id);
  assert.equal(sent.receiver_id, null);
  assert.equal(sent.receiver_nickname, null);
  const inbox = (await request(2, '/messages/inbox')).body.messages.find(row => row.id === second.body.id);
  assert.equal(inbox.sender_id, null);
  assert.equal((await reply(2, id, '恶意路由', { receiver_id: 1 })).status, 400);
  assert.equal((await reply(1, id, '取消匿名', { is_anonymous: false })).status, 400);
  assert.equal((await thread(3, id)).status, 403);
  assert.equal((await thread(2, id, '', { wall: 2 })).status, 403);
});

test('身份申请须确认，可携带Markdown且仅原作者审批；同意仅披露指定原信收件人', async () => {
  const id = await letter();
  const other = await letter();
  assert.equal((await request(2, '/messages/confessions/' + id + '/identity-requests', { method: 'POST', body: { message: '未确认' } })).status, 400);
  assert.equal((await apply(id, {}, 1)).status, 403);
  assert.equal((await apply(id, {}, 3)).status, 403);
  const submitted = await apply(id, { message: '    Markdown附言\n\n**可以认识你吗**' });
  assert.equal(submitted.status, 200);
  const application = submitted.body.request;
  assert.equal(application.status, 'pending');
  assert.equal(application.message, '    Markdown附言\n\n**可以认识你吗**');
  assert.equal(application.author_id, undefined);
  assert.equal(application.requester.id, 2);
  assert.equal((await thread(2, id)).body.confession.revealed_sender, null);
  assert.equal((await apply(id)).status, 409);
  assert.equal((await decide(application.id, 'approve', 2)).status, 403);
  assert.equal((await decide(application.id, 'approve', 3)).status, 403);
  assert.equal((await decide(application.id, 'approve', 1, { wall: 2 })).status, 403);
  assert.equal((await request(3, '/messages/confessions/identity-requests')).body.requests.length, 0);
  const authorApplications = (await request(1, '/messages/confessions/identity-requests')).body.requests;
  assert.equal(authorApplications.length, 1);
  assert.equal(authorApplications[0].is_author, true);
  assert.deepEqual(Object.keys(authorApplications[0].requester).sort(), ['avatar', 'id', 'nickname']);
  const allowed = await decide(application.id);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.request.status, 'approved');
  assert.ok(allowed.body.request.decided_at);
  assert.equal((await decide(application.id, 'reject')).status, 409);
  const disclosed = (await thread(2, id)).body.confession;
  assert.deepEqual(disclosed.revealed_sender, { id: 1, nickname: '秘密作者', avatar: '/avatar-1' });
  assert.equal(disclosed.sender_id, null);
  assert.equal((await thread(2, other)).body.confession.revealed_sender, null);
  assert.equal((await thread(1, id)).body.confession.revealed_sender, null);
  assert.equal((await thread(3, id)).status, 403);
  const inbox = (await request(2, '/messages/inbox')).body.messages;
  assert.deepEqual(inbox.find(row => row.id === id).revealed_sender, disclosed.revealed_sender);
  const notice = inbox.find(row => row.title === '表白信身份申请结果');
  assert.equal(notice.sender_id, null);
  assert.ok(!JSON.stringify(notice).includes('秘密作者'));
  assert.ok(!JSON.stringify(disclosed).includes('隐藏真实姓名'));
  assert.ok(!JSON.stringify(disclosed).includes('隐藏QQ'));
  // Grant is tied to the original letter, never a global author/recipient pair.
  assert.equal((await thread(2, other)).body.confession.identity_request, null);
});

test('拒绝不泄露身份、申请不允许重复，空白或省略附言均可', async () => {
  const id = await letter();
  const submitted = await apply(id);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.request.message, '');
  assert.equal((await decide(submitted.body.request.id, 'reject')).body.request.status, 'rejected');
  assert.equal((await thread(2, id)).body.confession.revealed_sender, null);
  assert.equal((await apply(id, { message: '再次请求' })).status, 409);
  const blank = await apply(await letter(), { message: '   ' });
  assert.equal(blank.status, 200);
  assert.equal(blank.body.request.message, '');
  const named = await letter({ is_anonymous: false });
  assert.equal((await apply(named)).status, 403);
});

for (const [name, mutate] of [
  ['作者删除', id => db.prepare('UPDATE messages SET sender_deleted=1 WHERE id=?').run(id)],
  ['收信人删除', id => db.prepare('UPDATE messages SET receiver_deleted=1 WHERE id=?').run(id)],
  ['撤回', id => db.prepare('UPDATE messages SET is_revoked=1 WHERE id=?').run(id)],
  ['作者拉黑', () => db.prepare("INSERT INTO friends(user_id,friend_id,status) VALUES (1,2,'blocked')").run()],
  ['收信人拉黑', () => db.prepare("INSERT INTO friends(user_id,friend_id,status) VALUES (2,1,'blocked')").run()],
  ['作者退墙', () => db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=1').run()],
  ['收信人退墙', () => db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=2').run()],
  ['墙停用', () => db.prepare("UPDATE walls SET status='disabled' WHERE id=1").run()],
  ['作者停用', () => db.prepare("UPDATE users SET status='disabled' WHERE id=1").run()],
]) {
  test(name + '使申请、审批、回复即时失效，已批准身份不再输出', async () => {
    const id = await letter();
    const second = await letter();
    const pending = await apply(id);
    const approved = await apply(second);
    assert.equal((await decide(approved.body.request.id)).status, 200);
    mutate(id);
    // The second letter shares relationship changes, and explicit mutations target it too.
    if (['作者删除', '收信人删除', '撤回'].includes(name)) mutate(second);
    assert.equal((await reply(2, id)).status, 403);
    assert.equal((await decide(pending.body.request.id)).status, 403);
    const result = await thread(2, second);
    assert.ok([200, 403].includes(result.status));
    if (result.status === 200) assert.equal(result.body.confession.revealed_sender, null);
    const requests = await request(2, '/messages/confessions/identity-requests');
    if (requests.status === 200) assert.equal(requests.body.requests.length, 0);
    const third = db.prepare("INSERT INTO messages(sender_id,receiver_id,wall_id,type,content,is_anonymous) VALUES (1,2,1,'confession','旧信',1)").run().lastInsertRowid;
    if (['作者删除', '收信人删除', '撤回'].includes(name)) mutate(third);
    assert.equal((await apply(third)).status, 403);
    assert.equal(db.prepare('SELECT status FROM confession_identity_requests WHERE id=?').get(pending.body.request.id).status, 'pending');
  });
}

test('并发重复申请和审批只成功一次，不重复通知或改变最终决定', async () => {
  const id = await letter();
  const applications = await Promise.all([apply(id), apply(id)]);
  assert.deepEqual(applications.map(row => row.status).sort(), [200, 409]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type='system'").get().c, 1);
  const requestId = applications.find(row => row.status === 200).body.request.id;
  const decisions = await Promise.all([decide(requestId), decide(requestId, 'reject')]);
  assert.deepEqual(decisions.map(row => row.status).sort(), [200, 409]);
  const final = db.prepare('SELECT status FROM confession_identity_requests').get().status;
  assert.equal(final, decisions.find(row => row.status === 200).body.request.status);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type='system'").get().c, 2);
});

test('申请及决定通知失败时完整回滚，重试只产生一条申请和通知', async () => {
  const id = await letter();
  db.exec("CREATE TRIGGER confession_notice_failure BEFORE INSERT ON messages WHEN NEW.type='system' BEGIN SELECT RAISE(ABORT,'injected confession notification failure'); END");
  try {
    assert.equal((await apply(id)).status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 0);
  } finally { db.exec('DROP TRIGGER confession_notice_failure'); }
  const submitted = await apply(id);
  assert.equal(submitted.status, 200);
  db.exec("CREATE TRIGGER confession_notice_failure BEFORE INSERT ON messages WHEN NEW.type='system' BEGIN SELECT RAISE(ABORT,'injected confession notification failure'); END");
  try {
    assert.equal((await decide(submitted.body.request.id)).status, 500);
    assert.equal(db.prepare('SELECT status FROM confession_identity_requests').get().status, 'pending');
    assert.equal((await thread(2, id)).body.confession.revealed_sender, null);
  } finally { db.exec('DROP TRIGGER confession_notice_failure'); }
  assert.equal((await decide(submitted.body.request.id)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type='system'").get().c, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('直接表白真实署名固定文案不可由客户端伪造，幂等重试且不能匿名或回复', async () => {
  const body = { receiver_id: 2, client_message_id: 'direct-once' };
  for (const forged of [{ sender_id: 3 }, { content: '自定义' }, { title: '伪造' }, { is_anonymous: false }, { confession_kind: 'direct' }, { allow_replies: true }]) {
    assert.equal((await request(1, '/messages/confessions/direct', { method: 'POST', body: { ...body, ...forged } })).status, 400);
  }
  const sent = await request(1, '/messages/confessions/direct', { method: 'POST', body });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message_item.content, '秘密作者在此网站的表白信界面对你进行表白');
  assert.equal(sent.body.message_item.sender_id, 1);
  assert.equal(sent.body.message_item.sender_nickname, '秘密作者');
  assert.equal(sent.body.message_item.confession_kind, 'direct');
  assert.equal(sent.body.message_item.is_anonymous, 0);
  assert.equal(sent.body.message_item.allow_replies, false);
  assert.equal((await reply(2, sent.body.id)).status, 403);
  assert.equal((await apply(sent.body.id)).status, 403);
  const retry = await request(1, '/messages/confessions/direct', { method: 'POST', body });
  assert.equal(retry.body.id, sent.body.id);
  assert.equal(retry.body.deduplicated, true);
  assert.equal((await request(1, '/messages/confessions/direct', { method: 'POST', body: { ...body, receiver_id: 3 } })).status, 409);
  assert.equal((await request(1, '/messages', { method: 'POST', body: { type: 'confession', receiver_id: 2, content: '伪造系统文案', confession_kind: 'direct' } })).status, 400);
  assert.equal((await request(1, '/messages/confessions/direct', { method: 'POST', body: { receiver_id: 4 } })).status, 403);
  const received = (await request(2, '/messages/inbox?type=confession')).body.messages[0];
  assert.equal(received.sender_id, 1);
  assert.equal(received.sender_nickname, '秘密作者');
});

test('统计仅计本人收到原始表白，匿名实名分组、当前墙和分页过滤一致', async () => {
  const anon = await letter();
  const named = await letter({ is_anonymous: false });
  const direct = await request(1, '/messages/confessions/direct', { method: 'POST', body: { receiver_id: 2 } });
  assert.equal(direct.status, 200);
  await reply(2, anon);
  await reply(1, anon);
  await apply(anon);
  const removed = await letter();
  const revoked = await letter();
  assert.equal((await request(2, '/messages/' + removed, { method: 'DELETE' })).status, 200);
  assert.equal((await request(1, '/messages/' + revoked + '/revoke', { method: 'PUT', body: {} })).status, 200);
  assert.equal((await request(1, '/messages', { method: 'POST', wall: 2, body: { type: 'confession', receiver_id: 2, content: '另一墙' } })).status, 200);
  assert.deepEqual((await request(2, '/messages/confessions/stats')).body, { anonymous: 1, named: 2, total: 3 });
  assert.deepEqual((await request(2, '/messages/confessions/stats', { wall: null })).body, { anonymous: 1, named: 3, total: 4 });
  assert.deepEqual((await request(1, '/messages/confessions/stats')).body, { anonymous: 0, named: 0, total: 0 });
  const first = await request(2, '/messages/confessions/received?limit=2');
  const second = await request(2, '/messages/confessions/received?limit=2&page=2');
  assert.equal(first.body.total, 3);
  assert.equal(first.body.hasMore, true);
  assert.equal(second.body.hasMore, false);
  assert.deepEqual(first.body.messages.concat(second.body.messages).map(row => row.id), [direct.body.id, named, anon]);
  assert.equal((await request(2, '/messages/confessions/received?anonymous=1')).body.total, 1);
  assert.equal((await request(2, '/messages/confessions/received?anonymous=0')).body.total, 2);
  assert.equal((await request(4, '/messages/confessions/stats')).status, 403);
  assert.equal((await request(2, '/messages/confessions/stats?wall_id=2')).status, 400);
  assert.equal((await request(2, '/messages/confessions/stats', { authenticated: false })).status, 401);
  const versioned = await request(2, '/messages/confessions/stats', { versioned: true });
  assert.equal(versioned.status, 200);
  assert.deepEqual(versioned.body.data, { anonymous: 1, named: 2, total: 3 });
  assert.equal(versioned.body.error, null);
});

test('旧收发件箱、未读和单条批量操作同样隔离当前墙，退墙后不泄露不可见计数', async () => {
  const current = await letter();
  const foreign = await request(1, '/messages', { method: 'POST', wall: 2, body: { type: 'confession', receiver_id: 2, content: '第二墙匿名信', is_anonymous: true } });
  assert.equal(foreign.status, 200);
  const foreignId = foreign.body.id;
  const currentInbox = await request(2, '/messages/inbox');
  assert.deepEqual(currentInbox.body.messages.map(row => row.id), [current]);
  assert.equal(currentInbox.body.unreadCounts.confession, 1);
  assert.equal(currentInbox.body.totalUnread, 1);
  assert.deepEqual((await request(1, '/messages/sent')).body.map(row => row.id), [current]);
  assert.equal((await request(2, '/messages/' + foreignId + '/read', { method: 'PUT', body: {} })).status, 403);
  assert.equal((await request(2, '/messages/' + foreignId, { method: 'DELETE' })).status, 403);
  assert.equal((await request(1, '/messages/' + foreignId + '/revoke', { method: 'PUT', body: {} })).status, 403);
  assert.equal((await request(2, '/messages/read-batch', { method: 'PUT', body: { ids: [current, foreignId] } })).status, 200);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(current).is_read, 1);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(foreignId).is_read, 0);
  assert.equal((await request(2, '/messages/read-all', { method: 'PUT', body: { type: 'confession' } })).status, 200);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(foreignId).is_read, 0);
  assert.equal((await request(2, '/messages/inbox/all?type=confession', { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT receiver_deleted FROM messages WHERE id=?').get(current).receiver_deleted, 1);
  assert.equal(db.prepare('SELECT receiver_deleted FROM messages WHERE id=?').get(foreignId).receiver_deleted, 0);
  db.prepare('DELETE FROM wall_members WHERE user_id=2').run();
  const hidden = await request(2, '/messages/inbox', { wall: null });
  assert.deepEqual(hidden.body.messages, []);
  assert.equal(hidden.body.unreadCounts.confession, 0);
  assert.equal(hidden.body.totalUnread, 0);
});

test('身份申请随硬删原信或账号级联清理，批准不授予其他原信或用户身份访问', async () => {
  const id = await letter();
  assert.equal((await apply(id)).status, 200);
  db.prepare('DELETE FROM messages WHERE id=?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 0);
  const second = await letter();
  assert.equal((await apply(second)).status, 200);
  db.prepare('DELETE FROM users WHERE id=1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const deletionMode of ['admin', 'self']) {
  for (const deletedUser of [1, 2]) {
    test(deletionMode + '真实HTTP删号清理' + (deletedUser === 1 ? '作者' : '收件人') + '的申请，外键和无关申请保持完整', async () => {
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      const id = await letter();
      assert.equal((await apply(id)).status, 200);
      db.prepare("UPDATE users SET role='super_admin' WHERE id=4").run();
      db.prepare('UPDATE walls SET owner_id=3').run();
      db.prepare("INSERT INTO messages(sender_id,receiver_id,wall_id,type,content,is_anonymous) VALUES(3,4,2,'confession','unrelated',1)").run();
      const unrelatedRoot = db.prepare('SELECT MAX(id) AS id FROM messages').get().id;
      db.prepare('INSERT INTO confession_identity_requests(message_id,wall_id,requester_id,author_id) VALUES(?,2,4,3)').run(unrelatedRoot);
      if (deletionMode === 'self') {
        const passwordHash = await require('../lib/password').hashPassword('confession-delete-test-password');
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, deletedUser);
      }
      // sql.js export reopens the database; the wrapper must restore enforcement.
      db.exportBytes();
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      const result = deletionMode === 'admin'
        ? await request(4, '/admin/users/' + deletedUser, { method: 'DELETE' })
        : await request(deletedUser, '/auth/account', { method: 'DELETE', body: { password: 'confession-delete-test-password' } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(deletedUser), undefined);
      assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get(id), undefined);
      const remaining = db.prepare('SELECT message_id FROM confession_identity_requests').all();
      assert.deepEqual(remaining, [{ message_id: unrelatedRoot }]);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  }
}

test('gzip个人数据导出不能绕过匿名回复脱敏或墙可见性', async () => {
  const id = await letter();
  const recipientReply = await reply(2, id, '收件人自己的回复');
  const authorReply = await reply(1, id, '匿名作者的回复');
  const exported = await request(2, '/auth/export', { wall: null });
  assert.equal(exported.status, 200);
  const sent = exported.body.messages_sent.find(row => row.id === recipientReply.body.id);
  assert.equal(sent.receiver_id, null);
  assert.equal(sent.revealed_sender, null);
  for (const messageId of [id, authorReply.body.id]) {
    const received = exported.body.messages_received.find(row => row.id === messageId);
    assert.equal(received.sender_id, null);
    assert.equal(received.sender_nickname, null);
    assert.equal(received.sender_avatar, null);
    assert.equal(received.revealed_sender, null);
  }
  assert.ok(!JSON.stringify(exported.body.messages_sent).includes('秘密作者'));
  assert.ok(!JSON.stringify(exported.body.messages_received).includes('秘密作者'));
  db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=2').run();
  const revokedAccess = await request(2, '/auth/export', { wall: null });
  assert.equal(revokedAccess.status, 200);
  assert.deepEqual(revokedAccess.body.messages_sent, []);
  assert.deepEqual(revokedAccess.body.messages_received, []);
});

test('输入限长、布尔和正整数严格验证，不接受身份或系统路由字段注入', async () => {
  const id = await letter();
  for (const suffix of ['?page=0', '?page=-1', '?page=1.5', '?limit=101', '?anonymous=true', '?page=9999999999999999999', '?limit[]=1']) {
    assert.equal((await request(2, '/messages/confessions/received' + suffix)).status, 400, suffix);
  }
  for (const suffix of ['?limit=0', '?limit=101', '?before=0', '?before=-1']) assert.equal((await thread(2, id, suffix)).status, 400);
  for (const content of ['', '   ', 'x'.repeat(2001), {}, null]) assert.equal((await reply(2, id, content)).status, 400);
  assert.equal((await apply(id, { message: 'x'.repeat(2001) })).status, 400);
  assert.equal((await apply(id, { confirmed: 'true' })).status, 400);
  assert.equal((await apply(id, { author_id: 3 })).status, 400);
  assert.equal((await reply(2, id, '回复', { client_message_id: '../bad' })).status, 400);
  assert.equal((await request(2, '/messages/confessions/0/replies', { method: 'POST', body: { content: '回复' } })).status, 400);
  assert.equal((await decide('0')).status, 400);
  assert.equal((await request(2, '/messages', { method: 'POST', body: [] })).status, 400);
  assert.equal((await request(2, '/messages/confessions/direct', { method: 'POST', body: [] })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM confession_identity_requests').get().c, 0);
});
