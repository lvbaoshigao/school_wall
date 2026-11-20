'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'phase3-auth-performance-isolated-test-key';
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const express = require('express');
const http = require('node:http');
const { authRequired, getRateUserId, settleBan, settleWallBan, SECRET } = require('../middleware/auth');
const { getRequestAuth, getRateUserId: getRateUserIdWithSecret } = require('../lib/requestAuth');
const sqlReady = initSqlJs();

function countedDb(SQL, userRows = [{ id: 1, status: 'active', role: 'super_admin', token_version: 0, ban_until: '', ban_reason: '', ban_level: 'login' }]) {
  const memory = new SQL.Database();
  memory.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT, role TEXT, token_version INTEGER, ban_until TEXT, ban_reason TEXT, ban_level TEXT);
    CREATE TABLE user_permissions (user_id INTEGER, wall_id INTEGER, perm TEXT, effect TEXT);
    CREATE TABLE walls (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE wall_members (wall_id INTEGER, user_id INTEGER, wall_role TEXT, status TEXT, wall_ban_until TEXT, wall_ban_reason TEXT);
  `);
  for (const user of userRows) memory.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',
    [user.id, user.status, user.role, user.token_version, user.ban_until || '', user.ban_reason || '', user.ban_level || 'login']);
  const counts = new Map();
  const normalize = sql => sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const db = {
    memory, counts, overrideFailure: false, dirty: 0,
    markDirty() { this.dirty++; },
    exec(sql) { memory.run(sql); },
    prepare(sql) {
      const normalized = normalize(sql);
      const group = normalized.includes('from users where id = ?') ? 'user' :
        normalized.includes('from user_permissions') ? 'overrides' : normalized.includes('wall_members') ? 'wall_members' :
          normalized.includes('from walls') ? 'walls' : normalized;
      const execute = (params, mode) => {
        counts.set(group, (counts.get(group) || 0) + 1);
        if (group === 'overrides' && db.overrideFailure) throw new Error('injected permission query failure');
        const statement = memory.prepare(sql);
        try {
          if (params.length) statement.bind(params);
          if (mode === 'get') return statement.step() ? statement.getAsObject() : undefined;
          const rows = []; while (statement.step()) rows.push(statement.getAsObject()); return rows;
        } finally { statement.free(); }
      };
      return {
        get(...params) { return execute(params, 'get'); },
        all(...params) { return execute(params, 'all'); },
        run(...params) {
          counts.set(group, (counts.get(group) || 0) + 1);
          if (group === 'overrides' && db.overrideFailure) throw new Error('injected permission query failure');
          memory.run(sql, params);
          return { changes: memory.getRowsModified() };
        },
      };
    },
  };
  return db;
}

function observeVerify(t) {
  const original = jwt.verify;
  let calls = 0;
  jwt.verify = function (...args) { calls++; return original.apply(this, args); };
  t.after(() => { jwt.verify = original; });
  return () => calls;
}

function token(secret = SECRET, { id = 1, tv = 0, ...extra } = {}, options = { expiresIn: '1h' }) {
  return jwt.sign({ id, tv, ...extra }, secret, options);
}

function request(server, method, pathname, bearer) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: pathname,
      headers: bearer ? { Authorization: 'Bearer ' + bearer } : {}, agent: false }, res => {
      const chunks = []; res.on('data', value => chunks.push(value));
      res.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject); req.end();
  });
}

async function appFixture(t, db, bearer) {
  const app = express();
  app.use((req, res, next) => { req.db = db; next(); });
  app.use((req, res, next) => {
    if (req.path === '/auth/after-await') setImmediate(() => db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=1').run());
    next();
  });
  app.use('/rate', (req, res, next) => {
    req.rateUser = getRateUserId(req, db);
    req.rateUserAgain = getRateUserId(req, db);
    next();
  });
  app.get('/rate/one-auth', authRequired, (req, res) => res.json({ id: req.user.id, rateUser: req.rateUser, again: req.rateUserAgain }));
  app.get('/rate/two-auth', authRequired, (req, res, next) => {
    req.firstPrincipal = req.user;
    req.user.role = 'poisoned-route-role';
    authRequired(req, res, () => res.json({ id: req.user.id, role: req.user.role, samePrincipal: req.firstPrincipal === req.user, firstRole: req.firstPrincipal.role }));
  });
  app.get('/plain', authRequired, (req, res) => res.json({ id: req.user.id }));
  app.get('/auth/expiry-await', authRequired, async (req, res, next) => {
    await new Promise(resolve => setTimeout(resolve, 1150));
    authRequired(req, res, () => res.json({ id: req.user.id }));
  });
  app.get('/permission/lazy', authRequired, (req, res) => res.json({ ok: true }));
  app.get('/permission/check', authRequired, (req, res) => res.json({ allowed: req.can('global.user.manage') }));
  app.get('/permission/fail', authRequired, (req, res) => res.json({ allowed: req.can('global.user.manage') }));
  app.get('/auth/after-await', authRequired, async (req, res, next) => {
    await new Promise(resolve => setImmediate(resolve));
    authRequired(req, res, () => res.json({ id: req.user.id }));
  });
  app.use((error, req, res, next) => res.status(500).json({ error: 'permission service unavailable' }));
  const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.memory.close(); });
  return { server, bearer };
}

test('phase3 auth: expired ban settlement marks the database dirty only when an update succeeds', () => {
  for (const changes of [1, 0]) {
    let dirty = 0;
    const db = {
      prepare() { return { run() { return { changes }; } }; },
      markDirty() { dirty++; },
    };
    const user = { id: 1, status: 'banned', ban_until: '2000-01-01T00:00:00.000Z', ban_reason: 'expired', ban_level: 'login' };
    assert.equal(settleBan(db, user).banned, false);
    assert.equal(dirty, changes > 0 ? 1 : 0);
    const member = { status: 'banned', wall_ban_until: '2000-01-01T00:00:00.000Z', wall_ban_reason: 'expired' };
    assert.equal(settleWallBan(db, 2, 1, member).banned, false);
    assert.equal(dirty, changes > 0 ? 2 : 0);
  }
  const legacyDb = { prepare() { return { run() { return { changes: 1 }; } }; } };
  assert.equal(settleBan(legacyDb, { id: 1, status: 'banned', ban_until: '2000-01-01T00:00:00.000Z' }).banned, false);
});

test('phase3 auth: invalid limiter credentials and database errors never get a user quota', async () => {
  const SQL = await sqlReady; const db = countedDb(SQL);
  assert.equal(getRateUserId({ headers: { authorization: 'Bearer ' + token(SECRET, { aud: 'dashboard' }) } }, db), null);
  assert.equal(db.counts.get('user') || 0, 0, 'dashboard tickets are rejected before querying an API user');
  const brokenDb = { prepare() { throw new Error('database unavailable'); } };
  assert.equal(getRateUserId({ headers: { authorization: 'Bearer ' + token() } }, brokenDb), null);
});

test('phase3 auth: limiter and first auth share one user query and two synchronous limiter keys', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL);
  const bearer = token(); const app = await appFixture(t, db, bearer);
  const response = await request(app.server, 'GET', '/rate/one-auth', bearer);
  assert.equal(response.status, 200);
  assert.equal(response.body.rateUser, 1); assert.equal(response.body.again, 1);
  assert.equal(db.counts.get('user'), 1, 'rate identity database row is synchronously reused by first authRequired');
  assert.equal(verifyCalls(), 1, 'same HTTP request has one HS256 verification');
  assert.equal(db.counts.get('overrides') || 0, 0, 'ordinary profile reads do not load permission overrides');
});

test('phase3 auth: later authRequired refreshes account row while sharing claims and principal mutations do not poison cache', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL);
  const bearer = token(); const app = await appFixture(t, db, bearer);
  const response = await request(app.server, 'GET', '/rate/two-auth', bearer);
  assert.equal(response.status, 200);
  assert.equal(response.body.samePrincipal, false);
  assert.equal(response.body.firstRole, 'poisoned-route-role');
  assert.equal(response.body.role, 'super_admin');
  assert.equal(db.counts.get('user'), 2, 'second authentication rereads current database state');
  assert.equal(verifyCalls(), 1, 'repeated authentication reuses verified claims');
});

test('phase3 auth: token version revocation during an async boundary rejects the recheck', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL);
  const app = await appFixture(t, db, token());
  // A preceding setImmediate revokes tv after initial authentication but before KDF-like work resolves.
  const result = await request(app.server, 'GET', '/auth/after-await', token());
  assert.equal(result.status, 401);
  assert.equal(verifyCalls(), 1, 'same-request valid JWT signature remains cached after revocation');
  assert.equal(db.counts.get('user'), 2, 'post-await auth check rereads status and token version');
});

test('phase3 auth: rate snapshot expires at the microtask boundary and a later limiter lookup sees token revocation', async () => {
  const SQL = await sqlReady; const db = countedDb(SQL);
  const req = { headers: { authorization: 'Bearer ' + token() } };
  assert.equal(getRateUserId(req, db), 1);
  await new Promise(resolve => setImmediate(resolve));
  db.prepare('UPDATE users SET token_version=1 WHERE id=1').run();
  assert.equal(getRateUserId(req, db), null);
  assert.equal(db.counts.get('user'), 2, 'expired limiter snapshot is reloaded before assigning user quota');
});

test('phase3 auth: changed secret cannot reuse claims or a rate identity cached for another secret', async () => {
  const SQL = await sqlReady; const db = countedDb(SQL);
  const secretA = 'request-cache-secret-a-phase3'; const secretB = 'request-cache-secret-b-phase3';
  const req = { headers: { authorization: 'Bearer ' + token(secretA) } };
  assert.equal(getRateUserIdWithSecret(req, db, secretA), 1);
  assert.equal(getRateUserIdWithSecret(req, db, secretB), null);
  assert.equal(db.counts.get('user'), 1);
  const auth = getRequestAuth(req, db, secretB);
  assert.equal(auth.claims, null);
  assert.equal(auth.error, 'invalid');
});

test('phase3 auth: cached JWT expiry and not-before are checked again after async time passes', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL);
  const expiresSoon = token(SECRET, { id: 1, tv: 0 }, { expiresIn: '1s' });
  const req = { headers: { authorization: 'Bearer ' + expiresSoon } };
  assert.ok(getRequestAuth(req, db, SECRET).claims);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(getRequestAuth(req, db, SECRET).claims, null, 'signature cache never extends JWT lifetime');
  assert.equal(getRequestAuth(req, db, SECRET).error, 'invalid');
  const notBefore = token(SECRET, { id: 1, tv: 0, nbf: Math.floor(Date.now() / 1000) + 2 }, { expiresIn: '1h' });
  const laterReq = { headers: { authorization: 'Bearer ' + notBefore } };
  assert.equal(getRequestAuth(laterReq, db, SECRET).claims, null);
  assert.equal(verifyCalls(), 2, 'each distinct request token is signature-verified once');
});

test('phase3 auth: the actual authRequired middleware rejects a token expiring during awaited downstream work', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL);
  const app = await appFixture(t, db, token());
  const shortToken = jwt.sign({ id: 1, tv: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1s' });
  const response = await request(app.server, 'GET', '/auth/expiry-await', shortToken);
  assert.equal(response.status, 401);
  assert.equal(verifyCalls(), 1);
  assert.equal(db.counts.get('user'), 1);
});

test('phase3 auth: distinct HTTP requests never share cached user rows or signatures', async t => {
  const verifyCalls = observeVerify(t);
  const SQL = await sqlReady; const db = countedDb(SQL); const bearer = token();
  const app = await appFixture(t, db, bearer);
  assert.equal((await request(app.server, 'GET', '/rate/one-auth', bearer)).status, 200);
  assert.equal((await request(app.server, 'GET', '/rate/one-auth', bearer)).status, 200);
  assert.equal(db.counts.get('user'), 2);
  assert.equal(verifyCalls(), 2);
});

test('phase3 auth: override query is lazy, reused within one auth call and refreshed by reauthentication', async t => {
  const SQL = await sqlReady; const db = countedDb(SQL);
  const bearer = token(); const app = await appFixture(t, db, bearer);
  const plain = await request(app.server, 'GET', '/permission/lazy', bearer);
  assert.equal(plain.status, 200);
  assert.equal(db.counts.get('overrides') || 0, 0);
  assert.equal((await request(app.server, 'GET', '/permission/check', bearer)).body.allowed, true);
  assert.equal(db.counts.get('overrides'), 1);
  db.overrideFailure = true;
  const failed = await request(app.server, 'GET', '/permission/fail', bearer);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, 'permission service unavailable');
});

test('phase3 auth: request permission snapshots are rebuilt after repeat auth and do not leak across requests', async t => {
  const SQL = await sqlReady; const db = countedDb(SQL);
  const app = await appFixture(t, db, token());
  app.server.removeAllListeners('request');
  // A standalone Express app proves permission rows are read once on-demand per request.
  const local = express();
  local.use((req, res, next) => { req.db = db; next(); });
  local.get('/', authRequired, (req, res) => {
    const before = req.can('global.user.manage');
    db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (1,0,'global.user.manage','deny')").run();
    authRequired(req, res, () => res.json({ before, after: req.can('global.user.manage') }));
  });
  const server = await new Promise(resolve => { const listening = local.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const response = await request(server, 'GET', '/', token());
  assert.deepEqual(response.body, { before: true, after: false });
  assert.equal(db.counts.get('overrides'), 2, 'one successful override query per authRequired permission view');
});
