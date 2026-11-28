'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const serverDirectory = path.resolve(__dirname, '..');

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send({ type: 'school-wall-test-shutdown' }, error => {
    if (error && child.exitCode === null) child.kill('SIGTERM');
  });
  const force = setTimeout(() => child.kill('SIGKILL'), 7000);
  try { await exited; } finally { clearTimeout(force); }
}

async function startServer(directory) {
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
    env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1', HOST: '127.0.0.1', PORT: '0', SERVE_CLIENT: '0',
      NODE_ENV: 'production', TRUST_PROXY: '0', ADMIN_IP_WHITELIST: '', ALLOWED_ORIGINS: '',
      JWT_SECRET: 'isolated-dashboard-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const remember = chunk => { output = (output + chunk.toString()).slice(-12000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('server startup timed out: ' + output)), 12000);
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error('server exited (' + code + ', ' + signal + '): ' + output));
    const onMessage = message => { if (Number.isInteger(message?.port) && message.port > 0) finish(null, message.port); };
    function finish(error, value) {
      clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.off('message', onMessage);
      if (error) reject(error); else resolve(value);
    }
    child.once('error', onError); child.once('exit', onExit); child.on('message', onMessage);
  }).catch(async error => { await stopServer(child); throw error; });
  return { child, url: 'http://127.0.0.1:' + port };
}

