const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

// Never load initDB(): every fixture is an isolated, in-memory database.
process.env.JWT_SECRET = 'social-security-isolated-test-secret-2026';
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
  schema = match[1];
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

test('blocking preserves the other party blacklist and is idempotent', async t => {
  const { db, request } = await fixture(t);
  await request('POST', '/friends/block', { user_id: 2 }, 3);
  assert.equal((await request('POST', '/friends/block', { user_id: 3 })).status, 200);
  assert.equal((await request('POST', '/friends/block', { user_id: 3 })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM friends WHERE status='blocked'").get().n, 2);
  await request('POST', '/friends/unblock', { user_id: 3 });
  assert.ok(db.prepare("SELECT id FROM friends WHERE user_id=3 AND friend_id=2 AND status='blocked'").get());
  assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'private', content: '绕过拉黑' })).status, 403);
});

test('blocked and accepted records cannot be turned into friend requests', async t => {
  const { db, request } = await fixture(t);
  const id = db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (3,2,'blocked')").run().lastInsertRowid;
  assert.equal((await request('PUT', '/friends/' + id + '/respond', { action: 'accept' })).status, 404);
  assert.equal((await request('PUT', '/friends/' + id + '/respond', { action: 'reject' })).status, 404);
  assert.equal((await request('DELETE', '/friends/' + id)).status, 404);
  assert.equal(db.prepare('SELECT status FROM friends WHERE id=?').get(id).status, 'blocked');
});

test('only a pending request recipient can accept and acceptance cannot be replayed', async t => {
  const { db, request } = await fixture(t);
  const result = await request('POST', '/friends/add', { friend_id: 3 });
  assert.equal(result.status, 200);
  const id = db.prepare("SELECT id FROM friends WHERE user_id=2 AND friend_id=3").get().id;
  assert.equal((await request('PUT', '/friends/' + id + '/respond', { action: 'accept' }, 7)).status, 404);
  assert.equal((await request('PUT', '/friends/' + id + '/respond', { action: 'accept' }, 3)).status, 200);
  assert.equal((await request('PUT', '/friends/' + id + '/respond', { action: 'accept' }, 3)).status, 404);
});

test('friend requests reject cross wall strangers, malformed IDs and duplicate reverse requests', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('POST', '/friends/add', { friend_id: 4 })).status, 403);
  for (const id of ['3suffix', [], {}, -1, 1.5, '9007199254740993']) assert.equal((await request('POST', '/friends/add', { friend_id: id })).status, 400);
  assert.equal((await request('POST', '/friends/add', { friend_id: 3 })).status, 200);
  assert.equal((await request('POST', '/friends/add', { friend_id: 2 }, 3)).status, 400);
  assert.equal((await request('POST', '/friends/block', { user_id: 999 })).status, 404);
});

test('permanent wall bans cannot be removed by leaving and rejoining', async t => {
  const { db, request } = await fixture(t);
  db.prepare("UPDATE wall_members SET status='banned' WHERE wall_id=1 AND user_id=2").run();
  assert.equal((await request('POST', '/walls/1/leave', {})).status, 403);
  assert.equal((await request('POST', '/walls/1/join', {})).status, 403);
  assert.equal(db.prepare('SELECT status FROM wall_members WHERE wall_id=1 AND user_id=2').get().status, 'banned');
});

test('expired wall bans settle before a legitimate leave', async t => {
  const { db, request } = await fixture(t);
  db.prepare("UPDATE wall_members SET status='banned',wall_ban_until='2000-01-01T00:00:00Z' WHERE wall_id=1 AND user_id=2").run();
  assert.equal((await request('POST', '/walls/1/leave', {})).status, 200);
  assert.equal(db.prepare('SELECT id FROM wall_members WHERE wall_id=1 AND user_id=2').get(), undefined);
});

test('wall mutation IDs, switches and authority are validated', async t => {
  const { db, request } = await fixture(t);
  assert.equal((await request('POST', '/walls/1suffix/leave', {})).status, 400);
  assert.equal((await request('PUT', '/walls/1', { require_join_approval: 'false' }, 1, 1)).status, 400);
  assert.equal((await request('PUT', '/walls/1', { description: {} }, 1, 1)).status, 400);
  assert.equal((await request('PUT', '/walls/1', { description: '新的墙介绍' }, 2, 1)).status, 403);
  assert.equal((await request('PUT', '/walls/2', { description: '越权修改' }, 1, 1)).status, 400);
  assert.equal((await request('POST', '/walls/apply-create', { wall_name: {} })).status, 400);
  assert.equal(db.prepare('SELECT description FROM walls WHERE id=1').get().description, '');
});

