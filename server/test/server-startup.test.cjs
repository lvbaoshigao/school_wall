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

async function startServer(t, directory) {
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
    require('./index.js');
  `;
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: serverDirectory,
    env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1', HOST: '127.0.0.1', PORT: '0',
      NODE_ENV: 'production', TRUST_PROXY: '0', ADMIN_IP_WHITELIST: '', ALLOWED_ORIGINS: '',
      JWT_SECRET: 'school-wall-isolated-startup-test-secret' },
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
