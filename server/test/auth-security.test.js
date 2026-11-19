const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

// Never load or modify the installation's persistent JWT secret or database.
process.env.JWT_SECRET = 'auth-security-isolated-test-key-2026';
const passwordLib = require('../lib/password');
const { authRequired, wallContext, wallPathContext, SECRET } = require('../middleware/auth');
const root = path.resolve(__dirname, '..');
let SQL;
let originalHash;
let replacementHash;
let schema;

test.before(async () => {
  SQL = await initSqlJs();
  originalHash = await passwordLib.hashPassword('original-password');
  replacementHash = await passwordLib.hashPassword('replacement-password');
  // Exercise the application's real schema without calling initDB (which persists a live database).
  const dbSource = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  schema = dbSource.match(/wrapper\.exec\(`([\s\S]*?)`\);/)[1];
});

function loadModule(relative, overrides = {}, customProcess = process) {
  const filename = path.join(root, relative);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const run = vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['require', 'module', 'exports', '__filename', '__dirname', 'process'], { filename });
  run(id => Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : nativeRequire(id),
    module, module.exports, filename, path.dirname(filename), customProcess);
  return module.exports;
}

function wrap(db) {
  return {
    db, saves: 0,
    saveNow() { this.saves++; },
    prepare(sql) {
      const rows = params => {
        const statement = db.prepare(sql);
        try {
          if (params.length) statement.bind(params);
          const result = [];
          while (statement.step()) result.push(statement.getAsObject());
          return result;
        } finally { statement.free(); }
      };
      return {
        get(...params) { return rows(params)[0]; },
        all(...params) { return rows(params); },
        run(...params) {
          db.run(sql, params);
          return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
        },
      };
    },
  };
}

function addUser(db, id, username, hash = originalHash, role = 'user') {
  db.prepare('INSERT INTO users (id, username, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hash, username, role);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('security test barrier timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { empty = false, passwords = passwordLib, signing = jwt, encoder } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-auth-security-'));
  const db = wrap(new SQL.Database());
  db.db.run('PRAGMA foreign_keys = ON');
  db.db.run(schema);
  if (!empty) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('initialized', '1')").run();
    addUser(db, 1, 'alpha');
    addUser(db, 2, 'bravo');
  }
  const paths = { DATA_DIR: temporary, DB_PATH: path.join(temporary, 'data.db'), UPLOADS_DIR: path.join(temporary, 'uploads') };
  fs.mkdirSync(path.join(paths.UPLOADS_DIR, 'avatars'), { recursive: true });
  const uploads = require('../lib/uploads');
  const router = loadModule('routes/auth.js', {
    '../lib/password': passwords, '../lib/paths': paths,
    '../lib/uploads': { ...uploads, encodeValidatedImage: encoder || uploads.encodeValidatedImage, checkQuota: () => ({ ok: true, commit() {} }) },
  });
  const setup = loadModule('routes/setup.js', { '../lib/password': passwords, jsonwebtoken: signing });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', router);
  app.use('/api/setup', setup((req, res, next) => next()));
  for (const prefix of ['/api/messages', '/api/friends', '/api/chat']) {
    app.use(prefix, authRequired, (req, res) => res.json({ ok: true }));
  }
  app.post('/wall-context', authRequired, wallContext, (req, res) => res.json({ wallId: req.wallId }));
  app.post('/wall-path/:id', authRequired, wallPathContext, (req, res) => res.json({ wallId: req.wallId }));
  app.get('/downstream-error', authRequired, () => { throw new Error('downstream failure'); });
  app.use((err, req, res, next) => { res.status(500).json({ error: 'test server error' }); });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const token = (id = 1, claims = {}, options = {}) => jwt.sign({ id, tv: 0, ...claims }, SECRET, { expiresIn: '7d', ...options });
  const request = (method, url, body, authorization = empty ? undefined : token(), extraHeaders = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: json, headers: res.headers, bytes });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
  return { db, request, token, temporary, paths };
}

