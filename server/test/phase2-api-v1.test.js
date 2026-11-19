'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
process.env.JWT_SECRET = 'phase2-api-v1-in-memory-test-secret';
process.env.ADMIN_IP_WHITELIST = '';
const { apiV1Middleware, apiV1Router, getApiV1Capabilities } = require('../lib/apiV1');
const { authRequired, wallContext, SECRET } = require('../middleware/auth');
const { whitelistGuard } = require('../lib/ipguard');
const sqlReady = initSqlJs();

function wrap(memory) {
  return {
    exec(sql) { memory.run(sql); },
    prepare(sql) {
      const all = params => {
        const statement = memory.prepare(sql);
        try { statement.bind(params); const rows = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
        finally { statement.free(); }
      };
      return { get(...params) { return all(params)[0]; }, all(...params) { return all(params); }, run(...params) { memory.run(sql, params); return { changes: memory.getRowsModified() }; } };
    },
  };
}

async function fixture(t, { quota = Infinity, duplicateAdapter = false, document = 'valid' } = {}) {
  const SQL = await sqlReady;
  const memory = new SQL.Database();
  memory.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user', status TEXT DEFAULT 'active', ban_until TEXT DEFAULT '', ban_reason TEXT DEFAULT '', ban_level TEXT DEFAULT 'login', token_version INTEGER DEFAULT 0);
    CREATE TABLE user_permissions (user_id INTEGER, wall_id INTEGER, perm TEXT, effect TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE walls (id INTEGER PRIMARY KEY, status TEXT DEFAULT 'active');
    CREATE TABLE wall_members (wall_id INTEGER, user_id INTEGER, wall_role TEXT DEFAULT 'member', status TEXT DEFAULT 'active', wall_ban_until TEXT DEFAULT '', wall_ban_reason TEXT DEFAULT '');
    INSERT INTO users (id,username,role) VALUES (1,'test-user','user'),(2,'test-root','super_admin');
    INSERT INTO users (id,username,status,ban_level,ban_reason) VALUES (3,'chat-ban','banned','chat','test reason'),(4,'login-ban','banned','login','test reason'),(5,'post-ban','banned','post','test reason');
    INSERT INTO walls (id) VALUES (1),(2);
    INSERT INTO wall_members (wall_id,user_id) VALUES (1,1),(1,2);
  `);
  const db = wrap(memory);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-phase2-api-v1-'));
  const openApiPath = path.join(directory, 'openapi.json');
  const openApi = { openapi: '3.1.0', info: { title: 'Isolated API fixture', version: '1' }, paths: {} };
  if (document === 'valid') fs.writeFileSync(openApiPath, JSON.stringify(openApi, null, 2) + String.fromCharCode(10));
  if (document === 'invalid') fs.writeFileSync(openApiPath, '{invalid');
  let healthCalls = 0;
  let protectedCalls = 0;
  let requests = 0;
  const app = express();
  app.use(cors({ origin(origin, cb) { cb(null, !origin || origin === 'https://allowed.example'); }, credentials: true }));
  app.use(apiV1Middleware());
  if (duplicateAdapter) app.use(apiV1Middleware());
  app.get('/api/health', (req, res) => { healthCalls++; res.json({ ok: true }); });
  app.use('/api/upload/image', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '128kb' }));
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
    next(error);
  });
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(whitelistGuard);
  app.use('/api', (req, res, next) => {
    requests++;
    if (requests > quota) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'slow down' }); }
    next();
  });
  app.use('/api', apiV1Router({ openApiPath }));
  app.get('/api/probe/:value?', (req, res) => res.json({ original: req.originalUrl, canonical: req.apiCanonicalPath || null, url: req.url, query: req.query, value: req.params.value || null }));
  app.get('/api/votes', (req, res) => res.json(['legacy votes']));
  app.get('/api/object', (req, res) => res.send({ hello: 'world', meta: { legacy: true } }));
  app.get('/api/raw-json', (req, res) => res.type('application/json').send(JSON.stringify([1, 2])));
  app.get('/api/nested-json', (req, res) => res.json({ data: 'original', error: null, meta: { legacy: true } }));
  app.get('/api/error/:status', (req, res) => res.status(Number(req.params.status)).json({ error: 'denied', ...(req.query.code ? { code: req.query.code } : {}), scope: 'wall', until: 'test-until' }));
  app.get('/api/error-object', (req, res) => res.status(403).json({ error: { code: 'CUSTOM_DENIAL', message: 'nested denial', remaining: 5 }, reason: 'test reason' }));
  app.get('/api/json-problem', (req, res) => res.status(422).type('application/problem+json').send(JSON.stringify({ error: 'validation failed' })));
  app.get('/api/text', (req, res) => res.type('text/plain').send('plain text'));
  app.get('/api/binary', (req, res) => res.type('application/octet-stream').send(Buffer.from([0, 255, 10, 13])));
  app.get('/api/stream', (req, res) => { res.type('application/octet-stream'); Readable.from([Buffer.from([0, 1]), Buffer.from([2, 255])]).pipe(res); });
  app.get('/api/attachment', (req, res) => res.attachment('test.json').json({ exported: true }));
  app.get('/api/empty', (req, res) => res.status(204).json({ ignored: true }));
  app.get('/api/auth/me', authRequired, (req, res) => res.json({ id: req.user.id }));
  app.post('/api/auth/appeal', authRequired, (req, res) => res.json({ accepted: true }));
  app.all('/api/messages', authRequired, (req, res) => { protectedCalls++; res.json({ messages: [] }); });
  app.get('/api/wall-protected', authRequired, wallContext, (req, res) => res.json({ wallId: req.wallId }));
  app.post('/api/upload/image', (req, res) => res.json({ characters: req.body.content.length }));
  app.post('/api/body', (req, res) => res.json(req.body));
  app.get('/api/admin/probe', (req, res) => { protectedCalls++; res.json({ private: true }); });
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((error, req, res, next) => res.status(500).json({ error: 'internal test error' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function request(url, { method = 'GET', body, raw, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
      const outgoing = { ...headers };
      if (encoded !== undefined) { outgoing['Content-Type'] ||= 'application/json'; outgoing['Content-Length'] = Buffer.byteLength(encoded); }
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers: outgoing }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { const buffer = Buffer.concat(chunks); const text = buffer.toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, buffer, text, json }); });
      });
      req.on('error', reject); req.end(encoded);
    });
  }
  function bearer(id, extra = {}) { return { Authorization: 'Bearer ' + jwt.sign({ id, tv: 0, ...extra }, SECRET, { algorithm: 'HS256', expiresIn: '10m' }) }; }
  function settings(mode, entries) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('ip_whitelist_mode', mode);
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('admin_ip_whitelist', JSON.stringify(entries));
  }
  return { request, db, bearer, settings, openApi, openApiPath, counters: () => ({ healthCalls, protectedCalls, requests }) };
}

function assertMeta(response) {
  assert.equal(response.headers['x-api-version'], '1');
  assert.match(response.headers['x-request-id'], /^[a-f0-9]{32}$/);
  assert.equal(response.json.meta.apiVersion, '1');
  assert.equal(response.json.meta.requestId, response.headers['x-request-id']);
}

test('phase2 v1: legacy API responses and headers remain unchanged', async t => {
  const f = await fixture(t);
  const legacy = await f.request('/api/object');
  assert.deepEqual(legacy.json, { hello: 'world', meta: { legacy: true } });
  assert.equal(legacy.headers['x-api-version'], undefined);
  assert.equal(legacy.headers['x-request-id'], undefined);
  assert.deepEqual((await f.request('/api/votes')).json, ['legacy votes']);
  assert.equal((await f.request('/api/capabilities')).status, 404);
});

test('phase2 v1: rewrite preserves original URL, query bytes and one parameter decode', async t => {
  const f = await fixture(t);
  const url = '/API/V1/probe/%E5%AD%A6%E6%A0%A1?q=a%2Fb&literal=%252e';
  const res = await f.request(url);
  assert.equal(res.status, 200); assertMeta(res);
  assert.equal(res.json.data.original, url);
  assert.equal(res.json.data.canonical, '/api/probe/%E5%AD%A6%E6%A0%A1');
  assert.equal(res.json.data.url, '/api/probe/%E5%AD%A6%E6%A0%A1?q=a%2Fb&literal=%252e');
  assert.equal(res.json.data.value, '学校');
  assert.deepEqual(res.json.data.query, { q: 'a/b', literal: '%2e' });
});

test('phase2 v1: success envelopes preserve original objects, arrays and original envelope-shaped data', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/v1/object')).json.data, { hello: 'world', meta: { legacy: true } });
  assert.deepEqual((await f.request('/api/v1/raw-json')).json.data, [1, 2]);
  const nested = await f.request('/api/v1/nested-json');
  assert.deepEqual(nested.json.data, { data: 'original', error: null, meta: { legacy: true } });
  assert.equal(nested.json.error, null); assertMeta(nested);
});

test('phase2 v1: request IDs are random per request and ignore user-supplied tracing headers', async t => {
  const f = await fixture(t);
  const headers = { 'X-Request-ID': 'attacker-chosen', 'X-API-Version': '2' };
  const a = await f.request('/api/v1/object', { headers });
  const b = await f.request('/api/v1/object', { headers });
  assertMeta(a); assertMeta(b); assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
  assert.doesNotMatch(a.text, /attacker-chosen/);
});

test('phase2 v1: HTTP errors preserve status and business details with stable default codes', async t => {
  const f = await fixture(t);
  for (const [status, code] of [[400, 'INVALID_REQUEST'], [401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [405, 'METHOD_NOT_ALLOWED'], [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA_TYPE'], [422, 'VALIDATION_ERROR'], [425, 'TOO_EARLY'], [429, 'RATE_LIMITED'], [500, 'INTERNAL_ERROR'], [503, 'SERVICE_UNAVAILABLE'], [507, 'INSUFFICIENT_STORAGE']]) {
    const res = await f.request('/api/v1/error/' + status);
    assert.equal(res.status, status); assertMeta(res);
    assert.equal(res.json.data, null); assert.equal(res.json.error.code, code);
    assert.equal(res.json.error.message, 'denied'); assert.deepEqual(res.json.error.details, { scope: 'wall', until: 'test-until' });
  }
  assert.equal((await f.request('/api/v1/error/403?code=BANNED')).json.error.code, 'BANNED');
  const nested = await f.request('/api/v1/error-object');
  assert.equal(nested.json.error.code, 'CUSTOM_DENIAL'); assert.equal(nested.json.error.message, 'nested denial');
  assert.deepEqual(nested.json.error.details, { remaining: 5, reason: 'test reason' });
  assert.equal((await f.request('/api/v1/json-problem')).json.error.code, 'VALIDATION_ERROR');
});

test('phase2 v1: text, binary, streamed, attachment and no-content responses keep native semantics', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/v1/text')).text, 'plain text');
  const binary = await f.request('/api/v1/binary');
  assert.deepEqual(binary.buffer, Buffer.from([0, 255, 10, 13])); assert.equal(Number(binary.headers['content-length']), 4);
  assert.deepEqual((await f.request('/api/v1/stream')).buffer, Buffer.from([0, 1, 2, 255]));
  const download = await f.request('/api/v1/attachment');
  assert.deepEqual(download.json, { exported: true }); assert.match(download.headers['content-disposition'], /^attachment/);
  const empty = await f.request('/api/v1/empty'); assert.equal(empty.status, 204); assert.equal(empty.text, '');
  const head = await f.request('/api/v1/object', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
});

test('phase2 v1: discovery is public protocol metadata with a fresh mutable copy only', async t => {
  const f = await fixture(t);
  const root = await f.request('/api/v1'); const caps = await f.request('/api/v1/capabilities/');
  assert.equal(root.status, 200); assert.deepEqual(root.json.data, caps.json.data); assertMeta(caps);
  assert.equal(caps.json.data.authentication.wallHeader, 'X-Wall-Id');
  assert.deepEqual(caps.json.data.pagination.messages.cursors, ['before', 'after', 'around_id']);
  assert.equal(caps.json.data.limits.jsonBodyBytes, 131072);
  assert.doesNotMatch(caps.text, /test-user|test-root|JWT_SECRET|token_version|password_hash/);
  const copy = getApiV1Capabilities(); copy.pagination.messages.cursors.push('unsafe');
  assert.equal(getApiV1Capabilities().pagination.messages.cursors.includes('unsafe'), false);
  assert.equal((await f.request('/api/v1/capabilities', { method: 'POST', body: {} })).status, 405);
});

test('phase2 v1: OpenAPI is raw JSON with native HEAD, not an envelope', async t => {
  const f = await fixture(t); const res = await f.request('/API/V1/OPENAPI.JSON');
  assert.equal(res.status, 200); assert.deepEqual(res.json, f.openApi);
  assert.equal(res.json.meta, undefined); assert.equal(res.text, fs.readFileSync(f.openApiPath, 'utf8'));
  assert.equal(res.headers['x-api-version'], '1');
  const head = await f.request('/api/v1/openapi.json', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
});

test('phase2 v1: missing and corrupt OpenAPI documents fail clearly without breaking other APIs', async t => {
  for (const document of ['missing', 'invalid']) {
    const f = await fixture(t, { document });
    assert.equal((await f.request('/api/v1/object')).status, 200);
    const res = await f.request('/api/v1/openapi.json');
    assert.equal(res.status, 503); assert.equal(res.json.error.code, 'OPENAPI_UNAVAILABLE');
    assert.doesNotMatch(res.text, /ENOENT|school-wall-phase2-api-v1/);
  }
});

test('phase2 v1: unsupported versions cannot reach health or any protected handler', async t => {
  const f = await fixture(t);
  for (const version of ['v2', 'V9', 'v0', 'v01', 'v1.0', 'v-1', 'vfoo', 'v']) {
    const res = await f.request('/api/' + version + '/health');
    assert.equal(res.status, 404, version); assert.equal(res.json.error.code, 'UNSUPPORTED_API_VERSION');
    assert.deepEqual(res.json.error.details.supportedVersions, ['1']);
  }
  assert.equal(f.counters().healthCalls, 0);
});

test('phase2 v1: unsafe encoded paths are rejected without decoding or reaching real routes', async t => {
  const f = await fixture(t);
  for (const suffix of ['/admin%2fprobe', '/admin%5cprobe', '/%61dmin/probe', '/admin/../probe', '/admin/./probe', '/admin/%2e%2e/probe', '/admin/%252e%252e/probe', '/admin/%25252fprobe', '/admin/%ZZ', '/admin/%C0%AF', '/admin/%00', '/admin//probe']) {
    const res = await f.request('/api/v1' + suffix);
    assert.equal(res.status, 400, suffix); assert.equal(res.json.error.code, 'INVALID_API_PATH');
  }
  for (const url of ['/%61pi/v1/admin/probe', '/api/%76%31/admin/probe']) {
    const res = await f.request(url); assert.equal(res.status, 400); assert.equal(res.json.error.code, 'INVALID_API_PATH');
  }
  assert.equal(f.counters().protectedCalls, 0);
});

test('phase2 v1: discovery docs and version errors all obey the real IP whitelist guard', async t => {
  const f = await fixture(t); f.settings('all', ['192.0.2.1']);
  for (const url of ['/api/v1', '/api/v1/capabilities', '/api/v1/openapi.json', '/api/v2/health', '/api/v1/admin/%2e%2e/probe']) {
    const res = await f.request(url); assert.equal(res.status, 403, url); assert.equal(res.json.error.code, 'FORBIDDEN');
  }
  assert.equal(f.counters().requests, 0);
  f.settings('admin', ['192.0.2.1']);
  assert.equal((await f.request('/API/V1/ADMIN/probe')).status, 403);
  assert.equal((await f.request('/api/v1/capabilities')).status, 200);
});

test('phase2 v1: legacy and v1 requests share the exact same limiter chain', async t => {
  const f = await fixture(t, { quota: 2 });
  assert.equal((await f.request('/api/object')).status, 200);
  assert.equal((await f.request('/api/v1/object')).status, 200);
  const limited = await f.request('/api/v1/capabilities');
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60'); assert.equal(limited.json.error.code, 'RATE_LIMITED');
});

test('phase2 v1: body parsing limits and invalid JSON reuse the original parser chain', async t => {
  const f = await fixture(t); const content = 'x'.repeat(140 * 1024);
  const res = await f.request('/api/v1/body', { method: 'POST', body: { content } });
  assert.equal(res.status, 413); assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await f.request('/api/body', { method: 'POST', body: { content } })).status, 413);
  const upload = await f.request('/api/v1/upload/image', { method: 'POST', body: { content } });
  assert.equal(upload.status, 200); assert.equal(upload.json.data.characters, content.length);
  const invalid = await f.request('/api/v1/body', { method: 'POST', raw: '{invalid' });
  assert.equal(invalid.status, 400); assert.equal(invalid.json.error.code, 'INVALID_REQUEST');
});

test('phase2 v1: existing authentication role and wall boundaries remain enforced', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/v1/auth/me')).status, 401);
  const valid = await f.request('/api/v1/auth/me', { headers: f.bearer(1) });
  assert.equal(valid.status, 200); assert.equal(valid.json.data.id, 1);
  assert.equal((await f.request('/api/v1/wall-protected', { headers: { ...f.bearer(1), 'X-Wall-Id': '2' } })).status, 403);
  assert.equal((await f.request('/api/v1/wall-protected', { headers: { ...f.bearer(1), 'X-Wall-Id': '1' } })).status, 200);
  f.db.prepare('UPDATE users SET token_version=1 WHERE id=1').run();
  assert.equal((await f.request('/api/v1/auth/me', { headers: f.bearer(1) })).status, 401);
});

test('phase2 v1: canonical paths preserve chat/post/login bans and the appeal-only exception', async t => {
  const f = await fixture(t);
  for (const url of ['/api/messages', '/api/v1/messages', '/API/V1/MESSAGES']) {
    const res = await f.request(url, { headers: f.bearer(3) }); assert.equal(res.status, 403);
    if (url.toLowerCase().includes('/v1/')) { assert.equal(res.json.error.code, 'BANNED'); assert.equal(res.json.error.details.reason, 'test reason'); }
  }
  assert.equal((await f.request('/api/v1/messages', { method: 'POST', headers: f.bearer(5), body: {} })).status, 403);
  assert.equal((await f.request('/api/v1/auth/me', { headers: f.bearer(4) })).status, 403);
  const appeal = await f.request('/API/V1/AUTH/APPEAL', { method: 'POST', headers: f.bearer(4), body: {} });
  assert.equal(appeal.status, 200); assert.equal(appeal.json.data.accepted, true);
});

test('phase2 v1: CORS remains explicit and never becomes wildcard through the adapter', async t => {
  const f = await fixture(t);
  const denied = await f.request('/api/v1/capabilities', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const allowed = await f.request('/api/v1/capabilities', { headers: { Origin: 'https://allowed.example' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://allowed.example');
  assert.match(allowed.headers['access-control-expose-headers'], /X-Request-ID/);
});

test('phase2 v1: accidental duplicate adapter mounting cannot decode or wrap twice', async t => {
  const f = await fixture(t, { duplicateAdapter: true });
  const res = await f.request('/api/v1/object');
  assert.deepEqual(res.json.data, { hello: 'world', meta: { legacy: true } });
  assert.equal((await f.request('/api/v1/v1/admin/probe')).status, 404);
  assert.equal(f.counters().protectedCalls, 0);
});
