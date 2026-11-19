const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { hashPassword } = require('../lib/password');
const initSqlJs = require('sql.js');

test('phase2: upgrading an existing database preserves messages and establishes idempotency constraints', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-phase2-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  const schema = source.match(/wrapper\.exec\(`([\s\S]*?)`\);/)[1].replace(/\s*client_message_id TEXT DEFAULT NULL,/, '');
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(schema);
  for (const id of [1, 2]) database.run("INSERT INTO users (id, username, nickname, password_hash) VALUES (?, ?, ?, 'unused-in-isolated-migration')", [id, 'migration-user-' + id, '迁移样本' + id]);
  database.run("INSERT INTO settings (key,value) VALUES ('initialized','1')");
  database.run("INSERT INTO messages (sender_id,receiver_id,type,content) VALUES (1,2,'private','previous message')");
  fs.writeFileSync(path.join(directory, 'data.db'), Buffer.from(database.export()), { mode: 0o600 });
  database.close();
  const program = `
    (async () => {
      const { initDB } = require(${JSON.stringify(path.join(root, 'db.js'))});
      const db = await initDB();
      const before = db.prepare('SELECT id, content, client_message_id FROM messages ORDER BY id').all();
      db.prepare("INSERT INTO messages (sender_id,receiver_id,type,content,client_message_id) VALUES (1,2,'private','new message','migration-request-1')").run();
      let duplicateRejected = false;
      try { db.prepare("INSERT INTO messages (sender_id,receiver_id,type,content,client_message_id) VALUES (1,2,'private','duplicate','migration-request-1')").run(); } catch { duplicateRejected = true; }
      db.prepare("INSERT INTO messages (sender_id,receiver_id,type,content,client_message_id) VALUES (2,1,'private','different sender','migration-request-1')").run();
      const after = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_messages_%'").all().map(row => row.name);
      db.saveNow();
      console.log('MIGRATION_RESULT=' + JSON.stringify({ before, after, duplicateRejected, indexes }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', program], { cwd: root, env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1' }, timeout: 15000, encoding: 'utf8' });
  const result = JSON.parse(output.split('\n').find(line => line.startsWith('MIGRATION_RESULT=')).slice('MIGRATION_RESULT='.length));
  assert.deepEqual(result.before, [{ id: 1, content: 'previous message', client_message_id: null }]);
  assert.equal(result.after, 3);
  assert.equal(result.duplicateRejected, true);
  for (const name of ['idx_messages_sender_client_id', 'idx_messages_private_incoming', 'idx_messages_private_outgoing']) assert.ok(result.indexes.includes(name));
  assert.equal(fs.statSync(path.join(directory, 'data.db')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(directory, '.jwt_secret')), false);
});

async function mainFixture(t, { whitelist = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-phase2-main-'));
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  const schema = source.match(/wrapper\.exec\(`([\s\S]*?)`\);/)[1];
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(schema);
  const password = await hashPassword('phase2-integration-password');
  for (const id of [1, 2, 3]) {
    database.run("INSERT INTO users (id,username,nickname,password_hash,role,status,ban_level) VALUES (?,?,?,?,?,?,?)", [id, 'phase2-user-' + id, '隔离样本' + id, password, id === 1 ? 'super_admin' : 'user', id === 3 ? 'banned' : 'active', id === 3 ? 'chat' : 'login']);
  }
  database.run("INSERT INTO walls (id,name,owner_id) VALUES (1,'隔离校园',1)");
  for (const id of [1, 2, 3]) database.run("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,?,'active')", [id, id === 1 ? 'owner' : 'member']);
  database.run("INSERT INTO settings (key,value) VALUES ('initialized','1'),('ip_whitelist_mode',?),('admin_ip_whitelist',?)", [whitelist ? 'all' : 'off', whitelist ? '["203.0.113.10"]' : '[]']);
  fs.writeFileSync(path.join(directory, 'data.db'), Buffer.from(database.export()), { mode: 0o600 });
  database.close();
  const secret = 'phase2-isolated-key-' + Math.random().toString(36).slice(2);
  const bootstrap = "const http=require('node:http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args)};require(" + JSON.stringify(path.join(root, 'index.js')) + ");";
  const child = spawn(process.execPath, ['-e', bootstrap], { cwd: root, env: { ...process.env, NODE_ENV: 'production', DATA_DIR: directory, KEEP_DB: '1', JWT_SECRET: secret, HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '0', ADMIN_IP_WHITELIST: '', ALLOWED_ORIGINS: 'https://mobile.example.test' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', value => { output = (output + value).slice(-16000); });
  child.stderr.on('data', value => { output = (output + value).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.kill('SIGTERM');
      try { await ended; } finally { clearTimeout(deadline); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Isolated main timeout: ' + output)), 15000);
    child.once('message', message => { clearTimeout(deadline); resolve(message.port); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('Main exited: ' + output)); });
  });
  const request = (url, { method = 'GET', body, raw, user, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const requestHeaders = { ...headers };
    if (user) requestHeaders.Authorization = 'Bearer ' + jwt.sign({ id: user, tv: 0 }, secret, { expiresIn: '1h' });
    if (payload !== undefined) { requestHeaders['Content-Type'] = 'application/json'; requestHeaders['Content-Length'] = Buffer.byteLength(payload); }
    const request = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: requestHeaders, agent: false }, response => {
      const chunks = []; response.on('data', value => chunks.push(value)); response.on('end', () => { const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); let data; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, body: data, bytes }); });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Request timeout: ' + url)));
    request.on('error', reject); request.end(payload);
  });
  return { request, output: () => output };
}

test('phase2: real main keeps legacy APIs while v1 envelopes auth, preferences and request errors', async t => {
  const f = await mainFixture(t);
  const legacy = await f.request('/api/auth/me', { user: 2 });
  assert.equal(legacy.status, 200); assert.equal(legacy.body.id, 2); assert.equal(legacy.body.meta, undefined);
  const versioned = await f.request('/api/v1/auth/me', { user: 2 });
  assert.equal(versioned.status, 200); assert.equal(versioned.body.data.id, 2); assert.equal(versioned.body.error, null);
  assert.equal(versioned.body.meta.apiVersion, '1'); assert.equal(typeof versioned.body.meta.requestId, 'string');
  assert.equal(versioned.headers['x-api-version'], '1');
  const denied = await f.request('/api/v1/auth/me');
  assert.equal(denied.status, 401); assert.equal(denied.body.data, null); assert.equal(typeof denied.body.error.code, 'string');
  const malformed = await f.request('/api/v1/auth/login', { method: 'POST', raw: '{' });
  assert.equal(malformed.status, 400); assert.equal(malformed.body.data, null); assert.ok(malformed.body.meta.requestId);
  const large = await f.request('/api/v1/auth/login', { method: 'POST', body: { input: 'x'.repeat(140000) } });
  assert.equal(large.status, 413); assert.ok(large.body.error);
  const prefs = await f.request('/api/v1/auth/prefs/schema', { user: 2 });
  assert.equal(prefs.status, 200); assert.ok(prefs.body.data.schema.chat_send_shortcut);
  assert.equal((await f.request('/api/v1/auth/prefs', { method: 'PUT', user: 2, body: { prefs: { chat_density: 'compact', wallpaper_enabled: false } } })).status, 200);
  const reset = await f.request('/api/v1/auth/prefs/reset', { method: 'POST', user: 2, body: { scope: 'chat' } });
  assert.equal(reset.status, 200); assert.equal(reset.body.data.prefs.chat_density, 'comfortable'); assert.equal(reset.body.data.prefs.wallpaper_enabled, false);
  const exportFile = await f.request('/api/v1/auth/export', { user: 2 });
  assert.equal(exportFile.status, 200); assert.ok(exportFile.bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])));
  const banned = await f.request('/api/v1/messages/conversations', { user: 3 });
  assert.equal(banned.status, 403); assert.equal(banned.body.error.code, 'BANNED');
  const allowedCors = await f.request('/api/v1/capabilities', { headers: { Origin: 'https://mobile.example.test' } });
  assert.equal(allowedCors.headers['access-control-allow-origin'], 'https://mobile.example.test');
  const deniedCors = await f.request('/api/v1/capabilities', { headers: { Origin: 'https://untrusted.example.test' } });
  assert.equal(deniedCors.headers['access-control-allow-origin'], undefined);
  assert.equal(f.output().includes('is not defined'), false);
});

test('phase2: versioned messaging preserves quotes and deduplicates a retry from a legacy send', async t => {
  const f = await mainFixture(t);
  const originalBody = { receiver_id: 2, type: 'private', content: '可定位的原消息', client_message_id: 'phase2-message-original' };
  const original = await f.request('/api/messages', { method: 'POST', user: 1, body: originalBody });
  assert.equal(original.status, 200);
  const repeated = await f.request('/api/v1/messages', { method: 'POST', user: 1, body: originalBody });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.data.id, original.body.id); assert.equal(repeated.body.data.deduplicated, true);
  const conflict = await f.request('/api/v1/messages', { method: 'POST', user: 1, body: { ...originalBody, content: 'different' } });
  assert.equal(conflict.status, 409);
  const quoted = await f.request('/api/v1/messages', { method: 'POST', user: 2, body: { receiver_id: 1, type: 'private', content: '已引用', reply_to_id: original.body.id, client_message_id: 'phase2-message-reply' } });
  assert.equal(quoted.status, 200);
  const history = await f.request('/api/v1/messages/conversation/1?mark_read=0&limit=1', { user: 2 });
  assert.equal(history.status, 200); assert.equal(history.body.data.messages.length, 1); assert.equal(history.body.data.hasMore, true);
  assert.equal(history.body.data.messages[0].reply_to.available, true);
  const around = await f.request('/api/v1/messages/conversation/1?around_id=' + original.body.id + '&mark_read=0&limit=10', { user: 2 });
  assert.equal(around.status, 200); assert.ok(around.body.data.messages.some(message => message.id === original.body.id));
  const summaries = await f.request('/api/v1/messages/conversations', { user: 2 });
  assert.equal(summaries.status, 200); assert.equal(summaries.body.data.conversations[0].user_id, 1);
  assert.equal((await f.request('/api/v1/messages/' + original.body.id, { method: 'DELETE', user: 2 })).status, 200);
  const hidden = await f.request('/api/v1/messages/conversation/1?mark_read=0', { user: 2 });
  assert.equal(hidden.status, 200); assert.equal(hidden.body.data.messages[0].reply_to.available, false); assert.equal(hidden.body.data.messages[0].reply_to.content, '');
});

test('phase2: discovery, documentation and unsupported versions remain behind the all-IP guard', async t => {
  const f = await mainFixture(t, { whitelist: true });
  for (const route of ['/api/v1', '/api/v1/capabilities', '/api/v1/openapi.json', '/api/v2/auth/me']) {
    const response = await f.request(route);
    assert.equal(response.status, 403, route); assert.equal(response.body.data, null); assert.ok(response.body.error);
  }
  assert.equal((await f.request('/api/health')).status, 200);
});