test('scrypt round trips, rejects JSON coercion and bounds malformed KDF data', async () => {
  assert.equal((await passwordLib.verifyPassword('original-password', originalHash)).ok, true);
  assert.equal((await passwordLib.verifyPassword('wrong-password', originalHash)).ok, false);
  for (const value of [{}, [], ['original-password'], 123456, null, 'x'.repeat(1025)]) {
    await assert.rejects(passwordLib.hashPassword(value), TypeError);
    assert.equal((await passwordLib.verifyPassword(value, originalHash)).ok, false);
  }
  for (const bad of [originalHash.replace('$16384$', '$16384junk$'), originalHash.replace('$8$', '$999999$'),
    originalHash.replace('$1$', '$999999$'), originalHash.slice(0, -4), '$2a$31$' + 'a'.repeat(53)]) {
    assert.equal((await passwordLib.verifyPassword('original-password', bad)).ok, false);
  }
});

test('legacy bcrypt migrates normal passwords but never pins an arbitrary tail after byte 72', async () => {
  const shortHash = await bcrypt.hash('original-password', 4);
  assert.deepEqual(await passwordLib.verifyPassword('original-password', shortHash), { ok: true, needsUpgrade: true });
  const prefix = 'x'.repeat(72);
  const longHash = await bcrypt.hash(prefix + 'real-tail', 4);
  assert.deepEqual(await passwordLib.verifyPassword(prefix + 'arbitrary-tail', longHash), { ok: true, needsUpgrade: false });
});

test('register validates strings, lengths and JSON object shape before any insert', async t => {
  const f = await fixture(t);
  const cases = [[], { username: {}, password: 'secure-password' }, { username: 'newuser', password: {} },
    { username: 'newuser', password: ['secure-password'] }, { username: 'newuser', password: 'x'.repeat(1025) },
    { username: 'newuser', password: 'secure-password', nickname: {} },
    { username: 'newuser', password: 'secure-password', real_name: 'x'.repeat(21) },
    { username: 'a\nb', password: 'secure-password' }];
  for (const body of cases) assert.equal((await f.request('POST', '/api/auth/register', body)).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2);
});

