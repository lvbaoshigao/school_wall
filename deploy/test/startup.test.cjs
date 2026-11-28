'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { parseArgs, dependencyFingerprint, processIdentity } = require('../development.cjs');
const root = path.resolve(__dirname, '../..');
const linux = process.platform === 'linux';

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-launcher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function execute(args, options = {}) {
  const child = spawn(args[0], args.slice(1), { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  const remember = data => { output = (output + data.toString()).slice(-32000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, finished, output: () => output };
}

async function waitOutput(process, text, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (process.output().includes(text)) return;
    if (process.child.exitCode !== null || process.child.signalCode !== null) break;
    await delay(50);
  }
  throw new Error('Did not observe ' + text + ': ' + process.output());
}

function cleanupProcess(t, process) {
  t.after(async () => {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 18000);
    try { await process.finished; } finally { clearTimeout(timer); }
  });
}

function fixture(t) {
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, 'deploy'));
  fs.mkdirSync(path.join(directory, 'server'));
  for (const file of ['deploy/development.cjs', 'deploy/check-runtime.cjs', 'deploy/check-idle.cjs', 'deploy.sh', 'start.sh', 'stop.sh']) {
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, 'server', file), path.join(directory, 'server', file));
  }
  fs.symlinkSync(path.join(root, 'server', 'node_modules'), path.join(directory, 'server', 'node_modules'), 'dir');
  return directory;
}

test('launch options reject invalid ports and conflicting modes before startup', () => {
  for (const value of ['0', '-1', '65536', '3e3', '3.5', '3000x']) {
    assert.throws(() => parseArgs(['start', '--port', value]), /integer between/);
  }
  assert.throws(() => parseArgs(['start', '--port', '5173']), /different ports/);
  assert.throws(() => parseArgs(['start', '--install', '--skip-install']), /cannot be combined/);
  assert.throws(() => parseArgs(['start', '--unexpected']), /Unknown argument/);
  assert.equal(parseArgs(['start', '--backend-only', '--port', '5173']).backendOnly, true);
  assert.equal(parseArgs(['start', '--port', '03000']).port, 3000);
});

test('dependency fingerprint changes when a lockfile changes', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
  const before = dependencyFingerprint(directory);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  assert.notEqual(dependencyFingerprint(directory), before);
});

test('API-only deploy preflight needs no client tree and does not initialize data', { skip: !linux, timeout: 10000 }, async t => {
  const directory = fixture(t);
  const data = path.join(directory, 'private-data');
  const result = await execute(['bash', path.join(directory, 'deploy.sh'), '--api-only', '--check'], { cwd: os.tmpdir(), env: { ...process.env, DATA_DIR: data } }).finished;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /server dependencies resolve OK/);
  assert.match(result.output, /No application was started/);
  assert.equal(fs.existsSync(path.join(directory, 'client')), false);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(path.join(directory, '.cache')), false);
});

test('development preflight is read-only and accepts a backend-only checkout', { skip: !linux, timeout: 10000 }, async t => {
  const directory = fixture(t);
  const data = path.join(directory, 'private-data');
  const port = await freePort();
  const result = await execute(['bash', path.join(directory, 'start.sh'), '--backend-only', '--check', '--port', String(port)], { cwd: os.tmpdir(), env: { ...process.env, DATA_DIR: data } }).finished;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Preflight passed/);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(path.join(directory, '.cache')), false);
});

test('occupied ports fail before installation or application writes', { skip: !linux, timeout: 10000 }, async t => {
  const directory = fixture(t);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const data = path.join(directory, 'private-data');
  const result = await execute(['bash', path.join(directory, 'start.sh'), '--backend-only', '--port', String(socket.address().port)], { env: { ...process.env, DATA_DIR: data } }).finished;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /already in use|unavailable/);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(path.join(directory, '.cache')), false);
});

