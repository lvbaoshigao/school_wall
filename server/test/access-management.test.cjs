'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-access-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'access-regression-secret-with-no-production-value';
delete process.env.KEEP_DB;

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { SECRET } = require('../middleware/auth');
const { hashPassword } = require('../lib/password');
const dbops = require('../routes/dbops');

let db;
let server;
let baseUrl;
let fixtureId = 0;
let originalAdmin;

function user(role = 'user', passwordHash = '') {
  fixtureId += 1;
  const username = 'access-user-' + fixtureId;
  const id = db.prepare("INSERT INTO users (username, password_hash, nickname, role, status) VALUES (?, ?, ?, ?, 'active')")
    .run(username, passwordHash, username, role).lastInsertRowid;
  return { id, username, token: jwt.sign({ id, username, role, tv: 0 }, SECRET, { expiresIn: '1h' }) };
}

function wall(owner) {
  fixtureId += 1;
  const id = db.prepare("INSERT INTO walls (name, owner_id, status) VALUES (?, ?, 'active')")
    .run('access-wall-' + fixtureId, owner.id).lastInsertRowid;
  db.prepare("INSERT INTO wall_members (wall_id, user_id, wall_role, status) VALUES (?, ?, 'owner', 'active')")
    .run(id, owner.id);
  return id;
}

function member(wallId, account, role = 'member') {
  db.prepare("INSERT INTO wall_members (wall_id, user_id, wall_role, status) VALUES (?, ?, ?, 'active')")
    .run(wallId, account.id, role);
}

async function request(route, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  db = await initDB({ deferInitialSave: true });
  db.pragma('foreign_keys = ON');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('initialized', '1')").run();
  originalAdmin = user('admin', await hashPassword('original-admin-password'));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/walls', require('../routes/walls'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/setup', require('../routes/setup')((req, res, next) => next()));
  app.use('/api/bug-reports', require('../routes/bugReports'));
  app.use(require('../dashboard'));
  app.use((error, req, res, next) => res.status(500).json({ error: 'test database operation failed' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (db) { db.dirty = false; db.db.close(); }
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('school-wall-access-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Bug feedback router mounts and restricts reporter/admin views', async () => {
  assert.equal(typeof require('../routes/bugReports'), 'function');
  const reporter = user();
  const outsider = user();
  const admin = user('admin');
  const submitted = await request('/api/bug-reports', {
    token: reporter.token, method: 'POST', body: { title: 'Report title', content: 'Report details' },
  });
  assert.equal(submitted.status, 200);
  const own = await request('/api/bug-reports', { token: reporter.token });
  assert.equal(own.status, 200);
  assert.ok(own.body.some(row => row.id === submitted.body.id));
  const others = await request('/api/bug-reports', { token: outsider.token });
  assert.deepEqual(others.body, []);
  assert.equal((await request('/api/bug-reports/admin', { token: outsider.token })).status, 403);
  const all = await request('/api/bug-reports/admin', { token: admin.token });
  assert.equal(all.status, 200);
  assert.ok(all.body.some(row => row.id === submitted.body.id));
});

test('Failed ownership transfer rolls back both wall roles and owner metadata', async () => {
  const owner = user();
  const target = user();
  const wallId = wall(owner);
  member(wallId, target);
  db.exec(`CREATE TRIGGER access_fail_owner_update BEFORE UPDATE OF owner_id ON walls
    WHEN OLD.id = ${wallId} BEGIN SELECT RAISE(ABORT, 'injected owner metadata failure'); END`);
  try {
    const response = await request('/api/walls/' + wallId + '/transfer-owner', {
      token: owner.token, method: 'PUT', body: { new_owner_id: target.id },
    });
    assert.equal(response.status, 500);
    assert.equal(db.prepare('SELECT owner_id FROM walls WHERE id=?').get(wallId).owner_id, owner.id);
    assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, owner.id).wall_role, 'owner');
    assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, target.id).wall_role, 'member');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE receiver_id=? AND title='你已成为墙主'").get(target.id).c, 0);
  } finally {
    db.exec('DROP TRIGGER access_fail_owner_update');
  }
});

test('Ownership transfer also rolls back when the success notification fails', async () => {
  const owner = user();
  const target = user();
  const wallId = wall(owner);
  member(wallId, target);
  db.exec(`CREATE TRIGGER access_fail_owner_notice BEFORE INSERT ON messages
    WHEN NEW.receiver_id = ${target.id} AND NEW.title = '你已成为墙主'
    BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END`);
  try {
    const response = await request('/api/walls/' + wallId + '/transfer-owner', {
      token: owner.token, method: 'PUT', body: { new_owner_id: target.id },
    });
    assert.equal(response.status, 500);
    assert.equal(db.prepare('SELECT owner_id FROM walls WHERE id=?').get(wallId).owner_id, owner.id);
    assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, owner.id).wall_role, 'owner');
    assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, target.id).wall_role, 'member');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE receiver_id=? AND title='你已成为墙主'").get(target.id).c, 0);
  } finally {
    db.exec('DROP TRIGGER access_fail_owner_notice');
  }
});