test('concurrent duplicate registrations create only one ordinary account', async t => {
  const f = await fixture(t);
  const body = { username: 'newuser', password: 'secure-password', role: 'super_admin', id: 99 };
  const results = await Promise.all([f.request('POST', '/api/auth/register', body), f.request('POST', '/api/auth/register', body)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const row = f.db.prepare('SELECT id, role, password_hash FROM users WHERE username = ?').get('newuser');
  assert.equal(row.role, 'user');
  assert.notEqual(row.id, 99);
  assert.equal((await passwordLib.verifyPassword(body.password, row.password_hash)).ok, true);
});

test('profile type and integer validation preserves privacy and prevents mass assignment', async t => {
  const f = await fixture(t);
  for (const body of [{ nickname: {} }, { real_name: [] }, { show_contact: 'false' }, { show_real_name: 2 },
    { class_number: [] }, { class_number: -1 }, { class_number: '1e2' }, { graduation_year: 1 }, { gender: 'unknown' }]) {
    assert.equal((await f.request('PUT', '/api/auth/profile', body)).status, 400);
  }
  const result = await f.request('PUT', '/api/auth/profile', { nickname: '更新昵称', show_contact: false,
    allow_discover: true, class_number: '3', graduation_year: 2026, role: 'super_admin', id: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, 1);
  assert.equal(result.body.role, 'user');
  assert.equal(result.body.show_contact, 0);
  assert.equal(result.body.class_number, 3);
  assert.equal(f.db.prepare('SELECT nickname FROM users WHERE id = 2').get().nickname, 'bravo');
});

test('password changes revoke old tokens, return a working replacement and handle nullable legacy versions', async t => {
  const f = await fixture(t);
  f.db.prepare('UPDATE users SET token_version = NULL WHERE id = 1').run();
  const previousToken = f.token();
  const changed = await f.request('PUT', '/api/auth/password', { oldPassword: 'original-password', newPassword: 'replacement-password' });
  assert.equal(changed.status, 200);
  assert.equal(jwt.verify(changed.body.token, SECRET).tv, 1);
  assert.equal((await f.request('GET', '/api/auth/me', undefined, previousToken)).status, 401);
  assert.equal((await f.request('GET', '/api/auth/me', undefined, changed.body.token)).status, 200);
  assert.equal((await f.request('POST', '/api/auth/login', { username: 'alpha', password: 'original-password' })).status, 401);
});

test('simultaneous password changes using the same old session cannot both commit', async t => {
  const ready = deferred(), release = deferred();
  let entered = 0;
  const f = await fixture(t, { passwords: { ...passwordLib, async verifyPassword(...args) {
    const result = await passwordLib.verifyPassword(...args);
    if (++entered === 2) ready.resolve();
    await release.promise;
    return result;
  } } });
  const changes = ['first-new-password', 'second-new-password'].map(newPassword =>
    f.request('PUT', '/api/auth/password', { oldPassword: 'original-password', newPassword }));
  await waitFor(ready.promise);
  release.resolve();
  const results = await Promise.all(changes);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal(f.db.prepare('SELECT token_version FROM users WHERE id = 1').get().token_version, 1);
});

test('successful legacy login upgrades the hash and produces an accepted API session', async t => {
  const f = await fixture(t);
  f.db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(await bcrypt.hash('original-password', 4));
  const login = await f.request('POST', '/api/auth/login', { username: 'alpha', password: 'original-password' });
  assert.equal(login.status, 200);
  const stored = f.db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;
  assert.ok(stored.startsWith('scrypt$'));
  assert.equal((await passwordLib.verifyPassword('original-password', stored)).ok, true);
  assert.equal((await f.request('GET', '/api/auth/me', undefined, login.body.token)).status, 200);
});

test('a delayed bcrypt upgrade cannot overwrite a new password or resurrect old credentials', async t => {
  const ready = deferred(), release = deferred();
  const f = await fixture(t, { passwords: { ...passwordLib, async hashPassword(value) {
    ready.resolve();
    await release.promise;
    return passwordLib.hashPassword(value);
  } } });
  f.db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(await bcrypt.hash('original-password', 4));
  const login = f.request('POST', '/api/auth/login', { username: 'alpha', password: 'original-password' });
  await waitFor(ready.promise);
  f.db.prepare('UPDATE users SET password_hash = ?, token_version = 1 WHERE id = 1').run(replacementHash);
  release.resolve();
  assert.equal((await login).status, 401);
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash, replacementHash);
});

test('a delayed password verification cannot log in with credentials changed in flight', async t => {
  const ready = deferred(), release = deferred();
  const f = await fixture(t, { passwords: { ...passwordLib, async verifyPassword(...args) {
    const result = await passwordLib.verifyPassword(...args);
    ready.resolve(); await release.promise; return result;
  } } });
  const login = f.request('POST', '/api/auth/login', { username: 'alpha', password: 'original-password' });
  await waitFor(ready.promise);
  f.db.prepare('UPDATE users SET password_hash = ?, token_version = 1 WHERE id = 1').run(replacementHash);
  release.resolve();
  assert.equal((await login).status, 401);
});

test('account deletion rechecks credentials and super-admin protection after verification awaits', async t => {
  for (const mutation of ['password', 'promotion']) {
    const ready = deferred(), release = deferred();
    const f = await fixture(t, { passwords: { ...passwordLib, async verifyPassword(...args) {
      const result = await passwordLib.verifyPassword(...args);
      ready.resolve(); await release.promise; return result;
    } } });
    const deletion = f.request('DELETE', '/api/auth/account', { password: 'original-password' });
    await waitFor(ready.promise);
    if (mutation === 'password') f.db.prepare('UPDATE users SET password_hash = ?, token_version = 1 WHERE id = 1').run(replacementHash);
    else f.db.prepare("UPDATE users SET role = 'super_admin' WHERE id = 1").run();
    release.resolve();
    assert.equal((await deletion).status, mutation === 'password' ? 401 : 403);
    assert.ok(f.db.prepare('SELECT id FROM users WHERE id = 1').get());
  }
});

test('account deletion requires the current password and preserves active wall ownership', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: {} })).status, 400);
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: 'wrong-password' })).status, 400);
  f.db.prepare("INSERT INTO walls (name, owner_id) VALUES ('校园墙', 1)").run();
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: 'original-password' })).status, 400);
  f.db.prepare("UPDATE users SET role = 'super_admin' WHERE id = 1").run();
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: 'original-password' })).status, 403);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2);
});

