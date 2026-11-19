'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
process.env.JWT_SECRET = 'phase2-preferences-isolated-test-key';
const { SECRET, authRequired } = require('../middleware/auth');
const prefsLib = require('../lib/prefs');
const authRouter = require('../routes/auth');
const sqlReady = initSqlJs();
const schema = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8').match(/wrapper\.exec\(`([\s\S]*?)`\);/)[1];

function wrapper(db) {
  return {
    db,
    prepare(sql) {
      const rows = parameters => {
        const statement = db.prepare(sql);
        try {
          if (parameters.length) statement.bind(parameters);
          const result = [];
          while (statement.step()) result.push(statement.getAsObject());
          return result;
        } finally { statement.free(); }
      };
      return {
        get(...parameters) { return rows(parameters)[0]; },
        all(...parameters) { return rows(parameters); },
        run(...parameters) {
          db.run(sql, parameters);
          return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
        },
      };
    },
  };
}

async function fixture(t) {
  const SQL = await sqlReady;
  const db = wrapper(new SQL.Database());
  db.db.run(schema);
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,real_name,contact_qq,show_real_name,show_contact,token_version) VALUES (?,?,?,?,?,?,1,1,0)')
      .run(id, 'phase2user' + id, 'private-test-hash-' + id, 'private-nickname-' + id, 'private-real-name-' + id, 'private-contact-' + id);
  }
  db.prepare("INSERT INTO settings (key,value) VALUES ('initialized','1')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  // Mirror the API adapter's trusted internal property without touching production data or server startup.
  app.use('/api/v1', (req, res, next) => { req.apiCanonicalPath = '/api' + req.url.split('?')[0]; next(); });
  app.use('/api/v1/auth', authRouter);
  app.use('/api/auth', authRouter);
  for (const prefix of ['/api/messages', '/api/v1/messages']) app.use(prefix, authRequired, (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'isolated test error' }));
  const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.db.close(); });
  const token = id => jwt.sign({ id, tv: 0 }, SECRET, { expiresIn: '1h' });
  const request = (method, url, body, user = 1) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (user !== null) headers.Authorization = 'Bearer ' + token(user);
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: url, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let result; try { result = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: result, headers: res.headers, text });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('isolated preferences request timed out')));
    req.on('error', reject); req.end(payload);
  });
  const save = (prefs, user = 1, key = 'navbar') => db.prepare('INSERT OR REPLACE INTO user_prefs (user_id,pref_key,pref_value) VALUES (?,?,?)').run(user, key, JSON.stringify(prefs));
  const stored = (user = 1, key = 'navbar') => db.prepare('SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key=?').get(user, key)?.pref_value;
  return { db, request, save, stored };
}

function modifiedDefaults() {
  return Object.fromEntries(Object.entries(prefsLib.PREF_SCHEMA).map(([key, spec]) =>
    [key, spec.type === 'bool' ? !spec.def : spec.values.find(value => value !== spec.def)]));
}

test('phase2 preferences: six shared defaults and typed enums match the agreed contract', () => {
  const defaults = prefsLib.mergePrefs({});
  assert.equal(Object.keys(defaults).length, 39);
  assert.deepEqual(Object.fromEntries(['chat_send_shortcut', 'chat_density', 'chat_show_timestamps',
    'chat_poll_interval', 'theme_mode', 'wallpaper_enabled'].map(key => [key, defaults[key]])), {
    chat_send_shortcut: 'enter', chat_density: 'comfortable', chat_show_timestamps: true,
    chat_poll_interval: '20', theme_mode: 'system', wallpaper_enabled: true,
  });
  assert.deepEqual(prefsLib.PREF_SCHEMA.chat_poll_interval.values, ['10', '20', '30', '60']);
  assert.deepEqual(prefsLib.PREF_SCHEMA.chat_send_shortcut.values, ['enter', 'modifier']);
  for (const [key, spec] of Object.entries(prefsLib.PREF_SCHEMA)) {
    for (const value of spec.type === 'bool' ? [true, false] : spec.values) {
      assert.deepEqual(prefsLib.sanitizePrefs({ [key]: value }), { [key]: value });
    }
  }
});