test('an ordinary wall admin cannot unban an admin sanctioned by the owner', async t => {
  const { db, request } = await fixture(t);
  db.prepare("UPDATE wall_members SET wall_role='admin',status='banned' WHERE wall_id=1 AND user_id=3").run();
  assert.equal((await request('POST', '/walls/1/members/3/unban', {}, 6, 1)).status, 403);
  assert.equal((await request('POST', '/walls/1/members/3/unban', {}, 1, 1)).status, 200);
});

test('ownership transfer rejects unavailable/current owners and succeeds for an active member', async t => {
  const { db, request } = await fixture(t);
  assert.equal((await request('PUT', '/walls/1/transfer-owner', { new_owner_id: '3x' }, 1, 1)).status, 400);
  assert.equal((await request('PUT', '/walls/1/transfer-owner', { new_owner_id: 1 }, 1, 1)).status, 400);
  db.prepare("UPDATE users SET status='banned' WHERE id=3").run();
  assert.equal((await request('PUT', '/walls/1/transfer-owner', { new_owner_id: 3 }, 1, 1)).status, 400);
  assert.equal((await request('PUT', '/walls/1/transfer-owner', { new_owner_id: 2 }, 1, 1)).status, 200);
  assert.equal(db.prepare('SELECT owner_id FROM walls WHERE id=1').get().owner_id, 2);
  assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=1 AND user_id=2').get().wall_role, 'owner');
});

test('private message references stay in the same pair and type', async t => {
  const { db, request, message } = await fixture(t);
  const secret = message(3, 2, 'private', '只有2和3可见');
  assert.equal((await request('POST', '/messages', { receiver_id: 7, type: 'private', content: '越权引用', reply_to_id: secret })).status, 403);
  assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'private', content: '合法回复', reply_to_id: secret })).status, 200);
  assert.equal(db.prepare('SELECT reply_to_content FROM messages ORDER BY id DESC LIMIT 1').get().reply_to_content, '只有2和3可见');
  assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'confession', content: '不同类型引用', reply_to_id: secret }, 2, 1)).status, 403);
});

test('private sends reject cross wall strangers and anonymous/type-confused input', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('POST', '/messages', { receiver_id: 4, type: 'private', content: '跨墙骚扰' })).status, 403);
  assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'private', content: '匿名伪装', is_anonymous: true })).status, 400);
  for (const body of [{ content: {} }, { content: ' ' }, { content: 'ok', receiver_id: '3x' }, { content: 'ok', is_anonymous: 'false' }, { content: 'ok', title: [] }]) {
    assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'private', ...body })).status, 400);
  }
  assert.equal((await request('GET', '/messages/conversation/3suffix')).status, 400);
  assert.equal((await request('GET', '/messages/conversation/3?limit=-2')).status, 400);
});

test('anonymous confessions preserve server attribution while concealing it from recipients', async t => {
  const { db, request } = await fixture(t);
  const sent = await request('POST', '/messages', { receiver_id: 3, type: 'confession', content: '匿名表白', is_anonymous: true }, 2, 1);
  assert.equal(sent.status, 200);
  const stored = db.prepare('SELECT sender_id,link FROM messages WHERE id=?').get(sent.data.id);
  assert.equal(stored.sender_id, 2);
  assert.equal(stored.link, '');
  const inbox = await request('GET', '/messages/inbox?type=confession', undefined, 3);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.messages[0].sender_id, null);
  assert.equal(inbox.data.messages[0].sender_nickname, null);
  assert.equal((await request('GET', '/messages/sent')).data[0].id, sent.data.id);
  assert.equal((await request('PUT', '/messages/' + sent.data.id + '/revoke', {})).status, 200);
});

test('confessions require an active wall and both active memberships', async t => {
  const { db, request } = await fixture(t);
  const body = { receiver_id: 3, type: 'confession', content: '校园表白' };
  assert.equal((await request('POST', '/messages', { ...body, wall_id: 2 }, 2, 1)).status, 400);
  db.prepare("UPDATE walls SET status='disabled' WHERE id=1").run();
  assert.equal((await request('POST', '/messages', body, 2, 1)).status, 403);
});