test('stop refuses an unrelated PID even when its start time matches', { skip: !linux, timeout: 10000 }, async t => {
  const directory = fixture(t);
  const port = await freePort();
  const state = path.join(directory, '.cache', 'school-wall');
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, 'dev-' + port + '.json');
  fs.writeFileSync(file, JSON.stringify({ root: directory, pid: process.pid, start: processIdentity(process.pid).start }));
  const result = await execute(['bash', path.join(directory, 'stop.sh'), '--port', String(port)]).finished;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /refusing to signal any process/);
  assert.equal(fs.existsSync(file), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('matching dependency stamp skips npm ci and changing the lock invalidates it', { skip: !linux, timeout: 10000 }, async t => {
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, 'deploy'));
  fs.mkdirSync(path.join(directory, 'server', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.copyFileSync(path.join(root, 'deploy/development.cjs'), path.join(directory, 'deploy/development.cjs'));
  fs.writeFileSync(path.join(directory, 'deploy/check-runtime.cjs'), "console.log('runtime checked');\n");
  fs.writeFileSync(path.join(directory, 'server/package.json'), '{}');
  const lock = path.join(directory, 'server/package-lock.json');
  fs.writeFileSync(lock, '{}');
  fs.writeFileSync(path.join(directory, 'server/node_modules/.school-wall-install'), dependencyFingerprint(path.join(directory, 'server')));
  fs.writeFileSync(path.join(directory, 'server/index.js'), "console.log('fixture backend entered'); process.exit(1);\n");
  fs.writeFileSync(path.join(directory, 'bin/npm'), '#!/bin/sh\necho install-was-requested\nexit 72\n', { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH };
  const command = [process.execPath, path.join(directory, 'deploy/development.cjs'), 'start', '--backend-only', '--port', String(await freePort())];
  const cached = await execute(command, { env }).finished;
  assert.match(cached.output, /Reusing installed server dependencies/);
  assert.match(cached.output, /fixture backend entered/);
  assert.doesNotMatch(cached.output, /install-was-requested/);
  fs.writeFileSync(lock, '{"changed":true}');
  command[command.length - 1] = String(await freePort());
  const changed = await execute(command, { env }).finished;
  assert.equal(changed.code, 1, changed.output);
  assert.match(changed.output, /install-was-requested/);
  assert.doesNotMatch(changed.output, /fixture backend entered/);
});

test('real backend-only launcher becomes healthy and stop closes its session', { skip: !linux, timeout: 30000 }, async t => {
  const data = temporary(t);
  const port = await freePort();
  const process = execute(['bash', path.join(root, 'start.sh'), '--skip-install', '--backend-only', '--port', String(port)], {
    cwd: os.tmpdir(), env: { ...global.process.env, DATA_DIR: data, JWT_SECRET: 'isolated-launcher-regression-test-secret', ALLOWED_ORIGINS: '', ADMIN_IP_WHITELIST: '', TRUST_PROXY: '0' },
  });
  cleanupProcess(t, process);
  await waitOutput(process, 'Backend ready:');
  const response = await fetch('http://127.0.0.1:' + port + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.doesNotMatch(process.output(), /Frontend ready/);
  const unsafeInstall = await execute([global.process.execPath, path.join(root, 'deploy/check-idle.cjs'), '--backend-only']).finished;
  assert.equal(unsafeInstall.code, 1, unsafeInstall.output);
  assert.match(unsafeInstall.output, /Cannot replace dependencies|Another development session/);
  const rootResponse = await fetch('http://127.0.0.1:' + port + '/');
  assert.equal(rootResponse.status, 200);
  assert.match(await rootResponse.text(), /后端服务运行中/);
  const missingPage = await fetch('http://127.0.0.1:' + port + '/frontend-route-that-does-not-exist');
  assert.equal(missingPage.status, 404);
  assert.match(missingPage.headers.get('content-type'), /application\/json/);
  await missingPage.body.cancel();
  const setup = await fetch('http://127.0.0.1:' + port + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'launcher-admin', password: 'isolated-launcher-password', nickname: '启动测试', wall_name: '启动测试墙' }),
  });
  assert.equal(setup.status, 200, await setup.text());
  const result = await execute(['bash', path.join(root, 'stop.sh'), '--port', String(port)]).finished;
  assert.equal(result.code, 0, result.output);
  assert.equal((await process.finished).code, 0, process.output());
  assert.equal(fs.existsSync(path.join(root, '.cache', 'school-wall', 'dev-' + port + '.json')), false);
  assert.equal(fs.existsSync(path.join(data, 'data.db')), true);
  const stopped = await execute(['bash', path.join(root, 'stop.sh'), '--port', String(port)]).finished;
  assert.equal(stopped.code, 0, stopped.output);
  assert.match(stopped.output, /No managed development session/);
});

