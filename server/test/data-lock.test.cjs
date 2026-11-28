'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverDirectory = path.resolve(__dirname, '..');
const lockDirectory = directory => path.join(directory, '.school-wall.lock');
const lockFile = directory => path.join(lockDirectory(directory), 'owner.sqlite');
const workerStops = new WeakMap();

// All DB reads/writes and lock acquisitions run in dedicated real processes.
// Never fs.readFile/open the coordination file in a lock-holding process:
// POSIX close(2) on another FD for that inode can cancel SQLite record locks.
const workerSource = `
  const fs = require('node:fs');
  const path = require('node:path');
  const { initDB, getSetting, setSetting } = require('./db');
  const { acquireDataLock } = require('./lib/dataLock');
  let db;
  let leases = [];
  function report(id, value) { process.send({ id, value }); }
  function failure(error) { return { error: error.code || 'DB_ERROR', message: error.message }; }
  process.on('message', async message => {
    try {
      let value;
      switch (message.command) {
        case 'init': {
          const before = process.listenerCount('beforeExit');
          const results = await Promise.all(Array.from({ length: message.count || 1 }, () => initDB({ deferInitialSave: !!message.defer })));
          const wasSame = !db || db === results[0];
          db = results[0];
          value = { same: wasSame && results.every(result => result === db), listenersAdded: process.listenerCount('beforeExit') - before };
          break;
        }
        case 'write':
          setSetting(db, message.key, message.value || '1');
          db.markDirty();
          value = message.deferred ? true : db.saveNow();
          break;
        case 'read': value = getSetting(db, message.key, null); break;
        case 'temporary':
          value = { started: !!db.startTemporary(() => ({ ok: true })) };
          setSetting(db, 'initialized', '1');
          setSetting(db, 'data_lock_temporary', 'private-memory-value');
          db.markDirty();
          value.saved = db.saveNow();
          break;
        case 'lease': leases.push(acquireDataLock(message.directory || process.env.DATA_DIR)); value = leases.length; break;
        case 'release': leases.pop().release(); value = true; break;
        case 'assert': leases[0].assertOwned(); value = true; break;
        case 'exit': process.disconnect(); return;
        default: throw new Error('Unknown worker command');
      }
      report(message.id, value);
    } catch (error) { report(message.id, failure(error)); }
  });
  process.send({ ready: true });
`;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-data-lock-'));
  const stops = [];
  workerStops.set(t, stops);
  t.after(async () => {
    await Promise.all(stops.map(stop => stop()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function worker(t, directory, environment = {}, nodeOptions = []) {
  const child = spawn(process.execPath, [...nodeOptions, '-e', workerSource], {
    cwd: serverDirectory,
    env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1', ...environment },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-12000); });
  child.stderr.on('data', data => { output = (output + data).slice(-12000); });
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Always observe rejection, including a failure before the ready message.
  exited.catch(() => {});
  child.on('message', message => {
    if (message.ready) readyResolve();
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback.resolve(message.value); }
  });
  function failed(error) {
    readyReject(error);
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
  }
  child.once('error', failed);
  child.once('exit', (code, signal) => failed(new Error('Worker exited (' + code + ', ' + signal + '): ' + output)));
  async function stop(signal) {
    if (child.exitCode === null && child.signalCode === null) {
      if (signal) child.kill(signal);
      else if (child.connected) child.send({ command: 'exit' });
      else child.kill('SIGKILL');
    }
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { return await exited; } finally { clearTimeout(force); }
  }
  const stops = workerStops.get(t);
  if (stops) stops.push(stop);
  else t.after(() => stop());
  const timeout = setTimeout(() => readyReject(new Error('Worker not ready: ' + output)), 10000);
  try { await ready; } finally { clearTimeout(timeout); }
  return {
    child, stop,
    request(command, values = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker request timed out: ' + output)); }, 10000);
        pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
        child.send({ ...values, id, command }, error => {
          if (error) { const callback = pending.get(id); pending.delete(id); callback?.reject(error); }
        });
      });
    },
  };
}

async function maintenance(t, directory, args = []) {
  // A regression to a hard-coded production DB path must fail before touching
  // it, even when this test is run from a checkout containing a real data.db.
  const bootstrap = `
    const fs = require('node:fs');
    const path = require('node:path');
    const expected = path.resolve(process.env.DATA_DIR);
    for (const method of ['existsSync', 'readFileSync', 'writeFileSync', 'chmodSync', 'renameSync']) {
      const original = fs[method];
      fs[method] = function (...args) {
        for (const value of args.slice(0, method === 'renameSync' ? 2 : 1)) {
          if (typeof value === 'string' && path.basename(value).startsWith('data.db') && path.dirname(path.resolve(value)) !== expected) {
            throw new Error('Test refused access to a database outside isolated DATA_DIR');
          }
        }
        return original.apply(this, args);
      };
    }
    require('./scripts/fix-timezone.js');
  `;
  const child = spawn(process.execPath, ['-e', bootstrap, '--', ...args], {
    cwd: serverDirectory, env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Maintenance process timed out: ' + output)); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

function assertInUse(result) {
  assert.equal(result.error, 'DATA_DIR_IN_USE', result.message);
  assert.match(result.message, /one backend per data directory/);
}

test('a second process cannot open a stale snapshot; retry after exit preserves both writes', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  const second = await worker(t, directory);
  assert.deepEqual(await first.request('init'), { same: true, listenersAdded: 1 });
  assert.equal(await first.request('write', { key: 'data_lock_a' }), true);
  const before = fs.statSync(path.join(directory, 'data.db'));
  assertInUse(await second.request('init'));
  const after = fs.statSync(path.join(directory, 'data.db'));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await first.stop()).code, 0);
  assert.equal((await second.request('init')).same, true);
  assert.equal(await second.request('read', { key: 'data_lock_a' }), '1');
  assert.equal(await second.request('write', { key: 'data_lock_b' }), true);
  await second.stop();
  const third = await worker(t, directory);
  await third.request('init');
  assert.equal(await third.request('read', { key: 'data_lock_a' }), '1');
  assert.equal(await third.request('read', { key: 'data_lock_b' }), '1');
});

test('simultaneous fresh initializers have exactly one owner and do not rebuild another process data', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const children = await Promise.all(Array.from({ length: 4 }, () => worker(t, directory)));
  const results = await Promise.all(children.map(child => child.request('init')));
  const winner = results.findIndex(result => result.same);
  assert.equal(results.filter(result => result.same).length, 1, JSON.stringify(results));
  for (let index = 0; index < results.length; index++) if (index !== winner) assertInUse(results[index]);
  await children[winner].request('write', { key: 'data_lock_survives_rebuild' });
  const rebuilding = await worker(t, directory, { KEEP_DB: '0' });
  assertInUse(await rebuilding.request('init'));
  assert.equal(await children[winner].request('read', { key: 'data_lock_survives_rebuild' }), '1');
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('data.db.bak_')).length, 0);
});