test('revocation hides quoted copies and rejects corrupt or expired timestamps', async t => {
  const { db, request, message } = await fixture(t);
  const id = message(2, 3);
  const reply = await request('POST', '/messages', { receiver_id: 2, type: 'private', content: '引用回复', reply_to_id: id }, 3);
  assert.equal(reply.status, 200);
  assert.equal((await request('PUT', '/messages/' + id + '/revoke', {})).status, 200);
  assert.equal(db.prepare('SELECT reply_to_content FROM messages WHERE id=?').get(reply.data.id).reply_to_content, '[消息已撤回]');
  const corrupt = message(2, 3);
  db.prepare("UPDATE messages SET created_at='invalid' WHERE id=?").run(corrupt);
  assert.equal((await request('PUT', '/messages/' + corrupt + '/revoke', {})).status, 400);
});

test('report evidence cannot include another pair or unrelated message types', async t => {
  const { db, request, message } = await fixture(t);
  const evidence = message(3, 2, 'private', '被举报人的消息');
  const unrelated = message(7, 2, 'private', '第三人的隐私');
  const outsider = message(4, 7, 'private', '两个陌生人的消息');
  const result = await request('POST', '/messages/report-user', { reported_user_id: 3, reason: '测试举报原因', selected_message_ids: [evidence, unrelated, outsider] });
  assert.equal(result.status, 200);
  const report = db.prepare('SELECT evidence_messages FROM user_reports ORDER BY id DESC LIMIT 1').get();
  assert.match(report.evidence_messages, /被举报人的消息/);
  assert.doesNotMatch(report.evidence_messages, /第三人|陌生人/);
  assert.equal((await request('POST', '/messages/report-user', { reported_user_id: 3, reason: {}, selected_message_ids: [] })).status, 400);
});

test('tree APIs conceal real identities and support server-resolved anonymous reports', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  const list = await request('GET', '/messages/tree-hole/conversations', undefined, 3);
  assert.equal(list.status, 200);
  assert.equal(Object.hasOwn(list.data.my[0], 'initiator_id'), false);
  const conversation = await request('GET', '/messages/tree-hole/' + convId, undefined, 3);
  assert.equal(conversation.status, 200);
  assert.equal(conversation.data.other_user_id, null);
  assert.equal(conversation.data.can_report, true);
  assert.equal(Object.hasOwn(conversation.data.messages[0], 'sender_id'), false);
  const report = await request('POST', '/messages/report-user', { conversation_id: convId, reason: '匿名会话举报', selected_message_ids: [conversation.data.messages[0].id] }, 3, 2);
  assert.equal(report.status, 200);
  assert.equal(db.prepare('SELECT reported_user_id,wall_id FROM user_reports ORDER BY id DESC LIMIT 1').get().reported_user_id, 2);
  assert.equal(db.prepare('SELECT wall_id FROM user_reports ORDER BY id DESC LIMIT 1').get().wall_id, 1);
  assert.equal((await request('POST', '/messages/report-user', { conversation_id: convId, reported_user_id: 7, reason: '伪造目标' }, 3)).status, 400);
});

test('removed or denied volunteers lose direct, list and inbox tree access immediately', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (3,1,'wall.tree_hole','deny')").run();
  assert.equal((await request('GET', '/messages/tree-hole/' + convId, undefined, 3)).status, 403);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '撤权后回复' }, 3)).status, 403);
  assert.equal((await request('GET', '/messages/tree-hole/conversations', undefined, 3)).data.my.length, 0);
  const inbox = await request('GET', '/messages/inbox', undefined, 3);
  assert.equal(inbox.data.messages.length, 0);
  assert.equal(inbox.data.unreadCounts.tree_hole, 0);
  db.prepare('DELETE FROM user_permissions WHERE user_id=3').run();
  db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=3').run();
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/close', {}, 3)).status, 403);
});

test('banned initiators cannot read, reply, close or delete tree conversations', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  db.prepare("UPDATE wall_members SET status='banned' WHERE wall_id=1 AND user_id=2").run();
  for (const [method, suffix, body] of [['GET', '', undefined], ['POST', '/reply', { content: '绕过封禁' }], ['POST', '/close', {}], ['DELETE', '', undefined]]) {
    assert.equal((await request(method, '/messages/tree-hole/' + convId + suffix, body)).status, 403);
  }
});

