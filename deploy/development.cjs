#!/usr/bin/env node
'use strict';

// No app imports: preflight/stop must never initialize a database.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const runtimeCheck = path.join(__dirname, 'check-runtime.cjs');
const stateDirectory = path.join(root, '.cache', 'school-wall');

function parseArgs(args) {
  const options = { command: args.shift(), port: process.env.PORT || '3000', clientPort: process.env.VITE_PORT || '5173', backendOnly: false, install: false, skipInstall: false, check: false };
  if (!['start', 'stop'].includes(options.command)) throw new Error('Expected start or stop');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--port', '-p', '--client-port'].includes(arg)) {
      if (!args[index + 1]) throw new Error('Missing value for ' + arg);
      options[arg === '--client-port' ? 'clientPort' : 'port'] = args[++index];
    } else if (['--backend-only', '--api-only'].includes(arg)) options.backendOnly = true;
    else if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--check') options.check = true;
    else if (['--help', '-h'].includes(arg)) options.help = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  for (const key of ['port', 'clientPort']) {
    if (!/^\d{1,5}$/.test(options[key]) || Number(options[key]) < 1 || Number(options[key]) > 65535) {
      throw new Error(key + ' must be an integer between 1 and 65535');
    }
    options[key] = Number(options[key]);
  }
  if (options.install && options.skipInstall) throw new Error('--install and --skip-install cannot be combined');
  if (options.command === 'start' && !options.backendOnly && options.port === options.clientPort) {
    throw new Error('Backend and frontend must use different ports');
  }
  return options;
}

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
    return { start, args };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function isOwnedState(state) {
  if (!state || state.root !== root || !Number.isSafeInteger(state.pid) || state.pid <= 1 || typeof state.start !== 'string') return false;
  const identity = processIdentity(state.pid);
  return identity !== null && identity.start === state.start && identity.args[1] === __filename && identity.args[2] === 'start';
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot verify startup state: ' + error.message); }
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', error => reject(new Error('Port ' + port + ' is unavailable: ' + error.code + '. Stop its owner explicitly or choose another port.')));
    socket.listen({ host: '127.0.0.1', port, exclusive: true }, () => socket.close(resolve));
  });
}

// Fingerprint only successful npm ci runs, including platform and Node ABI.
function dependencyFingerprint(directory) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'package.json')))
    .update(fs.readFileSync(path.join(directory, 'package-lock.json')))
    .update(process.platform + ':' + process.arch + ':' + process.versions.modules).digest('hex');
}

function assertDependenciesIdle(directory) {
  for (const file of (fs.existsSync(stateDirectory) ? fs.readdirSync(stateDirectory) : []).filter(name => /^dev-\d+\.json$/.test(name))) {
    const state = readState(path.join(stateDirectory, file));
    if (state?.pid !== process.pid && isOwnedState(state)) {
      throw new Error('Another development session is using this checkout. Stop it before replacing dependencies.');
    }
  }
  const entry = directory === path.join(root, 'server') ? path.join(directory, 'index.js') : path.join(directory, 'node_modules', 'vite', 'bin', 'vite.js');
  for (const item of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(item)) continue;
    let identity;
    try { identity = processIdentity(Number(item)); } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') continue;
      throw error;
    }
    if (!identity) continue;
    let cwd;
    try { cwd = fs.readlinkSync('/proc/' + item + '/cwd'); } catch { /* process may exit or belong to another user */ }
    if (identity.args[1] === entry || (cwd === directory && identity.args.includes(path.basename(entry)))) {
      throw new Error('Cannot replace dependencies while this checkout is running (PID ' + item + '). Stop it first.');
    }
  }
}

