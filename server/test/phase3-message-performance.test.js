const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

// Never load initDB(): every fixture is an isolated, in-memory database.
process.env.JWT_SECRET = 'phase3-message-performance-isolated-secret-2026';
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
  const metrics = { queries: [], executions: [], dirty: 0 };
  return {
    metrics,
    markDirty() { metrics.dirty++; },
    exec(text) { sql.run(text); },
    prepare(text) {
      const all = (...params) => {
        metrics.queries.push(text);
        metrics.executions.push({ text, params });
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
          metrics.queries.push(text);
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
    db.metrics.queries = [];
    db.metrics.executions = [];
    db.metrics.dirty = 0;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { authorization: 'Bearer ' + jwt.sign({ id: userId, tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '5m' }) };
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (wallId !== undefined) headers['x-wall-id'] = String(wallId);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: '/api' + url, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text), queryCount: db.metrics.queries.length, queries: [...db.metrics.queries], executions: [...db.metrics.executions], dirty: db.metrics.dirty }); } catch (err) { reject(new Error(text)); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const message = (sender = 2, receiver = 3, type = 'private', content = '私密内容', wallId = 0, convId = '', assignee = 0) => db.prepare('INSERT INTO messages (sender_id,receiver_id,type,content,wall_id,conversation_id,assignee_id,is_anonymous) VALUES (?,?,?,?,?,?,?,?)').run(sender, receiver, type, content, wallId, convId, assignee, type === 'tree_hole' ? 1 : 0).lastInsertRowid;
  const tree = (convId = 'th_social_case', sender = 2, volunteer = 3, wallId = 1) => { message(sender, volunteer, 'tree_hole', '匿名倾诉内容', wallId, convId, volunteer); return convId; };
  return { db, request, message, tree };
}

function seedPeers(db, count) {
  for (let index = 0; index < count; index++) {
    const id = 1000 + index;
    db.prepare('INSERT INTO users (id,username,password_hash,nickname) VALUES (?,?,?,?)').run(id, 'synthetic' + id, 'unused', '合成同学' + id);
    db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,'member','active')").run(id);
  }
}

function seedSummaries(db, message, count) {
  seedPeers(db, count);
  for (let index = 0; index < count; index++) {
    const peer = 1000 + index;
    const source = message(peer, 2, 'private', '合成原文' + index);
    const reply = message(2, peer, 'private', '合成回复' + index);
    db.prepare('UPDATE messages SET reply_to_id=?,reply_to_content=? WHERE id=?').run(source, '过期缓存', reply);
  }
}

function seedTrees(db, message, count) {
  seedPeers(db, count);
  for (let index = 0; index < count; index++) {
    const wallId = 1000 + index;
    const peer = 1000 + index;
    db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,?)').run(wallId, '合成墙' + wallId, peer);
    for (const [userId, role] of [[2, 'tree_hole'], [peer, 'owner']]) db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,?,'active')").run(wallId, userId, role);
    message(peer, 2, 'tree_hole', '合成匿名内容' + index, wallId, 'th_perf_' + index, 2);
  }
}

test('query counts for synthetic private summaries and replies', async t => {
  const measurements = [];
  for (const count of [20, 100]) {
    const { db, request, message } = await fixture(t);
    seedSummaries(db, message, count);
    const response = await request('GET', '/messages/conversations?limit=100');
    assert.equal(response.status, 200);
    assert.equal(response.data.conversations.length, count);
    assert.equal(response.data.conversations.every(c => c.can_send && c.last_message.reply_to.available), true);
    assert.doesNotMatch(JSON.stringify(response.data), /过期缓存/);
    assert.ok(response.queryCount <= 6, 'private summaries must batch peers, last messages and quote authors');
    measurements.push({ count, queries: response.queryCount });
  }
  t.diagnostic(JSON.stringify({ route: 'private summaries', measurements }));
});

test('query counts for synthetic tree unread, inbox and conversation list', async t => {
  const measurements = [];
  for (const count of [20, 100]) {
    const { db, request, message } = await fixture(t);
    seedTrees(db, message, count);
    const badge = await request('GET', '/social-tree-badge');
    assert.equal(badge.status, 200);
    assert.equal(badge.data.unread, count);
    const inbox = await request('GET', '/messages/inbox');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.unreadCounts.tree_hole, count);
    assert.equal(inbox.data.messages.length, count);
    const list = await request('GET', '/messages/tree-hole/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.data.my.length, count);
    assert.ok(badge.queryCount <= 7, 'badge must batch roots, roles and membership');
    assert.ok(inbox.queryCount <= 8, 'inbox category counts and tree checks must be grouped');
    assert.ok(list.queryCount <= 10, 'tree previews and authorization must be batched');
    measurements.push({ count, badge: badge.queryCount, inbox: inbox.queryCount, treeList: list.queryCount });
  }
  t.diagnostic(JSON.stringify({ route: 'tree polling', measurements }));
});