test('tree permission grants do not bypass active membership for pending previews and assignment', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (4,1,'wall.tree_hole','grant')").run();
  assert.equal((await request('GET', '/messages/tree-hole/conversations', undefined, 4)).data.pending.length, 0);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 4)).status, 403);
  assert.equal((await request('GET', '/messages/tree-hole/' + convId, undefined, 7)).status, 403);
});

test('volunteer takeover revokes the old assignee and preserves reply/close state', async t => {
  const { request, tree } = await fixture(t);
  const convId = tree();
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 5)).status, 200);
  assert.equal((await request('GET', '/messages/tree-hole/' + convId, undefined, 3)).status, 403);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '我在这里倾听' }, 5)).status, 200);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 6)).status, 400);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/close', {})).status, 200);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '关闭后回复' }, 5)).status, 400);
});

test('generic deletion hides one side and preserves tree root metadata and initiator', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  const root = db.prepare('SELECT id FROM messages WHERE conversation_id=?').get(convId).id;
  assert.equal((await request('DELETE', '/messages/' + root, undefined, 3)).status, 200);
  assert.equal((await request('DELETE', '/messages/inbox/all?type=tree_hole', undefined, 3)).status, 200);
  const stored = db.prepare('SELECT sender_id,sender_deleted,receiver_deleted FROM messages WHERE id=?').get(root);
  assert.equal(stored.sender_id, 2);
  assert.equal(stored.sender_deleted, 0);
  assert.equal(stored.receiver_deleted, 1);
  assert.equal((await request('GET', '/messages/tree-hole/' + convId)).data.messages.length, 1);
  assert.equal((await request('GET', '/messages/tree-hole/' + convId, undefined, 3)).data.messages.length, 0);
});

test('tree creation validates content and excludes banned volunteers and blocked pairs', async t => {
  const { db, request } = await fixture(t);
  assert.equal((await request('POST', '/messages/tree-hole', { content: {} }, 2, 1)).status, 400);
  db.prepare("UPDATE users SET status='banned' WHERE id IN (1,3,5,6)").run();
  assert.equal((await request('POST', '/messages/tree-hole', { content: '需要有人倾听' }, 2, 1)).status, 400);
  db.prepare("UPDATE users SET status='active' WHERE id=3").run();
  assert.equal((await request('POST', '/messages/tree-hole', { content: '需要有人倾听' }, 2, 1)).status, 200);
});

test('user search treats wildcards literally and enforces privacy, block and membership constraints', async t => {
  const { db, request } = await fixture(t);
  assert.equal((await request('GET', '/users/search?q[]=student', undefined, 2, 1)).status, 400);
  const wildcard = await request('GET', '/users/search?q=%25', undefined, 2, 1);
  assert.equal(wildcard.status, 200);
  assert.deepEqual(wildcard.data, []);
  assert.equal((await request('GET', '/users/search?q=3', undefined, 2, 1)).data[0].id, 3);
  db.prepare('UPDATE users SET allow_search_by_id=0 WHERE id=3').run();
  assert.deepEqual((await request('GET', '/users/search?q=3', undefined, 2, 1)).data, []);
  await request('POST', '/friends/block', { user_id: 3 });
  assert.equal((await request('GET', '/users/discover', undefined, 2, 1)).data.some(u => u.id === 3), false);
  assert.equal((await request('GET', '/users/3')).status, 403);
  assert.equal((await request('GET', '/users/4')).status, 403);
  assert.equal((await request('GET', '/users/3suffix')).status, 400);
});

test('profile sharing excludes disabled walls and never discloses hidden real names', async t => {
  const { db, request } = await fixture(t);
  const visible = await request('GET', '/users/3');
  assert.equal(visible.status, 200);
  assert.equal(visible.data.real_name, '');
  db.prepare("UPDATE walls SET status='disabled' WHERE id=1").run();
  assert.equal((await request('GET', '/users/3')).status, 403);
});

