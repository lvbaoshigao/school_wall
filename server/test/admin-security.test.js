'use strict';

// Real SQL/HTTP regression tests. Every file and database stays in a unique OS temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-admin-security-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'admin-security-isolated-test-secret-2026';
process.env.ADMIN_IP_WHITELIST = '';
const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { SECRET } = require('../middleware/auth');
const { effectivePerms, loadOverrides } = require('../lib/permissions');
const dbops = require('../routes/dbops');

test('admin security regression suite with isolated SQL database', async t => {
  const db = await initDB();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/admin/db', dbops.apiRouter);
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/permissions', require('../routes/permissions'));
  app.use('/api/walls', require('../routes/wallAdmin'));
  app.use(require('../dashboard'));
  app.use((err, req, res, next) => { res.status(500).json({ error: 'isolated-test-error' }); });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = (id, extras = {}) => jwt.sign({ id, tv: 0, ...extras }, SECRET, { algorithm: 'HS256', expiresIn: '10m' });
  async function request(url, { id = 1, method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = { ...(id ? { Authorization: 'Bearer ' + token(id) } : {}), ...headers };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined) { outgoing['Content-Type'] = 'application/json'; outgoing['Content-Length'] = Buffer.byteLength(payload); }
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: outgoing }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', part => { text += part; });
        res.on('end', () => {
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  function grant(userId, perm, wallId = 0, effect = 'grant') {
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,wall_id,perm,effect,operator_id) VALUES (?,?,?,?,1)').run(userId, wallId, perm, effect);
  }
  function seed() {
    db.pragma('foreign_keys = OFF');
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      db.exec('DELETE FROM "' + name.replace(/"/g, '""') + '"');
    }
    db.pragma('foreign_keys = ON');
    for (const [id, role] of [[1, 'super_admin'], [2, 'admin'], [3, 'admin'], [4, 'user'], [5, 'user'], [6, 'user']]) {
      db.prepare("INSERT INTO users (id,username,password_hash,nickname,real_name,show_real_name,role,status) VALUES (?,?,'test-only',?, 'private-real-name-marker',0,?,'active')").run(id, 'account-' + id, 'nickname-' + id, role);
    }
    for (const id of [1, 2]) db.prepare("INSERT INTO walls (id,name,owner_id,status) VALUES (?,?,1,'active')").run(id, 'test-wall-' + id);
    for (const userId of [1, 2, 3, 4, 5, 6]) db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,'member','active')").run(userId);
    for (const id of [1, 2]) db.prepare("INSERT INTO posts (id,wall_id,content,author_id,author_ip) VALUES (?,?,'private-post-marker',4,'127.0.0.1')").run(id, id);
  }
  const report = target => db.prepare("INSERT INTO user_reports (id,reporter_id,reported_user_id,reason,status) VALUES (1,6,?,'test','pending')").run(target);
  async function check(name, fn) { await t.test(name, async () => { seed(); await fn(); }); }
  try {
    await check('ordinary users cannot enter global moderation', async () => {
      assert.equal((await request('/api/admin/stats', { id: 4 })).status, 403);
    });
    await check('user listing permission cannot demote another administrator', async () => {
      grant(5, 'global.user.manage');
      const res = await request('/api/admin/users/3/role', { id: 5, method: 'PUT', body: { role: 'user' } });
      assert.equal(res.status, 403);
      assert.equal(db.prepare('SELECT role FROM users WHERE id=3').get().role, 'admin');
    });
    await check('authorized role managers can change a non-root role', async () => {
      assert.equal((await request('/api/admin/users/3/role', { method: 'PUT', body: { role: 'user' } })).status, 200);
      assert.equal(db.prepare('SELECT role FROM users WHERE id=3').get().role, 'user');
    });
    await check('report handling alone cannot ban users', async () => {
      grant(5, 'global.report.handle'); report(4);
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 5, method: 'PUT', body: { action: 'permanent_ban' } })).status, 403);
      assert.equal(db.prepare('SELECT status FROM users WHERE id=4').get().status, 'active');
      assert.equal(db.prepare('SELECT status FROM user_reports WHERE id=1').get().status, 'pending');
    });
    await check('reports cannot bypass super administrator ban protection', async () => {
      report(1);
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 2, method: 'PUT', body: { action: 'ban' } })).status, 403);
      assert.equal(db.prepare('SELECT status FROM users WHERE id=1').get().status, 'active');
    });
    await check('reports cannot bypass peer administrator ban protection', async () => {
      report(3);
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 2, method: 'PUT', body: { action: 'ban' } })).status, 403);
    });
    await check('reports cannot be used to ban oneself', async () => {
      report(2);
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 2, method: 'PUT', body: { action: 'ban' } })).status, 403);
    });
    await check('authorized report bans remain functional and reset stale ban levels', async () => {
      report(4); db.prepare("UPDATE users SET ban_level='chat' WHERE id=4").run();
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 2, method: 'PUT', body: { action: 'ban', duration: 60 } })).status, 200);
      const target = db.prepare('SELECT status,ban_level FROM users WHERE id=4').get();
      assert.deepEqual(target, { status: 'banned', ban_level: 'login' });
    });
    await check('administrative deletion removes related private rows and updates surviving counters', async () => {
      grant(4, 'global.dashboard');
      db.prepare("INSERT INTO user_prefs (user_id,pref_key,pref_value) VALUES (4,'test','private')").run();
      db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (1,'other author',6,'127.0.0.1')").run();
      db.prepare('INSERT INTO likes (post_id,user_id) VALUES (1,6)').run();
      db.prepare('INSERT INTO bookmarks (post_id,user_id) VALUES (1,6)').run();
      db.prepare("INSERT INTO posts (id,wall_id,content,author_id,author_ip,like_count,comment_count) VALUES (3,1,'surviving',6,'127.0.0.1',1,1)").run();
      db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (3,'deleted author',4,'127.0.0.1')").run();
      db.prepare('INSERT INTO likes (post_id,user_id) VALUES (3,4)').run();
      assert.equal((await request('/api/admin/users/4', { method: 'DELETE' })).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE id=4').get().c, 0);
      for (const table of ['user_prefs', 'user_permissions', 'comments', 'likes', 'bookmarks']) assert.equal(db.prepare('SELECT COUNT(*) c FROM ' + table).get().c, 0);
      assert.deepEqual(db.prepare('SELECT like_count,comment_count FROM posts WHERE id=3').get(), { like_count: 0, comment_count: 0 });
    });
    await check('administrative deletion rolls back earlier changes after SQL failure', async () => {
      grant(4, 'global.dashboard');
      db.exec("CREATE TRIGGER admin_test_delete_failure BEFORE DELETE ON users WHEN OLD.id=4 BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/admin/users/4', { method: 'DELETE' })).status, 500);
        assert.ok(db.prepare('SELECT id FROM users WHERE id=4').get());
        assert.equal(db.prepare('SELECT COUNT(*) c FROM posts WHERE author_id=4').get().c, 2);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM user_permissions WHERE user_id=4').get().c, 1);
      } finally { db.exec('DROP TRIGGER admin_test_delete_failure'); }
    });
    await check('unpublished real names cannot be inferred from administrative search results', async () => {
      const res = await request('/api/admin/users?q=private-real-name-marker');
      assert.equal(res.status, 200); assert.equal(res.json.total, 0);
    });
    await check('strict path and pagination validation rejects coercion', async () => {
      for (const url of ['/api/admin/users/3abc/role', '/api/admin/users/-1/role']) assert.equal((await request(url, { method: 'PUT', body: { role: 'user' } })).status, 400);
      for (const query of ['limit=-1', 'limit=abc', 'limit[]=10']) assert.equal((await request('/api/admin/users?' + query)).status, 400);
      assert.equal((await request('/api/admin/users/4/ban', { method: 'PUT', body: { banned: 'false' } })).status, 400);
    });
    await check('post report permission cannot substitute for delete permission', async () => {
      grant(5, 'wall.post.report', 1);
      db.prepare("INSERT INTO post_reports (id,wall_id,post_id,reporter_id,reason) VALUES (1,1,1,6,'test')").run();
      assert.equal((await request('/api/admin/wall/post-reports/1/review', { id: 5, method: 'PUT', headers: { 'X-Wall-Id': '1' }, body: { action: 'delete_post' } })).status, 403);
      assert.ok(db.prepare('SELECT id FROM posts WHERE id=1').get());
    });
    await check('post report deletion verifies the referenced post belongs to that wall', async () => {
      db.prepare("INSERT INTO post_reports (id,wall_id,post_id,reporter_id,reason) VALUES (1,1,2,6,'test')").run();
      assert.equal((await request('/api/admin/wall/post-reports/1/review', { method: 'PUT', headers: { 'X-Wall-Id': '1' }, body: { action: 'delete_post' } })).status, 404);
      assert.ok(db.prepare('SELECT id FROM posts WHERE id=2').get());
    });
    await check('administrative post deletion rolls back comments and bookmarks after failure', async () => {
      db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (1,'test',6,'127.0.0.1')").run();
      db.prepare('INSERT INTO bookmarks (post_id,user_id) VALUES (1,6)').run();
      db.exec("CREATE TRIGGER admin_test_post_failure BEFORE DELETE ON posts WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/admin/posts/1', { id: 2, method: 'DELETE' })).status, 500);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id=1').get().c, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM bookmarks WHERE post_id=1').get().c, 1);
      } finally { db.exec('DROP TRIGGER admin_test_post_failure'); }
      assert.equal((await request('/api/admin/posts/1', { id: 2, method: 'DELETE' })).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM bookmarks WHERE post_id=1').get().c, 0);
    });
    await check('last active root protection ignores unavailable root accounts', async () => {
      db.prepare("UPDATE users SET role='super_admin',status='banned' WHERE id=3").run();
      assert.equal((await request('/api/admin/users/1/assign-role', { method: 'PUT', body: { role: 'user' } })).status, 400);
      assert.equal(db.prepare('SELECT role FROM users WHERE id=1').get().role, 'super_admin');
    });
    await check('delegated permission managers cannot grant capabilities they do not hold', async () => {
      grant(5, 'global.permission.manage');
      const res = await request('/api/permissions/user/5', { id: 5, method: 'PUT', body: { wall_id: 0, changes: { 'global.db.manage': 'grant', 'global.user.role': 'grant' } } });
      assert.equal(res.status, 200); assert.equal(res.json.applied.length, 0); assert.equal(res.json.rejected.length, 2);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM user_permissions WHERE user_id=5 AND perm='global.db.manage'").get().c, 0);
    });
    await check('delegates cannot edit root permissions and malformed scopes never fall back to global', async () => {
      grant(5, 'global.permission.manage');
      assert.equal((await request('/api/permissions/user/1', { id: 5, method: 'PUT', body: { changes: { 'global.moderate': 'deny' } } })).status, 403);
      for (const wall_id of [-1, 'garbage', '1x', null, []]) assert.equal((await request('/api/permissions/user/4', { method: 'PUT', body: { wall_id, changes: { 'wall.edit': 'grant' } } })).status, 400);
    });
    await check('legitimate permission delegation is retained', async () => {
      grant(5, 'global.permission.manage'); grant(5, 'wall.post.delete', 1);
      const res = await request('/api/permissions/user/4', { id: 5, method: 'PUT', body: { wall_id: 1, changes: { 'wall.post.delete': 'grant' } } });
      assert.equal(res.status, 200); assert.deepEqual(res.json.applied, ['wall.post.delete']);
    });
    await check('permission resolution rejects malformed override scopes and fails closed on lookup errors', async () => {
      const perms = effectivePerms({ globalRole: 'user', wallRole: 'member', wallId: 1, overrides: [{ wall_id: 1, perm: 'global.db.manage', effect: 'grant' }, { wall_id: 0, perm: 'unknown', effect: 'grant' }] });
      assert.equal(perms.size, 0);
      assert.equal(effectivePerms({ globalRole: 'constructor', wallRole: 'toString', wallId: 1 }).size, 0);
      assert.throws(() => loadOverrides({ prepare() { throw new Error('unavailable'); } }, 1), /unavailable/);
    });
    await check('permission writes roll back earlier changes on SQL failure', async () => {
      db.exec("CREATE TRIGGER admin_test_perm_failure BEFORE INSERT ON user_permissions WHEN NEW.perm='global.user.ban' BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/permissions/user/4', { method: 'PUT', body: { changes: { 'global.moderate': 'grant', 'global.user.ban': 'grant' } } })).status, 500);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM user_permissions WHERE user_id=4').get().c, 0);
      } finally { db.exec('DROP TRIGGER admin_test_perm_failure'); }
    });
    await check('wall approval rejects unavailable applicants and validates path ids', async () => {
      db.prepare("INSERT INTO wall_applications (id,applicant_id,wall_name) VALUES (1,4,'request-wall')").run();
      db.prepare("UPDATE users SET status='banned' WHERE id=4").run();
      assert.equal((await request('/api/walls/admin/applications/1/review', { method: 'PUT', body: { action: 'approve' } })).status, 400);
      assert.equal((await request('/api/walls/admin/1x/status', { method: 'PUT', body: { status: 'disabled' } })).status, 400);
    });
    await check('wall approval is atomic when membership creation fails', async () => {
      db.prepare("INSERT INTO wall_applications (id,applicant_id,wall_name) VALUES (1,4,'request-wall')").run();
      db.exec("CREATE TRIGGER admin_test_wall_failure BEFORE INSERT ON wall_members BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/walls/admin/applications/1/review', { method: 'PUT', body: { action: 'approve' } })).status, 500);
        assert.equal(db.prepare("SELECT COUNT(*) c FROM walls WHERE name='request-wall'").get().c, 0);
        assert.equal(db.prepare('SELECT status FROM wall_applications WHERE id=1').get().status, 'pending');
      } finally { db.exec('DROP TRIGGER admin_test_wall_failure'); }
    });
    await check('backup APIs require database privilege and create distinct private files in DATA_DIR', async () => {
      assert.equal((await request('/api/admin/db/backup', { id: 2, method: 'POST', body: {} })).status, 403);
      const a = await request('/api/admin/db/backup', { method: 'POST', body: {} });
      const b = await request('/api/admin/db/backup', { method: 'POST', body: {} });
      assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.json.file, b.json.file);
      const file = path.join(dataDir, 'backups', a.json.file);
      assert.ok(fs.existsSync(file)); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });
    await check('backup list and download reject symlinks', async () => {
      const name = 'backup-20261119-000000.db';
      const symlink = path.join(dataDir, 'backups', name);
      fs.symlinkSync(path.join(dataDir, 'data.db'), symlink);
      try {
        const list = await request('/api/admin/db/backups');
        assert.equal(list.json.backups.some(b => b.name === name), false);
        assert.equal((await request('/api/admin/db/backups/' + name + '/download')).status, 404);
      } finally { fs.unlinkSync(symlink); }
    });
    await check('whitelist protection rejects empty enabled lists while off remains allowed', async () => {
      for (const mode of ['admin', 'all']) {
        assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode, entries: [] } })).status, 400);
      }
      assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key IN ('ip_whitelist_mode','admin_ip_whitelist')").get().c, 0);
      assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode: 'off', entries: [] } })).status, 200);
    });
    await check('whitelist empty config can rely on environment entries containing the current IP', async () => {
      process.env.ADMIN_IP_WHITELIST = '127.0.0.1,::1';
      try {
        for (const mode of ['admin', 'all']) assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode, entries: [] } })).status, 200);
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='admin_ip_whitelist'").get().value, '[]');
      } finally { process.env.ADMIN_IP_WHITELIST = ''; }
    });
    await check('whitelist enabled modes reject lists that exclude the current IP', async () => {
      for (const mode of ['admin', 'all']) assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode, entries: ['192.0.2.1'] } })).status, 400);
      process.env.ADMIN_IP_WHITELIST = '192.0.2.1';
      try {
        assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode: 'admin', entries: [] } })).status, 400);
      } finally { process.env.ADMIN_IP_WHITELIST = ''; }
    });
    await check('whitelist settings save atomically when the second write fails', async () => {
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('ip_whitelist_mode', 'off');
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('admin_ip_whitelist', '["192.0.2.1"]');
      db.exec("CREATE TRIGGER admin_test_whitelist_failure BEFORE INSERT ON settings WHEN NEW.key='admin_ip_whitelist' BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/admin/db/whitelist', { method: 'PUT', body: { mode: 'all', entries: ['127.0.0.1'] } })).status, 500);
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='ip_whitelist_mode'").get().value, 'off');
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='admin_ip_whitelist'").get().value, '["192.0.2.1"]');
      } finally { db.exec('DROP TRIGGER admin_test_whitelist_failure'); }
    });
    await check('database wipe rolls back table deletes on error', async () => {
      db.exec("CREATE TRIGGER admin_test_wipe_failure BEFORE DELETE ON posts BEGIN SELECT RAISE(ABORT,'test'); END");
      try { assert.throws(() => dbops.wipeNow(db), /test/); assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 6); }
      finally { db.exec('DROP TRIGGER admin_test_wipe_failure'); }
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    });
    await check('wipe safely quotes unusual SQLite table identifiers', async () => {
      db.exec('CREATE TABLE "admin-test-quote""table" (id INTEGER)');
      db.exec('INSERT INTO "admin-test-quote""table" VALUES (1)');
      try { dbops.wipeNow(db); assert.equal(db.prepare('SELECT COUNT(*) c FROM "admin-test-quote""table"').get().c, 0); }
      finally { db.exec('DROP TABLE "admin-test-quote""table"'); }
    });
    await check('wipe codes enforce cooldown, same session, expiry and attempt limits', async () => {
      const authorization = 'Bearer ' + token(1, { jti: 'admin-test-original' });
      const headers = { Authorization: authorization };
      const prepared = await request('/api/admin/db/wipe/prepare', { method: 'POST', headers, body: {} });
      assert.equal(prepared.status, 200);
      const code = prepared.json.code;
      assert.equal((await request('/api/admin/db/wipe/execute', { method: 'POST', headers, body: { code } })).status, 425);
      const now = Date.now;
      const base = now();
      Date.now = () => base + 11000;
      try {
        const otherHeaders = { Authorization: 'Bearer ' + token(1, { jti: 'admin-test-other' }) };
        assert.equal((await request('/api/admin/db/wipe/execute', { method: 'POST', headers: otherHeaders, body: { code } })).status, 403);
        const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
        for (let i = 0; i < 5; i++) assert.equal((await request('/api/admin/db/wipe/execute', { method: 'POST', headers, body: { code: wrong } })).status, 400);
        assert.match((await request('/api/admin/db/wipe/execute', { method: 'POST', headers, body: { code } })).json.error, /先生成/);
        const preparedAgain = await request('/api/admin/db/wipe/prepare', { method: 'POST', headers, body: {} });
        Date.now = () => base + 312000;
        assert.match((await request('/api/admin/db/wipe/execute', { method: 'POST', headers, body: { code: preparedAgain.json.code } })).json.error, /过期/);
      } finally { Date.now = now; }
      assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 6);
    });
    await check('wipe aborts before deletion when automatic backup fails', async () => {
      const headers = { Authorization: 'Bearer ' + token(1, { jti: 'admin-test-backup-failure' }) };
      const prepared = await request('/api/admin/db/wipe/prepare', { method: 'POST', headers, body: {} });
      const now = Date.now; const base = now();
      const originalExport = db.exportBytes;
      db.exportBytes = () => { throw new Error('isolated export failure'); };
      Date.now = () => base + 11000;
      try {
        assert.equal((await request('/api/admin/db/wipe/execute', { method: 'POST', headers, body: { code: prepared.json.code } })).status, 500);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 6);
      } finally { Date.now = now; db.exportBytes = originalExport; }
    });
    await check('dashboard renders safe data attributes and a compilable nonce script', async () => {
      const attackName = "x');pwned=1;//"; // Within the registration route's 20-character limit.
      db.prepare('UPDATE users SET username=?,nickname=? WHERE id=4').run(attackName, '<svg onload=alert(1)>');
      const session = await request('/api/dashboard/session', { method: 'POST', body: {} });
      assert.equal(session.status, 200);
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      const res = await request('/dashboard', { id: 0, headers: { Cookie: cookie } });
      assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], 'no-store');
      assert.match(res.headers['content-security-policy'], /script-src-attr 'none'/);
      const eventAttributes = [];
      for (const tag of res.text.match(/<[a-z][^<>]*>/gi) || []) {
        for (const attribute of tag.matchAll(/\s([^\s=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) {
          if (/^on[a-z]+$/i.test(attribute[1])) eventAttributes.push(attribute[1]);
        }
      }
      assert.deepEqual(eventAttributes, []);
      assert.doesNotMatch(res.text, /<svg/i);
      assert.doesNotMatch(res.text, /private-real-name-marker/);
      assert.match(res.text, /data-username="x&#39;/);
      const scripts = [...res.text.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
      assert.equal(scripts.length, 1);
      assert.ok(res.headers['content-security-policy'].includes("'nonce-" + scripts[0][1] + "'"));
      assert.doesNotThrow(() => new vm.Script(scripts[0][2]));
      const elements = new Map();
      const handlers = {};
      const doc = { activeElement: null, addEventListener(name, handler) { handlers[name] = handler; }, getElementById(id) {
        if (!elements.has(id)) {
          const classes = new Set();
          elements.set(id, { value: '', textContent: '', dataset: {}, style: {}, addEventListener() {}, focus() { doc.activeElement = this; },
            classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } });
        }
        return elements.get(id);
      } };
      const context = { document: doc, pwned: 0, fetch: async () => ({ ok: true, json: async () => ({ token: 'isolated' }) }), setTimeout() {} };
      vm.runInNewContext(scripts[0][2].replace('const CAN_DB=true;', 'const CAN_DB=false;'), context);
      handlers.click({ target: { closest: () => ({ dataset: { action: 'showSettings', id: '4', username: attackName, role: 'user', status: 'active' } }) } });
      assert.equal(context.pwned, 0);
      assert.equal(doc.getElementById('modal-username').textContent, attackName);
      assert.equal(doc.getElementById('settingsModal').classList.contains('active'), true);
      handlers.keydown({ key: 'Escape', target: { dataset: {} }, preventDefault() {} });
      assert.equal(doc.getElementById('settingsModal').classList.contains('active'), false);
    });
    await check('dashboard-only delegates cannot retrieve user or post details', async () => {
      grant(5, 'global.dashboard');
      const session = await request('/api/dashboard/session', { id: 5, method: 'POST', body: {} });
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      const page = await request('/dashboard', { id: 0, headers: { Cookie: cookie } });
      assert.equal(page.status, 200); assert.doesNotMatch(page.text, /private-post-marker|nickname-4|private-real-name-marker/);
      assert.equal((await request('/dashboard/api/db/status', { id: 0, headers: { Cookie: cookie } })).status, 403);
    });
    await check('dashboard token and dangerous APIs require session CSRF proof and same origin', async () => {
      const session = await request('/api/dashboard/session', { method: 'POST', body: {} });
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      const payload = jwt.decode(cookie.slice('sw_dash='.length));
      assert.equal((await request('/dashboard/api/token', { id: 0, method: 'POST', headers: { Cookie: cookie } })).status, 403);
      assert.equal((await request('/dashboard/api/db/backup', { id: 0, method: 'POST', headers: { Cookie: cookie }, body: {} })).status, 403);
      assert.equal((await request('/dashboard/api/token', { id: 0, method: 'POST', headers: { Cookie: cookie, 'X-Dashboard-CSRF': payload.csrf, Origin: 'https://attacker.example' } })).status, 403);
      const converted = await request('/dashboard/api/token', { id: 0, method: 'POST', headers: { Cookie: cookie, 'X-Dashboard-CSRF': payload.csrf } });
      assert.equal(converted.status, 200);
      assert.equal((await request('/api/admin/stats', { id: 0, headers: { Authorization: 'Bearer ' + converted.json.token } })).status, 200);
    });
    await check('dashboard tickets revoke immediately after password version or account status changes', async () => {
      const session = await request('/api/dashboard/session', { id: 2, method: 'POST', body: {} });
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      db.prepare('UPDATE users SET token_version=1 WHERE id=2').run();
      assert.equal((await request('/dashboard', { id: 0, headers: { Cookie: cookie } })).status, 401);
      db.prepare("UPDATE users SET token_version=0,status='banned' WHERE id=2").run();
      assert.equal((await request('/dashboard', { id: 0, headers: { Cookie: cookie } })).status, 403);
    });
    await check('wall announcement reads cannot delete expired data in another wall', async () => {
      grant(5, 'wall.announcement', 1);
      db.prepare("INSERT INTO announcements (id,wall_id,title,content,author_id,delete_at,scope) VALUES (1,2,'expired','test',1,'2000-01-01T00:00:00Z','wall')").run();
      db.prepare("INSERT INTO announcements (id,wall_id,title,content,author_id,delete_at,scope) VALUES (2,1,'expired local','test',1,'2000-01-01T00:00:00Z','wall')").run();
      const res = await request('/api/admin/wall/announcements', { id: 5, headers: { 'X-Wall-Id': '1' } });
      assert.equal(res.status, 200); assert.deepEqual(res.json, []);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM announcements').get().c, 2);
    });
    await check('announcement and delivery notifications roll back together', async () => {
      db.exec("CREATE TRIGGER admin_test_announcement_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test'); END");
      try {
        assert.equal((await request('/api/admin/announcements', { method: 'POST', body: { title: 'test', content: 'test' } })).status, 500);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM announcements').get().c, 0);
      } finally { db.exec('DROP TRIGGER admin_test_announcement_failure'); }
    });
    await check('report rejection records a rejected status', async () => {
      report(4);
      assert.equal((await request('/api/admin/user-reports/1/review', { id: 2, method: 'PUT', body: { action: 'reject' } })).status, 200);
      assert.equal(db.prepare('SELECT status FROM user_reports WHERE id=1').get().status, 'rejected');
    });
    await check('global announcement management used by dashboard works without wall context', async () => {
      const res = await request('/api/admin/announcements', { method: 'POST', body: { title: 'Test only', content: 'Isolated regression content' } });
      assert.equal(res.status, 200);
      assert.deepEqual(db.prepare('SELECT wall_id,scope FROM announcements WHERE id=?').get(res.json.id), { wall_id: 0, scope: 'global' });
      assert.equal((await request('/api/admin/announcements/' + res.json.id, { method: 'DELETE' })).status, 200);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.dirty = false;
    db.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