test('request caches observe immediate role, deny, ban, block, assignee and deletion changes', async t => {
  const { db, request, message } = await fixture(t);
  seedTrees(db, message, 1);
  const badge = () => request('GET', '/social-tree-badge');
  assert.equal((await badge()).data.unread, 1);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,1000,'wall.tree_hole','deny')").run();
  assert.equal((await badge()).data.unread, 0);
  db.prepare('DELETE FROM user_permissions WHERE user_id=2').run();
  db.prepare("UPDATE wall_members SET wall_role='member' WHERE wall_id=1000 AND user_id=2").run();
  assert.equal((await badge()).data.unread, 0);
  db.prepare("UPDATE wall_members SET wall_role='tree_hole',status='banned' WHERE wall_id=1000 AND user_id=2").run();
  assert.equal((await badge()).data.unread, 0);
  db.prepare("UPDATE wall_members SET status='active' WHERE wall_id=1000 AND user_id=2").run();
  db.prepare('UPDATE messages SET assignee_id=3 WHERE type=?').run('tree_hole');
  assert.equal((await badge()).data.unread, 0);
  db.prepare('UPDATE messages SET assignee_id=2,receiver_deleted=1 WHERE type=?').run('tree_hole');
  assert.equal((await badge()).data.unread, 0);
  db.prepare('UPDATE messages SET receiver_deleted=0 WHERE type=?').run('tree_hole');
  assert.equal((await badge()).data.unread, 1);
  message(1000, 2, 'private', '真实最近会话');
  assert.equal((await request('GET', '/messages/conversations')).data.conversations[0].can_send, true);
  db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (1000,2,'blocked')").run();
  assert.equal((await request('GET', '/messages/conversations')).data.conversations[0].can_send, false);
});

test('global approval grants respect a specific wall deny before exposing applicants', async t => {
  const { db, request } = await fixture(t);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,0,'wall.member.approve','grant')").run();
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,1,'wall.member.approve','deny')").run();
  db.prepare("UPDATE wall_members SET status='pending' WHERE wall_id=1 AND user_id=7").run();
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (2,7,'member','pending')").run();
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (2,2,'member','active')").run();
  const approvals = await request('GET', '/messages/approvals');
  assert.equal(approvals.status, 200);
  assert.deepEqual(approvals.data.wall_join.map(row => row.wall_id), [2]);
  assert.equal((await request('POST', '/walls/1/members/7/approve', {}, 2, 1)).status, 403);
  db.prepare("UPDATE user_permissions SET effect='grant' WHERE user_id=2 AND wall_id=1").run();
  const restored = await request('GET', '/messages/approvals');
  assert.deepEqual(restored.data.wall_join.map(row => row.wall_id).sort(), [1, 2]);
});

test('GET writes mark dirty only after actual read or expired-ban settlement changes', async t => {
  const { db, request, message } = await fixture(t);
  const id = message(3, 2);
  assert.equal((await request('GET', '/messages/conversation/3?mark_read=0')).dirty, 0);
  assert.equal((await request('GET', '/messages/conversation/3')).dirty, 1);
  assert.equal((await request('GET', '/messages/conversation/3')).dirty, 0);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id=?').get(id).is_read, 1);
  seedTrees(db, message, 20);
  db.prepare("UPDATE wall_members SET status='banned',wall_ban_until='2000-01-01T00:00:00Z' WHERE user_id=2 AND wall_id>=1000").run();
  const settled = await request('GET', '/social-tree-badge');
  assert.equal(settled.data.unread, 20);
  assert.equal(settled.dirty, 1);
  assert.equal(settled.queries.filter(sql => sql.startsWith('UPDATE wall_members')).length, 1);
  assert.equal((await request('GET', '/social-tree-badge')).dirty, 0);
});

