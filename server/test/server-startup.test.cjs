'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverDirectory = path.resolve(__dirname, '..');

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const exited = once(child, 'exit');
  // On Windows kill(SIGTERM) is abrupt; ask the isolated child to invoke the
  // same production shutdown handler before retaining force-kill as a timeout.
  if (child.connected) {
    child.send({ type: 'school-wall-test-shutdown' }, error => {
      if (error && child.exitCode === null) child.kill('SIGTERM');
    });
  } else child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 7000);
  try { return (await exited)[0]; } finally { clearTimeout(force); }
}

async function startServer(t, directory, env = {}, { failFinalSave = false } = {}) {
  // Capture the OS-assigned port through IPC, without racing for a free port
  // or changing production startup behavior.
  const bootstrap = `
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };
    process.on('message', message => {
      if (message?.type === 'school-wall-test-shutdown') process.emit('SIGTERM');
    });
    ${failFinalSave ? "process.prependOnceListener('SIGTERM', () => { require('./db').getWrapper().saveNow = () => { throw new Error('simulated final save failure'); }; });" : ''}
    require('./index.js');
  `;
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: serverDirectory,
    env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1', HOST: '127.0.0.1', PORT: '0',
      NODE_ENV: 'production', TRUST_PROXY: '0', ADMIN_IP_WHITELIST: '', ALLOWED_ORIGINS: '',
      JWT_SECRET: 'school-wall-isolated-startup-test-secret', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const remember = data => { output = (output + data.toString()).slice(-16000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  t.after(() => stopServer(child));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Server did not become ready: ' + output)), 10000);
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error('Server exited before listening (' + code + ', ' + signal + '): ' + output));
    const onMessage = message => {
      if (Number.isInteger(message?.port) && message.port > 0) finish(null, message.port);
    };
    function finish(error, value) {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
      if (error) reject(error); else resolve(value);
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  }).catch(async error => {
    await stopServer(child);
    throw error;
  });
  return { child, url: 'http://127.0.0.1:' + port };
}

async function json(url, pathname, options) {
  const response = await fetch(url + pathname, { signal: AbortSignal.timeout(5000), ...options });
  const body = await response.json();
  return { response, body };
}