function seedContent(db) {
  db.db.run(`
    INSERT INTO walls (id, name, owner_id) VALUES (1, '校园墙', 2);
    INSERT INTO posts (id, wall_id, content, author_id, author_ip, comment_count, like_count) VALUES
      (1, 1, 'delete this', 1, 'test', 1, 1), (2, 1, 'keep this', 2, 'test', 1, 1);
    INSERT INTO comments (post_id, content, author_id, author_ip) VALUES (1, 'other comment', 2, 'test'), (2, 'my comment', 1, 'test');
    INSERT INTO likes (post_id, user_id) VALUES (1, 2), (2, 1);
    INSERT INTO bookmarks (post_id, user_id) VALUES (1, 2), (2, 1);
    INSERT INTO votes (id, wall_id, title, author_id, author_ip) VALUES (1, 1, 'my vote', 1, 'test'), (2, 1, 'other vote', 2, 'test');
    INSERT INTO vote_options (id, vote_id, option_text, vote_count) VALUES (1, 1, 'A', 1), (2, 2, 'B', 1);
    INSERT INTO vote_records (vote_id, option_id, user_id) VALUES (1, 1, 2), (2, 2, 1);
    INSERT INTO announcements (wall_id, title, content, author_id) VALUES (1, 'my notice', 'notice', 1);
    INSERT INTO user_prefs (user_id, pref_key, pref_value) VALUES (1, 'navbar', '{}');
    INSERT INTO user_permissions (user_id, perm, effect) VALUES (1, 'global.moderate', 'deny');
  `);
}

test('account deletion fully rolls back content and counters if the final delete fails', async t => {
  const f = await fixture(t);
  seedContent(f.db);
  f.db.db.run("CREATE TRIGGER stop_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: 'original-password' })).status, 500);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM comments').get().c, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM user_prefs').get().c, 1);
  assert.equal(f.db.prepare('SELECT vote_count FROM vote_options WHERE id = 2').get().vote_count, 1);
});

test('successful account deletion removes dependent private data and repairs surviving counters', async t => {
  const f = await fixture(t);
  seedContent(f.db);
  assert.equal((await f.request('DELETE', '/api/auth/account', { password: 'original-password', id: 2 })).status, 200);
  assert.equal(f.db.prepare('SELECT id FROM users WHERE id = 1').get(), undefined);
  assert.ok(f.db.prepare('SELECT id FROM users WHERE id = 2').get());
  for (const table of ['comments', 'likes', 'bookmarks', 'vote_records', 'announcements', 'user_prefs', 'user_permissions']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, 0, table);
  }
  assert.deepEqual(f.db.prepare('SELECT comment_count, like_count FROM posts WHERE id = 2').get(), { comment_count: 0, like_count: 0 });
  assert.equal(f.db.prepare('SELECT vote_count FROM vote_options WHERE id = 2').get().vote_count, 0);
  assert.equal(f.db.prepare('SELECT id FROM posts WHERE id = 1').get(), undefined);
  assert.equal((await f.request('GET', '/api/auth/me')).status, 401);
});

test('avatars cannot adopt or delete another user file, including legacy malicious references', async t => {
  const f = await fixture(t);
  const otherAvatar = '/uploads/avatars/2_aaaaaaaaaaaa.png';
  const otherPath = path.join(f.paths.UPLOADS_DIR, 'avatars', '2_aaaaaaaaaaaa.png');
  fs.writeFileSync(otherPath, 'do not delete');
  assert.equal((await f.request('PUT', '/api/auth/avatar', { avatar: {} })).status, 400);
  assert.equal((await f.request('PUT', '/api/auth/avatar', { avatar: otherAvatar })).status, 400);
  assert.equal((await f.request('PUT', '/api/auth/avatar', { avatar: '/uploads/avatars/1_aaaaaaaaaaaa.png' })).status, 400);
  f.db.prepare('UPDATE users SET avatar = ? WHERE id = 1').run(otherAvatar);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPw76v5DwAE4gJZBTIyWgAAAABJRU5ErkJggg==';
  const upload = await f.request('PUT', '/api/auth/avatar', { avatar });
  assert.equal(upload.status, 200);
  assert.equal(fs.readFileSync(otherPath, 'utf8'), 'do not delete');
  assert.equal((await f.request('PUT', '/api/auth/avatar', { avatar: upload.body.avatar })).status, 200);
  assert.equal((await f.request('PUT', '/api/auth/avatar', { avatar })).status, 200);
  assert.ok(fs.existsSync(path.join(f.paths.UPLOADS_DIR, 'avatars', path.basename(upload.body.avatar))));
});

test('public profile lookup hides unrelated accounts, honors privacy and rejects id suffixes', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET real_name = 'private name', contact_qq = 'private contact' WHERE id = 2").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  assert.equal((await f.request('GET', '/api/auth/user/2junk')).status, 404);
  f.db.prepare("INSERT INTO friends (user_id, friend_id, status) VALUES (1, 2, 'accepted')").run();
  const result = await f.request('GET', '/api/auth/user/2');
  assert.equal(result.status, 200);
  assert.equal(result.body.real_name, '');
  assert.equal(result.body.contact_qq, '');
});