test('phase2 preferences: categories partition the schema and discovery returns independent safe copies', () => {
  const contract = prefsLib.getPrefsSchema();
  assert.equal(contract.version, 1);
  assert.deepEqual(Object.keys(contract).sort(), ['defaults', 'schema', 'scopes', 'version']);
  const scoped = Object.entries(contract.scopes).filter(([scope]) => scope !== 'all').flatMap(([, keys]) => keys);
  assert.equal(new Set(scoped).size, scoped.length);
  assert.deepEqual([...scoped].sort(), [...contract.scopes.all].sort());
  assert.equal(contract.scopes.publishing.length, 4);
  assert.equal(contract.scopes.reading.includes('default_markdown'), false);
  assert.equal(contract.scopes.navigation.includes('theme'), true);
  assert.equal(contract.scopes.appearance.includes('theme_mode'), true);
  for (const [key, spec] of Object.entries(contract.schema)) {
    assert.ok(contract.scopes[spec.scope].includes(key));
    assert.equal(spec.default, contract.defaults[key]);
    assert.ok(['bool', 'enum'].includes(spec.type));
    if (spec.type === 'enum') assert.ok(spec.values.includes(spec.default));
  }
  for (const key of ['show_contact', 'real_name', 'password', 'password_hash', 'token', 'token_version']) assert.equal(Object.hasOwn(contract.schema, key), false);
  contract.scopes.chat.push('token');
  contract.schema.theme_mode.values.push('arbitrary');
  contract.defaults.chat_show_timestamps = false;
  assert.equal(prefsLib.getPrefsSchema().scopes.chat.includes('token'), false);
  assert.equal(prefsLib.sanitizePrefs({ theme_mode: 'arbitrary' }).theme_mode, undefined);
  assert.equal(prefsLib.getPrefsSchema().defaults.chat_show_timestamps, true);
});

test('phase2 preferences: invalid values, array inputs and inherited properties never override defaults or persistence patches', () => {
  const invalid = { chat_send_shortcut: 'Ctrl+Enter', chat_density: [], chat_show_timestamps: 'false',
    chat_poll_interval: 30, theme_mode: 'sepia', wallpaper_enabled: 0, token: 'never-store' };
  assert.deepEqual(prefsLib.sanitizePrefs(invalid), {});
  assert.deepEqual(prefsLib.mergePrefs(invalid), prefsLib.mergePrefs({}));
  assert.deepEqual(prefsLib.sanitizePrefs([]), {});
  const inherited = Object.create({ chat_show_timestamps: false, theme_mode: 'dark' });
  assert.deepEqual(prefsLib.sanitizePrefs(inherited), {});
  assert.equal(prefsLib.mergePrefs(inherited).theme_mode, 'system');
  assert.deepEqual(prefsLib.sanitizePrefs(JSON.parse('{"__proto__":{"polluted":true},"chat_density":"compact"}')), { chat_density: 'compact' });
  assert.equal(Object.prototype.polluted, undefined);
});

test('phase2 preferences: schema and reset require a valid session and schema never includes account values', async t => {
  const f = await fixture(t);
  for (const [method, url, body] of [['GET', '/api/auth/prefs/schema'], ['POST', '/api/auth/prefs/reset', { scope: 'all' }]]) {
    assert.equal((await f.request(method, url, body, null)).status, 401);
  }
  f.save({ accent: 'forest', chat_density: 'compact' }, 1);
  f.save({ accent: 'rose', chat_density: 'comfortable' }, 2);
  const a = await f.request('GET', '/api/auth/prefs/schema');
  const b = await f.request('GET', '/api/auth/prefs/schema', undefined, 2);
  assert.equal(a.status, 200);
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.deepEqual(a.body, b.body);
  assert.equal(a.text.includes('private-'), false);
  assert.deepEqual(a.body.defaults, prefsLib.mergePrefs({}));
  f.db.prepare('UPDATE users SET token_version=1 WHERE id=1').run();
  assert.equal((await f.request('GET', '/api/auth/prefs/schema')).status, 401);
});

test('phase2 preferences: legacy bulk updates retain their shape and ignore invalid or unknown fields without losing valid values', async t => {
  const f = await fixture(t);
  f.save({ home: false, accent: 'forest', chat_poll_interval: '60', wallpaper_enabled: false });
  const saved = await f.request('PUT', '/api/auth/prefs', { prefs: { chat_send_shortcut: 'modifier', chat_density: 'compact',
    chat_show_timestamps: false, chat_poll_interval: 20, theme_mode: 'dark', wallpaper_enabled: 'true',
    accent: 'unknown', future_key: 'ignored', token: 'ignored' }, user_id: 2 });
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(saved.body), ['prefs']);
  assert.equal(saved.body.prefs.home, false);
  assert.equal(saved.body.prefs.accent, 'forest');
  assert.equal(saved.body.prefs.chat_poll_interval, '60');
  assert.equal(saved.body.prefs.wallpaper_enabled, false);
  assert.equal(saved.body.prefs.chat_density, 'compact');
  assert.equal(saved.body.prefs.chat_show_timestamps, false);
  assert.equal(saved.body.prefs.theme_mode, 'dark');
  assert.equal(Object.hasOwn(JSON.parse(f.stored()), 'future_key'), false);
  assert.equal(f.stored(2), undefined);
  assert.deepEqual((await f.request('GET', '/api/auth/prefs')).body.prefs, saved.body.prefs);
  assert.equal((await f.request('PUT', '/api/auth/prefs', { prefs: {} })).status, 200);
});

