'use strict';
// Isolation only: fake deployment tools, temporary checkout/data, no real app startup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-deploy-'));
  t.after(() => {
    // Delete only the unique, absolute test directory created in this invocation.
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^school-wall-deploy-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function executable(file, content) { fs.writeFileSync(file, content, { mode: 0o700 }); }
function fixture(t) {
  const base = temporary(t);
  const app = path.join(base, 'app with spaces');
  for (const sub of ['server/node_modules', 'client/node_modules', 'client/dist', 'deploy', 'bin']) {
    fs.mkdirSync(path.join(app, sub), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'deploy.sh'), path.join(app, 'deploy.sh'));
  for (const sub of ['server', 'client']) fs.writeFileSync(path.join(app, sub, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(app, 'server/data.db'), 'untouched-test-database');
  fs.writeFileSync(path.join(app, 'client/dist/index.html'), 'old-build');
  const log = path.join(base, 'commands.log');
  executable(path.join(app, 'bin/npm'), `#!/bin/bash
printf 'npm|%s|%s\n' "$PWD" "$*" >> "$SW_LOG"
if [ "$SW_FAIL" = server ] && [ "$PWD" = "$SW_FIXTURE/server" ]; then exit 23; fi
if [ "$SW_FAIL" = client ] && [ "$PWD" = "$SW_FIXTURE/client" ] && [ "$1" = ci ]; then exit 24; fi
if [ "$1 $2" = 'run build' ]; then
    [ "$SW_FAIL" != build ] || exit 25
    printf 'rebuilt' > "$SW_FIXTURE/client/dist/index.html"
fi
`);
  executable(path.join(app, 'bin/node'), `#!/bin/bash
case "$1" in
    */check-runtime.cjs)
        printf 'check|%s\n' "$*" >> "$SW_LOG"
        if [ "$SW_FAIL" = native ] && [ "$2" = --sharp ]; then exit 26; fi ;;
    *) printf 'start|PORT=%s|HOST=%s|KEEP_DB=%s|NODE_ENV=%s\n' "$PORT" "$HOST" "$KEEP_DB" "$NODE_ENV" >> "$SW_LOG" ;;
esac
`);
  return {
    base, app,
    run(args, failure = '') {
      const result = spawnSync('bash', [path.join(app, 'deploy.sh'), ...args], {
        cwd: base, encoding: 'utf8',
        env: { ...process.env, PATH: path.join(app, 'bin') + path.delimiter + process.env.PATH,
          SW_LOG: log, SW_FIXTURE: app, SW_FAIL: failure, PORT: '', HOST: '', KEEP_DB: '0', NODE_ENV: '', DATA_DIR: '' },
      });
      assert.ifError(result.error);
      const commands = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
      assert.equal(fs.readFileSync(path.join(app, 'server/data.db'), 'utf8'), 'untouched-test-database');
      return { ...result, commands };
    },
  };
}

test('each shell entry point parses independently', () => {
  const scripts = [path.join(root, 'deploy.sh'), ...fs.readdirSync(path.join(root, 'deploy')).filter(name => name.endsWith('.sh')).map(name => path.join(root, 'deploy', name))];
  for (const script of scripts) {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, path.basename(script) + ': ' + result.stderr);
  }
});

test('server installer check mode never invokes privilege, service or firewall commands', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(root, 'deploy/install-server.sh'), path.join(f.app, 'deploy/install-server.sh'));
  fs.mkdirSync(path.join(f.app, 'deploy/nginx'));
  for (const snippet of ['proxy', 'headers', 'csp', 'realip']) {
    fs.writeFileSync(path.join(f.app, 'deploy/nginx/school-wall-' + snippet + '.conf'), '# fixture');
  }
  const forbidden = path.join(f.base, 'forbidden.log');
  for (const name of ['sudo', 'systemctl', 'ss', 'curl', 'ufw', 'install', 'readlink', 'chmod']) {
    executable(path.join(f.app, 'bin', name), '#!/bin/bash\nprintf "forbidden" >> "$SW_FORBIDDEN"\nexit 91\n');
  }
  executable(path.join(f.app, 'bin/nginx'), '#!/bin/bash\nprintf "nginx --with-http_realip_module"\n');
  executable(path.join(f.app, 'bin/node'), '#!/bin/bash\ncase "$1" in\n-p) printf "/usr/bin/node" ;;\n*/service-data-dir.cjs) printf "%s/server" "$SW_FIXTURE" ;;\n*) exit 0 ;;\nesac\n');
  const result = spawnSync('bash', [path.join(f.app, 'deploy/install-server.sh'), '--check'], {
    encoding: 'utf8', env: { ...process.env, PATH: path.join(f.app, 'bin') + path.delimiter + process.env.PATH,
      SW_FIXTURE: f.app, SW_FORBIDDEN: forbidden, SSH_PORT: '22' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(forbidden), 'Read-only mode invoked a forbidden command');
  assert.equal(fs.readFileSync(path.join(f.app, 'server/data.db'), 'utf8'), 'untouched-test-database');
});

test('Node guard rejects unsupported versions before any application work', () => {
  const source = fs.readFileSync(path.join(root, 'deploy/check-runtime.cjs'), 'utf8');
  for (const version of ['18.20.8', '20.20.0', '22.11.9', '22.12.0', '22.23.3', '24.0.0']) {
    let exitCode = 0;
    const stop = new Error('exit');
    try {
      vm.runInNewContext(source, {
        process: { versions: { node: version }, version: 'v' + version, argv: [], exit(code) { exitCode = code; throw stop; } },
        console: { log() {}, error() {} },
      });
    } catch (error) { assert.equal(error, stop); }
    assert.equal(exitCode, ['18.20.8', '20.20.0', '22.11.9'].includes(version) ? 1 : 0, version);
  }
});

test('prepare rebuilds existing dependencies and dist, including native optional packages', t => {
  const f = fixture(t);
  const result = f.run(['--prepare-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.filter(line => line.startsWith('npm|')).map(line => line.split('|').slice(-1)[0]), [
    'ci --omit=dev --include=optional', 'ci --include=dev --include=optional', 'run build',
  ]);
  assert.equal(fs.readFileSync(path.join(f.app, 'client/dist/index.html'), 'utf8'), 'rebuilt');
  assert.ok(result.commands.some(line => line.includes('--sharp')));
  assert.ok(!result.commands.some(line => line.startsWith('start|')));
});

test('installation, native decoding and build failures stop before application startup', async t => {
  for (const [failure, expected, npmCalls] of [['server', 23, 1], ['native', 26, 1], ['client', 24, 2], ['build', 25, 3]]) {
    await t.test(failure, inner => {
      const f = fixture(inner);
      const result = f.run([], failure);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.commands.filter(line => line.startsWith('npm|')).length, npmCalls);
      assert.ok(!result.commands.some(line => line.startsWith('start|')));
    });
  }
});

test('read-only check does not install, build or launch', t => {
  const f = fixture(t);
  const result = f.run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.commands.every(line => line.startsWith('check|')));
  assert.equal(fs.readFileSync(path.join(f.app, 'client/dist/index.html'), 'utf8'), 'old-build');
});