test('avatar decoding rechecks token revocation before changing files or profile state', async t => {
  const ready = deferred(), release = deferred();
  const uploads = require('../lib/uploads');
  const f = await fixture(t, { async encoder(...args) {
    const image = await uploads.encodeValidatedImage(...args);
    ready.resolve(); await release.promise; return image;
  } });
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPw76v5DwAE4gJZBTIyWgAAAABJRU5ErkJggg==';
  const update = f.request('PUT', '/api/auth/avatar', { avatar });
  await waitFor(ready.promise);
  f.db.prepare('UPDATE users SET token_version = 1 WHERE id = 1').run();
  release.resolve();
  assert.equal((await update).status, 401);
  assert.equal(f.db.prepare('SELECT avatar FROM users WHERE id = 1').get().avatar, '');
  assert.equal(fs.readdirSync(path.join(f.paths.UPLOADS_DIR, 'avatars')).length, 0);
});

test('wall contexts reject explicit malformed and conflicting sources instead of parseInt prefixes', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO walls (id,name,owner_id) VALUES (1,'test wall',1)").run();
  f.db.prepare("INSERT INTO wall_members (wall_id,user_id,status) VALUES (1,1,'active')").run();
  const headers = { 'X-Wall-Id': '1' };
  assert.equal((await f.request('POST', '/wall-context?wall_id=1', { wall_id: 1 }, f.token(), headers)).status, 200);
  for (const [url, body, extra] of [
    ['/wall-context', {}, { 'X-Wall-Id': '1suffix' }], ['/wall-context?wall_id[]=1', {}, {}],
    ['/wall-context', { wall_id: [1] }, {}], ['/wall-context', { wall_id: true }, {}],
    ['/wall-context?wall_id=2', {}, headers], ['/wall-context', { wall_id: 2 }, headers],
    ['/wall-path/2', {}, headers], ['/wall-context', {}, {}],
  ]) assert.equal((await f.request('POST', url, body, f.token(), extra)).status, 400, url + JSON.stringify(body));
});

test('anonymous and deleted messages cannot become profile identity probes or bypass blocks and inactive walls', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO messages (sender_id,receiver_id,type,content,is_anonymous) VALUES (2,1,'confession','anonymous',1)").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  f.db.prepare("UPDATE messages SET type='tree_hole', is_anonymous=0").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  f.db.prepare("UPDATE messages SET type='private', receiver_deleted=1").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  f.db.prepare('UPDATE messages SET receiver_deleted=0').run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 200);
  f.db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (2,1,'blocked')").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  f.db.db.run("DELETE FROM friends; DELETE FROM messages; INSERT INTO walls (id,name,status) VALUES (1,'inactive wall','inactive'); INSERT INTO wall_members (wall_id,user_id,status) VALUES (1,1,'active'),(1,2,'active');");
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
  f.db.prepare("UPDATE walls SET status='active' WHERE id=1").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 200);
  f.db.prepare("UPDATE users SET status='banned' WHERE id=2").run();
  assert.equal((await f.request('GET', '/api/auth/user/2')).status, 404);
});