async function json(url, pathName, options = {}) {
  const response = await fetch(url + pathName, { signal: AbortSignal.timeout(7000), ...options });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test('standalone dashboard assets, cookie origin/CSRF, overview, filters and exports', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-dashboard-test-'));
  let server;
  try {
    server = await startServer(directory);
    const { url, child } = server;
    const setup = await json(url, '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dashboard-test-admin', password: 'dashboard-test-password', nickname: '看板测试员', wall_name: '看板测试墙' }),
    });
    assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
    const auth = { Authorization: 'Bearer ' + setup.body.token };
    const ticket = await fetch(url + '/api/dashboard/session', { method: 'POST', headers: auth, signal: AbortSignal.timeout(7000) });
    assert.equal(ticket.status, 200);
    const setCookie = ticket.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/dashboard/i);
    const cookie = setCookie.split(';')[0];
    const jwtValue = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const payload = jwt.decode(jwtValue);
    assert.equal(typeof payload.csrf, 'string');
    const cookieHeaders = { Cookie: cookie };
    const origin = new URL(url).origin;

    const unauthorized = await json(url, '/dashboard/api/overview');
    assert.equal(unauthorized.response.status, 401);
    const badOrigin = await json(url, '/dashboard/api/overview', { headers: { ...cookieHeaders, Origin: 'https://attacker.example' } });
    assert.equal(badOrigin.response.status, 403);
    const crossSite = await json(url, '/dashboard/api/overview', { headers: { ...cookieHeaders, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.response.status, 403);
    const overview = await json(url, '/dashboard/api/overview?days=30', { headers: { ...cookieHeaders, Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(overview.response.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.schema_version, 1);
    assert.equal(overview.body.daily.length, 30);
    assert.equal(overview.response.headers.get('cache-control'), 'no-store');
    const serialized = JSON.stringify(overview.body);
    assert.equal(serialized.includes('author_id'), false);
    assert.equal(serialized.includes('author_ip'), false);
    assert.equal(serialized.includes('message_content'), false);
    const invalidRange = await json(url, '/dashboard/api/overview?days=8', { headers: { ...cookieHeaders, Origin: origin } });
    assert.equal(invalidRange.response.status, 400);
    assert.ok(invalidRange.body.code);

    const dashboard = await fetch(url + '/dashboard?user_q=%3Cimg%20src=x%20onerror=alert(1)%3E&users_page=99999999', {
      headers: cookieHeaders, signal: AbortSignal.timeout(7000),
    });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    assert.match(dashboard.headers.get('content-security-policy'), /script-src 'self'/);
    const page = await dashboard.text();
    assert.match(page, /\/dashboard\/assets\/dashboard\.css/);
    assert.match(page, /\/dashboard\/assets\/dashboard\.js/);
    assert.equal(page.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
    assert.equal(page.includes('<img src=x onerror=alert(1)>'), false);
    assert.doesNotMatch(page, /<style[ >]/i);
    assert.doesNotMatch(page, /<script(?:\s|>)(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(page, /\{\{[A-Z_]+\}\}/);
    assert.doesNotMatch(page, /消息总数/);

    // Stored text is data, not JavaScript replacement syntax or another template.
    const literalText = 'literal $& $$ {{USER_EXPORT_QUERY}} <b>not HTML</b>';
    const created = await json(url, '/api/posts', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Wall-Id': String(setup.body.wall.id) },
      body: JSON.stringify({ content: literalText, category: '分享' }),
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const literalPage = await fetch(url + '/dashboard', { headers: cookieHeaders, signal: AbortSignal.timeout(7000) });
    assert.equal(literalPage.status, 200);
    assert.ok((await literalPage.text()).includes('literal $&amp; $$ {{USER_EXPORT_QUERY}} &lt;b&gt;not HTML&lt;/b&gt;'));

    for (const [pathname, expectedType] of [['/dashboard/assets/dashboard.css', /text\/css/], ['/dashboard/assets/dashboard.js', /javascript/]]) {
      const asset = await fetch(url + pathname, { signal: AbortSignal.timeout(5000) });
      assert.equal(asset.status, 200, pathname);
      assert.match(asset.headers.get('content-type'), expectedType);
      assert.equal(asset.headers.get('cache-control'), 'no-store');
      const source = await asset.text();
      assert.ok(source.length > 500);
      if (pathname.endsWith('.js')) {
        assert.match(source, /AbortController/);
        assert.match(source, /requestId!==overviewRequestId/);
        assert.match(source, /response.status===401\|\|response.status===403/);
        assert.match(source, /clearOverview/);
        assert.match(source, /walls_meta/);
        assert.match(source, /todos_meta/);
        assert.match(source, /aria-busy/);
        assert.match(source, /overviewRefresh.disabled=true/);
        assert.match(source, /正常状态用户/);
        assert.match(source, /访问标识按登录用户或访客 IP/);
        assert.doesNotMatch(source, /位访客|活跃用户/);
      }
    }

    const icon = await fetch(url + '/dashboard/assets/favicon.svg', { signal: AbortSignal.timeout(7000) });
    assert.equal(icon.status, 200);
    assert.ok((await icon.text()).startsWith('<svg'));

    const noCsrf = await json(url, '/dashboard/api/token', { method: 'POST', headers: { ...cookieHeaders, Origin: origin } });
    assert.equal(noCsrf.response.status, 403);
    const wrongCsrf = await json(url, '/dashboard/api/token', { method: 'POST', headers: { ...cookieHeaders, Origin: origin, 'X-Dashboard-CSRF': '0'.repeat(64) } });
    assert.equal(wrongCsrf.response.status, 403);
    const wrongWriteOrigin = await json(url, '/dashboard/api/token', { method: 'POST', headers: { ...cookieHeaders, Origin: 'https://attacker.example', 'X-Dashboard-CSRF': payload.csrf } });
    assert.equal(wrongWriteOrigin.response.status, 403);
    const token = await json(url, '/dashboard/api/token', { method: 'POST', headers: { ...cookieHeaders, Origin: origin.replace('http:', 'HTTP:'), 'X-Dashboard-CSRF': payload.csrf } });
    assert.equal(token.response.status, 200);
    assert.ok(token.body.token);

    const exportDeniedWithoutCookie = await json(url, '/dashboard/api/export?type=users', { headers: { Authorization: auth.Authorization } });
    assert.equal(exportDeniedWithoutCookie.response.status, 401);
    const csv = await fetch(url + '/dashboard/api/export?type=users', { headers: { ...cookieHeaders, Origin: origin }, signal: AbortSignal.timeout(7000) });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="users\.csv"/);
    assert.match(await csv.text(), /dashboard-test-admin/);

    assert.equal(await stopServer(child), undefined);
  } finally {
    if (server && server.child.exitCode === null) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