test('invalid ports are rejected before installing or launching', async t => {
  for (const value of ['0', '65536', '-1', '3000x', '1;touch invalid', '99999999999999999']) {
    await t.test(value, inner => {
      const result = fixture(inner).run(['--port', value]);
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.commands, []);
    });
  }
});

test('foreground startup normalizes port, binds locally, and prevents accidental rebuild', t => {
  const result = fixture(t).run(['--port', '03000']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.at(-1), 'start|PORT=3000|HOST=127.0.0.1|KEEP_DB=1|NODE_ENV=production');
  assert.doesNotMatch(result.stdout, /admin \/ 123456/);
});

function configFixture(t) {
  const base = temporary(t);
  const app = path.join(base, 'app');
  fs.mkdirSync(path.join(app, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(app, 'server'));
  fs.copyFileSync(path.join(root, 'deploy/service-data-dir.cjs'), path.join(app, 'deploy/service-data-dir.cjs'));
  const sentinel = path.join(app, 'server/data.db');
  fs.writeFileSync(sentinel, 'no-app-imports');
  return {
    app, base,
    run(config) {
      fs.writeFileSync(path.join(app, 'server/.env'), config);
      const result = spawnSync(process.execPath, [path.join(app, 'deploy/service-data-dir.cjs')], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'no-app-imports');
      return result;
    },
  };
}

test('service data config preserves legacy default and accepts a private external data directory', t => {
  const f = configFixture(t);
  let result = f.run('JWT_SECRET=this-value-is-not-printed\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(f.app, 'server'));
  assert.doesNotMatch(result.stdout, /this-value/);
  const data = path.join(f.base, 'private-data');
  result = f.run('DATA_DIR=' + data + '\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), data);
  assert.ok(!fs.existsSync(data), 'Preflight must not create a data directory');
});

test('service preflight rejects overrides, shared source paths and symlink traversal', t => {
  const f = configFixture(t);
  for (const config of ['HOST=0.0.0.0', 'PORT=8080', 'KEEP_DB=0', 'TRUST_PROXY=2', 'NODE_ENV=development', 'DATA_DIR=../client', 'DATA_DIR=' + f.base, 'DATA_DIR=/tmp/has space', 'DATA_DIR=/tmp/data # inline comment', 'export DATA_DIR=/tmp/data', 'DATA_DIR=/tmp/one\nDATA_DIR=/tmp/two']) {
    const result = f.run(config);
    assert.notEqual(result.status, 0, config);
    assert.equal(result.stdout, '');
  }
  const data = path.join(f.base, 'private-data');
  fs.mkdirSync(data);
  const link = path.join(f.base, 'linked-data');
  fs.symlinkSync(data, link);
  assert.notEqual(f.run('DATA_DIR=' + link).status, 0);
  assert.notEqual(f.run('DATA_DIR=' + path.join(link, 'not-created')).status, 0);
});

test('nginx upload config delegates tickets and private cache/referrer policy to the backend', () => {
  const nginx = fs.readFileSync(path.join(root, 'deploy/nginx/school-wall.conf'), 'utf8');
  const upload = nginx.match(/location \/uploads\/ \{([\s\S]*?)\n    \}/)[1].replace(/#.*$/gm, '');
  assert.match(upload, /proxy_pass http:\/\/school_wall_backend;/);
  assert.doesNotMatch(upload, /\balias\b|\bexpires\b|add_header\s+(?:Cache-Control|Referrer-Policy)/i);
  assert.match(upload, /proxy_cache off;/);
  const dashboard = nginx.match(/location \/dashboard \{([\s\S]*?)\n    \}/)[1];
  assert.doesNotMatch(dashboard, /school-wall-csp/);
  const csp = fs.readFileSync(path.join(root, 'deploy/nginx/school-wall-csp.conf'), 'utf8');
  assert.match(csp, /img-src[^;]*blob:/);
});

test('Windows entry points remain ASCII/CRLF and preserve PowerShell failure exit codes', () => {
  for (const name of ['deploy.bat', 'start.bat', 'stop.bat']) {
    const bytes = fs.readFileSync(path.join(root, name));
    assert.ok(bytes.every(byte => byte < 128), name);
    const source = bytes.toString('ascii');
    assert.ok(!/(?<!\r)\n/.test(source), name);
    assert.match(source, /-File "%~dp0deploy\\windows[.]ps1"/);
    assert.match(source, /exit \/b %ERRORLEVEL%/i);
    assert.doesNotMatch(source, /taskkill|123456|enabledelayedexpansion/i);
  }
});