test('clearing private chat hides both directions only for the current user', async t => {
  const { db, request, message } = await fixture(t);
  const sent = message(2, 3, 'private', '我发出的消息');
  const received = message(3, 2, 'private', '对方发出的消息');
  assert.equal((await request('DELETE', '/messages/chat/3')).status, 200);
  assert.deepEqual((await request('GET', '/messages/conversation/3')).data.messages, []);
  assert.deepEqual((await request('GET', '/messages/sent')).data, []);
  const inbox = await request('GET', '/messages/inbox');
  assert.equal(inbox.data.messages.length, 0);
  assert.equal(inbox.data.totalUnread, 0);
  const otherHistory = await request('GET', '/messages/conversation/2', undefined, 3);
  assert.deepEqual(otherHistory.data.messages.map(m => m.id), [sent, received]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('single message and bulk inbox deletion preserve the other party sent copy', async t => {
  const { db, request, message } = await fixture(t);
  const first = message(3, 2, 'private', '保留发件人副本');
  const second = message(3, 2, 'private', '另一个副本');
  assert.equal((await request('DELETE', '/messages/' + first)).status, 200);
  assert.equal((await request('DELETE', '/messages/' + first)).status, 404);
  assert.equal((await request('DELETE', '/messages/inbox/all?type=private')).status, 200);
  assert.equal((await request('GET', '/messages/inbox')).data.messages.length, 0);
  const senderCopy = await request('GET', '/messages/sent', undefined, 3);
  assert.equal(senderCopy.data.length, 2);
  assert.equal(senderCopy.data.some(m => Object.hasOwn(m, 'receiver_deleted')), false);
  assert.equal(db.prepare('SELECT receiver_deleted FROM messages WHERE id=?').get(second).receiver_deleted, 1);
});

test('hidden messages cannot be read-marked, quoted or used as report evidence', async t => {
  const { db, request, message } = await fixture(t);
  const id = message(3, 2, 'private', '已被我删除的内容');
  await request('DELETE', '/messages/' + id);
  assert.equal((await request('PUT', '/messages/' + id + '/read', {})).status, 404);
  await request('PUT', '/messages/read-batch', { ids: [id] });
  await request('PUT', '/messages/read-all', { type: 'private' });
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(id).is_read, 0);
  assert.equal((await request('POST', '/messages', { receiver_id: 3, type: 'private', content: '引用隐藏内容', reply_to_id: id })).status, 403);
  await request('POST', '/messages/report-user', { reported_user_id: 3, reason: '举报', selected_message_ids: [id] });
  assert.equal(db.prepare('SELECT evidence_messages FROM user_reports ORDER BY id DESC LIMIT 1').get().evidence_messages, '');
});

test('tree conversation deletion hides only own history while preserving participant and closed state', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '志愿者的回应' }, 3);
  assert.equal((await request('DELETE', '/messages/tree-hole/' + convId)).status, 200);
  assert.equal((await request('GET', '/messages/tree-hole/conversations')).data.my.length, 0);
  const hidden = await request('GET', '/messages/tree-hole/' + convId);
  assert.equal(hidden.data.is_initiator, true);
  assert.deepEqual(hidden.data.messages, []);
  const volunteer = await request('GET', '/messages/tree-hole/' + convId, undefined, 3);
  assert.equal(volunteer.data.is_initiator, false);
  assert.equal(volunteer.data.messages.length, 2);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/close', {}, 3)).status, 200);
  await request('DELETE', '/messages/tree-hole/' + convId);
  const hiddenClosed = await request('GET', '/messages/tree-hole/' + convId);
  assert.equal(hiddenClosed.data.is_closed, true);
  assert.equal(hiddenClosed.data.is_initiator, true);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '不能重开' })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(convId).n, 3);
});

test('tree latest previews and unread counts exclude deleted history for the viewer', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '较早的回复' }, 3);
  await request('POST', '/messages/tree-hole/' + convId + '/reply', { content: '即将删除的最新消息' }, 3);
  const lastId = db.prepare('SELECT MAX(id) AS id FROM messages').get().id;
  await request('DELETE', '/messages/' + lastId);
  const list = await request('GET', '/messages/tree-hole/conversations');
  assert.equal(list.data.my[0].last_message, '较早的回复');
  assert.equal(list.data.my[0].msg_count, 2);
  assert.equal(list.data.my[0].unread_count, 1);
  assert.equal((await request('GET', '/messages/inbox')).data.unreadCounts.tree_hole, 1);
});

