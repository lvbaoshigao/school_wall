'use strict';
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-markdown-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'markdown-test-secret-not-for-production';
const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
let db, server, baseUrl, token;

before(async () => {
  db = await initDB({ deferInitialSave: true });
  db.prepare('INSERT INTO users (id,username,password_hash,nickname) VALUES (1,?,?,?)').run('markdown-user', 'unused-hash', '同学');
  db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (1,?,1)').run('Markdown 测试墙');
  db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,1,'member','active')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/posts', require('../routes/posts'));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/posts';
  token = jwt.sign({ id: 1, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
});
after(async () => {
  if (server) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  if (db) { db.dirty = false; db.db.close(); }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function request(endpoint, body) {
  const response = await fetch(baseUrl + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-wall-id': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('Markdown leading indentation survives publish, feed and detail reads', async () => {
  const content = '    const answer = 42;\n    console.log(answer);';
  const created = await request('', { content, is_markdown: true, is_anonymous: false, category: '分享' });
  assert.equal(created.status, 200);
  assert.equal(created.body.content, content);
  const feed = await request('');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.posts.find(post => post.id === created.body.id).content, content);
  const detail = await request('/' + created.body.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.post.content, content);
});

test('Markdown validation still rejects whitespace while ordinary post trimming is unchanged', async () => {
  assert.equal((await request('', { content: '  \n  ', is_markdown: true })).status, 400);
  const created = await request('', { content: '  普通文本  ', is_markdown: false });
  assert.equal(created.status, 200);
  assert.equal(created.body.content, '普通文本');
});
