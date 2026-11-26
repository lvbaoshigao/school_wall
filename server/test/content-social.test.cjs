'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, beforeEach, after } = require('node:test');

// Set isolation before requiring any application module (including JWT/upload paths).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-content-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'content-test-secret-never-use-in-production';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');

let db;
let server;
let baseUrl;

before(async () => {
  db = await initDB({ deferInitialSave: true });
  db.pragma('foreign_keys = ON');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/votes', require('../routes/votes'));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

beforeEach(() => {
  for (const table of ['vote_records', 'vote_options', 'votes', 'messages', 'friends', 'user_permissions', 'wall_members', 'walls', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  for (const [id, nickname] of [[1, '倾诉者'], [2, '志愿者'], [3, '同学'], [4, '其他用户']]) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname) VALUES (?,?,?,?)')
      .run(id, `content-user-${id}`, 'unused-password-hash', nickname);
  }
  for (const wallId of [1, 2]) {
    db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,?)').run(wallId, `content-wall-${wallId}`, 1);
    for (const userId of [1, 2, 3]) {
      db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,?,'active')")
        .run(wallId, userId, userId === 2 ? 'tree_hole' : 'member');
    }
  }
});

after(async () => {
  if (server) {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
  if (db) {
    // initDB owns an unref'ed autosave timer; prevent it from touching a closed test DB.
    db.dirty = false;
    db.db.close();
  }
  try {
    assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function request(userId, endpoint, { method = 'GET', body } = {}) {
  const token = jwt.sign({ id: userId, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const response = await fetch(baseUrl + endpoint, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-wall-id': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function message({ senderId = 1, receiverId = 2, wallId = 1, type = 'tree_hole', conversationId = 'th_content', assigneeId = 2, title = '', content = '隔离测试消息', revoked = 0, deleted = 0 } = {}) {
  return db.prepare(`
    INSERT INTO messages (sender_id,receiver_id,wall_id,type,conversation_id,assignee_id,title,content,is_revoked,receiver_deleted,is_anonymous)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(senderId, receiverId, wallId, type, conversationId, assigneeId, title, content, revoked, deleted, type === 'tree_hole' ? 1 : 0).lastInsertRowid;
}

function denyVolunteer() {
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,1,'wall.tree_hole','deny')").run();
}

function state(id) {
  return db.prepare('SELECT is_read,receiver_deleted,sender_deleted FROM messages WHERE id=?').get(id);
}

test('失去树洞权限后，单条标记已读与读取对话都拒绝访问', async () => {
  const id = message();
  denyVolunteer();
  assert.equal((await request(2, '/messages/tree-hole/th_content')).status, 403);
  assert.equal((await request(2, '/messages/inbox')).body.totalUnread, 0);
  const result = await request(2, `/messages/${id}/read`, { method: 'PUT', body: {} });
  assert.equal(result.status, 403);
  assert.equal(state(id).is_read, 0);
});

test('批量已读只修改当前可访问的接收消息', async () => {
  const forbidden = message();
  const allowed = message({ wallId: 2, conversationId: 'th_allowed' });
  const ordinary = message({ type: 'system', wallId: 0, conversationId: '', assigneeId: 0 });
  const foreign = message({ type: 'private', receiverId: 3 });
  const deleted = message({ type: 'system', deleted: 1 });
  denyVolunteer();
  const result = await request(2, '/messages/read-batch', { method: 'PUT', body: { ids: [forbidden, allowed, ordinary, foreign, deleted, allowed] } });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已标记2条消息为已读');
  assert.equal(state(forbidden).is_read, 0);
  assert.equal(state(allowed).is_read, 1);
  assert.equal(state(ordinary).is_read, 1);
  assert.equal(state(foreign).is_read, 0);
  assert.equal(state(deleted).is_read, 0);
});

test('全部已读保留无权访问树洞的未读状态，恢复权限后仍可见', async () => {
  const forbidden = message();
  const allowed = message({ wallId: 2, conversationId: 'th_allowed' });
  const ordinary = message({ type: 'system', wallId: 0, conversationId: '', assigneeId: 0 });
  denyVolunteer();
  const result = await request(2, '/messages/read-all', { method: 'PUT', body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已标记2条消息为已读');
  assert.equal(state(forbidden).is_read, 0);
  assert.equal(state(allowed).is_read, 1);
  assert.equal(state(ordinary).is_read, 1);
  db.exec('DELETE FROM user_permissions');
  const inbox = await request(2, '/messages/inbox');
  assert.equal(inbox.body.unreadCounts.tree_hole, 1);
  assert.equal(inbox.body.messages.find(item => item.id === forbidden).is_read, 0);
});

test('按类型全部已读不会绕过退墙与当前受指派者检查', async () => {
  const leftWall = message();
  db.prepare('DELETE FROM wall_members WHERE wall_id=1 AND user_id=2').run();
  const otherAssignee = message({ wallId: 2, conversationId: 'th_reassigned', assigneeId: 3 });
  const ordinary = message({ type: 'system', wallId: 0, conversationId: '', assigneeId: 0 });
  const result = await request(2, '/messages/read-all', { method: 'PUT', body: { type: 'tree_hole' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已标记0条消息为已读');
  assert.equal(state(leftWall).is_read, 0);
  assert.equal(state(otherAssignee).is_read, 0);
  assert.equal(state(ordinary).is_read, 0);
});

test('批量删除沿用单条删除的树洞授权且只隐藏本人的副本', async () => {
  const forbidden = message();
  const allowed = message({ wallId: 2, conversationId: 'th_allowed' });
  const ordinary = message({ type: 'private', wallId: 0, conversationId: '', assigneeId: 0 });
  denyVolunteer();
  assert.equal((await request(2, `/messages/${forbidden}`, { method: 'DELETE' })).status, 403);
  const result = await request(2, '/messages/inbox/all', { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已删除2条消息');
  assert.equal(state(forbidden).receiver_deleted, 0);
  assert.deepEqual(state(allowed), { is_read: 0, receiver_deleted: 1, sender_deleted: 0 });
  assert.deepEqual(state(ordinary), { is_read: 0, receiver_deleted: 1, sender_deleted: 0 });
});

test('树洞墙内封禁到期仍由既有权限逻辑恢复并允许标记已读', async () => {
  const id = message();
  db.prepare("UPDATE wall_members SET status='banned',wall_ban_until=? WHERE wall_id=1 AND user_id=2")
    .run(new Date(Date.now() - 60000).toISOString());
  const result = await request(2, `/messages/${id}/read`, { method: 'PUT', body: {} });
  assert.equal(result.status, 200);
  assert.equal(state(id).is_read, 1);
  assert.equal(db.prepare('SELECT status FROM wall_members WHERE wall_id=1 AND user_id=2').get().status, 'active');
});

test('倾诉者无需志愿者权限即可将收到的回复标记已读', async () => {
  const root = message();
  const reply = message({ senderId: 2, receiverId: 1 });
  const result = await request(1, '/messages/read-all', { method: 'PUT', body: { type: 'tree_hole' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已标记1条消息为已读');
  assert.equal(state(root).is_read, 0);
  assert.equal(state(reply).is_read, 1);
});

test('批量已读支持上限500个不同树洞且重复调用不虚增计数', async () => {
  const ids = Array.from({ length: 500 }, (_, index) => message({ conversationId: `th_batch_${index}` }));
  const result = await request(2, '/messages/read-batch', { method: 'PUT', body: { ids } });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, '已标记500条消息为已读');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE is_read=1').get().c, 500);
  const repeated = await request(2, '/messages/read-batch', { method: 'PUT', body: { ids } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.message, '已标记0条消息为已读');
});

test('批量已读中后续更新失败时回滚已更新的普通消息', async () => {
  const ordinary = message({ type: 'system', wallId: 0, conversationId: '', assigneeId: 0 });
  const tree = message();
  db.exec(`CREATE TRIGGER content_read_failure BEFORE UPDATE OF is_read ON messages
    WHEN OLD.type='tree_hole' BEGIN SELECT RAISE(ABORT, 'content test injected failure'); END`);
  try {
    const result = await request(2, '/messages/read-all', { method: 'PUT', body: {} });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /content test injected failure/);
    assert.equal(state(ordinary).is_read, 0);
    assert.equal(state(tree).is_read, 0);
  } finally {
    db.exec('DROP TRIGGER content_read_failure');
  }
});

for (const type of ['private', 'confession']) {
  test(`${type} 撤回同时移除标题与正文，已有引用显示撤回状态`, async () => {
    const original = await request(1, '/messages', { method: 'POST', body: { receiver_id: 3, type, title: '标题中的敏感信息', content: '原消息正文', ...(type === 'confession' ? { allow_replies: true } : {}) } });
    assert.equal(original.status, 200);
    const originalId = original.body.id;
    const reply = await request(3, '/messages', { method: 'POST', body: { receiver_id: 1, type, content: '回复', reply_to_id: originalId } });
    assert.equal(reply.status, 200);
    assert.equal((await request(1, `/messages/${originalId}/revoke`, { method: 'PUT', body: {} })).status, 200);
    const stored = db.prepare('SELECT title,content,is_revoked FROM messages WHERE id=?').get(originalId);
    assert.deepEqual(stored, { title: '', content: '[消息已撤回]', is_revoked: 1 });
    const inbox = await request(3, '/messages/inbox');
    const revoked = inbox.body.messages.find(item => item.id === originalId);
    assert.equal(revoked.title, '');
    assert.equal(revoked.content, '[消息已撤回]');
    const sent = await request(1, '/messages/sent');
    assert.equal(sent.body.find(item => item.id === originalId).title, '');
    const quoted = (await request(1, '/messages/inbox')).body.messages.find(item => item.id === reply.body.id);
    assert.equal(quoted.reply_to.available, false);
    assert.equal(quoted.reply_to.reason, 'revoked');
    assert.equal(quoted.reply_to_content, '[消息已撤回]');
  });
}

test('历史已撤回消息的标题在所有消息展示接口中隐藏', async () => {
  const id = message({ type: 'private', wallId: 0, conversationId: '', assigneeId: 0, title: '旧版本残留的敏感标题', content: '[消息已撤回]', revoked: 1 });
  const inbox = await request(2, '/messages/inbox');
  const sent = await request(1, '/messages/sent');
  const conversation = await request(2, '/messages/conversation/1?mark_read=0');
  const summaries = await request(2, '/messages/conversations');
  for (const item of [inbox.body.messages.find(item => item.id === id), sent.body.find(item => item.id === id), conversation.body.messages.find(item => item.id === id), summaries.body.conversations[0].last_message]) {
    assert.equal(item.is_revoked, 1);
    assert.equal(item.title, '');
  }
});

test('外键约束启用时，现有投票创建、投票和删除能完整清理选项及记录', async () => {
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const created = await request(1, '/votes', { method: 'POST', body: { title: '午饭选择', options: ['米饭', '面条'] } });
  assert.equal(created.status, 200);
  const voteId = created.body.id;
  const detail = await request(2, `/votes/${voteId}`);
  assert.equal(detail.status, 200);
  const chosen = detail.body.options[0].id;
  assert.equal((await request(2, `/votes/${voteId}/vote`, { method: 'POST', body: { option_id: chosen } })).status, 200);
  assert.equal((await request(1, `/votes/${voteId}`, { method: 'DELETE' })).status, 200);
  for (const table of ['votes', 'vote_options', 'vote_records']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
