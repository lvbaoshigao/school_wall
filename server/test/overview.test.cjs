'use strict';

const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-overview-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'overview-test-secret-without-production-value';
process.env.TZ = 'Asia/Shanghai';
delete process.env.KEEP_DB;

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { SECRET } = require('../middleware/auth');
const { apiV1Middleware } = require('../lib/apiV1');
const { getOverview, parseOverviewQuery, OverviewError } = require('../lib/overview');
const visits = require('../lib/visits');
const NOW = new Date('2026-02-09T00:30:00+08:00');
const CREATED = '2026-02-01 12:00:00';
let db, server, baseUrl, sequence = 0;

function user(role = 'user', status = 'active', createdAt = CREATED) {
  const name = 'overview-user-' + ++sequence;
  const id = db.prepare('INSERT INTO users(username,password_hash,nickname,real_name,role,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(name, 'PRIVATE-HASH', 'PRIVATE-NICKNAME', 'PRIVATE-REAL-NAME', role, status, createdAt).lastInsertRowid;
  return { id, token: jwt.sign({ id, role, username: name, tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}
function wall(owner, status = 'active') {
  const id = db.prepare('INSERT INTO walls(name,owner_id,status,created_at) VALUES (?,?,?,?)').run('overview-wall-' + ++sequence, owner?.id || null, status, CREATED).lastInsertRowid;
  if (owner) membership(id, owner, 'owner');
  return id;
}
function membership(wallId, account, role = 'member', status = 'active', until = '') {
  db.prepare('INSERT INTO wall_members(wall_id,user_id,wall_role,status,wall_ban_until,created_at) VALUES (?,?,?,?,?,?)').run(wallId, account.id, role, status, until, CREATED);
}
function override(account, perm, effect = 'grant', wallId = 0) {
  db.prepare('INSERT OR REPLACE INTO user_permissions(user_id,wall_id,perm,effect) VALUES (?,?,?,?)').run(account.id, wallId, perm, effect);
}
function post(wallId, createdAt = CREATED, anonymous = 0, authorId = null) {
  return db.prepare('INSERT INTO posts(wall_id,content,author_id,author_ip,is_anonymous,like_count,comment_count,created_at) VALUES (?,?,?,?,?,999,999,?)')
    .run(wallId, 'PRIVATE-POST-CONTENT', authorId, 'PRIVATE-IP-127.0.0.1', anonymous, createdAt).lastInsertRowid;
}
function safety(wallId, reporter, status) {
  db.prepare('INSERT INTO reports(wall_id,tracking_code,reporter_id,report_types,content,is_anonymous,status,created_at) VALUES (?,?,?,?,?,1,?,?)')
    .run(wallId, 'PRIVATE-TRACK-' + ++sequence, reporter.id, 'PRIVATE-REPORT-TYPE', 'PRIVATE-REPORT-CONTENT', status, CREATED);
}
function postReport(wallId, postId, reporter, status = 'pending') {
  db.prepare('INSERT INTO post_reports(wall_id,post_id,reporter_id,reason,status,created_at) VALUES (?,?,?,?,?,?)').run(wallId, postId, reporter.id, 'PRIVATE-REASON', status, CREATED);
}
function userReport(wallId, reporter, status = 'pending') {
  db.prepare('INSERT INTO user_reports(wall_id,reporter_id,reported_user_id,reason,evidence_messages,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(wallId, reporter.id, reporter.id, 'PRIVATE-USER-REASON', 'PRIVATE-EVIDENCE', status, CREATED);
}
function bug(reporter, status) {
  db.prepare('INSERT INTO bug_reports(reporter_id,title,content,status,created_at) VALUES (?,?,?,?,?)').run(reporter.id, 'PRIVATE-BUG-TITLE', 'PRIVATE-BUG-CONTENT', status, CREATED);
}
function overview(account, options = {}) { return getOverview(db, { userId: account.id, now: NOW, ...options }); }
function throwsOverview(fn, status, code) {
  assert.throws(fn, error => error instanceof OverviewError && error.status === status && (!code || error.code === code));
}
async function request(query = '', { account, headers = {}, method = 'GET' } = {}) {
  const response = await fetch(baseUrl + '/api/admin/overview' + query, { method, headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}), ...headers } });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

before(async () => {
  db = await initDB({ deferInitialSave: true });
  const app = express();
  app.use(apiV1Middleware());
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/admin/overview', require('../routes/overview'));
  app.use((error, req, res, next) => res.status(500).json({ error: '请求失败' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => { db.exec('SAVEPOINT overview_test'); });
afterEach(() => { db.exec('ROLLBACK TO SAVEPOINT overview_test'); db.exec('RELEASE SAVEPOINT overview_test'); db.dirty = false; });
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (db) { db.dirty = false; db.db.close(); }
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('school-wall-overview-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('real SQL.js schema produces exact stored totals, local-day trends and open work', () => {
  const root = user('super_admin');
  const owner = user();
  const member = user();
  const waiting = user('user', 'active', '2026-02-09 00:01:00');
  const banned = user('user', 'banned');
  const a = wall(owner), b = wall(owner);
  membership(a, member); membership(a, waiting, 'member', 'pending'); membership(a, banned, 'member', 'banned');
  const first = post(a, '2026-02-03 00:00:00', 1, owner.id);
  post(a, '2026-02-09 23:59:59'); post(a, '2026-02-02 23:59:59');
  const other = post(b, '2026-02-08 10:00:00');
  post(999999, '2026-02-09 12:00:00'); // Removed-wall orphan is not a visible wall.
  db.prepare('INSERT INTO comments(post_id,content,author_id,author_ip,created_at) VALUES (?,?,?,?,?)').run(first, 'PRIVATE-COMMENT', member.id, 'PRIVATE-IP', '2026-02-03 00:00:00');
  db.prepare('INSERT INTO comments(post_id,content,author_id,author_ip,created_at) VALUES (?,?,?,?,?)').run(other, 'PRIVATE-COMMENT', member.id, 'PRIVATE-IP', '2026-02-08 12:00:00');
  db.prepare('INSERT INTO comments(post_id,content,author_id,author_ip,created_at) VALUES (?,?,?,?,?)').run(999999, 'PRIVATE-ORPHAN', member.id, 'PRIVATE-IP', '2026-02-09 12:00:00');
  for (const [postId, accountId] of [[first, root.id], [first, owner.id], [other, root.id]]) db.prepare('INSERT INTO likes(post_id,user_id,created_at) VALUES (?,?,?)').run(postId, accountId, CREATED);
  db.prepare('INSERT INTO votes(wall_id,title,author_ip,created_at) VALUES (?,?,?,?)').run(a, 'PRIVATE-VOTE', 'PRIVATE-IP', '2026-02-09 00:00:01');
  db.prepare('INSERT INTO votes(wall_id,title,author_ip,created_at) VALUES (?,?,?,?)').run(b, 'PRIVATE-VOTE', 'PRIVATE-IP', '2026-02-02 12:00:00');
  db.prepare('INSERT INTO announcements(wall_id,title,content,author_id,scope) VALUES (?,?,?,?,?)').run(a, 'PRIVATE-TITLE', 'PRIVATE-ANNOUNCEMENT', owner.id, 'wall');
  db.prepare('INSERT INTO announcements(wall_id,title,content,author_id,scope) VALUES (?,?,?,?,?)').run(0, 'PRIVATE-TITLE', 'PRIVATE-GLOBAL', root.id, 'global');
  postReport(a, first, member); postReport(a, first, member, 'rejected'); postReport(b, other, member);
  for (const status of ['pending', 'processing', 'resolved']) safety(a, member, status);
  safety(b, member, 'pending');
  for (const id of [a, b, 0]) userReport(id, member);
  userReport(a, member, 'resolved');
  for (const status of ['pending', 'processing', 'resolved']) bug(member, status);
  db.prepare('INSERT INTO wall_applications(applicant_id,wall_name,status) VALUES (?,?,?)').run(member.id, 'PRIVATE-APPLICATION', 'pending');
  db.prepare('INSERT INTO messages(sender_id,receiver_id,type,content,is_anonymous) VALUES (?,?,?,?,1)').run(owner.id, member.id, 'tree_hole', 'PRIVATE-TREE-HOLE');
  const changes = db.prepare('SELECT total_changes() AS count').get().count;
  const result = overview(root);
  assert.deepEqual(result.scope, { kind: 'global', wall_id: null, available_wall_count: 2, global_stats: true });
  assert.deepEqual(result.totals, { users: 5, active_users: 4, banned_users: 1, walls: 2, active_walls: 2, members: 3, posts: 4, anonymous_posts: 1, comments: 2, votes: 2, likes: 3, announcements: 1, pending: 12 });
  assert.deepEqual(result.pending, { members: 1, wall_applications: 1, post_reports: 2, safety_reports: 3, user_reports: 3, bug_reports: 2, total: 12 });
  assert.deepEqual(result.today, { users: 1, posts: 1, comments: 0, votes: 1, members: 0 });
  assert.equal(result.schema_version, 1);
  assert.equal(result.generated_at, '2026-02-08T16:30:00.000Z');
  assert.deepEqual(result.range, { days: 7, start_date: '2026-02-03', end_date: '2026-02-09', timezone: 'Asia/Shanghai', utc_offset_minutes: 480, date_basis: 'server-local', includes_today: true, timestamp_storage: 'local-naive' });
  assert.deepEqual(result.daily[0], { date: '2026-02-03', users: 0, posts: 1, comments: 1, votes: 0, members: 0 });
  assert.deepEqual(result.daily[1], { date: '2026-02-04', users: 0, posts: 0, comments: 0, votes: 0, members: 0 });
  assert.equal(result.daily.length, 7);
  assert.equal(result.walls[0].id, a);
  assert.equal(result.walls[0].posts_in_range, 2);
  assert.ok(result.todos.some(todo => todo.key === 'members' && todo.wall_id === a && todo.permission === 'wall.member.approve'));
  assert.ok(result.todos.some(todo => todo.key === 'safety_reports' && todo.permission === 'global.safety.handle'));
  assert.equal(result.system.database.engine, 'sql.js');
  assert.ok(result.system.uptime_seconds >= 0 && result.system.memory.rss_bytes > 0);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('PRIVATE-'));
  for (const key of ['author_id', 'author_ip', 'reporter_id', 'real_name', 'sender_id', 'receiver_id', 'password_hash', 'tracking_code', 'conversation_id']) assert.ok(!serialized.includes('"' + key + '"'), key);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.equal(db.dirty, false);
});

test('wall-scoped readers see only their wall and null for unavailable fields', () => {
  const owner = user(), stranger = user();
  const a = wall(owner), b = wall(stranger);
  post(a, '2026-02-09 01:00:00'); post(b, '2026-02-09 01:00:00');
  membership(a, stranger, 'member', 'pending');
  const result = overview(owner, { wallId: a, days: 30 });
  assert.deepEqual(result.scope, { kind: 'wall', wall_id: a, available_wall_count: 1, global_stats: false });
  assert.equal(result.totals.posts, 1);
  assert.equal(result.totals.users, null);
  assert.equal(result.today.users, null);
  assert.equal(result.daily.length, 30);
  assert.ok(result.daily.every(day => day.users === null));
  assert.equal(result.pending.wall_applications, null);
  assert.equal(result.pending.user_reports, null);
  assert.equal(result.pending.bug_reports, null);
  assert.equal(result.pending.members, 1);
  assert.equal(result.system, null);
  assert.deepEqual(result.walls.map(row => row.id), [a]);
  throwsOverview(() => overview(owner), 403, 'OVERVIEW_FORBIDDEN');
  throwsOverview(() => overview(owner, { wallId: b }), 403, 'OVERVIEW_WALL_FORBIDDEN');
});

test('wall filters constrain globally authorized user reports and omit unrelated global work', () => {
  const root = user('super_admin'), owner = user(), reporter = user();
  const a = wall(owner), b = wall(owner);
  userReport(a, reporter); userReport(b, reporter); userReport(0, reporter);
  bug(reporter, 'pending');
  db.prepare('INSERT INTO wall_applications(applicant_id,wall_name,status) VALUES (?,?,?)').run(reporter.id, 'application', 'pending');
  const result = overview(root, { wallId: a });
  assert.equal(result.pending.user_reports, 1);
  assert.equal(result.pending.wall_applications, null);
  assert.equal(result.pending.bug_reports, null);
  assert.equal(result.totals.users, null);
  assert.ok(result.todos.some(todo => todo.key === 'user_reports' && todo.wall_id === a));
  assert.ok(!result.todos.some(todo => ['wall_applications', 'bug_reports'].includes(todo.key)));
});

test('effective grant/deny precedence applies to aggregates, trends and each pending type', () => {
  const admin = user('admin'), owner = user(), reporter = user();
  const a = wall(owner), b = wall(owner);
  const pa = post(a, '2026-02-09 01:00:00'), pb = post(b, '2026-02-09 01:00:00');
  postReport(a, pa, reporter); postReport(b, pb, reporter);
  safety(a, reporter, 'pending'); userReport(a, reporter); bug(reporter, 'pending');
  override(admin, 'wall.stats.view', 'deny', b);
  override(admin, 'wall.post.report', 'deny', a);
  override(admin, 'global.report.handle', 'deny');
  override(admin, 'global.bug.handle', 'deny');
  override(admin, 'global.dashboard', 'deny');
  let result = overview(admin);
  assert.equal(result.totals.posts, 1);
  assert.equal(result.today.posts, 1);
  assert.deepEqual(result.walls.map(row => row.id), [a]);
  assert.equal(result.pending.post_reports, null);
  assert.equal(result.pending.safety_reports, null); // Global admin is NOT safety staff.
  assert.equal(result.pending.user_reports, null);
  assert.equal(result.pending.bug_reports, null);
  assert.equal(result.system, null);
  assert.ok(!result.todos.some(todo => ['post_reports', 'safety_reports', 'user_reports', 'bug_reports'].includes(todo.key)));
  override(admin, 'wall.stats.view', 'deny');
  override(admin, 'wall.stats.view', 'grant', a); // Specific grant wins over global deny.
  override(admin, 'wall.post.report', 'grant', a);
  result = overview(admin);
  assert.equal(result.totals.posts, 1);
  assert.equal(result.pending.post_reports, 1);
  assert.equal(result.walls[0].pending_post_reports, 1);
  override(admin, 'wall.stats.view', 'deny', a);
  assert.equal(overview(admin).totals.posts, 0);
});

test('a granted statistics permission still needs membership unless global moderation permits entry', () => {
  const reader = user(), owner = user();
  const a = wall(owner);
  post(a);
  override(reader, 'wall.stats.view', 'grant', a);
  throwsOverview(() => overview(reader, { wallId: a }), 403);
  membership(a, reader);
  let result = overview(reader, { wallId: a });
  assert.equal(result.totals.posts, 1);
  assert.equal(result.pending.members, null);
  assert.equal(result.pending.post_reports, null);
  assert.equal(result.walls[0].pending_safety_reports, null);
  override(reader, 'wall.stats.view', 'deny', a);
  throwsOverview(() => overview(reader, { wallId: a }), 403);
});

test('runtime-only dashboard grant never implies content or user-management access', () => {
  const observer = user(), owner = user();
  const a = wall(owner); post(a);
  override(observer, 'global.dashboard');
  const result = overview(observer);
  assert.equal(result.scope.global_stats, false);
  assert.equal(result.totals.users, null);
  assert.equal(result.totals.posts, 0);
  assert.deepEqual(result.walls, []);
  assert.equal(result.pending.total, 0);
  assert.ok(result.system);
  override(observer, 'global.moderate');
  assert.equal(overview(observer).totals.posts, 0); // Moderate is not wall.stats.view.
  override(observer, 'wall.stats.view');
  assert.equal(overview(observer).totals.posts, 1);
});

test('membership bans, pending/removed roles and owner metadata do not bypass scope checks', () => {
  const owner = user(), reader = user();
  const a = wall(owner);
  membership(a, reader, 'owner', 'pending');
  throwsOverview(() => overview(reader, { wallId: a }), 403);
  db.prepare("UPDATE wall_members SET status='banned',wall_ban_until='' WHERE wall_id=? AND user_id=?").run(a, reader.id);
  throwsOverview(() => overview(reader, { wallId: a }), 403);
  db.prepare("UPDATE wall_members SET wall_ban_until='not-a-date' WHERE wall_id=? AND user_id=?").run(a, reader.id);
  throwsOverview(() => overview(reader, { wallId: a }), 403);
  db.prepare("UPDATE wall_members SET wall_ban_until='2026-02-08T00:00:00.000Z' WHERE wall_id=? AND user_id=?").run(a, reader.id);
  const changes = db.prepare('SELECT total_changes() AS count').get().count;
  assert.equal(overview(reader, { wallId: a }).scope.wall_id, a);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
  db.prepare('DELETE FROM wall_members WHERE wall_id=? AND user_id=?').run(a, owner.id);
  throwsOverview(() => overview(owner, { wallId: a }), 403);
  db.prepare('DELETE FROM wall_members WHERE wall_id=? AND user_id=?').run(a, reader.id);
  throwsOverview(() => overview(reader, { wallId: a }), 403);
});

test('disabled/deleted walls and globally unavailable accounts fail closed', () => {
  const root = user('super_admin'), owner = user();
  const a = wall(owner), disabled = wall(owner, 'disabled');
  post(a); post(disabled); post(999999);
  assert.equal(overview(root).totals.posts, 2);
  assert.equal(overview(root).totals.active_walls, 1);
  throwsOverview(() => overview(root, { wallId: disabled }), 404);
  db.prepare('DELETE FROM walls WHERE id=?').run(a);
  assert.equal(overview(root).totals.posts, 1);
  throwsOverview(() => overview(owner, { wallId: a }), 404);
  db.prepare("UPDATE users SET status='banned' WHERE id=?").run(root.id);
  throwsOverview(() => overview(root), 403, 'OVERVIEW_ACCOUNT_UNAVAILABLE');
  db.prepare('DELETE FROM users WHERE id=?').run(root.id);
  throwsOverview(() => overview(root), 401, 'OVERVIEW_ACCOUNT_MISSING');
});

test('daily windows include today, exclude following day, and use calendar arithmetic across DST', () => {
  const root = user('super_admin'), a = wall();
  post(a, '2026-02-03 00:00:00'); post(a, '2026-02-02 23:59:59');
  post(a, '2026-02-09 23:59:59'); post(a, '2026-02-10 00:00:00');
  const result = overview(root);
  assert.equal(result.totals.posts, 4);
  assert.equal(result.walls[0].posts_in_range, 2);
  assert.equal(result.daily.reduce((total, day) => total + day.posts, 0), 2);
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const dst = getOverview(db, { userId: root.id, days: 7, now: new Date('2026-03-10T01:00:00-04:00') });
    assert.deepEqual(dst.daily.map(row => row.date), ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
    assert.equal(dst.range.timezone, 'America/New_York');
    assert.equal(dst.range.utc_offset_minutes, -240);
    assert.equal(getOverview(db, { userId: root.id, days: 90, now: new Date('2026-03-10T01:00:00-04:00') }).daily.length, 90);
  } finally { process.env.TZ = originalTz; }
});

test('traffic reflects the existing rolling process counter with explicit limitations', () => {
  const root = user('super_admin');
  const key = 'overview-test-traffic-' + ++sequence;
  visits.track(key); visits.track(key);
  const existing = visits.stats();
  const actual = overview(root).system.visits;
  assert.equal(actual.visitors, existing.visitors);
  assert.equal(actual.requests, existing.requests);
  assert.equal(actual.window_minutes, 60);
  assert.equal(actual.scope, 'process');
  assert.equal(actual.reset_on_restart, true);
  assert.equal(actual.visitor_definition, 'authenticated-user-or-guest-ip');
  assert.equal(actual.identity_limit, 50000);
  assert.equal(actual.bounded, true);
});

test('HTTP requires Bearer auth, never accepts dashboard cookies, and is always no-store', async () => {
  let response = await request();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await request('', { headers: { Cookie: 'sw_dash=not-a-bearer-token' } });
  assert.equal(response.status, 401);
  const ordinary = user();
  response = await request('', { account: ordinary });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const root = user('super_admin');
  response = await request('?days=90', { account: root });
  assert.equal(response.status, 200);
  assert.equal(response.body.daily.length, 90);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  response = await request('', { account: root, method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  response = await request('', { account: root, method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
});

test('v1 shares the same authorization, private cache policy and structured errors', async () => {
  const root = user('super_admin');
  const headers = { Authorization: 'Bearer ' + root.token };
  let response = await fetch(baseUrl + '/api/v1/admin/overview?days=30', { headers });
  let result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.schema_version, 1);
  assert.equal(result.data.daily.length, 30);
  assert.equal(result.error, null);
  assert.equal(result.meta.apiVersion, '1');
  response = await fetch(baseUrl + '/api/v1/admin/overview?days=14', { headers });
  result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'INVALID_OVERVIEW_DAYS');
  response = await fetch(baseUrl + '/api/v1/admin/overview');
  result = await response.json();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(result.error.code, 'UNAUTHENTICATED');
});

test('query validation rejects coercion, arrays, injection and ambiguous wall selection', async () => {
  const root = user('super_admin'), owner = user();
  const a = wall(owner), b = wall(owner);
  post(a); post(b);
  assert.deepEqual(parseOverviewQuery({}, { 'x-wall-id': String(a) }), { days: 7, wallId: null });
  const global = await request('', { account: root, headers: { 'X-Wall-Id': String(a) } });
  assert.equal(global.body.totals.posts, 2);
  const filtered = await request('?days=30&wall_id=' + a, { account: root, headers: { 'X-Wall-Id': String(a) } });
  assert.equal(filtered.body.totals.posts, 1);
  assert.equal(filtered.body.scope.kind, 'wall');
  assert.equal((await request('?wall_id=' + a, { account: root, headers: { 'X-Wall-Id': String(b) } })).status, 400);
  const invalid = ['days=14', 'days=', 'days=7x', 'days=-7', 'days=7&days=30', 'days[]=7', 'days[x]=7', 'days=7%20OR%201=1', 'wall_id=0', 'wall_id=-1', 'wall_id=01', 'wall_id=1.0', 'wall_id=1e2', 'wall_id=9007199254740992', 'wall_id[]=1', 'wall_id[x]=1', 'wall_id=1&wall_id=2', 'wall_id=1%20OR%201=1'];
  for (const query of invalid) {
    const response = await request('?' + query, { account: root });
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.body.code.startsWith('INVALID_OVERVIEW_'), query);
  }
  assert.equal((await request('?wall_id=' + a, { account: root, headers: { 'X-Wall-Id': 'invalid' } })).status, 400);
  assert.equal((await request('?userId=' + root.id, { account: owner })).status, 403);
});

test('database role changes, token revocation and permission revocation affect the next request', async () => {
  const admin = user('admin');
  assert.equal((await request('', { account: admin })).status, 200);
  override(admin, 'global.moderate', 'deny'); override(admin, 'global.dashboard', 'deny');
  assert.equal((await request('', { account: admin })).status, 403);
  db.prepare('DELETE FROM user_permissions WHERE user_id=?').run(admin.id);
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(admin.id);
  assert.equal((await request('', { account: admin })).status, 403); // JWT still says admin.
  db.prepare("UPDATE users SET role='admin',token_version=1 WHERE id=?").run(admin.id);
  assert.equal((await request('', { account: admin })).status, 401);
});

test('permission storage errors return a generic failure, never default-role data', async () => {
  const root = user('super_admin');
  const original = db.prepare;
  try {
    db.prepare = function (sql) {
      if (sql.includes('FROM user_permissions')) throw new Error('PRIVATE-SQL-ERROR');
      return original.call(this, sql);
    };
    assert.throws(() => overview(root), /PRIVATE-SQL-ERROR/);
    const response = await request('', { account: root });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.body, { error: '请求失败' });
  } finally { db.prepare = original; }
});

test('500-wall aggregation stays fixed-query and bounds lists without truncating totals', () => {
  const root = user('super_admin');
  for (let i = 0; i < 500; i++) {
    const id = wall();
    membership(id, root, 'member', 'pending');
    post(id, '2026-02-09 01:00:00');
    override(root, 'wall.edit', 'deny', id);
    override(root, 'wall.transfer', 'deny', id);
  }
  const original = db.prepare;
  let queries = 0;
  let result;
  const start = performance.now();
  try {
    db.prepare = function (sql) { queries++; return original.call(this, sql); };
    result = overview(root);
  } finally { db.prepare = original; }
  assert.ok(queries <= 20, 'queries=' + queries);
  assert.equal(result.totals.walls, 500);
  assert.equal(result.totals.posts, 500);
  assert.equal(result.today.posts, 500);
  assert.equal(result.pending.members, 500);
  assert.equal(result.walls.length, 100);
  assert.deepEqual(result.walls_meta, { limit: 100, total: 500, truncated: true });
  assert.equal(result.todos.length, 30);
  assert.deepEqual(result.todos_meta, { limit: 30, total: 500, truncated: true });
  assert.ok(JSON.stringify(result).length < 60000);
  console.log('overview 500-wall query count=' + queries + ', elapsed_ms=' + (performance.now() - start).toFixed(1));
  const selected = result.walls[0].id;
  wall();
  throwsOverview(() => overview(root), 400, 'OVERVIEW_SCOPE_TOO_LARGE');
  assert.equal(overview(root, { wallId: selected }).totals.posts, 1);
});