for (const scope of ['appearance', 'chat', 'notifications', 'navigation', 'reading', 'publishing']) {
  test('phase2 preferences: resetting ' + scope + ' changes only that category', async t => {
    const f = await fixture(t);
    const before = modifiedDefaults();
    f.save(before); f.save({ accent: 'rose' }, 2); f.save({ draft: 'preserve' }, 1, 'drafts');
    const other = f.stored(2);
    const response = await f.request('POST', '/api/auth/prefs/reset', { scope });
    assert.equal(response.status, 200);
    for (const key of Object.keys(before)) {
      assert.equal(response.body.prefs[key], prefsLib.PREF_SCOPES[scope].includes(key) ? prefsLib.PREF_SCHEMA[key].def : before[key], key);
    }
    assert.equal(f.stored(2), other);
    assert.deepEqual(JSON.parse(f.stored(1, 'drafts')), { draft: 'preserve' });
    assert.deepEqual((await f.request('GET', '/api/auth/prefs')).body.prefs, response.body.prefs);
  });
}

test('phase2 preferences: storedKeys distinguishes an unset theme from explicit system and survives unrelated scoped resets', async t => {
  const f = await fixture(t);
  const initial = await f.request('GET', '/api/auth/prefs');
  assert.equal(initial.body.prefs.theme_mode, 'system');
  assert.deepEqual(initial.body.storedKeys, []);
  f.save({ theme_mode: 'system', wallpaper_enabled: false, unknown_private_key: 'not-listed' }, 2);
  const explicit = await f.request('GET', '/api/auth/prefs', undefined, 2);
  assert.deepEqual(explicit.body.storedKeys.sort(), ['theme_mode', 'wallpaper_enabled']);
  assert.equal((await f.request('POST', '/api/auth/prefs/reset', { scope: 'chat' })).status, 200);
  const chatReset = await f.request('GET', '/api/auth/prefs');
  assert.equal(chatReset.body.storedKeys.includes('theme_mode'), false);
  assert.deepEqual(chatReset.body.storedKeys.sort(), [...prefsLib.PREF_SCOPES.chat].sort());
  assert.equal((await f.request('PUT', '/api/auth/prefs', { prefs: { theme_mode: 'dark' } })).status, 200);
  assert.equal((await f.request('GET', '/api/auth/prefs')).body.storedKeys.includes('theme_mode'), true);
  f.save({ theme_mode: 'invalid', chat_poll_interval: 30 });
  assert.deepEqual((await f.request('GET', '/api/auth/prefs')).body.storedKeys, []);
  assert.equal((await f.request('POST', '/api/auth/prefs/reset', { scope: 'appearance' })).status, 200);
  assert.equal((await f.request('GET', '/api/auth/prefs')).body.storedKeys.includes('theme_mode'), true);
});

test('phase2 preferences: all reset changes preferences only and keeps privacy, password and the active session intact', async t => {
  const f = await fixture(t);
  f.save(modifiedDefaults()); f.save({ future: 'keep-other-user' }, 2);
  const users = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  const other = f.stored(2);
  const reset = await f.request('POST', '/api/auth/prefs/reset', { scope: 'all' });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { prefs: prefsLib.mergePrefs({}) });
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), users);
  assert.equal(f.stored(2), other);
  assert.equal((await f.request('GET', '/api/auth/me')).status, 200);
});

test('phase2 preferences: new reset rejects missing, unknown and malformed scopes or extra fields with400 and no mutation', async t => {
  const f = await fixture(t);
  f.save(modifiedDefaults());
  const before = f.stored();
  for (const body of [undefined, {}, [], null, { scope: '' }, { scope: 'privacy' }, { scope: 'constructor' },
    { scope: '__proto__' }, { scope: ['all'] }, { scope: true }, { scope: 1 }, { scope: 'all', user_id: 2 },
    { scope: 'chat', prefs: { accent: 'rose' } }, { group: 'chat' }]) {
    assert.equal((await f.request('POST', '/api/auth/prefs/reset', body)).status, 400, JSON.stringify(body));
    assert.equal(f.stored(), before);
  }
  for (const prefs of [null, [], false, 'invalid']) assert.equal((await f.request('PUT', '/api/auth/prefs', { prefs })).status, 400);
});