test('real server starts, exposes legacy/v1 APIs and discards temporary data', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-startup-test-'));
  let server;
  try {
    server = await startServer(t, directory);
    const { child, url } = server;
    const legacy = await json(url, '/api/health');
    assert.equal(legacy.response.status, 200);
    assert.equal(legacy.body.ok, true);
    assert.equal(legacy.body.data, undefined);
    assert.equal(legacy.response.headers.get('cache-control'), 'no-store');

    const health = await json(url, '/api/v1/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.data.ok, true);
    assert.equal(health.body.error, null);
    assert.equal(health.body.meta.apiVersion, '1');
    assert.equal(health.response.headers.get('x-request-id'), health.body.meta.requestId);

    const unauthorized = await json(url, '/api/v1/bug-reports');
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.error.code, 'UNAUTHENTICATED');

    const specification = await json(url, '/api/v1/openapi.json');
    assert.equal(specification.response.status, 200);
    assert.equal(specification.body.openapi, '3.0.3');
    assert.ok(specification.body.paths['/health']);
    assert.equal(specification.body.meta, undefined);

    const missing = await json(url, '/api/v1/does-not-exist');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');

    const malformed = await json(url, '/api/v1/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error.code, 'INVALID_REQUEST');

    const initial = await json(url, '/api/setup/status');
    assert.equal(initial.body.initialized, false);
    assert.equal(initial.body.testAvailable, true);
    const session = await json(url, '/api/v1/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temporary: true }),
    });
    assert.equal(session.response.status, 200);
    assert.equal(session.body.data.temporary, true);
    const headers = { Authorization: 'Bearer ' + session.body.data.token, 'X-Wall-Id': String(session.body.data.wall.id) };
    const reports = await json(url, '/api/v1/bug-reports', { headers });
    assert.equal(reports.response.status, 200);
    assert.deepEqual(reports.body.data, []);

    assert.equal(await stopServer(child), 0);
    assert.equal(fs.existsSync(path.join(directory, 'data.db')), false);
    assert.equal(fs.existsSync(path.join(directory, '.jwt_secret')), false);
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('formal setup and successful writes survive a clean server restart', { timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-restart-test-'));
  const servers = [];
  try {
    const first = await startServer(t, directory);
    servers.push(first);
    const session = await json(first.url, '/api/v1/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'startup-admin', password: 'isolated-startup-password', nickname: '测试管理员', wall_name: '持久化测试墙' }),
    });
    assert.equal(session.response.status, 200);
    const headers = { Authorization: 'Bearer ' + session.body.data.token, 'X-Wall-Id': String(session.body.data.wall.id), 'Content-Type': 'application/json' };
    const created = await json(first.url, '/api/v1/posts', {
      method: 'POST', headers, body: JSON.stringify({ content: '重启后仍应存在的帖子', category: '分享' }),
    });
    assert.equal(created.response.status, 200);
    assert.ok(created.body.data.id > 0);
    assert.equal(await stopServer(first.child), 0);
    assert.equal(fs.existsSync(path.join(directory, 'data.db')), true);

    const second = await startServer(t, directory);
    servers.push(second);
    const status = await json(second.url, '/api/v1/setup/status');
    assert.equal(status.body.data.initialized, true);
    assert.equal(status.body.data.testAvailable, false);
    const detail = await json(second.url, '/api/v1/posts/' + created.body.data.id, { headers });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.data.post.content, '重启后仍应存在的帖子');
    assert.equal(detail.body.data.post.author_id, session.body.data.user.id);
  } finally {
    for (const server of servers) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone backend exposes management APIs without serving the Vue application', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-api-only-test-'));
  let server;
  try {
    server = await startServer(t, directory, { SERVE_CLIENT: '0' });
    const { url } = server;
    const root = await fetch(url + '/', { signal: AbortSignal.timeout(5000) });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /独立后端/);
    for (const pathname of ['/login', '/assets/missing.js', '/uploads/missing.png', '/dashboard/missing']) {
      const response = await fetch(url + pathname, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 404, pathname);
    }
    const unauthorized = await json(url, '/api/admin/overview');
    assert.equal(unauthorized.response.status, 401);
    const session = await json(url, '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'api-only-admin', password: 'isolated-management-test-password', nickname: '管理测试员', wall_name: '独立后端测试墙' }),
    });
    assert.equal(session.response.status, 200);
    const headers = { Authorization: 'Bearer ' + session.body.token };
    const overview = await json(url, '/api/admin/overview?days=7', { headers });
    assert.equal(overview.response.status, 200);
    assert.equal(overview.body.schema_version, 1);
    assert.equal(overview.body.daily.length, 7);
    const ticket = await fetch(url + '/api/dashboard/session', { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
    assert.equal(ticket.status, 200);
    const cookie = ticket.headers.get('set-cookie').split(';')[0];
    const dashboard = await fetch(url + '/dashboard', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(dashboard.status, 200);
    assert.ok(dashboard.headers.get('content-type').startsWith('text/html'));
    const snapshot = await json(url, '/dashboard/api/overview?days=7', { headers: { Cookie: cookie } });
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.body.schema_version, 1);
    const csrf = await json(url, '/dashboard/api/token', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(csrf.response.status, 403);
    const blockedOrigin = await fetch(url + '/api/health', { headers: { Origin: 'https://untrusted.example' }, signal: AbortSignal.timeout(5000) });
    assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('combined hosting keeps browser routes separate from missing assets and malformed requests', {
  timeout: 20000,
  skip: !fs.existsSync(path.resolve(serverDirectory, '../client/dist/index.html')),
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-static-test-'));
  let server;
  try {
    server = await startServer(t, directory, { SERVE_CLIENT: '1' });
    const page = await fetch(server.url + '/login', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(await page.text(), /id="app"/);
    for (const pathname of ['/assets/missing.js', '/missing.css', '/rele/missing.jpg', '/dashboard/missing']) {
      const response = await fetch(server.url + pathname, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 404, pathname);
    }
    const nonNavigation = await json(server.url, '/unknown-page', { headers: { Accept: 'application/json' } });
    assert.equal(nonNavigation.response.status, 404);
    const invalidPath = await json(server.url, '/%ZZ');
    assert.equal(invalidPath.response.status, 400);
    const invalidEncoding = await json(server.url, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=unknown' }, body: '{}',
    });
    assert.equal(invalidEncoding.response.status, 415);
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed final database save exits unsuccessfully instead of reporting a clean stop', { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-shutdown-error-test-'));
  let server;
  try {
    server = await startServer(t, directory, { SERVE_CLIENT: '0' }, { failFinalSave: true });
    assert.equal(await stopServer(server.child), 1);
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