test('data export hides anonymous tree counterpart IDs, honors side deletion and revokes former volunteer access', async t => {
  const f = await fixture(t);
  f.db.db.run(`
    INSERT INTO walls (id,name,owner_id) VALUES (1,'tree wall',1);
    INSERT INTO wall_members (wall_id,user_id,status) VALUES (1,1,'active'),(1,2,'active');
    INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (2,1,'wall.tree_hole','grant');
    INSERT INTO messages (id,sender_id,receiver_id,wall_id,type,content,is_anonymous,conversation_id,assignee_id) VALUES
      (1,1,2,1,'tree_hole','initiator text',1,'tree_fixture',2),
      (2,2,1,1,'tree_hole','volunteer text',1,'tree_fixture',2),
      (3,2,1,1,'confession','anonymous confession',1,'',0);
    INSERT INTO messages (id,sender_id,receiver_id,type,content,sender_deleted,receiver_deleted) VALUES
      (4,1,2,'private','sender deleted',1,0), (5,2,1,'private','receiver deleted',0,1);
  `);
  const readExport = async token => {
    const result = await f.request('GET', '/api/auth/export', undefined, token);
    assert.equal(result.status, 200);
    return JSON.parse(zlib.gunzipSync(result.bytes));
  };
  const initiator = await readExport(f.token(1));
  assert.equal(initiator.messages_sent.find(message => message.id === 1).receiver_id, null);
  assert.equal(initiator.messages_received.find(message => message.id === 2).sender_id, null);
  assert.equal(initiator.messages_received.find(message => message.id === 3).sender_id, null);
  assert.equal(initiator.messages_sent.some(message => message.id === 4), false);
  assert.equal(initiator.messages_received.some(message => message.id === 5), false);
  assert.equal(JSON.stringify(initiator.messages_received).includes('assignee_id'), false);
  assert.equal(JSON.stringify(initiator.messages_sent).includes('conversation_id'), false);
  const volunteer = await readExport(f.token(2));
  assert.equal(volunteer.messages_sent.find(message => message.id === 2).receiver_id, null);
  f.db.prepare("UPDATE user_permissions SET effect='deny' WHERE user_id=2 AND perm='wall.tree_hole'").run();
  const revoked = await readExport(f.token(2));
  assert.equal(revoked.messages_sent.some(message => message.type === 'tree_hole'), false);
  assert.equal(revoked.messages_received.some(message => message.type === 'tree_hole'), false);
});

test('setup validates inputs and concurrent requests create exactly one initialized owner', async t => {
  const f = await fixture(t, { empty: true });
  for (const body of [{ username: 'admin', password: {}, wall_name: '校园墙' },
    { username: 'admin', password: 'secure-password', wall_name: {} },
    { username: 'admin', password: 'secure-password', wall_name: '校园墙', wall_description: [] }]) {
    assert.equal((await f.request('POST', '/api/setup', body)).status, 400);
  }
  const body = { username: 'admin', password: 'secure-password', wall_name: '校园墙' };
  const results = await Promise.all([f.request('POST', '/api/setup', body), f.request('POST', '/api/setup', { ...body, username: 'otheradmin' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM walls').get().c, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM wall_members').get().c, 1);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key = 'initialized'").get().value, '1');
  assert.equal(f.db.saves, 1);
  assert.equal(jwt.verify(results.find(r => r.status === 200).body.token, SECRET).role, 'super_admin');
});

test('setup settings-write and token-sign failures roll back all initialization records', async t => {
  for (const failure of ['settings', 'sign']) {
    const f = await fixture(t, { empty: true, signing: failure === 'sign' ? { ...jwt, sign() { throw new Error('injected sign failure'); } } : jwt });
    if (failure === 'settings') f.db.db.run("CREATE TRIGGER stop_initialized BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'injected settings failure'); END");
    assert.equal((await f.request('POST', '/api/setup', { username: 'admin', password: 'secure-password', wall_name: '校园墙' })).status, 500);
    for (const table of ['users', 'walls', 'wall_members', 'settings']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, 0, table);
    assert.equal(f.db.saves, 0);
  }
});

test('chat bans survive router mounting and case-insensitive Express paths', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET status = 'banned', ban_level = 'chat' WHERE id = 1").run();
  for (const url of ['/api/messages', '/api/messages/99', '/API/MESSAGES/99', '/api/friends', '/api/chat/room']) {
    const response = await f.request('POST', url, {});
    assert.equal(response.status, 403, url);
    assert.equal(response.body.code, 'BANNED');
  }
  assert.equal((await f.request('GET', '/api/auth/me')).status, 200);
});

test('global bans only allow valid-session appeals, bound reason size and rate-limit repeats', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET status = 'banned', ban_level = 'login' WHERE id = 1").run();
  assert.equal((await f.request('GET', '/api/auth/me')).status, 403);
  assert.equal((await f.request('PUT', '/api/auth/profile', { nickname: 'blocked' })).status, 403);
  assert.equal((await f.request('POST', '/api/auth/appeal', { reason: {} })).status, 400);
  assert.equal((await f.request('POST', '/api/auth/appeal', { reason: 'x'.repeat(1001) })).status, 400);
  assert.equal((await f.request('POST', '/api/auth/appeal', { reason: '请复核封禁' })).status, 200);
  assert.equal((await f.request('POST', '/api/auth/appeal', { reason: '请复核封禁' })).status, 429);
  assert.equal((await f.request('POST', '/api/auth/appeal', { reason: 'no session' }, 'invalid-token')).status, 401);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS c FROM ban_logs WHERE action = 'appeal'").get().c, 1);
});