test('phase2 preferences: corrupt and primitive legacy storage recovers through read, save and reset', async t => {
  const f = await fixture(t);
  for (const stored of ['{broken', 'null', '[]', '"old string"', '42']) {
    f.db.prepare("INSERT OR REPLACE INTO user_prefs (user_id,pref_key,pref_value) VALUES (1,'navbar',?)").run(stored);
    assert.deepEqual((await f.request('GET', '/api/auth/prefs')).body.prefs, prefsLib.mergePrefs({}));
    const save = await f.request('PUT', '/api/auth/prefs', { prefs: { chat_poll_interval: '30' } });
    assert.equal(save.status, 200); assert.equal(save.body.prefs.chat_poll_interval, '30');
    const reset = await f.request('POST', '/api/auth/prefs/reset', { scope: 'chat' });
    assert.equal(reset.status, 200); assert.equal(reset.body.prefs.chat_poll_interval, '20');
  }
});

test('phase2 preferences: disjoint simultaneous saves and scoped resets do not lose other categories', async t => {
  const f = await fixture(t);
  const updates = await Promise.all([
    f.request('PUT', '/api/auth/prefs', { prefs: { accent: 'forest' } }),
    f.request('PUT', '/api/auth/prefs', { prefs: { chat_density: 'compact' } }),
  ]);
  assert.deepEqual(updates.map(result => result.status), [200, 200]);
  const operations = await Promise.all([
    f.request('POST', '/api/auth/prefs/reset', { scope: 'chat' }),
    f.request('PUT', '/api/auth/prefs', { prefs: { font_scale: 'lg' } }),
  ]);
  assert.deepEqual(operations.map(result => result.status), [200, 200]);
  const saved = (await f.request('GET', '/api/auth/prefs')).body.prefs;
  assert.equal(saved.accent, 'forest'); assert.equal(saved.font_scale, 'lg'); assert.equal(saved.chat_density, 'comfortable');
});

test('phase2 preferences: failed save/reset preserves the old row and permits a successful retry', async t => {
  const f = await fixture(t);
  f.save({ accent: 'rose', chat_density: 'compact' });
  const before = f.stored();
  f.db.db.run("CREATE TRIGGER fail_prefs BEFORE INSERT ON user_prefs WHEN NEW.user_id=1 AND NEW.pref_key='navbar' BEGIN SELECT RAISE(ABORT, 'injected private database failure'); END");
  for (const [method, url, body] of [['PUT', '/api/auth/prefs', { prefs: { accent: 'forest' } }], ['POST', '/api/auth/prefs/reset', { scope: 'all' }]]) {
    const response = await f.request(method, url, body);
    assert.equal(response.status, 500); assert.equal(response.text.includes('injected private'), false);
    assert.equal(f.stored(), before);
  }
  f.db.db.run('DROP TRIGGER fail_prefs');
  assert.equal((await f.request('POST', '/api/auth/prefs/reset', { scope: 'all' })).status, 200);
  assert.deepEqual(JSON.parse(f.stored()), prefsLib.mergePrefs({}));
});

test('phase2 preferences: save/reset use nested transactions without committing their caller transaction', async t => {
  const f = await fixture(t);
  f.save({ accent: 'rose', chat_density: 'compact' });
  const before = f.stored();
  f.db.db.run('BEGIN');
  assert.equal((await f.request('PUT', '/api/auth/prefs', { prefs: { accent: 'forest' } })).status, 200);
  assert.equal((await f.request('POST', '/api/auth/prefs/reset', { scope: 'chat' })).status, 200);
  assert.equal(JSON.parse(f.stored()).accent, 'forest');
  f.db.db.run('ROLLBACK');
  assert.equal(f.stored(), before);
});

test('phase2 preferences: canonical v1 paths preserve chat bans and the valid-session appeal exception', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET status='banned',ban_level='chat' WHERE id=1").run();
  assert.equal((await f.request('GET', '/api/messages/private')).status, 403);
  assert.equal((await f.request('GET', '/api/v1/messages/private')).status, 403);
  f.db.prepare("UPDATE users SET ban_level='login' WHERE id=1").run();
  const appeal = await f.request('POST', '/api/v1/auth/appeal', { reason: 'phase2 isolated appeal' });
  assert.equal(appeal.status, 200);
  assert.equal((await f.request('POST', '/api/v1/auth/prefs/reset', { scope: 'all' })).status, 403);
});