test('pending tree queues batch requesters and preserve anonymous exclusions and closure', async t => {
  const { db, request, message } = await fixture(t);
  seedTrees(db, message, 100);
  db.prepare("UPDATE messages SET receiver_id=3,assignee_id=3 WHERE type='tree_hole'").run();
  const first = await request('GET', '/messages/tree-hole/conversations');
  assert.equal(first.data.my.length, 0);
  assert.equal(first.data.pending.length, 100);
  assert.ok(first.queryCount <= 10);
  assert.deepEqual(Object.keys(first.data.pending[0]).sort(), ['conversation_id', 'first_message', 'first_time', 'msg_count']);
  db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (2,1000,'blocked')").run();
  db.prepare("UPDATE users SET status='banned' WHERE id=1001").run();
  db.prepare("UPDATE wall_members SET status='banned' WHERE user_id=1002 AND wall_id=1002").run();
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,1003,'wall.tree_hole','deny')").run();
  const close = message(1004, 3, 'tree_hole', '[对话已关闭]', 1004, 'th_perf_4', 3);
  db.prepare('UPDATE messages SET is_revoked=1 WHERE id=?').run(close);
  message(3, 1005, 'tree_hole', '已有志愿者跟进', 1005, 'th_perf_5', 3);
  const restricted = await request('GET', '/messages/tree-hole/conversations');
  assert.equal(restricted.data.pending.length, 94);
  assert.ok(restricted.queryCount <= 10);
  assert.equal(restricted.data.pending.some(row => ['th_perf_0','th_perf_1','th_perf_2','th_perf_3','th_perf_4','th_perf_5'].includes(row.conversation_id)), false);
});

test('batched tree access remains bounded across SQL parameter chunk boundaries', async t => {
  const { db, request, message } = await fixture(t);
  seedTrees(db, message, 401);
  const badge = await request('GET', '/social-tree-badge');
  assert.equal(badge.data.unread, 401);
  assert.ok(badge.queryCount <= 12);
  const inbox = await request('GET', '/messages/inbox');
  assert.equal(inbox.data.unreadCounts.tree_hole, 401);
  assert.equal(inbox.data.messages.length, 401);
  assert.ok(inbox.queryCount <= 13);
  const list = await request('GET', '/messages/tree-hole/conversations');
  assert.equal(list.data.my.length, 401);
  assert.ok(list.queryCount <= 17);
});

test('EXPLAIN identifies useful root and unread indexes using only synthetic messages', async t => {
  const { db, request, message } = await fixture(t);
  seedTrees(db, message, 100);
  db.exec('CREATE INDEX idx_messages_conversation ON messages(conversation_id); CREATE INDEX idx_messages_receiver ON messages(receiver_id,is_read); CREATE INDEX idx_messages_type ON messages(receiver_id,type)');
  const response = await request('GET', '/social-tree-badge');
  const root = response.executions.find(item => item.text.includes('MIN(id) AS id'));
  const unread = response.executions.find(item => item.text.includes('COUNT(*) AS c FROM messages'));
  assert.ok(root && unread);
  const plan = item => db.prepare('EXPLAIN QUERY PLAN ' + item.text).all(...item.params).map(row => row.detail);
  const before = { root: plan(root), unread: plan(unread) };
  db.exec('CREATE INDEX phase3_test_tree_root ON messages(type,conversation_id,id); CREATE INDEX phase3_test_unread ON messages(receiver_id,receiver_deleted,is_read,type,conversation_id)');
  const after = { root: plan(root), unread: plan(unread) };
  assert.ok(after.root.some(line => line.includes('phase3_test_tree_root')));
  assert.ok(after.unread.some(line => line.includes('phase3_test_unread')));
  t.diagnostic(JSON.stringify({ before, after }));
});

test('latest private history avoids duplicate lookahead and batches live quote labels', async t => {
  const { db, request, message } = await fixture(t);
  for (let index = 0; index < 100; index++) {
    const source = message(3, 2, 'private', '原文' + index);
    const reply = message(2, 3, 'private', '回复' + index);
    db.prepare('UPDATE messages SET reply_to_id=? WHERE id=?').run(source, reply);
  }
  const first = await request('GET', '/messages/conversation/3?mark_read=0');
  assert.equal(first.status, 200);
  assert.equal(first.data.messages.length, 100);
  assert.equal(first.data.hasMoreBefore, true);
  assert.equal(first.data.hasMoreAfter, false);
  assert.ok(first.queryCount <= 5);
  assert.equal(first.dirty, 0);
  db.prepare("UPDATE users SET nickname='刚修改的昵称' WHERE id=3").run();
  const second = await request('GET', '/messages/conversation/3?mark_read=0');
  assert.equal(second.data.messages.filter(row => row.reply_to).every(row => row.reply_to.sender_nickname === '刚修改的昵称'), true);
});
