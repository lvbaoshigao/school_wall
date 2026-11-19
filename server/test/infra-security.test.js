'use strict';

// Real index.js subprocesses run only with generated fixtures in a temporary DATA_DIR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const { hashPassword } = require('../lib/password');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const schema = source.match(/wrapper\.exec\(`([\s\S]*?)`\);/)[1];
const sqlReady = initSqlJs();
const passwordReady = hashPassword('infra-original-password');
const trackingCode = 'INFRA-PRIVATE-EVIDENCE';
const legacyEvidence = '/uploads/images/legacy-evidence.png';
const legacyOtherAvatar = '/uploads/avatars/3_aaaaaaaaaaaa.png';
const sharedAvatar = '/uploads/avatars/4_cccccccccccc.png';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length); suffix.writeUInt32BE(crc32(bytes));
  return Buffer.concat([prefix, bytes, suffix]);
}

function png(color = [79, 142, 124, 255], imageData) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', imageData || zlib.deflateSync(Buffer.from([0, ...color]))), chunk('IEND', Buffer.alloc(0))]);
}

const pngOne = png();
const pngTwo = png([125, 167, 151, 255]);
const dataUrl = (bytes, format = 'png') => `data:image/${format};base64,${bytes.toString('base64')}`;

async function service(t, { whitelistMode = 'off', whitelist = [], trustProxy = '0', envWhitelist = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-infra-security-'));
  const databasePath = path.join(directory, 'data.db');
  const SQL = await sqlReady;
  const database = new SQL.Database();
  database.run(schema);
  const hash = await passwordReady;
  for (let id = 1; id <= 5; id++) {
    const avatar = id === 2 || id === 3 ? legacyOtherAvatar : id === 4 || id === 5 ? sharedAvatar : '';
    database.run('INSERT INTO users (id, username, password_hash, nickname, role, avatar) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'infrauser' + id, hash, 'infra-user-' + id, id === 1 ? 'super_admin' : 'user', avatar]);
  }
  database.run("INSERT INTO settings (key,value) VALUES ('initialized','1'),('ip_whitelist_mode',?),('admin_ip_whitelist',?)",
    [whitelistMode, JSON.stringify(whitelist)]);
  database.run("INSERT INTO walls (id,name,owner_id) VALUES (1,'infra-test-wall',1)");
  for (let id = 1; id <= 5; id++) database.run("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,?,'active')", [id, id === 1 ? 'owner' : 'member']);
  database.run('INSERT INTO reports (wall_id,tracking_code,reporter_id,report_types,content,images,is_anonymous) VALUES (1,?,2,?,?,?,1)',
    [trackingCode, 'test-only', 'private fixture evidence', JSON.stringify([legacyEvidence])]);
  fs.writeFileSync(databasePath, Buffer.from(database.export()), { mode: 0o600 });
  database.close();
  for (const subdirectory of ['avatars', 'images', 'bug-reports']) fs.mkdirSync(path.join(directory, 'uploads', subdirectory), { recursive: true });
  for (const url of [legacyEvidence, legacyOtherAvatar, sharedAvatar, '/uploads/images/public.png']) {
    fs.writeFileSync(path.join(directory, url), pngOne, { mode: 0o600 });
  }
  const secret = crypto.randomBytes(48).toString('hex');
  // Observe the actual OS-assigned listening port; the real main and middleware remain unchanged.
  const bootstrap = `
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once('listening', () => { if (process.send) process.send({ port: this.address().port }); });
      return listen.apply(this, args);
    };
    require(${JSON.stringify(path.join(root, 'index.js'))});
  `;
  const child = spawn(process.execPath, ['-e', bootstrap], { cwd: root,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory, JWT_SECRET: secret,
      KEEP_DB: '1', TRUST_PROXY: trustProxy, ADMIN_IP_WHITELIST: envWhitelist, ALLOWED_ORIGINS: '',
      UPLOAD_MAX_TOTAL_MB: '32', UPLOAD_MAX_USER_MB_PER_HOUR: '8' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', value => { output = (output + value).slice(-16000); });
  child.stderr.on('data', value => { output = (output + value).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(deadline); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated main startup timed out: ' + output)), 15000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Isolated main exited ${code}/${signal}: ${output}`)); });
  });
  const token = (id = 2, version = 0, additional = {}) => jwt.sign({ id, tv: version, ...additional }, secret, { expiresIn: '1h' });
  const request = (url, { method = 'GET', body, raw, user, bearer, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const requestHeaders = { ...headers };
    if (user !== undefined || bearer) requestHeaders.Authorization = 'Bearer ' + (bearer || token(user));
    if (payload !== undefined) { requestHeaders['Content-Type'] = 'application/json'; requestHeaders['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: requestHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', value => chunks.push(value));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text, body: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Isolated request timed out: ' + url)));
    req.end(payload);
  });
  return { request, token, directory, databasePath, secret, output: () => output };
}

test('infra: real main returns JSON400 for malformed requests, secure headers and bounded unknown API404', async t => {
  const f = await service(t);
  for (const raw of ['{', 'null', '[]', '"primitive"']) {
    const result = await f.request('/api/auth/login', { method: 'POST', raw });
    assert.equal(result.status, 400, raw);
    assert.match(result.headers['content-type'], /application\/json/);
    assert.ok(result.body.error);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.text.includes('SyntaxError'), false);
  }
  for (const url of ['/api/no-such-infra-route', '/API/NO-SUCH-INFRA-ROUTE']) {
    const result = await f.request(url);
    assert.equal(result.status, 404);
    assert.match(result.headers['content-type'], /application\/json/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(result.headers['content-security-policy'], /object-src 'none'/);
    assert.equal(result.headers['x-powered-by'], undefined);
  }
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(fs.statSync(f.databasePath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.directory, '.jwt_secret')), false, 'explicit test JWT key avoids persistent secret creation');
});

test('infra: real unread badge endpoint stays aligned with single-sided deletion', async t => {
  const f = await service(t);
  assert.equal((await f.request('/api/messages/unread-count')).status, 401);
  const initial = await f.request('/api/messages/unread-count', { user: 3 });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { count: 0, chat: 0, treeHole: 0, system: 0, announcement: 0 });
  const sent = await f.request('/api/messages', { method: 'POST', user: 2, body: { receiver_id: 3, type: 'private', content: 'isolated badge regression' } });
  assert.equal(sent.status, 200);
  const unread = await f.request('/api/messages/unread-count', { user: 3 });
  assert.equal(unread.status, 200);
  assert.equal(unread.body.count, 1);
  assert.equal(unread.body.chat, 1);
  assert.equal(unread.body.treeHole, 0);
  assert.equal((await f.request('/api/messages/' + sent.body.id, { method: 'DELETE', user: 3 })).status, 200);
  const hidden = await f.request('/api/messages/unread-count', { user: 3 });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.count, 0);
  assert.equal(hidden.body.chat, 0);
  assert.equal(f.output().includes('is not defined'), false);
});

test('infra: uploads reject JSON types, SVG and false MIME while accepting a complete PNG', async t => {
  const f = await service(t);
  for (const image of [{}, [], null, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    dataUrl(Buffer.from('<html>not an image</html>')), 'data:image/png;base64,%%%']) {
    const result = await f.request('/api/upload/image', { method: 'POST', user: 2, body: { image } });
    assert.equal(result.status, 400, JSON.stringify(image));
  }
  const uploaded = await f.request('/api/upload/image', { method: 'POST', user: 2, body: { image: dataUrl(pngOne) } });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.url, /^\/uploads\/images\/[\w.-]+\.png$/);
  const image = await f.request(uploaded.body.url);
  assert.equal(image.status, 200);
  assert.match(image.headers['content-type'], /image\/png/);
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(image.headers['content-security-policy'], /sandbox/);
  assert.ok(image.bytes.subarray(0, 8).equals(pngOne.subarray(0, 8)));
});

test('infra: accepted uploads are decoded and rewritten without user-supplied private metadata', async t => {
  const f = await service(t);
  const sensitive = 'infra-fixture-sensitive-GPS-and-creator-metadata';
  const withMetadata = Buffer.concat([pngOne.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0' + sensitive)), pngOne.subarray(33)]);
  const upload = await f.request('/api/upload/image', { method: 'POST', user: 2, body: { image: dataUrl(withMetadata) } });
  assert.equal(upload.status, 200);
  const image = await f.request(upload.body.url);
  assert.equal(image.status, 200);
  assert.equal(image.bytes.includes(Buffer.from(sensitive)), false);
  assert.equal(image.bytes.includes(Buffer.from('tEXt')), false);
});

test('infra: upload decoding rejects truncated PNG, corrupt CRC, invalid IDAT, fake GIF and VP8X shells', async t => {
  const f = await service(t);
  const corruptCrc = Buffer.from(pngOne); corruptCrc[29] ^= 0xff;
  const fakeGif = Buffer.alloc(14); fakeGif.write('GIF89a'); fakeGif.writeUInt16LE(1, 6); fakeGif.writeUInt16LE(1, 8); fakeGif[13] = 0x3b;
  const fakeWebp = Buffer.alloc(30); fakeWebp.write('RIFF'); fakeWebp.writeUInt32LE(22, 4); fakeWebp.write('WEBPVP8X', 8); fakeWebp.writeUInt32LE(10, 16);
  const invalid = [[pngOne.subarray(0, 14), 'png'], [pngOne.subarray(0, -1), 'png'], [corruptCrc, 'png'],
    [png(undefined, Buffer.from('not-zlib-image-data')), 'png'], [fakeGif, 'gif'], [fakeWebp, 'webp']];
  const outcomes = [];
  for (const [bytes, format] of invalid) {
    const result = await f.request('/api/upload/image', { method: 'POST', user: 2, body: { image: dataUrl(bytes, format) } });
    outcomes.push({ format, length: bytes.length, status: result.status });
  }
  assert.deepEqual(outcomes.map(row => row.status), invalid.map(() => 400), JSON.stringify(outcomes));
});

test('infra: both avatar endpoints replace own files and preserve another account file', async t => {
  const f = await service(t);
  const first = await f.request('/api/avatar/upload', { method: 'PUT', user: 2, body: { avatar: dataUrl(pngOne) } });
  assert.equal(first.status, 200);
  assert.equal((await f.request(legacyOtherAvatar)).status, 200, 'legacy malicious reference must not delete user3 file');
  const second = await f.request('/api/auth/avatar', { method: 'PUT', user: 2, body: { avatar: dataUrl(pngTwo) } });
  assert.equal(second.status, 200);
  assert.equal((await f.request(first.body.avatar)).status, 404);
  assert.equal((await f.request(second.body.avatar)).status, 200);
  const third = await f.request('/api/avatar/upload', { method: 'PUT', user: 2, body: { avatar: dataUrl(pngOne) } });
  assert.equal(third.status, 200);
  assert.equal((await f.request(second.body.avatar)).status, 404);
  assert.equal((await f.request(legacyOtherAvatar)).status, 200);
  assert.equal((await f.request('/api/auth/avatar', { method: 'PUT', user: 2, body: { avatar: legacyOtherAvatar } })).status, 400);
});

test('infra: replacing a shared legacy avatar preserves files still referenced by another profile', async t => {
  const f = await service(t);
  const replacement = await f.request('/api/avatar/upload', { method: 'PUT', user: 4, body: { avatar: dataUrl(pngTwo) } });
  assert.equal(replacement.status, 200);
  assert.equal((await f.request(sharedAvatar)).status, 200);
  assert.ok(fs.existsSync(path.join(f.directory, sharedAvatar)));
});

test('infra: private image capabilities resist encoding bypass, path substitution and use as login tokens', async t => {
  const f = await service(t);
  const upload = await f.request('/api/upload/bug-image', { method: 'POST', user: 2, body: { image: dataUrl(pngOne) } });
  assert.equal(upload.status, 200);
  const signed = new URL(upload.body.url, 'http://fixture.invalid');
  const ticket = signed.searchParams.get('ticket');
  assert.ok(ticket);
  assert.equal(ticket.split('.').length, 2);
  const basename = path.posix.basename(signed.pathname);
  const variants = [signed.pathname, signed.pathname.replace('/bug-reports/', '/%62ug-reports/'),
    signed.pathname.replace('/bug-reports/', '/images/../bug-reports/'),
    signed.pathname.replace('/bug-reports/', '/images/%2e%2e/bug-reports/'),
    signed.pathname.replace('/bug-reports/', '/images%2f..%2fbug-reports/'),
    signed.pathname.replace('/uploads/', '/UPLOADS/'),
    '/uploads/bug-reports/' + '%62' + basename.slice(1)];
  for (const pathname of variants) {
    assert.equal((await f.request(pathname)).status, 404, pathname);
    const allowed = await f.request(pathname + '?ticket=' + encodeURIComponent(ticket));
    assert.equal(allowed.status, 200, pathname);
    assert.equal(allowed.headers['cache-control'], 'private, no-store');
    assert.equal(allowed.headers['referrer-policy'], 'no-referrer');
  }
  assert.equal((await f.request(signed.pathname, { user: 2 })).status, 404, 'API authentication alone is not an image capability');
  assert.equal((await f.request(signed.pathname + '?ticket=' + encodeURIComponent(f.token(2)))).status, 404);
  assert.equal((await f.request('/api/auth/me', { bearer: ticket })).status, 401);
  assert.equal((await f.request(signed.pathname + '?ticket=' + encodeURIComponent(ticket.slice(0, -1) + (ticket.endsWith('A') ? 'B' : 'A')))).status, 404);
  assert.equal((await f.request('/uploads/%2562ug-reports/' + basename)).status, 404);
  assert.equal((await f.request('/uploads/bug-reports/' + basename + '%00.png')).status, 404);
  assert.equal((await f.request('/uploads/bug-reports/%zz')).status, 400);
  const another = await f.request('/api/upload/bug-image', { method: 'POST', user: 2, body: { image: dataUrl(pngTwo) } });
  const anotherPath = new URL(another.body.url, 'http://fixture.invalid').pathname;
  assert.equal((await f.request(anotherPath + '?ticket=' + encodeURIComponent(ticket))).status, 404);
  const changed = await f.request('/api/auth/password', { method: 'PUT', user: 2, body: { oldPassword: 'infra-original-password', newPassword: 'infra-replacement-password' } });
  assert.equal(changed.status, 200);
  assert.equal((await f.request(upload.body.url)).status, 404, 'token-version revocation also revokes existing image capabilities');
});

test('infra: historical report images are private across encoded paths and only authorized report reads sign them', async t => {
  const f = await service(t);
  for (const pathname of [legacyEvidence, '/uploads/%69mages/legacy-evidence.png', '/uploads/avatars/../images/legacy-evidence.png']) {
    assert.equal((await f.request(pathname)).status, 404, pathname);
  }
  const unauthorized = await f.request('/api/reports/track/' + trackingCode, { user: 3 });
  assert.equal(unauthorized.status, 404);
  const authorized = await f.request('/api/reports/track/' + trackingCode, { user: 2 });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers['cache-control'], 'no-store');
  const images = JSON.parse(authorized.body.images);
  assert.equal(images.length, 1);
  assert.equal((await f.request(images[0])).status, 200);
  assert.equal((await f.request('/uploads/images/public.png')).status, 200);
  const forbidden = await f.request('/api/bug-reports', { method: 'POST', user: 3, body: { title: 'test', content: 'test', images: [legacyEvidence] } });
  assert.equal(forbidden.status, 400, 'public report endpoints cannot act as a signing oracle for legacy image URLs');
});

test('infra: mode=all whitelist protects APIs and management regardless of case and ignores spoofed proxy headers', async t => {
  const f = await service(t, { whitelistMode: 'all', whitelist: ['203.0.113.10'] });
  const headers = { 'CF-Connecting-IP': '203.0.113.10', 'X-Forwarded-For': '203.0.113.10' };
  for (const url of ['/api/auth/me', '/API/AUTH/ME', '/api/admin/db/whitelist', '/API/ADMIN/DB/WHITELIST',
    '/dashboard', '/DASHBOARD', '/dashboard/api/db/whitelist', '/api/walls/admin', '/api/permissions/user/2', '/api/bug-reports/admin']) {
    assert.equal((await f.request(url, { user: 1, headers })).status, 403, url);
  }
  assert.equal((await f.request('/api/health', { headers })).status, 200);
  assert.equal((await f.request('/API/HEALTH', { headers })).status, 200);
});

test('infra: trusted proxy chains use the nearest untrusted XFF hop instead of the attacker-controlled first IP or CF header', async t => {
  const f = await service(t, { whitelistMode: 'all', whitelist: ['203.0.113.10'], trustProxy: '1' });
  assert.equal((await f.request('/api/auth/me', { user: 2, headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 200);
  assert.equal((await f.request('/api/auth/me', { user: 2, headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 403);
  assert.equal((await f.request('/api/auth/me', { user: 2, headers: { 'X-Forwarded-For': '203.0.113.10, 198.51.100.22', 'CF-Connecting-IP': '203.0.113.10' } })).status, 403);
  const configuration = await f.request('/api/admin/db/whitelist', { user: 1, headers: { 'X-Forwarded-For': '203.0.113.10' } });
  assert.equal(configuration.status, 200);
  assert.equal(configuration.body.current_ip, '203.0.113.10');
});

test('infra: revoked or nonexistent-account JWTs share the anonymous write throttle and cannot mint fresh quota buckets', async t => {
  const f = await service(t);
  const responses = [];
  for (let index = 0; index < 45; index++) {
    const bearer = index % 2 ? f.token(2 + (index % 4), 99) : f.token(1000 + index);
    responses.push(await f.request('/api/no-such-write', { method: 'POST', bearer, body: {} }));
  }
  assert.ok(responses.some(response => response.status === 429));
  assert.equal(responses.at(-1).status, 429);
  assert.equal((await f.request('/api/no-such-write', { method: 'POST', user: 2, body: {} })).status, 404,
    'a current authenticated account retains its independent legitimate quota');
});

test('infra: authentication throttling remains per IP despite rotating valid, revoked or dashboard credentials', async t => {
  const f = await service(t);
  const tokens = [f.token(1), f.token(2), f.token(3), f.token(4), f.token(5), f.token(2, 99), f.token(1, 0, { aud: 'dashboard' })];
  const responses = [];
  for (let index = 0; index < 24; index++) {
    responses.push(await f.request('/api/auth/login', { method: 'POST', bearer: tokens[index % tokens.length],
      headers: { 'CF-Connecting-IP': '198.51.100.' + (index + 1), 'X-Forwarded-For': '198.51.100.' + (index + 1) },
      body: { username: 'does-not-exist', password: 'wrong-password' } }));
  }
  assert.ok(responses.some(response => response.status === 429));
  assert.equal(responses.at(-1).status, 429);
  assert.ok(Number(responses.at(-1).headers['retry-after']) > 0);
});