test('Ownership transfer preserves permission checks and succeeds atomically', async () => {
  const owner = user();
  const target = user();
  const wallId = wall(owner);
  member(wallId, target);
  assert.equal((await request('/api/walls/' + wallId + '/transfer-owner', {
    token: target.token, method: 'PUT', body: { new_owner_id: target.id },
  })).status, 403);
  const response = await request('/api/walls/' + wallId + '/transfer-owner', {
    token: owner.token, method: 'PUT', body: { new_owner_id: target.id },
  });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT owner_id FROM walls WHERE id=?').get(wallId).owner_id, target.id);
  assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, owner.id).wall_role, 'admin');
  assert.equal(db.prepare('SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, target.id).wall_role, 'owner');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE receiver_id=? AND title='你已成为墙主'").get(target.id).c, 1);
});

test('Admin and self account deletion work with foreign keys enabled', async () => {
  const admin = user('super_admin');
  const passwordHash = await hashPassword('access-test-password');
  for (const selfDelete of [false, true]) {
    const target = user('user', passwordHash);
    const vote = db.prepare("INSERT INTO votes (wall_id, author_id, title, author_ip) VALUES (1, ?, 'test vote', '127.0.0.1')")
      .run(target.id).lastInsertRowid;
    const option = db.prepare("INSERT INTO vote_options (vote_id, option_text, vote_count) VALUES (?, 'option', 1)").run(vote).lastInsertRowid;
    db.prepare('INSERT INTO vote_records (vote_id, option_id, user_id) VALUES (?, ?, ?)').run(vote, option, target.id);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const response = await request(selfDelete ? '/api/auth/account' : '/api/admin/users/' + target.id, {
      token: selfDelete ? target.token : admin.token, method: 'DELETE',
      body: selfDelete ? { password: 'access-test-password' } : undefined,
    });
    assert.equal(response.status, 200);
    assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(target.id), undefined);
    assert.equal(db.prepare('SELECT id FROM votes WHERE id=?').get(vote), undefined);
    assert.equal(db.prepare('SELECT id FROM vote_options WHERE id=?').get(option), undefined);
    assert.equal(db.prepare('SELECT id FROM vote_records WHERE vote_id=?').get(vote), undefined);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

test('Wiping and initializing again never revives old login tokens or dashboard tickets', async () => {
  const login = await request('/api/auth/login', {
    method: 'POST', body: { username: originalAdmin.username, password: 'original-admin-password' },
  });
  assert.equal(login.status, 200);
  const session = await fetch(baseUrl + '/api/dashboard/session', {
    method: 'POST', headers: { Authorization: 'Bearer ' + login.body.token },
  });
  assert.equal(session.status, 200);
  await session.json();
  const oldCookie = session.headers.get('set-cookie').split(';')[0];
  const beforeWipe = await fetch(baseUrl + '/dashboard/api/db/status', { headers: { Cookie: oldCookie } });
  assert.equal(beforeWipe.status, 403); // Existing ticket authenticates, admin lacks database permission.
  await beforeWipe.json();
  const oldUsers = db.prepare('SELECT id, username, role, token_version FROM users').all();
  assert.ok(oldUsers.length > 0);
  const oldTokens = oldUsers.map(account => jwt.sign({
    id: account.id, username: account.username, role: account.role, tv: account.token_version || 0,
  }, SECRET, { expiresIn: '1h' }));
  oldTokens.push(login.body.token);
  const maxOldId = Math.max(...oldUsers.map(account => account.id));
  dbops.wipeNow(db);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
  const setup = await request('/api/setup', {
    method: 'POST', body: { username: 'replacement-admin', password: 'new-access-password', wall_name: 'replacement-wall' },
  });
  assert.equal(setup.status, 200);
  const staleDashboard = await fetch(baseUrl + '/dashboard/api/db/status', { headers: { Cookie: oldCookie } });
  assert.equal(staleDashboard.status, 401, 'a pre-wipe dashboard ticket must not become the new administrator');
  await staleDashboard.json();
  for (const token of oldTokens) {
    const response = await request('/api/auth/me', { token });
    assert.equal(response.status, 401, 'a pre-wipe token must not become the new administrator');
  }
  assert.ok(setup.body.user.id > maxOldId);
  const fresh = await request('/api/auth/me', { token: setup.body.token });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.username, 'replacement-admin');
  const newSession = await fetch(baseUrl + '/api/dashboard/session', {
    method: 'POST', headers: { Authorization: 'Bearer ' + setup.body.token },
  });
  assert.equal(newSession.status, 200);
  await newSession.json();
  const newCookie = newSession.headers.get('set-cookie').split(';')[0];
  const freshDashboard = await fetch(baseUrl + '/dashboard/api/db/status', { headers: { Cookie: newCookie } });
  assert.equal(freshDashboard.status, 200);
  await freshDashboard.json();
  const registered = await request('/api/auth/register', {
    method: 'POST', body: { username: 'replacement-user', password: 'new-access-password' },
  });
  assert.equal(registered.status, 200);
  assert.ok(registered.body.user.id > setup.body.user.id);
  for (const token of oldTokens) assert.equal((await request('/api/auth/me', { token })).status, 401);
});
