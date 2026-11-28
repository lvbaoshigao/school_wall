'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-delete-api-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'wall-delete-isolated-test-secret-2026';
process.env.KEEP_DB = '1';
delete process.env.ADMIN_IP_WHITELIST;

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const passwords = require('../lib/password');
const { hashPassword } = passwords;
const { UPLOADS_DIR } = require('../lib/paths');
const { apiV1Middleware } = require('../lib/apiV1');
const COUNTS = ['members', 'wall_applications', 'ban_logs', 'posts', 'comments', 'likes', 'bookmarks', 'messages', 'announcements', 'votes', 'vote_options', 'vote_records', 'reports', 'post_reports', 'user_reports', 'user_permissions', 'attachments', 'deletable_attachments', 'retained_attachments'];
const PASSWORD = 'Current-password-42';
let db, server, baseUrl, nextUser = 0, passwordHash, superAdmin;
let afterPasswordVerified = null;

function account(role = 'user') {
  const username = 'wall-delete-user-' + (++nextUser);
  const id = db.prepare('INSERT INTO users (username,password_hash,nickname,role,status) VALUES (?,?,?,? ,\'active\')')
    .run(username, passwordHash, username, role).lastInsertRowid;
  const token = jwt.sign({ id, username, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { id, username, token };
}

function wall(name, ownerId) {
  const id = db.prepare("INSERT INTO walls (name,description,owner_id,status) VALUES (?, 'private description', ?, 'active')")
    .run(name, ownerId).lastInsertRowid;
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'owner','active')").run(id, ownerId);
  return id;
}

function message({ sender = superAdmin.id, receiver = superAdmin.id, wallId = 0, type = 'system', content, link = '', conversation = '', replyTo = 0, replyContent = '' }) {
  return db.prepare('INSERT INTO messages (sender_id,receiver_id,wall_id,type,title,content,link,conversation_id,reply_to_id,reply_to_content) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(sender, receiver, wallId, type, '', content, link, conversation, replyTo, replyContent).lastInsertRowid;
}

async function request(route, { account: actor, method = 'GET', body, headers = {} } = {}) {
  if (actor) headers.authorization = 'Bearer ' + actor.token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(baseUrl + route, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) : null };
}

function assertError(result, status, code) {
  assert.equal(result.response.status, status);
  assert.equal(result.body.code, code);
}

before(async () => {
  db = await initDB({ deferInitialSave: true });
  db.pragma('foreign_keys = ON');
  for (const subdir of ['images', 'bug-reports']) fs.mkdirSync(path.join(UPLOADS_DIR, subdir), { recursive: true });
  passwordHash = await hashPassword(PASSWORD);
  superAdmin = account('super_admin');
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('initialized','1')").run();
  const app = express();
  app.use(apiV1Middleware());
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/setup', require('../routes/setup')((req, res, next) => next()));
  // Match the production mounting order: existing management routes run first.
  app.use('/api/walls', require('../routes/wallAdmin'));
  const verifyPassword = passwords.verifyPassword;
  try {
    passwords.verifyPassword = async (...args) => {
      const result = await verifyPassword(...args);
      const hook = afterPasswordVerified;
      afterPasswordVerified = null;
      hook?.();
      return result;
    };
    app.use('/api/walls', require('../routes/walls'));
  } finally { passwords.verifyPassword = verifyPassword; }
  app.use((error, req, res, next) => res.status(500).json({ error: 'test server error', detail: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
  if (db) { db.dirty = false; db.db.close(); }
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('school-wall-delete-api-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('deletion routes coexist with existing management and support a versioned DELETE end to end', async () => {
  const applicant = account();
  const applied = await request('/api/walls/apply-create', { account: applicant, method: 'POST', body: { wall_name: '管理路由兼容测试墙' } });
  assert.equal(applied.response.status, 200);
  const applications = await request('/api/walls/admin/applications', { account: superAdmin });
  assert.equal(applications.response.status, 200);
  const application = applications.body.find(item => item.wall_name === '管理路由兼容测试墙');
  assert.ok(application);
  const approved = await request('/api/walls/admin/applications/' + application.id + '/review', { account: superAdmin, method: 'PUT', body: { action: 'approve' } });
  assert.equal(approved.response.status, 200);
  const target = approved.body.wall_id;
  const allWalls = await request('/api/walls/admin/all', { account: superAdmin });
  assert.equal(allWalls.response.status, 200);
  assert.ok(allWalls.body.some(item => item.id === target));
  const status = await request('/api/walls/admin/' + target + '/status', { account: superAdmin, method: 'PUT', body: { status: 'disabled' } });
  assert.equal(status.response.status, 200);
  const preview = await request('/api/v1/walls/admin/' + target + '/deletion-preview', { account: superAdmin });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.data.wall.status, 'disabled');
  const deleted = await request('/api/v1/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: { confirm_name: '管理路由兼容测试墙', password: PASSWORD } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.data.deleted_wall_id, target);
  assert.equal(deleted.body.error, null);
  assert.equal(deleted.body.meta.apiVersion, '1');
  assert.match(deleted.response.headers.get('cache-control'), /no-store/);
  assert.equal(db.prepare('SELECT id FROM walls WHERE id=?').get(target), undefined);
  assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(applicant.id));
});

test('preview and delete enforce global permission, valid IDs, exact name and current password', async () => {
  const owner = account();
  const target = wall('权限确认测试墙', owner.id);
  const deniedPreview = await request('/api/walls/admin/' + target + '/deletion-preview', { account: owner });
  assertError(deniedPreview, 403, 'PERMISSION_DENIED');
  assert.match(deniedPreview.response.headers.get('cache-control'), /no-store/);
  const invalidId = await request('/api/walls/admin/0/deletion-preview', { account: superAdmin });
  assertError(invalidId, 400, 'INVALID_WALL_ID');
  const anonymous = await request('/api/walls/admin/' + target + '/deletion-preview');
  assert.equal(anonymous.response.status, 401);
  assert.match(anonymous.response.headers.get('cache-control'), /no-store/);
  const missing = await request('/api/walls/admin/999999/deletion-preview', { account: superAdmin });
  assertError(missing, 404, 'WALL_NOT_FOUND');

  const preview = await request('/api/walls/admin/' + target + '/deletion-preview', { account: superAdmin });
  assert.equal(preview.response.status, 200);
  assert.match(preview.response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Object.keys(preview.body.counts).sort(), [...COUNTS].sort());
  for (const value of Object.values(preview.body.counts)) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.deepEqual(Object.keys(preview.body.wall).sort(), ['created_at', 'description', 'id', 'name', 'owner_id', 'status'].sort());
  assert.equal(preview.body.wall.name, '权限确认测试墙');
  assert.equal(preview.body.can_delete, true);

  assertError(await request('/api/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: {} }), 400, 'INVALID_CONFIRMATION');
  assertError(await request('/api/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: { confirm_name: ' 权限确认测试墙', password: PASSWORD } }), 400, 'INVALID_CONFIRMATION');
  assertError(await request('/api/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: { confirm_name: '权限确认测试墙', password: 'incorrect-password' } }), 403, 'PASSWORD_INVALID');
  const ownerDelete = await request('/api/walls/admin/' + target, { account: owner, method: 'DELETE', body: { confirm_name: '权限确认测试墙', password: PASSWORD } });
  assertError(ownerDelete, 403, 'PERMISSION_DENIED');
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(target));

  const v1 = await request('/api/v1/walls/admin/' + target + '/deletion-preview', { account: superAdmin });
  assert.equal(v1.response.status, 200);
  assert.equal(v1.body.data.wall.id, target);
  assert.equal(v1.body.meta.apiVersion, '1');
});

test('deletion isolates wall data, preserves accounts/global data and retains all attachment files', async () => {
  const owner = account();
  const otherOwner = account();
  const target = wall('隔离删除测试墙', owner.id);
  const other = wall('保留的另一面墙', otherOwner.id);
  const member = account();
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'member','active')").run(target, member.id);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (?,?,'wall.edit','grant')").run(owner.id, target);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (?,0,'global.wall.manage','grant')").run(superAdmin.id);
  db.prepare("INSERT INTO user_prefs (user_id,pref_key,pref_value) VALUES (?,'navbar','keep-this-preference')").run(owner.id);
  db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (?,?,'accepted')").run(owner.id, member.id);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('global.keep','yes')").run();

  const sharedImage = '/uploads/images/shared-wall.png';
  const exclusiveImage = '/uploads/images/exclusive-wall.png';
  const commentImage = '/uploads/images/comment-wall.png';
  const reportImage = '/uploads/bug-reports/report-wall.png';
  const messageImage = '/uploads/images/message-wall.png';
  for (const url of [sharedImage, exclusiveImage, commentImage, reportImage, messageImage]) {
    const full = path.join(UPLOADS_DIR, url.includes('/bug-reports/') ? 'bug-reports' : 'images', path.basename(url));
    fs.writeFileSync(full, Buffer.from('synthetic attachment'));
  }
  const targetPost = db.prepare('INSERT INTO posts (wall_id,content,author_ip) VALUES (?,?,?)')
    .run(target, 'private ' + sharedImage + ' ' + exclusiveImage, 'target-hash').lastInsertRowid;
  const otherPost = db.prepare('INSERT INTO posts (wall_id,content,author_ip) VALUES (?,?,?)')
    .run(other, 'shared reference ' + sharedImage, 'other-hash').lastInsertRowid;
  db.prepare('INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (?,?,?,?)').run(targetPost, commentImage, member.id, 'comment-hash');
  db.prepare('INSERT INTO likes (post_id,user_id) VALUES (?,?)').run(targetPost, member.id);
  db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (?,?)').run(member.id, targetPost);

  const targetVote = db.prepare('INSERT INTO votes (wall_id,title,author_ip) VALUES (?,?,?)').run(target, 'target vote', 'vote-hash').lastInsertRowid;
  const targetOption = db.prepare('INSERT INTO vote_options (vote_id,option_text) VALUES (?,?)').run(targetVote, 'yes').lastInsertRowid;
  db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,?)').run(targetVote, targetOption, member.id);
  const otherVote = db.prepare('INSERT INTO votes (wall_id,title,author_ip) VALUES (?,?,?)').run(other, 'other vote', 'vote-hash').lastInsertRowid;
  const otherOption = db.prepare('INSERT INTO vote_options (vote_id,option_text) VALUES (?,?)').run(otherVote, 'no').lastInsertRowid;
  db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,?)').run(otherVote, otherOption, member.id);

  const targetReport = db.prepare('INSERT INTO reports (wall_id,tracking_code,reporter_id,report_types,content,images) VALUES (?,?,?,?,?,?)')
    .run(target, 'RPT-WALL-DELETE-1', member.id, 'safety', 'private evidence', JSON.stringify([reportImage])).lastInsertRowid;
  const otherReport = db.prepare('INSERT INTO reports (wall_id,tracking_code,reporter_id,report_types,content) VALUES (?,?,?,?,?)')
    .run(other, 'RPT-WALL-DELETE-2', member.id, 'safety', 'other wall report').lastInsertRowid;
  db.prepare('INSERT INTO post_reports (wall_id,post_id,reporter_id,reason) VALUES (?,?,?,?)').run(other, targetPost, member.id, 'target post ownership wins');
  db.prepare('INSERT INTO post_reports (wall_id,post_id,reporter_id,reason) VALUES (?,?,?,?)').run(target, 90000001, member.id, 'orphan for this wall');
  const mismatchedPostReport = db.prepare('INSERT INTO post_reports (wall_id,post_id,reporter_id,reason) VALUES (?,?,?,?)').run(target, otherPost, member.id, 'belongs to other post').lastInsertRowid;

  db.prepare("INSERT INTO wall_applications (applicant_id,wall_name,status) VALUES (?,?,'approved')").run(member.id, '隔离删除测试墙');
  const pendingApp = db.prepare("INSERT INTO wall_applications (applicant_id,wall_name,status) VALUES (?,?,'pending')").run(member.id, '隔离删除测试墙').lastInsertRowid;
  const rejectedApp = db.prepare("INSERT INTO wall_applications (applicant_id,wall_name,status) VALUES (?,?,'rejected')").run(member.id, '隔离删除测试墙').lastInsertRowid;
  db.prepare("INSERT INTO ban_logs (scope,wall_id,target_user_id,action,reason) VALUES ('wall',?,?, 'ban','target')").run(target, member.id);
  db.prepare("INSERT INTO ban_logs (scope,wall_id,target_user_id,action,reason) VALUES ('global',?,?, 'ban','global')").run(target, member.id);
  db.prepare("INSERT INTO announcements (wall_id,title,content,author_id,scope) VALUES (?,?,?,?,'wall')").run(target, 'target announcement', 'private', owner.id);
  db.prepare("INSERT INTO announcements (wall_id,title,content,author_id,scope) VALUES (?,?,?,?,'global')").run(target, 'global announcement', 'keep', owner.id);
  db.prepare("INSERT INTO announcements (wall_id,title,content,author_id,scope) VALUES (?,?,?,?,'wall')").run(other, 'other announcement', 'keep', otherOwner.id);
  db.prepare('INSERT INTO user_reports (wall_id,reporter_id,reported_user_id,reason,evidence_messages) VALUES (?,?,?,?,?)').run(target, member.id, owner.id, 'target user report', 'target evidence');
  db.prepare('INSERT INTO user_reports (wall_id,reporter_id,reported_user_id,reason) VALUES (?,?,?,?)').run(other, member.id, otherOwner.id, 'other report');

  const targetMessage = message({ wallId: target, content: 'wall secret ' + messageImage });
  const snapshotMessage = message({ wallId: other, content: 'reply snapshot', link: '/post/' + targetPost, replyTo: targetMessage, replyContent: 'quoted wall secret' });
  const treeConversation = 'th_' + target + '_1700000000000_synthetic';
  const orphanTreeMessage = message({ wallId: other, type: 'tree_hole', content: 'orphan conversation secret', conversation: treeConversation });
  const legacyInteraction = message({ wallId: 0, type: 'interaction', content: 'legacy post notification snapshot', link: '/post/' + targetPost });
  const privateWithLink = message({ wallId: 0, type: 'private', content: 'private message body must remain intact', link: '/post/' + targetPost });
  const globalWallMention = message({ wallId: 0, content: 'Global message mentions 隔离删除测试墙', link: '/post/' + targetPost });
  const globalUnrelated = message({ wallId: 0, content: 'global app notification mentions 隔离删除测试墙', link: '/admin?panel=wallApps' });
  const otherMessage = message({ wallId: other, content: 'other wall private content' });

  const preview = await request('/api/walls/admin/' + target + '/deletion-preview', { account: superAdmin });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.counts.wall_applications, 1);
  assert.equal(preview.body.counts.posts, 1);
  assert.equal(preview.body.counts.post_reports, 2);
  assert.equal(preview.body.counts.messages, 3);
  assert.equal(preview.body.counts.attachments, 5);
  assert.equal(preview.body.counts.deletable_attachments, 0);
  assert.equal(preview.body.counts.retained_attachments, 5);
  assert.ok(preview.body.warnings.some(value => value.includes('保留附件文件')));

  const deleted = await request('/api/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: { confirm_name: '隔离删除测试墙', password: PASSWORD } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted_wall_id, target);
  for (const key of COUNTS) assert.ok(Number.isSafeInteger(deleted.body.counts[key]) && deleted.body.counts[key] >= 0, key);
  assert.equal(db.prepare('SELECT id FROM walls WHERE id=?').get(target), undefined);
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(other));
  assert.equal(db.prepare('SELECT id FROM posts WHERE id=?').get(targetPost), undefined);
  assert.ok(db.prepare('SELECT id FROM posts WHERE id=?').get(otherPost));
  assert.equal(db.prepare('SELECT id FROM comments WHERE post_id=?').get(targetPost), undefined);
  assert.equal(db.prepare('SELECT id FROM votes WHERE id=?').get(targetVote), undefined);
  assert.ok(db.prepare('SELECT id FROM votes WHERE id=?').get(otherVote));
  assert.equal(db.prepare('SELECT id FROM reports WHERE id=?').get(targetReport), undefined);
  assert.ok(db.prepare('SELECT id FROM reports WHERE id=?').get(otherReport));
  assert.equal(db.prepare('SELECT id FROM post_reports WHERE post_id=?').get(targetPost), undefined);
  assert.equal(db.prepare('SELECT id FROM post_reports WHERE id=?').get(mismatchedPostReport).id, mismatchedPostReport);
  assert.equal(db.prepare('SELECT id FROM wall_applications WHERE id=?').get(pendingApp).id, pendingApp);
  assert.equal(db.prepare('SELECT id FROM wall_applications WHERE id=?').get(rejectedApp).id, rejectedApp);
  assert.ok(db.prepare("SELECT id FROM ban_logs WHERE scope='global' AND wall_id=?").get(target));
  assert.ok(db.prepare("SELECT id FROM announcements WHERE scope='global' AND wall_id=?").get(target));
  assert.ok(db.prepare("SELECT id FROM announcements WHERE wall_id=? AND scope='wall'").get(other));
  assert.equal(db.prepare('SELECT id FROM user_reports WHERE wall_id=?').get(target), undefined);
  assert.ok(db.prepare('SELECT id FROM user_reports WHERE wall_id=?').get(other));
  assert.equal(db.prepare('SELECT id FROM user_permissions WHERE wall_id=?').get(target), undefined);
  assert.ok(db.prepare("SELECT id FROM user_permissions WHERE user_id=? AND wall_id=0 AND perm='global.wall.manage'").get(superAdmin.id));
  assert.equal(db.prepare('SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key=?').get(owner.id, 'navbar').pref_value, 'keep-this-preference');
  assert.ok(db.prepare('SELECT id FROM friends WHERE user_id=? AND friend_id=?').get(owner.id, member.id));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='global.keep'").get().value, 'yes');
  const snapshot = db.prepare('SELECT link,reply_to_id,reply_to_content FROM messages WHERE id=?').get(snapshotMessage);
  assert.equal(snapshot.link, '');
  assert.equal(snapshot.reply_to_id, 0);
  assert.equal(snapshot.reply_to_content, '');
  assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get(orphanTreeMessage), undefined);
  assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get(legacyInteraction), undefined);
  const privateBody = db.prepare('SELECT content FROM messages WHERE id=?').get(privateWithLink);
  assert.equal(privateBody.content, 'private message body must remain intact');
  const globalMention = db.prepare('SELECT wall_id,content,link FROM messages WHERE id=?').get(globalWallMention);
  assert.equal(globalMention.wall_id, 0);
  assert.match(globalMention.content, /隔离删除测试墙/);
  assert.equal(globalMention.link, '');
  const retainedGlobal = db.prepare('SELECT content,link FROM messages WHERE id=?').get(globalUnrelated);
  assert.match(retainedGlobal.content, /隔离删除测试墙/);
  assert.equal(retainedGlobal.link, '/admin?panel=wallApps');
  assert.ok(db.prepare('SELECT id FROM messages WHERE id=?').get(otherMessage));
  for (const url of [sharedImage, exclusiveImage, commentImage, reportImage, messageImage]) {
    const directory = url.includes('/bug-reports/') ? 'bug-reports' : 'images';
    assert.equal(fs.existsSync(path.join(UPLOADS_DIR, directory, path.basename(url))), true, url);
  }
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='initialized'").get().value, '1');
});

test('transaction rollback and cross-wall vote foreign-key anomalies never partially delete data', async () => {
  const owner = account();
  const rollbackWall = wall('事务回滚测试墙', owner.id);
  const rollbackPost = db.prepare('INSERT INTO posts (wall_id,content,author_ip) VALUES (?,?,?)').run(rollbackWall, 'rollback', 'hash').lastInsertRowid;
  db.prepare('INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (?,?,?,?)').run(rollbackPost, 'must rollback', owner.id, 'hash');
  db.exec("CREATE TRIGGER fail_wall_delete BEFORE DELETE ON walls WHEN OLD.id=" + rollbackWall + " BEGIN SELECT RAISE(ABORT,'forced wall delete failure'); END");
  const failed = await request('/api/walls/admin/' + rollbackWall, { account: superAdmin, method: 'DELETE', body: { confirm_name: '事务回滚测试墙', password: PASSWORD } });
  assert.equal(failed.response.status, 500);
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(rollbackWall));
  assert.ok(db.prepare('SELECT id FROM posts WHERE id=?').get(rollbackPost));
  assert.ok(db.prepare('SELECT id FROM comments WHERE post_id=?').get(rollbackPost));
  db.exec('DROP TRIGGER fail_wall_delete');

  const targetOwner = account(), foreignOwner = account(), voter = account();
  const target = wall('跨墙投票冲突墙', targetOwner.id), foreign = wall('冲突引用归属墙', foreignOwner.id);
  const targetVote = db.prepare('INSERT INTO votes (wall_id,title,author_ip) VALUES (?,?,?)').run(target, 'target', 'hash').lastInsertRowid;
  const targetOption = db.prepare('INSERT INTO vote_options (vote_id,option_text) VALUES (?,?)').run(targetVote, 'target option').lastInsertRowid;
  const foreignVote = db.prepare('INSERT INTO votes (wall_id,title,author_ip) VALUES (?,?,?)').run(foreign, 'foreign', 'hash').lastInsertRowid;
  db.prepare('INSERT INTO vote_options (vote_id,option_text) VALUES (?,?)').run(foreignVote, 'foreign option');
  db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,?)').run(foreignVote, targetOption, voter.id);
  const conflict = await request('/api/walls/admin/' + target, { account: superAdmin, method: 'DELETE', body: { confirm_name: '跨墙投票冲突墙', password: PASSWORD } });
  assertError(conflict, 409, 'WALL_REFERENCE_CONFLICT');
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(target));
  assert.ok(db.prepare('SELECT id FROM votes WHERE id=?').get(targetVote));
  assert.ok(db.prepare('SELECT id FROM vote_options WHERE id=?').get(targetOption));
  assert.ok(db.prepare('SELECT id FROM vote_records WHERE vote_id=? AND option_id=?').get(foreignVote, targetOption));
  const outgoingConflict = await request('/api/v1/walls/admin/' + foreign, { account: superAdmin, method: 'DELETE', body: { confirm_name: '冲突引用归属墙', password: PASSWORD } });
  assert.equal(outgoingConflict.response.status, 409);
  assert.equal(outgoingConflict.body.error.code, 'WALL_REFERENCE_CONFLICT');
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(foreign));
  assert.ok(db.prepare('SELECT id FROM votes WHERE id=?').get(foreignVote));
  assert.ok(db.prepare('SELECT id FROM vote_records WHERE vote_id=? AND option_id=?').get(foreignVote, targetOption));
});

