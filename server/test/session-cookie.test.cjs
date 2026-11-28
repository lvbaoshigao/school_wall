'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Set both paths and signing material before loading any application modules.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-session-cookie-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'isolated-session-cookie-test-secret-not-production';
process.env.NODE_ENV = 'production';
process.env.ALLOWED_ORIGINS = 'https://app.school.example';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.SERVE_CLIENT = '0';
delete process.env.KEEP_DB;

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { SECRET } = require('../middleware/auth');
const { apiV1Middleware } = require('../lib/apiV1');
const DAY = 24 * 60 * 60;
const csrf = { 'X-Requested-With': 'school-wall' };
const adminCredentials = { username: 'cookie-admin', password: 'isolated-cookie-password' };
let db;
let app;
let server;
let baseUrl;
let sequence = 0;

async function request(route, { method = 'GET', headers = {}, body, rawBody } = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody,
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  return { status: response.status, headers: response.headers, body: payload,
    data: response.headers.get('x-api-version') === '1' ? payload.data : payload };
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'successful credential exchange must set a session cookie');
  assert.match(header, /^sw_session=[A-Za-z0-9_.-]+;/);
  assert.match(header, /; Max-Age=2592000(?:;|$)/);
  assert.match(header, /; Path=\/api(?:;|$)/);
  assert.match(header, /; HttpOnly(?:;|$)/);
  assert.match(header, /; SameSite=Lax(?:;|$)/);
  assert.doesNotMatch(header, /; Domain=/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const cookie = header.split(';')[0];
  const claims = jwt.verify(cookie.slice('sw_session='.length), SECRET, {
    algorithms: ['HS256'], audience: 'school-wall-session',
  });
  assert.equal(claims.exp - claims.iat, 30 * DAY);
  assert.equal(claims.aud, 'school-wall-session');
  assert.equal(claims.role, undefined);
  const expires = /; Expires=([^;]+)/.exec(header);
  assert.ok(expires);
  assert.ok(Math.abs(Date.parse(expires[1]) / 1000 - claims.exp) <= 1);
  return { cookie, claims };
}

function apiClaims(token, lifetime = 7 * DAY) {
  const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  assert.equal(claims.aud, undefined);
  assert.equal(claims.exp - claims.iat, lifetime);
  return claims;
}

function clearedCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.match(header, /^sw_session=;/);
  assert.match(header, /; Path=\/api(?:;|$)/);
  assert.match(header, /; HttpOnly(?:;|$)/);
  assert.match(header, /; SameSite=Lax(?:;|$)/);
  assert.match(header, /; Expires=Thu, 01 Jan 1970 00:00:00 GMT(?:;|$)/);
  assert.doesNotMatch(header, /; Domain=/i);
  assert.doesNotMatch(header, /; Max-Age=[1-9]/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

async function register() {
  const username = 'cookie-user-' + (++sequence);
  const password = 'isolated-member-password';
  const response = await request('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  return { ...response.data.user, password, token: response.data.token, ...sessionCookie(response) };
}

async function refresh(cookie, headers = {}, route = '/api/auth/refresh') {
  return request(route, { method: 'POST', headers: { ...csrf, ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}

async function atTime(seconds, callback) {
  const original = Date.now;
  Date.now = () => seconds * 1000;
  try { return await callback(); } finally { Date.now = original; }
}

before(async () => {
  db = await initDB({ deferInitialSave: true });
  app = express();
  app.set('trust proxy', false);
  app.use(apiV1Middleware());
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/setup', require('../routes/setup')((req, res, next) => next()));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((error, req, res, next) => res.status(500).json({ error: 'isolated fixture failed' }));
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
  assert.ok(path.basename(dataDir).startsWith('school-wall-session-cookie-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('formal setup preserves the v1 payload, rejects login CSRF and issues a host-only 30-day cookie', async () => {
  const body = { ...adminCredentials, wall_name: 'Cookie 会话测试墙' };
  const rejected = await request('/api/v1/setup', { method: 'POST', headers: { Origin: 'https://evil.example' }, body });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'FORBIDDEN');
  assert.equal(rejected.headers.get('set-cookie'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  const response = await request('/api/v1/setup', { method: 'POST', headers: { Origin: baseUrl }, body });
  assert.equal(response.status, 200);
  assert.equal(response.body.error, null);
  assert.equal(response.body.meta.apiVersion, '1');
  assert.equal(response.data.user.username, adminCredentials.username);
  const { claims } = sessionCookie(response);
  const api = apiClaims(response.data.token);
  assert.equal(claims.id, api.id);
  assert.equal(claims.username, api.username);
  assert.equal(claims.tv, 0);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
});

test('registration and login preserve legacy/v1 JSON while writing persistent cookies', async () => {
  const account = await register();
  assert.equal(apiClaims(account.token).id, account.id);
  assert.equal(account.claims.username, account.username);
  for (const route of ['/api/auth/login', '/api/v1/auth/login']) {
    const response = await request(route, { method: 'POST', body: { username: account.username, password: account.password } });
    assert.equal(response.status, 200);
    assert.equal(response.data.user.id, account.id);
    assert.equal(apiClaims(response.data.token).id, account.id);
    assert.equal(sessionCookie(response).claims.id, account.id);
  }
  const rejected = await request('/api/auth/login', { method: 'POST', body: { username: account.username, password: 'wrong-password' } });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('set-cookie'), null);
});

test('HTTP refresh restores an expired 7-day Bearer and caps late refreshes at the original 30-day expiry', async () => {
  const account = await register();
  let lateToken;
  await atTime(account.claims.iat + 8 * DAY, async () => {
    assert.equal((await request('/api/auth/me', { headers: { Authorization: 'Bearer ' + account.token } })).status, 401);
    const restored = await refresh(account.cookie);
    assert.equal(restored.status, 200);
    assert.deepEqual(Object.keys(restored.data), ['token']);
    assert.equal(apiClaims(restored.data.token).id, account.id);
    assert.equal(restored.headers.get('set-cookie'), null);
    assert.equal(restored.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/api/auth/me', { headers: { Authorization: 'Bearer ' + restored.data.token } })).status, 200);
  });
  await atTime(account.claims.iat + 29 * DAY, async () => {
    const restored = await refresh(account.cookie, {}, '/api/v1/auth/refresh');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.error, null);
    const claims = apiClaims(restored.data.token, DAY);
    assert.equal(claims.exp, account.claims.exp);
    assert.equal(restored.headers.get('set-cookie'), null);
    lateToken = restored.data.token;
  });
  await atTime(account.claims.exp - 1, async () => {
    const restored = await refresh(account.cookie);
    assert.equal(restored.status, 200);
    assert.equal(apiClaims(restored.data.token, 1).exp, account.claims.exp);
    assert.equal(restored.headers.get('set-cookie'), null);
  });
  await atTime(account.claims.exp, async () => {
    const expired = await refresh(account.cookie);
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get('set-cookie'), null);
    assert.equal((await request('/api/auth/me', { headers: { Authorization: 'Bearer ' + lateToken } })).status, 401);
  });
});

test('refresh only accepts a signed HS256 session Cookie with complete current claims', async () => {
  const account = await register();
  const sign = (patch = {}, secret = SECRET, algorithm = 'HS256') =>
    jwt.sign(Object.fromEntries(Object.entries({ ...account.claims, ...patch }).filter(([, value]) => value !== undefined)), secret, { algorithm });
  const invalid = [
    ['missing', undefined], ['malformed', 'sw_session=broken'], ['empty', 'sw_session='],
    ['unrelated', 'other=' + account.cookie.slice('sw_session='.length)],
    ['wrong secret', 'sw_session=' + sign({}, 'an-unrelated-and-invalid-signing-secret')],
    ['HS384', 'sw_session=' + sign({}, SECRET, 'HS384')],
    ['HS512', 'sw_session=' + sign({}, SECRET, 'HS512')],
    ['unsigned', 'sw_session=' + sign({}, null, 'none')],
    ['wrong audience', 'sw_session=' + sign({ aud: 'school-wall-dashboard' })],
    ['audience array', 'sw_session=' + sign({ aud: ['school-wall-session'] })],
    ['no audience', 'sw_session=' + sign({ aud: undefined })],
    ['API token', 'sw_session=' + account.token],
    ['wrong tv', 'sw_session=' + sign({ tv: 7 })], ['no tv', 'sw_session=' + sign({ tv: undefined })],
    ['string tv', 'sw_session=' + sign({ tv: '0' })], ['negative tv', 'sw_session=' + sign({ tv: -1 })],
    ['wrong username', 'sw_session=' + sign({ username: 'different-user' })],
    ['no username', 'sw_session=' + sign({ username: undefined })],
    ['string id', 'sw_session=' + sign({ id: String(account.id) })],
    ['negative id', 'sw_session=' + sign({ id: -1 })],
    ['no expiry', 'sw_session=' + sign({ exp: undefined })],
    ['overlong lifetime', 'sw_session=' + sign({ exp: account.claims.exp + 1 })],
    ['future issue time', 'sw_session=' + sign({ iat: account.claims.iat + DAY, exp: account.claims.exp + DAY })],
    ['not yet active', 'sw_session=' + sign({ nbf: account.claims.iat + DAY })],
    ['no issue time', 'sw_session=' + jwt.sign(account.claims, SECRET, { noTimestamp: true })],
    ['duplicate', account.cookie + '; ' + account.cookie],
    ['overlong', 'sw_session=' + 'x'.repeat(8193)],
  ];
  for (const [label, cookie] of invalid) {
    const response = await refresh(cookie, { Authorization: 'Bearer ' + account.token });
    assert.equal(response.status, 401, label);
    assert.equal(response.headers.get('set-cookie'), null, label + ' must not erase a concurrent login');
  }
  const bodyOnly = await request('/api/auth/refresh', { method: 'POST', headers: csrf, body: { token: account.cookie.slice('sw_session='.length) } });
  assert.equal(bodyOnly.status, 401);
  assert.equal((await refresh('other=value; ' + account.cookie + '; another=value')).status, 200);
});

test('refresh reports database failures as 500 and the same Cookie works after recovery', async () => {
  const account = await register();
  const prepare = db.prepare;
  db.prepare = function (sql) {
    if (sql === 'SELECT id, username, role, status, token_version FROM users WHERE id = ?') {
      throw new Error('simulated temporary database outage');
    }
    return prepare.call(this, sql);
  };
  try {
    for (const route of ['/api/auth/refresh', '/api/v1/auth/refresh']) {
      const response = await refresh(account.cookie, {}, route);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    // Invalid credentials still fail before any database access.
    assert.equal((await refresh('sw_session=broken')).status, 401);
  } finally { db.prepare = prepare; }
  const recovered = await refresh(account.cookie);
  assert.equal(recovered.status, 200);
  assert.equal(apiClaims(recovered.data.token).id, account.id);
  assert.equal(recovered.headers.get('set-cookie'), null);
});

test('Cookie credentials cannot authorize API requests or be reused as API Bearer tokens', async () => {
  const account = await register();
  for (const route of ['/api/auth/me', '/api/v1/auth/me']) {
    assert.equal((await request(route, { headers: { Cookie: account.cookie } })).status, 401);
    assert.equal((await request(route, { headers: { Authorization: 'Bearer ' + account.cookie.slice('sw_session='.length) } })).status, 401);
    assert.equal((await request(route, { headers: { Authorization: 'Bearer ' + account.token } })).status, 200);
  }
});

test('refresh rechecks current versions, roles, disabled users, deleted users and reused IDs', async () => {
  const account = await register();
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(account.id);
  const changedRole = await refresh(account.cookie);
  assert.equal(changedRole.status, 200);
  assert.equal(apiClaims(changedRole.data.token).role, 'admin');
  db.prepare('UPDATE users SET token_version=1 WHERE id=?').run(account.id);
  assert.equal((await refresh(account.cookie)).status, 401);
  db.prepare("UPDATE users SET token_version=0,status='disabled' WHERE id=?").run(account.id);
  assert.equal((await refresh(account.cookie)).status, 401);
  db.prepare('DELETE FROM users WHERE id=?').run(account.id);
  assert.equal((await refresh(account.cookie)).status, 401);
  db.prepare("INSERT INTO users (id,username,password_hash,role,status) VALUES (?,?,'','user','active')")
    .run(account.id, 'recreated-different');
  assert.equal((await refresh(account.cookie)).status, 401);
});

test('a banned session may refresh for appeal but all existing ban guards still apply', async () => {
  const account = await register();
  db.prepare("UPDATE users SET status='banned',ban_until='',ban_level='login',ban_reason='fixture ban' WHERE id=?").run(account.id);
  const restored = await refresh(account.cookie);
  assert.equal(restored.status, 200);
  apiClaims(restored.data.token);
  for (const route of ['/api/auth/me', '/api/v1/auth/me']) {
    const guarded = await request(route, { headers: { Authorization: 'Bearer ' + restored.data.token } });
    assert.equal(guarded.status, 403);
    assert.equal(route.includes('/v1/') ? guarded.body.error.code : guarded.body.code, 'BANNED');
  }
  const appeal = await request('/api/v1/auth/appeal', { method: 'POST', headers: { Authorization: 'Bearer ' + restored.data.token }, body: { reason: 'Please review this isolated ban.' } });
  assert.equal(appeal.status, 200);
  const login = await request('/api/auth/login', { method: 'POST', body: { username: account.username, password: account.password } });
  assert.equal(login.status, 403);
  assert.equal(login.data.code, 'BANNED');
  assert.equal(login.headers.get('set-cookie'), null);
});

test('successful password change issues a new Cookie and revokes every older Cookie/Bearer version', async () => {
  const account = await register();
  const headers = { Authorization: 'Bearer ' + account.token, Cookie: account.cookie };
  const failed = await request('/api/auth/password', { method: 'PUT', headers, body: { oldPassword: 'wrong-password', newPassword: 'new-isolated-password' } });
  assert.equal(failed.status, 400);
  assert.equal(failed.headers.get('set-cookie'), null);
  const changed = await request('/api/v1/auth/password', { method: 'PUT', headers, body: { oldPassword: account.password, newPassword: 'new-isolated-password' } });
  assert.equal(changed.status, 200);
  assert.equal(apiClaims(changed.data.token).tv, 1);
  const fresh = sessionCookie(changed);
  assert.equal(fresh.claims.tv, 1);
  assert.equal(fresh.claims.username, account.username);
  assert.equal((await request('/api/auth/me', { headers })).status, 401);
  const oldRefresh = await refresh(account.cookie);
  assert.equal(oldRefresh.status, 401);
  assert.equal(oldRefresh.headers.get('set-cookie'), null);
  assert.equal((await refresh(fresh.cookie)).status, 200);
  assert.equal((await request('/api/auth/me', { headers: { Authorization: 'Bearer ' + changed.data.token } })).status, 200);
});

test('refresh/logout require the exact non-simple header and reject untrusted Origins', async () => {
  const account = await register();
  for (const route of ['/api/auth/refresh', '/api/auth/logout']) {
    for (const extra of [{}, { 'X-Requested-With': 'XMLHttpRequest' }, { 'X-Requested-With': 'school-wall, school-wall' }]) {
      const response = await request(route, { method: 'POST', headers: { Cookie: account.cookie, Origin: baseUrl, ...extra } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    for (const origin of ['https://evil.example', 'null', '', baseUrl + '/', baseUrl.replace('127.0.0.1', 'localhost'), 'https://app.school.example/']) {
      const response = await request(route, { method: 'POST', headers: { ...csrf, Cookie: account.cookie, Origin: origin } });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    for (const origin of [undefined, baseUrl, 'https://app.school.example']) {
      const response = await request(route, { method: 'POST', headers: { ...csrf, Cookie: account.cookie, ...(origin === undefined ? {} : { Origin: origin }) } });
      assert.equal(response.status, 200);
    }
  }
});

test('JSON login/register/setup reject simple form CSRF without adding a new header requirement', async () => {
  const body = { ...adminCredentials, wall_name: 'Origin 测试墙' };
  for (const route of ['/api/auth/login', '/api/auth/register', '/api/setup']) {
    const rejected = await request(route, { method: 'POST', headers: { Origin: 'https://evil.example' }, body });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('set-cookie'), null);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const form = await request(route, { method: 'POST', headers: { 'Content-Type': type }, rawBody: JSON.stringify(body) });
      assert.equal(form.status, 415);
      assert.equal(form.headers.get('set-cookie'), null);
    }
  }
  const allowed = await request('/api/auth/login', { method: 'POST', headers: { Origin: 'https://app.school.example', 'Content-Type': 'application/json; charset=utf-8' }, body: adminCredentials });
  assert.equal(allowed.status, 200);
  sessionCookie(allowed);
});

test('logout clears the host-only cookie without requiring a valid or present Bearer', async () => {
  const account = await register();
  const expired = jwt.sign({ id: account.id, tv: 0 }, SECRET, { expiresIn: -1 });
  for (const token of [undefined, 'invalid-bearer', expired]) {
    const response = await request('/api/v1/auth/logout', { method: 'POST', headers: { ...csrf, Cookie: account.cookie, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    assert.equal(response.status, 200);
    assert.equal(typeof response.data.message, 'string');
    clearedCookie(response);
  }
  const noCookie = await request('/api/auth/logout', { method: 'POST', headers: csrf });
  assert.equal(noCookie.status, 200);
  clearedCookie(noCookie);
});

test('Secure follows req.secure and only honors forwarded HTTPS when Express trusts the proxy', async () => {
  const forwarded = { 'X-Forwarded-Proto': 'https' };
  const plain = await request('/api/auth/login', { method: 'POST', headers: { ...forwarded, Origin: baseUrl }, body: adminCredentials });
  assert.equal(plain.status, 200);
  sessionCookie(plain);
  assert.doesNotMatch(plain.headers.get('set-cookie'), /; Secure(?:;|$)/);
  const httpsOrigin = baseUrl.replace('http:', 'https:');
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { ...forwarded, Origin: httpsOrigin }, body: adminCredentials })).status, 403);
  app.set('trust proxy', 1);
  try {
    const secure = await request('/api/auth/login', { method: 'POST', headers: { ...forwarded, Origin: httpsOrigin }, body: adminCredentials });
    assert.equal(secure.status, 200);
    const session = sessionCookie(secure);
    assert.match(secure.headers.get('set-cookie'), /; Secure(?:;|$)/);
    assert.equal((await refresh(session.cookie, { ...forwarded, Origin: httpsOrigin })).status, 200);
    assert.equal((await refresh(session.cookie, { ...forwarded, 'X-Forwarded-Host': 'evil.example', Origin: 'https://evil.example' })).status, 403);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...csrf, ...forwarded, Origin: httpsOrigin } });
    clearedCookie(logout);
    assert.match(logout.headers.get('set-cookie'), /; Secure(?:;|$)/);
  } finally { app.set('trust proxy', false); }
});

// A child process gets its own DB singleton, empty DATA_DIR and temporary key.
// It uses actual HTTP routes without exposing any fixture controls in production.
async function temporaryHttpFixture() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { once } = require('node:events');
  const { initDB } = require('./db');
  const { SECRET } = require('./middleware/auth');
  const { hashPassword } = require('./lib/password');
  const { apiV1Middleware } = require('./lib/apiV1');
  const db = await initDB({ deferInitialSave: true });
  const app = express();
  app.set('trust proxy', false);
  app.use(apiV1Middleware());
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/setup', require('./routes/setup')((req, res, next) => next()));
  app.use('/api/auth', require('./routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const setup = await fetch(url + '/api/v1/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: 'sw_session=old.session.value' }, body: JSON.stringify({ temporary: true }) });
    assert.equal(setup.status, 200);
    const data = (await setup.json()).data;
    assert.equal(data.temporary, true);
    assert.match(setup.headers.get('set-cookie'), /^sw_session=;.*Expires=Thu, 01 Jan 1970/);
    assert.doesNotMatch(setup.headers.get('set-cookie'), /Max-Age=[1-9]/);
    assert.equal(jwt.verify(data.token, db.temporarySecret, { algorithms: ['HS256'] }).exp - jwt.decode(data.token).iat, 7 * 86400);
    const oldCookie = jwt.sign({ id: data.user.id, tv: 0, username: data.user.username }, SECRET, { audience: 'school-wall-session', expiresIn: '30d' });
    const refresh = await fetch(url + '/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'school-wall', Cookie: 'sw_session=' + oldCookie } });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.headers.get('set-cookie'), null);
    // Even a later password change must retain temporary-key API auth and clear cookies.
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('temporary-old-password'), data.user.id);
    const changed = await fetch(url + '/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.token }, body: JSON.stringify({ oldPassword: 'temporary-old-password', newPassword: 'temporary-new-password' }) });
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie'), /^sw_session=;.*Expires=Thu, 01 Jan 1970/);
    const changedData = await changed.json();
    assert.equal(jwt.verify(changedData.token, db.temporarySecret, { algorithms: ['HS256'] }).tv, 1);
    assert.equal((await fetch(url + '/api/auth/me', { headers: { Authorization: 'Bearer ' + changedData.token } })).status, 200);
    assert.equal(db.saveNow(), false);
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'data.db')), false);
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, '.jwt_secret')), false);
    console.log('temporary-http-ok');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.dirty = false;
    db.db.close();
  }
}

test('temporary setup clears a prior cookie, keeps API auth temporary and never persists a session/database', async () => {
  const directory = path.join(dataDir, 'temporary-http');
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', '(' + temporaryHttpFixture.toString() + ')().catch(error => { console.error(error); process.exitCode = 1; })'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: directory }, timeout: 15000,
  });
  assert.match(stdout, /temporary-http-ok/);
  assert.equal(fs.existsSync(path.join(directory, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(directory, '.jwt_secret')), false);
});