test('anonymous reporting rejects all explicit target IDs without acting as an identity oracle', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  for (const guess of [2, 7]) {
    const response = await request('POST', '/messages/report-user', { conversation_id: convId, reported_user_id: guess, reason: '探测匿名身份' }, 3);
    assert.equal(response.status, 400);
    assert.equal(response.data.error, '匿名对话请仅提供会话 ID');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_reports').get().n, 0);
});

test('volunteer reassignment does not inherit the old recipient deletion and read state', async t => {
  const { request, tree } = await fixture(t);
  const convId = tree();
  await request('GET', '/messages/tree-hole/' + convId, undefined, 3);
  await request('DELETE', '/messages/tree-hole/' + convId, undefined, 3);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 5)).status, 200);
  const list = await request('GET', '/messages/tree-hole/conversations', undefined, 5);
  assert.equal(list.data.my[0].unread_count, 1);
  assert.equal(list.data.my[0].msg_count, 1);
  const conversation = await request('GET', '/messages/tree-hole/' + convId, undefined, 5);
  assert.equal(conversation.data.messages[0].content, '匿名倾诉内容');
});

test('pending tree disclosure and assignment exclude blocked or departed initiators', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  await request('POST', '/friends/block', { user_id: 2 }, 5);
  assert.equal((await request('GET', '/messages/tree-hole/conversations', undefined, 5)).data.pending.length, 0);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 5)).status, 403);
  await request('POST', '/friends/unblock', { user_id: 2 }, 5);
  db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=2').run();
  assert.equal((await request('GET', '/messages/tree-hole/conversations', undefined, 5)).data.pending.length, 0);
  assert.equal((await request('POST', '/messages/tree-hole/' + convId + '/assign', {}, 5)).status, 403);
});

test('shared tree unread badge becomes zero immediately after volunteer permission is revoked', async t => {
  const { db, request, tree } = await fixture(t);
  tree();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 1);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (3,1,'wall.tree_hole','deny')").run();
  const badge = await request('GET', '/social-tree-badge', undefined, 3);
  const inbox = await request('GET', '/messages/inbox', undefined, 3);
  assert.equal(badge.status, 200);
  assert.equal(badge.data.unread, 0);
  assert.equal(inbox.data.unreadCounts.tree_hole, badge.data.unread);
  assert.equal((await request('GET', '/messages/tree-hole/th_social_case', undefined, 3)).status, 403);
});

test('shared tree unread badge excludes hidden rows and inaccessible wall membership', async t => {
  const { db, request, tree } = await fixture(t);
  const convId = tree();
  await request('DELETE', '/messages/tree-hole/' + convId, undefined, 3);
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 0);
  db.prepare('UPDATE messages SET receiver_deleted=0').run();
  db.prepare("UPDATE wall_members SET status='banned' WHERE wall_id=1 AND user_id=3").run();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 0);
  db.prepare("UPDATE wall_members SET status='active' WHERE wall_id=1 AND user_id=3").run();
  db.prepare("UPDATE walls SET status='disabled' WHERE id=1").run();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 0);
  db.prepare("UPDATE walls SET status='active' WHERE id=1").run();
  db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=3').run();
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (3,1,'wall.tree_hole','grant')").run();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 0);
});

test('shared tree unread badge honors current assignee and settles expired wall bans', async t => {
  const { db, request, tree } = await fixture(t);
  tree();
  db.prepare('UPDATE messages SET assignee_id=5').run();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 0);
  db.prepare('UPDATE messages SET assignee_id=3').run();
  db.prepare("UPDATE wall_members SET status='banned',wall_ban_until='2000-01-01T00:00:00Z' WHERE wall_id=1 AND user_id=3").run();
  assert.equal((await request('GET', '/social-tree-badge', undefined, 3)).data.unread, 1);
  assert.equal(db.prepare('SELECT status FROM wall_members WHERE wall_id=1 AND user_id=3').get().status, 'active');
});

test('chat-level global bans apply inside mounted social routers', async t => {
  const { db, request } = await fixture(t);
  db.prepare("UPDATE users SET status='banned',ban_level='chat' WHERE id=2").run();
  assert.equal((await request('GET', '/messages/inbox')).status, 403);
  assert.equal((await request('POST', '/friends/add', { friend_id: 3 })).status, 403);
});