test('combined development launcher checks the proxy and stops both children', { skip: !linux, timeout: 30000 }, async t => {
  const data = temporary(t);
  const port = await freePort();
  let clientPort = await freePort();
  while (clientPort === port) clientPort = await freePort();
  const session = execute(['bash', path.join(root, 'start.sh'), '--skip-install', '--port', String(port), '--client-port', String(clientPort)], {
    env: { ...process.env, DATA_DIR: data, JWT_SECRET: 'isolated-combined-launcher-test-secret', ALLOWED_ORIGINS: '', ADMIN_IP_WHITELIST: '', TRUST_PROXY: '0' },
  });
  cleanupProcess(t, session);
  await waitOutput(session, 'Backend ready:');
  assert.match(session.output(), /Frontend ready:/);
  const health = await fetch('http://127.0.0.1:' + clientPort + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const dashboard = await fetch('http://127.0.0.1:' + clientPort + '/dashboard');
  assert.equal(dashboard.status, 401);
  await dashboard.body.cancel();
  const result = await execute(['bash', path.join(root, 'stop.sh'), '--port', String(port)]).finished;
  assert.equal(result.code, 0, result.output);
  assert.equal((await session.finished).code, 0, session.output());
  for (const listenPort of [port, clientPort]) {
    await assert.rejects(fetch('http://127.0.0.1:' + listenPort + '/api/health', { signal: AbortSignal.timeout(1500) }));
  }
});

test('Vite proxy preserves Host and Origin for dashboard CSRF semantics', { timeout: 20000 }, async t => {
  const backend = http.createServer((request, response) => {
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin, url: request.url }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const vite = execute([process.execPath, path.join(root, 'client/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: path.join(root, 'client'), env: { ...process.env, BACKEND_ORIGIN: 'http://127.0.0.1:' + backend.address().port, VITE_PORT: String(port), VITE_BACKEND_PORT: '3000' },
  });
  cleanupProcess(t, vite);
  await waitOutput(vite, 'Local:');
  for (const pathname of ['/api/dashboard/session', '/dashboard/action']) {
    const response = await fetch(origin + pathname, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const seen = await response.json();
    assert.equal(seen.host, '127.0.0.1:' + port);
    assert.equal(seen.origin, origin);
    assert.equal(seen.url, pathname);
  }
});

test('Vite rejects proxy credentials, paths and self loops', async () => {
  const module = await import(pathToFileURL(path.join(root, 'client/vite.config.js')).href);
  const saved = { BACKEND_ORIGIN: process.env.BACKEND_ORIGIN, VITE_PORT: process.env.VITE_PORT };
  try {
    process.env.VITE_PORT = '5173';
    for (const value of ['ftp://example.test', 'http://user:pass@example.test', 'http://example.test/api', 'http://127.0.0.1:5173']) {
      process.env.BACKEND_ORIGIN = value;
      assert.throws(() => module.default({ mode: 'development' }), /BACKEND_ORIGIN|cannot point/);
    }
    process.env.BACKEND_ORIGIN = 'https://api.example.test:8443';
    const config = module.default({ mode: 'development' });
    assert.equal(config.server.proxy['/api'].target, 'https://api.example.test:8443');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