test('SIGKILL releases the OS lock immediately without deleting or aging a PID file', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init');
  await first.request('write', { key: 'data_lock_before_crash' });
  const inode = fs.statSync(lockFile(directory)).ino;
  await first.stop('SIGKILL');
  const next = await worker(t, directory);
  assert.equal((await next.request('init')).same, true);
  assert.equal(await next.request('read', { key: 'data_lock_before_crash' }), '1');
  assert.equal(fs.statSync(lockFile(directory)).ino, inode);
});

test('natural beforeExit flush stays protected until the process exits', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init');
  await first.request('write', { key: 'data_lock_final_flush', deferred: true });
  assert.equal((await first.stop()).code, 0);
  const next = await worker(t, directory);
  await next.request('init');
  assert.equal(await next.request('read', { key: 'data_lock_final_flush' }), '1');
});

test('concurrent and repeated same-process init reuse the snapshot, lock and exit listener', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  assert.deepEqual(await first.request('init', { count: 6 }), { same: true, listenersAdded: 1 });
  await first.request('write', { key: 'data_lock_unsaved', deferred: true });
  assert.deepEqual(await first.request('init', { count: 3 }), { same: true, listenersAdded: 0 });
  assert.equal(await first.request('read', { key: 'data_lock_unsaved' }), '1');
  const second = await worker(t, directory);
  assertInUse(await second.request('init'));
});

test('temporary mode owns the data root but never persists the database or signing key', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init', { defer: true });
  assert.deepEqual(await first.request('temporary'), { started: true, saved: false });
  const second = await worker(t, directory);
  assertInUse(await second.request('init', { defer: true }));
  await first.stop();
  assert.equal(fs.existsSync(path.join(directory, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(directory, 'data.db.tmp')), false);
  assert.equal(fs.existsSync(path.join(directory, '.jwt_secret')), false);
  assert.equal(fs.statSync(lockFile(directory)).size, 0);
  assert.equal((await second.request('init', { defer: true })).same, true);
});

test('failed database initialization releases ownership and can be retried in the same process', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  fs.mkdirSync(path.join(directory, 'data.db'));
  const first = await worker(t, directory);
  assert.ok((await first.request('init')).error);
  fs.rmdirSync(path.join(directory, 'data.db'));
  const second = await worker(t, directory);
  assert.equal((await second.request('init')).same, true);
  assertInUse(await first.request('init'));
  await second.stop();
  assert.equal((await first.request('init')).same, true);
});

test('same-process lock leases retain ownership until the final release', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  const second = await worker(t, directory);
  await first.request('lease');
  await first.request('lease');
  await first.request('release');
  assertInUse(await second.request('lease'));
  await first.request('release');
  assert.equal(await second.request('lease'), 1);
});

test('symbolic DATA_DIR aliases share the same ownership', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const directory = temporaryDirectory(t);
  const alias = path.join(directory, 'alias');
  const target = path.join(directory, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, 'dir');
  const first = await worker(t, target);
  const second = await worker(t, alias);
  await first.request('init');
  assertInUse(await second.request('init'));
  await first.request('lease', { directory: alias });
  await first.request('release');
  assertInUse(await second.request('init'));
});

