'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// These tests only create synthetic data in a disposable directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-security-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'security-regressions-secret-never-use-in-production';
delete process.env.KEEP_DB;
delete process.env.ADMIN_IP_WHITELIST;

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { initDB } = require('../db');
const { whitelistGuard } = require('../lib/ipguard');
const { apiV1Middleware } = require('../lib/apiV1');
const { UPLOADS_DIR } = require('../lib/paths');
const { privateUploadGuard, signImageUrl, signPrivateImages, verifyImageTicket } = require('../lib/uploads');

let db;
let server;
let baseUrl;
let sequence = 0;
let png;
const dirs = Object.fromEntries([['AVATAR_DIR', 'avatars'], ['IMAGE_DIR', 'images'], ['BUG_REPORT_IMAGE_DIR', 'bug-reports']]
  .map(([name, directory]) => [name, path.join(UPLOADS_DIR, directory)]));

function user(role = 'user') {
  const username = 'security-user-' + (++sequence);
  const id = db.prepare("INSERT INTO users (username,password_hash,nickname,role,status) VALUES (?,'unused',?,?,'active')")
    .run(username, username, role).lastInsertRowid;
  return { id, token: jwt.sign({ id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' }) };
}

function wall(owner) {
  const id = db.prepare("INSERT INTO walls (name,owner_id,status) VALUES (?,?,'active')")
    .run('security-wall-' + (++sequence), owner.id).lastInsertRowid;
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'owner','active')").run(id, owner.id);
  return id;
}

function member(wallId, account) {
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'member','active')").run(wallId, account.id);
}

async function request(route, { account, wallId, method = 'GET', body, headers = {} } = {}) {
  if (account) headers.authorization = 'Bearer ' + account.token;
  if (wallId) headers['x-wall-id'] = String(wallId);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const json = bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : null;
  return { status: response.status, body: json, bytes, headers: response.headers };
}

async function withWhitelist(run, { mode = 'admin', entries = ['192.0.2.10'], env = '' } = {}) {
  const keys = ['ip_whitelist_mode', 'admin_ip_whitelist'];
  const previous = keys.map(key => db.prepare('SELECT value FROM settings WHERE key=?').get(key));
  const previousEnv = process.env.ADMIN_IP_WHITELIST;
  process.env.ADMIN_IP_WHITELIST = env;
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(keys[0], mode);
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(keys[1], JSON.stringify(entries));
  try { await run(); } finally {
    keys.forEach((key, index) => {
      if (previous[index]) db.prepare('UPDATE settings SET value=? WHERE key=?').run(previous[index].value, key);
      else db.prepare('DELETE FROM settings WHERE key=?').run(key);
    });
    if (previousEnv === undefined) delete process.env.ADMIN_IP_WHITELIST;
    else process.env.ADMIN_IP_WHITELIST = previousEnv;
  }
}

function guardedStatus(method, pathname, ip = '198.51.100.25') {
  let status = 200;
  const res = { setHeader() {}, status(code) { status = code; return this; }, json() {}, send() {} };
  whitelistGuard({ method, path: pathname, ip, db }, res, () => {});
  return status;
}

function imageFixture(directory, filename) {
  fs.writeFileSync(path.join(UPLOADS_DIR, directory, filename), png, { flag: 'wx' });
  return '/uploads/' + directory + '/' + filename;
}

function reportFixture(reporter, wallId, image, anonymous = true) {
  const code = 'RPT-SECURITY-' + (++sequence);
  const id = db.prepare('INSERT INTO reports (wall_id,tracking_code,reporter_id,report_types,content,images,is_anonymous) VALUES (?,?,?,?,?,?,?)')
    .run(wallId, code, reporter.id, '校园霸凌行为', 'synthetic evidence', JSON.stringify([image]), anonymous ? 1 : 0).lastInsertRowid;
  return { id, code };
}

before(async () => {
  db = await initDB({ deferInitialSave: true });
  db.pragma('foreign_keys = ON');
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const app = express();
  app.use(apiV1Middleware());
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(whitelistGuard);
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/walls', require('../routes/walls'));
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/votes', require('../routes/votes'));
  app.use('/api/reports', require('../routes/reports'));
  app.use('/api/bug-reports', require('../routes/bugReports'));
  app.use('/api/posts', require('../routes/posts'));
  app.use('/api', require('../routes/uploads')((req, res, next) => next(), dirs));
  app.use('/uploads', privateUploadGuard, express.static(UPLOADS_DIR, {
    setHeaders(res) { if (res.locals.privateUpload) res.setHeader('Cache-Control', 'private, no-store'); },
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: 'synthetic test error' }));
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
  assert.ok(path.basename(dataDir).startsWith('school-wall-security-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('anonymous safety-report attachments do not disclose reporter IDs or original filenames', async () => {
  const owner = user();
  const reporter = user();
  const wallId = wall(owner);
  member(wallId, reporter);
  const filename = 'bug_' + reporter.id + '_1700000000000_' + 'a'.repeat(32) + '.png';
  const original = imageFixture('bug-reports', filename);
  const report = reportFixture(reporter, wallId, original);

  const listed = await request('/api/reports', { account: owner, wallId });
  assert.equal(listed.status, 200);
  const item = listed.body.reports.find(row => row.id === report.id);
  assert.equal(item.reporter_name, null);
  assert.equal(item.reporter_username, null);
  assert.equal(item.reporter_id, undefined);
  const [url] = JSON.parse(item.images);
  assert.equal(new URL(url, baseUrl).pathname, '/uploads/bug-reports/private-image');
  assert.ok(!url.includes(filename), 'the original owner-bearing filename must stay server-side');
  const ticket = new URL(url, baseUrl).searchParams.get('ticket');
  assert.match(ticket, /^v2\./);
  const parts = ticket.split('.');
  for (const part of parts) assert.ok(!Buffer.from(part, 'base64url').includes(Buffer.from(original)));
  const fetched = await request(url);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.bytes, png);
  assert.match(fetched.headers.get('cache-control'), /no-store/);
  assert.equal(fetched.headers.get('referrer-policy'), 'no-referrer');

  const tracked = await request('/api/reports/track/' + report.code, { account: owner });
  assert.equal(tracked.status, 200);
  assert.ok(!JSON.stringify(tracked.body).includes(filename));
  assert.equal((await request(original)).status, 404);
  const [secondUrl] = JSON.parse(signPrivateImages(JSON.stringify([original]), { db, user: owner }));
  assert.notEqual(secondUrl, url, 'random IVs prevent stable identity links between reads');
  assert.equal(secondUrl.length, url.length);
  const longerPath = original.replace('.png', '-with-a-longer-filename.png');
  const [longerUrl] = JSON.parse(signPrivateImages(JSON.stringify([longerPath]), { db, user: owner }));
  assert.equal(longerUrl.length, url.length, 'ciphertext length must not encode original filename length');
});

test('historical bug-report screenshots in images remain private while public post images still work', async () => {
  const reporter = user();
  const outsider = user();
  const admin = user('admin');
  const image = imageFixture('images', 'legacy-bug-' + (++sequence) + '.png');
  const publicImage = imageFixture('images', 'public-post-' + (++sequence) + '.png');
  db.prepare('INSERT INTO bug_reports (reporter_id,title,content,images) VALUES (?,?,?,?)')
    .run(reporter.id, 'synthetic bug', 'synthetic details', JSON.stringify([image]));
  assert.equal((await request(image)).status, 404);
  assert.equal((await request(publicImage)).status, 200);
  assert.equal((await request(signImageUrl(image, { db, user: outsider }))).status, 404);
  const own = await request('/api/bug-reports', { account: reporter });
  const [ownUrl] = JSON.parse(own.body[0].images);
  assert.equal((await request(ownUrl)).status, 200);
  const listed = await request('/api/bug-reports/admin', { account: admin });
  const [adminUrl] = JSON.parse(listed.body.find(row => row.reporter_id === reporter.id).images);
  assert.equal((await request(adminUrl)).status, 200);
});

test('private attachment capabilities reject tampering, expiry, cross-wall access and revoked authority', async () => {
  const owner = user();
  const reporter = user();
  const foreignOwner = user();
  const peer = user();
  const wallId = wall(owner);
  wall(foreignOwner);
  member(wallId, peer);
  member(wallId, reporter);
  const original = imageFixture('bug-reports', 'bug_' + reporter.id + '_' + (++sequence) + '.png');
  reportFixture(reporter, wallId, original);
  const signed = () => JSON.parse(signPrivateImages(JSON.stringify([original]), { db, user: owner }))[0];
  const url = signed();
  assert.equal((await request(url)).status, 200);
  const ticket = new URL(url, baseUrl).searchParams.get('ticket');
  assert.equal(verifyImageTicket(ticket, original, db), true);
  assert.equal(verifyImageTicket(ticket, original + '.other', db), false);
  const tampered = url.slice(0, -8) + (url.at(-8) === 'a' ? 'b' : 'a') + url.slice(-7);
  assert.equal((await request(tampered)).status, 404);
  const foreign = JSON.parse(signPrivateImages(JSON.stringify([original]), { db, user: foreignOwner }))[0];
  assert.equal((await request(foreign)).status, 404);
  const unrelated = JSON.parse(signPrivateImages(JSON.stringify([original]), { db, user: peer }))[0];
  assert.equal((await request(unrelated)).status, 404);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (?,?,'wall.safety.report','deny')").run(owner.id, wallId);
  assert.equal((await request(url)).status, 404);
  db.prepare('DELETE FROM user_permissions WHERE user_id=?').run(owner.id);
  db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(owner.id);
  assert.equal((await request(url)).status, 404);
  const current = signed();
  assert.equal((await request(current)).status, 200);
  const now = Date.now;
  try {
    Date.now = () => now() + 301000;
    assert.equal(verifyImageTicket(new URL(current, baseUrl).searchParams.get('ticket'), original, db), false);
  } finally { Date.now = now; }
  db.prepare("UPDATE users SET status='banned' WHERE id=?").run(owner.id);
  assert.equal((await request(current)).status, 404);
});

test('named evidence and legacy HMAC owner links remain readable without accepting unsafe paths', async () => {
  const owner = user();
  const reporter = user();
  const wallId = wall(owner);
  member(wallId, reporter);
  const original = imageFixture('bug-reports', 'bug_' + reporter.id + '_' + (++sequence) + '.png');
  const report = reportFixture(reporter, wallId, original, false);
  const legacy = signImageUrl(original, { db, user: reporter });
  assert.equal((await request(legacy)).status, 200);
  assert.equal(verifyImageTicket(new URL(legacy, baseUrl).searchParams.get('ticket'), original, db), true);
  const listed = await request('/api/reports', { account: owner, wallId });
  const named = listed.body.reports.find(row => row.id === report.id);
  assert.ok(named.reporter_name);
  const [opaque] = JSON.parse(named.images);
  assert.equal((await request(opaque)).status, 200);
  const head = await request(opaque, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.deepEqual(head.bytes, Buffer.alloc(0));

  const alias = '/uploads/bug-reports/private-image';
  assert.equal((await request(alias)).status, 404);
  const legacyTicket = new URL(legacy, baseUrl).searchParams.get('ticket');
  assert.equal((await request(alias + '?ticket=' + legacyTicket)).status, 404);
  const opaqueTicket = new URL(opaque, baseUrl).searchParams.get('ticket');
  assert.equal((await request(alias + '?ticket=' + opaqueTicket + '&ticket=' + opaqueTicket)).status, 404);
  assert.equal((await request(alias + '?ticket=' + 'x'.repeat(2049))).status, 404);
  for (const unsafe of ['/uploads/images/../data.db', '/uploads/bug-reports/../../.jwt_secret', 'https://example.invalid/image.png', '/uploads/avatars/private.png']) {
    assert.equal(signImageUrl(unsafe, { db, user: reporter }), '');
    // Even an authentic historical signature must not widen the path whitelist.
    const payload = Buffer.from(JSON.stringify({ p: unsafe, u: reporter.id, t: 0, e: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update('private-upload:' + payload).digest('base64url');
    assert.equal(verifyImageTicket(payload + '.' + signature, unsafe, db), false);
  }
});

test('upload authentication, image decoding and evidence ownership checks fail closed', async () => {
  const reporter = user();
  const outsider = user();
  const owner = user();
  const wallId = wall(owner);
  member(wallId, reporter);
  member(wallId, outsider);
  const uploadBody = { image: 'data:image/png;base64,' + png.toString('base64') };
  assert.equal((await request('/api/upload/bug-image', { method: 'POST', body: uploadBody })).status, 401);
  assert.equal((await request('/api/upload/bug-image', { account: reporter, method: 'POST', body: { image: 'data:image/png;base64,' + Buffer.from('<html>fake</html>').toString('base64') } })).status, 400);
  assert.equal((await request('/api/upload/bug-image', { account: reporter, method: 'POST', body: { image: 'data:image/png;base64,' + png.subarray(0, 24).toString('base64') } })).status, 400);
  const uploaded = await request('/api/upload/bug-image', { account: reporter, method: 'POST', body: uploadBody });
  assert.equal(uploaded.status, 200);
  assert.equal((await request(uploaded.body.url)).status, 200);
  const reportBody = { report_types: ['校园霸凌行为'], content: 'synthetic test', agreed: true, is_anonymous: true, images: [uploaded.body.url] };
  assert.equal((await request('/api/reports', { account: outsider, wallId, method: 'POST', body: reportBody })).status, 400);
  assert.equal((await request('/api/reports', { account: reporter, wallId, method: 'POST', body: reportBody })).status, 200);
});



test('admin IP mode classifies management methods and route shapes while preserving ordinary endpoints', async () => {
  await withWhitelist(async () => {
    const management = [
      ['GET', '/api/admin/users'], ['GET', '/dashboard'], ['GET', '/api/walls/admin/applications'],
      ['PUT', '/api/permissions/user/%31'], ['GET', '/api/bug-reports/admin'],
      ['PUT', '/api/bug-reports/1/status'], ['PUT', '/API/BUG-REPORTS/%31/status/'],
      ['PUT', '/api/bug-reports/1x/status'], ['GET', '/api/reports'], ['HEAD', '/api/reports/'],
      ['PUT', '/api/reports/%31/status'], ['DELETE', '/api/reports/1x'],
      ['GET', '/api/walls/1/members'], ['HEAD', '/api/walls/%31/ban-logs/'],
      ['PUT', '/api/walls/1'], ['PUT', '/api/walls/1/transfer-owner'],
      ['PUT', '/api/walls/1/members/2/role'], ['POST', '/api/dashboard/session'],
      ...['approve', 'reject', 'remove', 'ban', 'unban'].map(action => ['POST', '/api/walls/%31/members/%32/' + action]),
    ];
    for (const [method, pathname] of management) {
      assert.equal(guardedStatus(method, pathname), 403, method + ' ' + pathname);
      assert.equal(guardedStatus(method, pathname, '192.0.2.10'), 200, 'whitelisted: ' + pathname);
    }
    const ordinary = [
      ['POST', '/api/reports'], ['GET', '/api/reports/track/RPT-test'], ['HEAD', '/api/reports/track/RPT-test/'],
      ['GET', '/api/bug-reports'], ['POST', '/api/bug-reports'], ['GET', '/api/walls/1'],
      ['POST', '/api/walls/1/join'], ['POST', '/api/walls/1/leave'], ['POST', '/api/walls/apply-create'],
      ['GET', '/api/permissions/me'], ['GET', '/api/permissions/catalog'], ['GET', '/api/messages/approvals'],
      ['DELETE', '/api/posts/1'], ['DELETE', '/api/votes/1'], ['GET', '/api/health'], ['OPTIONS', '/api/reports'],
    ];
    for (const [method, pathname] of ordinary) assert.equal(guardedStatus(method, pathname), 200, method + ' ' + pathname);
  });
  await withWhitelist(async () => {
    assert.equal(guardedStatus('PUT', '/api/bug-reports/1/status'), 403);
    assert.equal(guardedStatus('POST', '/api/reports'), 200);
  }, { mode: 'off', entries: [], env: '192.0.2.10' });
  await withWhitelist(async () => {
    assert.equal(guardedStatus('POST', '/api/reports'), 403);
    assert.equal(guardedStatus('GET', '/api/reports/track/RPT-test'), 403);
    assert.equal(guardedStatus('GET', '/api/health'), 200);
  }, { mode: 'all' });
});

test('non-whitelisted management mutations fail before changing reports or wall members, including v1 aliases', async () => {
  const admin = user('admin');
  const owner = user();
  const reporter = user();
  const newcomer = user();
  const wallId = wall(owner);
  member(wallId, reporter);
  const bugId = db.prepare('INSERT INTO bug_reports (reporter_id,title,content) VALUES (?,?,?)')
    .run(reporter.id, 'synthetic bug', 'synthetic bug content').lastInsertRowid;
  await withWhitelist(async () => {
    const submitted = await request('/api/reports', { account: reporter, wallId, method: 'POST', body: {
      report_types: ['校园霸凌行为'], content: 'synthetic safety report', agreed: true,
    } });
    assert.equal(submitted.status, 200);
    const report = db.prepare('SELECT id,status FROM reports WHERE tracking_code=?').get(submitted.body.tracking_code);
    assert.equal((await request('/api/reports/track/' + submitted.body.tracking_code, { account: reporter })).status, 200);
    assert.equal((await request('/api/reports', { account: owner, wallId })).status, 403);
    assert.equal((await request('/api/v1/reports/', { account: owner, wallId })).status, 403);
    assert.equal((await request('/api/reports/', { account: owner, wallId, method: 'HEAD' })).status, 403);
    assert.equal((await request('/api/walls/' + wallId + '/members/', { account: owner, method: 'HEAD' })).status, 403);
    const encodedBugId = String(bugId).replace(/[0-9]/g, digit => '%3' + digit);
    assert.equal((await request('/api/bug-reports/' + encodedBugId + '/status/', { account: admin, method: 'PUT', body: { status: 'resolved' } })).status, 403);
    assert.equal((await request('/api/bug-reports/' + bugId + 'x/status', { account: admin, method: 'PUT', body: { status: 'resolved' } })).status, 403);
    for (const prefix of ['/api', '/api/v1']) {
      assert.equal((await request(prefix + '/bug-reports/' + bugId + '/status', { account: admin, method: 'PUT', body: { status: 'resolved' } })).status, 403);
      assert.equal((await request(prefix + '/reports/' + report.id + '/status', { account: owner, method: 'PUT', body: { status: 'processing' } })).status, 403);
      assert.equal((await request(prefix + '/walls/' + wallId + '/members/' + reporter.id + '/ban', { account: owner, method: 'POST', body: { duration: 60 } })).status, 403);
    }
    assert.equal((await request('/api/reports/' + report.id, { account: admin, method: 'DELETE' })).status, 403);
    assert.equal((await request('/api/walls/' + wallId, { account: owner, method: 'PUT', body: { description: 'forbidden change' } })).status, 403);
    assert.equal((await request('/api/walls/' + wallId + '/members', { account: owner })).status, 403);
    assert.equal((await request('/api/bug-reports/' + bugId + '/status', { account: admin, method: 'PUT', body: { status: 'resolved' }, headers: { 'x-forwarded-for': '192.0.2.10' } })).status, 403);
    assert.equal(db.prepare('SELECT status FROM bug_reports WHERE id=?').get(bugId).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(report.id).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, reporter.id).status, 'active');
    assert.notEqual(db.prepare('SELECT description FROM walls WHERE id=?').get(wallId).description, 'forbidden change');
    assert.equal((await request('/api/walls/' + wallId, { account: newcomer })).status, 200);
    assert.equal((await request('/api/walls/' + wallId + '/join', { account: newcomer, method: 'POST', body: {} })).status, 200);
    assert.equal((await request('/api/walls/' + wallId + '/leave', { account: newcomer, method: 'POST', body: {} })).status, 200);
    assert.equal((await request('/api/bug-reports', { account: reporter })).status, 200);
    db.prepare("UPDATE settings SET value='[\"127.0.0.1\"]' WHERE key='admin_ip_whitelist'").run();
    assert.equal((await request('/api/bug-reports/' + bugId + '/status', { account: admin, method: 'PUT', body: { status: 'resolved' } })).status, 200);
    assert.equal((await request('/api/bug-reports/' + encodedBugId + '/status/', { account: admin, method: 'PUT', body: { status: 'processing' } })).status, 200);
    assert.equal((await request('/api/bug-reports/' + bugId + 'x/status', { account: admin, method: 'PUT', body: { status: 'resolved' } })).status, 400, 'existing router parameter validation remains effective after the IP guard');
    assert.equal((await request('/api/reports', { account: owner, wallId })).status, 200);
    assert.equal((await request('/api/reports/', { account: owner, wallId, method: 'HEAD' })).status, 200);
  });
});

test('mixed content deletion retains owner actions but enforces the admin IP boundary for moderation', async () => {
  const owner = user();
  const author = user();
  const wallId = wall(owner);
  member(wallId, author);
  const postId = db.prepare('INSERT INTO posts (wall_id,author_id,content,author_ip) VALUES (?,?,?,?)').run(wallId, author.id, 'synthetic post', 'synthetic-ip').lastInsertRowid;
  const commentId = db.prepare('INSERT INTO comments (post_id,author_id,content,author_ip) VALUES (?,?,?,?)').run(postId, author.id, 'synthetic comment', 'synthetic-ip').lastInsertRowid;
  const voteId = db.prepare('INSERT INTO votes (wall_id,author_id,title,author_ip) VALUES (?,?,?,?)').run(wallId, author.id, 'synthetic vote', 'synthetic-ip').lastInsertRowid;
  await withWhitelist(async () => {
    for (const endpoint of ['/api/posts/' + postId, '/api/posts/' + postId + '/comments/' + commentId, '/api/votes/' + voteId]) {
      assert.equal((await request(endpoint, { account: owner, wallId, method: 'DELETE' })).status, 403, endpoint);
    }
    assert.ok(db.prepare('SELECT id FROM posts WHERE id=?').get(postId));
    assert.ok(db.prepare('SELECT id FROM comments WHERE id=?').get(commentId));
    assert.ok(db.prepare('SELECT id FROM votes WHERE id=?').get(voteId));
    assert.equal((await request('/api/posts/' + postId + '/comments/' + commentId, { account: author, wallId, method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/votes/' + voteId, { account: author, wallId, method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/posts/' + postId, { account: author, wallId, method: 'DELETE' })).status, 200);
    const ownPost = db.prepare('INSERT INTO posts (wall_id,author_id,content,author_ip) VALUES (?,?,?,?)').run(wallId, owner.id, 'moderator-owned content', 'synthetic-ip').lastInsertRowid;
    assert.equal((await request('/api/posts/' + ownPost, { account: owner, wallId, method: 'DELETE' })).status, 200, 'moderators can still delete their own content outside the whitelist');
    const moderatedVote = db.prepare('INSERT INTO votes (wall_id,author_id,title,author_ip) VALUES (?,?,?,?)').run(wallId, author.id, 'moderated vote', 'synthetic-ip').lastInsertRowid;
    db.prepare("UPDATE settings SET value='[\"127.0.0.1\"]' WHERE key='admin_ip_whitelist'").run();
    assert.equal((await request('/api/votes/' + moderatedVote, { account: owner, wallId, method: 'DELETE' })).status, 200);
  });
});

test('mixed approvals keep personal friend requests while hiding administrative work outside the whitelist', async () => {
  const manager = user('super_admin');
  const applicant = user();
  const wallId = wall(manager);
  const friendId = db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (?,?,'pending')").run(applicant.id, manager.id).lastInsertRowid;
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'member','pending')").run(wallId, applicant.id);
  const applicationId = db.prepare('INSERT INTO wall_applications (applicant_id,wall_name) VALUES (?,?)').run(applicant.id, 'security-application-' + (++sequence)).lastInsertRowid;
  await withWhitelist(async () => {
    const outside = await request('/api/messages/approvals', { account: manager });
    assert.equal(outside.status, 200);
    assert.ok(outside.body.friend.some(item => item.id === friendId));
    assert.deepEqual(outside.body.wall_join, []);
    assert.deepEqual(outside.body.wall_create, []);
    assert.equal(outside.body.total, outside.body.friend.length);
    db.prepare("UPDATE settings SET value='[\"127.0.0.1\"]' WHERE key='admin_ip_whitelist'").run();
    const inside = await request('/api/messages/approvals', { account: manager });
    assert.ok(inside.body.friend.some(item => item.id === friendId));
    assert.ok(inside.body.wall_join.some(item => item.user_id === applicant.id && item.wall_id === wallId));
    assert.ok(inside.body.wall_create.some(item => item.id === applicationId));
  });
});

test('public profile counts exclude anonymous and invisible-wall activity while self counts keep their existing scope', async () => {
  const author = user();
  const observer = user();
  const sharedWall = wall(author);
  member(sharedWall, observer);
  const profile = () => request('/api/auth/user/' + author.id, { account: observer });
  let shown = await profile();
  assert.equal(shown.status, 200);
  assert.deepEqual([shown.body.postCount, shown.body.voteCount], [0, 0]);
  const content = (wallId, anonymous) => {
    db.prepare('INSERT INTO posts (wall_id,author_id,is_anonymous,content,author_ip) VALUES (?,?,?,?,?)').run(wallId, author.id, anonymous, 'synthetic profile post', 'synthetic-ip');
    db.prepare('INSERT INTO votes (wall_id,author_id,is_anonymous,title,author_ip) VALUES (?,?,?,?,?)').run(wallId, author.id, anonymous, 'synthetic profile vote', 'synthetic-ip');
  };
  content(sharedWall, 1);
  shown = await profile();
  assert.deepEqual([shown.body.postCount, shown.body.voteCount], [0, 0], 'anonymous activity must not identify its author through profile counts');
  content(sharedWall, 0);
  for (const state of ['outside', 'disabled', 'pending', 'banned']) {
    const hiddenWall = wall(author);
    if (state !== 'outside') {
      db.prepare('INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,?,?)').run(hiddenWall, observer.id, 'member', state === 'disabled' ? 'active' : state);
    }
    if (state === 'disabled') db.prepare("UPDATE walls SET status='disabled' WHERE id=?").run(hiddenWall);
    content(hiddenWall, 0);
  }
  shown = await profile();
  assert.deepEqual([shown.body.postCount, shown.body.voteCount], [1, 1]);
  const self = await request('/api/auth/user/' + author.id, { account: author });
  assert.deepEqual([self.body.postCount, self.body.voteCount], [6, 6]);
  const ownStatistics = await request('/api/auth/statistics', { account: author });
  assert.equal(ownStatistics.body.counts.named_posts, 5);
  db.prepare("INSERT INTO friends (user_id,friend_id,status) VALUES (?,?,'accepted')").run(observer.id, author.id);
  db.prepare('DELETE FROM wall_members WHERE wall_id=? AND user_id=?').run(sharedWall, observer.id);
  shown = await profile();
  assert.equal(shown.status, 200, 'friendship still permits the profile itself');
  assert.deepEqual([shown.body.postCount, shown.body.voteCount], [0, 0]);
});

test('content routes reject cross-wall reads and malformed pagination without exposing anonymous ownership', async () => {
  const owner = user();
  const other = user();
  const firstWall = wall(owner);
  const secondWall = wall(other);
  const id = db.prepare('INSERT INTO posts (wall_id,author_id,content,is_anonymous,author_ip) VALUES (?,?,?,?,?)')
    .run(firstWall, owner.id, 'synthetic anonymous post', 1, 'synthetic-private-hash').lastInsertRowid;
  assert.equal((await request('/api/posts/' + id, { account: other, wallId: secondWall })).status, 404);
  assert.equal((await request('/api/posts/' + id, { account: other, wallId: firstWall })).status, 403);
  for (const query of ['?limit=-1', '?limit=1000000000', '?limit[]=1', '?page=1.1', '?q[$ne]=value']) {
    assert.equal((await request('/api/posts' + query, { account: owner, wallId: firstWall })).status, 400);
  }
  const shown = await request('/api/posts/' + id, { account: owner, wallId: firstWall });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.post.author_id, null);
  assert.ok(!JSON.stringify(shown.body).includes('synthetic-private-hash'));
});