async function start(options) {
  if (process.platform !== 'linux') throw new Error('Use start.bat on Windows; this helper requires Linux /proc for safe process ownership checks.');
  const selected = options.backendOnly ? ['server'] : ['server', 'client'];
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >=22.13.0 is required');
  // Check before npm ci or any application writes.
  await assertFreePort(options.port);
  if (!options.backendOnly) await assertFreePort(options.clientPort);
  for (const name of selected) dependencyFingerprint(path.join(root, name));

  const children = new Map();
  let stopping = false;
  let stateFile;
  let ownsState = false;
  let shutdownPromise;
  function launch(executable, args, cwd, env, persistent = false) {
    if (stopping) throw new Error('Startup was cancelled');
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', detached: true });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
        if (persistent && !stopping) void shutdown(1, new Error(path.basename(args[0]) + ' exited unexpectedly (' + (code ?? signal) + ')'));
      });
    });
    children.set(child, finished);
    // Keep errors handled even when a long-lived child fails before its health check.
    finished.catch(error => { if (!stopping) void shutdown(1, error); });
    return { child, finished };
  }
  async function run(executable, args, cwd) {
    const result = await launch(executable, args, cwd, process.env).finished;
    if (result.code !== 0) throw new Error(path.basename(executable) + ' ' + args.join(' ') + ' failed (' + (result.code ?? result.signal) + ')');
  }
  function signalChild(child, signal) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  async function shutdown(code, error) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    process.exitCode = code;
    if (error) console.error('Startup failed: ' + error.message);
    shutdownPromise = (async () => {
      const active = [...children.entries()];
      for (const [child] of active) signalChild(child, 'SIGTERM');
      const force = setTimeout(() => { for (const [child] of active) signalChild(child, 'SIGKILL'); }, 15000);
      try { await Promise.allSettled(active.map(([, finished]) => finished)); }
      finally {
        clearTimeout(force);
        if (ownsState && readState(stateFile)?.pid === process.pid) fs.unlinkSync(stateFile);
      }
    })();
    return shutdownPromise;
  }
  if (!options.check) {
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    stateFile = path.join(stateDirectory, 'dev-' + options.port + '.json');
    const existing = readState(stateFile);
    if (existing && isOwnedState(existing)) throw new Error('This backend already has a startup supervisor. Stop it first.');
    if (existing) {
      // Do not silently overwrite unverifiable live PIDs.
      if (Number.isSafeInteger(existing.pid) && existing.pid > 1 && processIdentity(existing.pid)) throw new Error('Refusing to overwrite startup state for an unverified live process');
      fs.unlinkSync(stateFile);
    }
    const identity = processIdentity(process.pid);
    fs.writeFileSync(stateFile, JSON.stringify({ root, pid: process.pid, start: identity.start }), { flag: 'wx', mode: 0o600 });
    ownsState = true;
    process.once('SIGINT', () => { void shutdown(0); });
    process.once('SIGTERM', () => { void shutdown(0); });
  }
  try {
    for (const name of selected) {
      const directory = path.join(root, name);
      const fingerprint = dependencyFingerprint(directory);
      const stamp = path.join(directory, 'node_modules', '.school-wall-install');
      let current;
      try { current = fs.readFileSync(stamp, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!options.check && !options.skipInstall && (options.install || current !== fingerprint)) {
        assertDependenciesIdle(directory);
        console.log('Installing locked ' + name + ' dependencies...');
        await run('npm', ['ci', '--include=optional', name === 'client' ? '--include=dev' : '--omit=dev'], directory);
        await run(process.execPath, [runtimeCheck, '--' + name, ...(name === 'server' ? ['--sharp'] : [])], root);
        if (stopping) return;
        fs.writeFileSync(stamp, fingerprint + '\n');
      } else {
        await run(process.execPath, [runtimeCheck, '--' + name, ...(name === 'server' ? ['--sharp'] : [])], root);
        console.log('Reusing installed ' + name + ' dependencies.');
      }
    }
    if (options.check) { console.log('Preflight passed. No installation or application startup was performed.'); return; }
    if (stopping) return;
    // Installation may have taken time; do not race a newly occupied port.
    await assertFreePort(options.port);
    if (!options.backendOnly) await assertFreePort(options.clientPort);
    const origin = 'http://127.0.0.1:' + options.port;
    const env = { ...process.env, PORT: String(options.port), HOST: '127.0.0.1', NODE_ENV: 'development', KEEP_DB: '1', SERVE_CLIENT: '0',
      VITE_BACKEND_PORT: String(options.port), BACKEND_ORIGIN: origin, VITE_PORT: String(options.clientPort) };
    const backend = launch(process.execPath, [path.join(root, 'server', 'index.js')], path.join(root, 'server'), env, true);
    async function waitReady(child, url, health) {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (stopping || child.exitCode !== null || child.signalCode !== null) throw new Error('Process stopped before becoming ready: ' + url);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
          if (health) {
            if (response.ok && (await response.json()).ok === true) return;
            await response.body?.cancel();
          } else {
            await response.arrayBuffer();
            if (response.ok) return;
          }
        } catch { /* Retry only while our child is running. */ }
        await delay(250);
      }
      throw new Error('Health check timed out: ' + url);
    }
    await waitReady(backend.child, origin + '/api/health', true);
    if (!options.backendOnly) {
      const frontend = launch(process.execPath, [path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(options.clientPort), '--strictPort'], path.join(root, 'client'), env, true);
      const frontendOrigin = 'http://127.0.0.1:' + options.clientPort;
      await waitReady(frontend.child, frontendOrigin + '/', false);
      await waitReady(frontend.child, frontendOrigin + '/api/health', true);
      console.log('Frontend ready: ' + frontendOrigin);
    }
    if (!stopping) {
      console.log('Backend ready: ' + origin + '/api/health');
      console.log('Dashboard: ' + origin + '/dashboard');
      console.log('Press Ctrl+C or run bash stop.sh --port ' + options.port + ' to stop this session.');
    }
  } catch (error) { await shutdown(stopping ? (process.exitCode || 0) : 1, stopping ? undefined : error); }
}

async function stop(options) {
  if (process.platform !== 'linux') throw new Error('Safe stop requires Linux /proc. Use stop.bat on Windows.');
  const file = path.join(stateDirectory, 'dev-' + options.port + '.json');
  const state = readState(file);
  if (!state) { console.log('No managed development session for backend port ' + options.port + '.'); return; }
  if (!isOwnedState(state)) throw new Error('Cannot verify supervisor identity; refusing to signal any process. Use its original terminal.');
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!isOwnedState(state)) { console.log('Stopped this checkout\'s development session.'); return; }
    await delay(250);
  }
  throw new Error('Supervisor is still shutting down. Check its original terminal; no unrelated process was stopped.');
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: bash start.sh [--port PORT] [--client-port PORT] [--backend-only] [--install | --skip-install] [--check]');
      console.log('       bash stop.sh [--port PORT]');
      return;
    }
    if (options.command === 'stop') await stop(options); else await start(options);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, dependencyFingerprint, processIdentity, isOwnedState, assertDependenciesIdle };