test('changes to token, account, role, password or wall name during verification cancel deletion', async t => {
  const replacementHash = await hashPassword('Replacement-password-43');
  const cases = [
    { name: 'token', status: 401, change: actor => db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(actor.id) },
    { name: 'account', status: 403, change: actor => db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(actor.id) },
    { name: 'role', status: 403, code: 'PERMISSION_DENIED', change: actor => db.prepare("UPDATE users SET role='user' WHERE id=?").run(actor.id) },
    { name: 'password', status: 403, code: 'PASSWORD_INVALID', change: actor => db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(replacementHash, actor.id) },
    { name: 'wall-name', status: 400, code: 'INVALID_CONFIRMATION', change: (actor, target) => db.prepare('UPDATE walls SET name=? WHERE id=?').run('校验期间已改名', target) },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const actor = account('super_admin');
    const name = '校验变化-' + scenario.name;
    const target = wall(name, actor.id);
    let verificationObserved = false;
    afterPasswordVerified = () => {
      verificationObserved = true;
      scenario.change(actor, target);
    };
    const result = await request('/api/walls/admin/' + target, { account: actor, method: 'DELETE', body: { confirm_name: name, password: PASSWORD } });
    assert.equal(verificationObserved, true);
    assert.equal(result.response.status, scenario.status);
    if (scenario.code) assert.equal(result.body.code, scenario.code);
    assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(target));
    assert.ok(db.prepare('SELECT id FROM wall_members WHERE wall_id=?').get(target));
  });
});