test('lock paths reject symlinks, hardlinks and unsafe permissions without changing targets', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  for (const kind of ['directory-symlink', 'file-symlink', 'hardlink', 'public-file', 'public-directory', 'public-root']) {
    await t.test(kind, async t => {
      const directory = temporaryDirectory(t);
      const outside = path.join(directory, 'untouched');
      fs.writeFileSync(outside, '', { mode: 0o600 });
      if (kind === 'directory-symlink') fs.symlinkSync(directory, lockDirectory(directory), 'dir');
      else {
        fs.mkdirSync(lockDirectory(directory), { mode: 0o700 });
        if (kind === 'file-symlink') fs.symlinkSync(outside, lockFile(directory));
        if (kind === 'hardlink') fs.linkSync(outside, lockFile(directory));
        if (kind === 'public-file') fs.writeFileSync(lockFile(directory), '', { mode: 0o666 });
        if (kind === 'public-file') fs.chmodSync(lockFile(directory), 0o666);
        if (kind === 'public-directory') fs.chmodSync(lockDirectory(directory), 0o755);
        if (kind === 'public-root') fs.chmodSync(directory, 0o777);
      }
      const first = await worker(t, directory);
      assert.equal((await first.request('init')).error, 'DATA_DIR_LOCK_UNSAFE');
      assert.equal(fs.statSync(outside).size, 0);
      assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(path.join(directory, 'data.db')), false);
    });
  }
});

test('replacing the locked inode makes saveNow fail closed before altering data.db', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init');
  const before = fs.statSync(path.join(directory, 'data.db'));
  fs.renameSync(lockFile(directory), path.join(lockDirectory(directory), 'old-owner.sqlite'));
  fs.writeFileSync(lockFile(directory), '', { mode: 0o600 });
  const result = await first.request('write', { key: 'data_lock_must_not_save' });
  assert.equal(result.error, 'DATA_DIR_LOCK_LOST');
  assert.equal(fs.statSync(path.join(directory, 'data.db')).ino, before.ino);
  assert.equal(fs.statSync(path.join(directory, 'data.db')).mtimeMs, before.mtimeMs);
});

test('lock state contains no application bytes and uses private POSIX permissions', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init', { defer: true });
  assert.equal(fs.statSync(lockFile(directory)).size, 0);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(lockDirectory(directory)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(lockFile(directory)).mode & 0o777, 0o600);
  }
});

test('empty coordination file left before chmod is recovered without altering directory permissions', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const directory = temporaryDirectory(t);
  fs.chmodSync(directory, 0o770);
  fs.mkdirSync(lockDirectory(directory), { mode: 0o700 });
  fs.writeFileSync(lockFile(directory), '', { mode: 0o644 });
  fs.chmodSync(lockFile(directory), 0o644);
  const first = await worker(t, directory);
  assert.equal((await first.request('init')).same, true);
  assert.equal(fs.statSync(lockFile(directory)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o770);
});

test('maintenance apply shares DATA_DIR ownership while dry-run stays read-only', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const first = await worker(t, directory);
  await first.request('init');
  await first.request('write', { key: 'data_lock_maintenance' });
  const before = fs.statSync(path.join(directory, 'data.db'));
  const onlineDryRun = await maintenance(t, directory);
  assert.equal(onlineDryRun.code, 0, onlineDryRun.output);
  assert.match(onlineDryRun.output, /只读快照/);
  const onlineApply = await maintenance(t, directory, ['--apply']);
  assert.equal(onlineApply.code, 1, onlineApply.output);
  assert.match(onlineApply.output, /DATA_DIR_IN_USE/);
  assert.equal(fs.statSync(path.join(directory, 'data.db')).ino, before.ino);
  assert.equal(fs.statSync(path.join(directory, 'data.db')).mtimeMs, before.mtimeMs);
  await first.stop();
  // Remove only the empty, unlocked coordination state to prove dry-run never
  // creates it. Never remove a lock file while any participant is running.
  fs.rmSync(lockDirectory(directory), { recursive: true });
  const offlineDryRun = await maintenance(t, directory);
  assert.equal(offlineDryRun.code, 0, offlineDryRun.output);
  assert.equal(fs.existsSync(lockDirectory(directory)), false);
  const applied = await maintenance(t, directory, ['--apply']);
  assert.equal(applied.code, 0, applied.output);
  assert.match(applied.output, /已写入数据库/);
  const next = await worker(t, directory);
  assert.equal((await next.request('init')).same, true);
  assert.equal(await next.request('read', { key: 'data_lock_maintenance' }), '1');
  assert.ok(await next.request('read', { key: 'tz_shift_v1' }));
});

test('missing native SQLite support fails clearly before creating any data directory', { timeout: 20000 }, async t => {
  const directory = path.join(temporaryDirectory(t), 'not-created');
  const first = await worker(t, directory, {}, ['--no-experimental-sqlite']);
  const result = await first.request('init');
  assert.equal(result.error, 'DATA_DIR_LOCK_UNAVAILABLE');
  assert.match(result.message, /Node[.]js >=22[.]13[.]0/);
  assert.equal(fs.existsSync(directory), false);
});