test('a failed appeal notification rolls back its record so the same user can retry immediately', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET status = 'banned', ban_level = 'login' WHERE id = 1").run();
  f.db.prepare("UPDATE users SET role = 'super_admin' WHERE id = 2").run();
  f.db.db.run("CREATE TRIGGER stop_notification BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'notification failed'); END");
  const body = { reason: '请复核封禁' };
  assert.equal((await f.request('POST', '/api/auth/appeal', body)).status, 500);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS c FROM ban_logs WHERE action = 'appeal'").get().c, 0);
  f.db.db.run('DROP TRIGGER stop_notification');
  assert.equal((await f.request('POST', '/api/auth/appeal', body)).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE receiver_id = 2').get().c, 1);
});

test('middleware validates claims, token version, algorithms and current database roles', async t => {
  const f = await fixture(t);
  for (const token of [f.token('1'), f.token(1, { tv: '0' }), f.token(1, { aud: 'dashboard' }), f.token(1, {}, { algorithm: 'HS384' }),
    jwt.sign({ id: 1, tv: 0 }, SECRET), f.token(999)]) {
    assert.equal((await f.request('GET', '/api/auth/me', undefined, token)).status, 401);
  }
  const result = await f.request('GET', '/api/auth/me', undefined, f.token(1, { role: 'super_admin' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.role, 'user');
  f.db.prepare("UPDATE users SET status = 'disabled' WHERE id = 1").run();
  assert.equal((await f.request('GET', '/api/auth/me')).status, 403);
});

test('downstream synchronous errors are server errors, not mislabeled expired sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/downstream-error')).status, 500);
});

test('JWT secret creation is exclusive and fails closed on bad configuration or persistence failure', () => {
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  let written;
  const fakeFs = { mkdirSync() {}, readFileSync() { throw enoent(); }, chmodSync() {},
    writeFileSync(file, value, options) { written = { value, options }; } };
  const generated = loadModule('middleware/auth.js', { fs: fakeFs }, { env: {} });
  assert.equal(generated.SECRET, written.value);
  assert.equal(written.options.flag, 'wx');
  assert.equal(written.options.mode, 0o600);
  assert.throws(() => loadModule('middleware/auth.js', { fs: fakeFs }, { env: { JWT_SECRET: 'short' } }), /JWT_SECRET/);
  assert.throws(() => loadModule('middleware/auth.js', { fs: { ...fakeFs, writeFileSync() { throw new Error('disk full'); } } }, { env: {} }), /持久化/);
  let reads = 0;
  const existing = 'concurrent-writer-secret-value';
  const raced = loadModule('middleware/auth.js', { fs: { ...fakeFs,
    readFileSync() { if (++reads === 1) throw enoent(); return existing; },
    writeFileSync() { throw Object.assign(new Error('already exists'), { code: 'EEXIST' }); },
  } }, { env: {} });
  assert.equal(raced.SECRET, existing);
});

test('offline adduser refuses implicit/default credentials and only creates a new protected database copy', async t => {
  const f = await fixture(t);
  const { main } = require('../adduser');
  await assert.rejects(main([], {}));
  const source = path.join(f.temporary, 'source.db');
  const output = path.join(f.temporary, 'new.db');
  const before = Buffer.from(f.db.db.export());
  fs.writeFileSync(source, before);
  const args = ['--database', source, '--output', output, '--username', 'offlineuser'];
  await assert.rejects(main(args, {}));
  await main(args, { ADDUSER_PASSWORD: 'offline-secure-password' });
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const copy = wrap(new SQL.Database(fs.readFileSync(output)));
  try {
    const row = copy.prepare("SELECT role, password_hash FROM users WHERE username = 'offlineuser'").get();
    assert.equal(row.role, 'user');
    assert.equal((await passwordLib.verifyPassword('offline-secure-password', row.password_hash)).ok, true);
    assert.equal(copy.prepare("SELECT COUNT(*) AS c FROM users WHERE username IN ('zhangsan', 'wangwu')").get().c, 0);
  } finally { copy.db.close(); }
  await assert.rejects(main(args, { ADDUSER_PASSWORD: 'offline-secure-password' }), /覆盖/);
});