test('rechecks permission after password verification and permits deleting the final wall without reopening setup', async () => {
  const revoker = account();
  const protectedWall = wall('权限异步复核墙', account().id);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (?,0,'global.wall.manage','grant')").run(revoker.id);
  let verificationObserved = false;
  afterPasswordVerified = () => {
    verificationObserved = true;
    db.prepare('DELETE FROM user_permissions WHERE user_id=? AND wall_id=0 AND perm=?').run(revoker.id, 'global.wall.manage');
  };
  const revoked = await request('/api/walls/admin/' + protectedWall, { account: revoker, method: 'DELETE', body: { confirm_name: '权限异步复核墙', password: PASSWORD } });
  assert.equal(verificationObserved, true, 'revocation must occur after initial authorization and password verification');
  assertError(revoked, 403, 'PERMISSION_DENIED');
  assert.ok(db.prepare('SELECT id FROM walls WHERE id=?').get(protectedWall));

  db.exec('DELETE FROM vote_records; DELETE FROM vote_options; DELETE FROM votes; DELETE FROM post_reports; DELETE FROM comments; DELETE FROM likes; DELETE FROM bookmarks; DELETE FROM reports; DELETE FROM announcements; DELETE FROM messages; DELETE FROM user_reports; DELETE FROM ban_logs WHERE scope=\'wall\'; DELETE FROM user_permissions WHERE wall_id>0; DELETE FROM wall_members; DELETE FROM posts; DELETE FROM walls;');
  const finalOwner = account();
  const lastWall = wall('最后一面校园墙', finalOwner.id);
  const deleted = await request('/api/walls/admin/' + lastWall, { account: superAdmin, method: 'DELETE', body: { confirm_name: '最后一面校园墙', password: PASSWORD } });
  assert.equal(deleted.response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM walls').get().c, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='initialized'").get().value, '1');
  const status = await request('/api/setup/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.initialized, true);
  assert.equal(status.body.testAvailable, false);
  const setup = await request('/api/setup', { method: 'POST', body: { username: 'must-not-reopen', password: PASSWORD, wall_name: '重新初始化校园墙' } });
  assert.equal(setup.response.status, 400);
});
