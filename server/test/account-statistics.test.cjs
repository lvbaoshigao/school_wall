'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-account-statistics-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'account-statistics-isolated-test-secret';
delete process.env.KEEP_DB;
const express = require('express');
const jwt = require('jsonwebtoken');
const { initDB } = require('../db');
const { apiV1Middleware, apiV1Router } = require('../lib/apiV1');
let db, server, baseUrl;
const zeroCounts = { walls_joined: 0, friends: 0, named_posts: 0, comments: 0, bookmarks: 0, votes_participated: 0 };
const ownCounts = { walls_joined: 2, friends: 2, named_posts: 2, comments: 2, bookmarks: 2, votes_participated: 2 };
const registeredAt = '2024-03-02 13:14:15';

before(async () => {
  db = await initDB({ deferInitialSave: true });
  const app = express();
  app.use(apiV1Middleware());
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api', apiV1Router());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  for (const table of ['vote_records', 'vote_options', 'votes', 'bookmarks', 'comments', 'posts', 'friends', 'wall_members', 'walls', 'users']) db.exec('DELETE FROM ' + table);
  for (const userId of [1, 2, 3, 4, 5]) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,created_at) VALUES (?,?,?,?,?)')
      .run(userId, 'statistics-user-' + userId, 'unused-hash', 'private-nickname-' + userId, userId === 5 ? null : registeredAt);
  }
  for (const [wallId, status] of [[1, 'active'], [2, 'active'], [3, 'pending'], [4, 'disabled'], [5, 'active'], [6, 'active'], [7, 'active']]) {
    db.prepare('INSERT INTO walls (id,name,owner_id,status) VALUES (?,?,1,?)').run(wallId, 'statistics-wall-' + wallId, status);
  }
  for (const [wallId, status] of [[1, 'active'], [2, 'active'], [3, 'active'], [4, 'active'], [5, 'pending'], [6, 'banned'], [999, 'active']]) {
    db.prepare('INSERT INTO wall_members (wall_id,user_id,status) VALUES (?,1,?)').run(wallId, status);
  }
  db.prepare("INSERT INTO wall_members (wall_id,user_id,status) VALUES (1,2,'active')").run();
  for (const [userId, friendId, status] of [[1, 2, 'accepted'], [2, 1, 'accepted'], [3, 1, 'accepted'], [1, 4, 'pending'], [4, 1, 'blocked'], [1, 1, 'accepted'], [1, 999, 'accepted']]) {
    db.prepare('INSERT INTO friends (user_id,friend_id,status) VALUES (?,?,?)').run(userId, friendId, status);
  }
  for (const [id, wallId, authorId, anonymous] of [[1, 1, 1, 0], [2, 2, 1, 0], [3, 1, 2, 0], [4, 1, null, 1], [5, 2, 1, 1]]) {
    db.prepare('INSERT INTO posts (id,wall_id,author_id,is_anonymous,content,author_ip) VALUES (?,?,?,?,?,?)')
      .run(id, wallId, authorId, anonymous, 'sensitive-post-content-' + id, 'private-ip-hash');
  }
  for (const [postId, authorId] of [[1, 1], [3, 1], [1, 2], [2, 3]]) {
    db.prepare('INSERT INTO comments (post_id,author_id,content,author_ip) VALUES (?,?,?,?)')
      .run(postId, authorId, 'sensitive-comment-content', 'private-comment-ip');
  }
  for (const [userId, postId] of [[1, 1], [1, 3], [1, 999], [2, 2]]) db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (?,?)').run(userId, postId);
  for (const voteId of [1, 2, 3]) {
    db.prepare('INSERT INTO votes (id,wall_id,title,author_id,author_ip) VALUES (?,?,?,?,?)').run(voteId, voteId === 2 ? 2 : 1, 'private-vote-title', 2, 'private-vote-ip');
    db.prepare('INSERT INTO vote_options (id,vote_id,option_text) VALUES (?,?,?)').run(voteId, voteId, 'private-vote-option');
  }
  for (const [voteId, userId] of [[1, 1], [2, 1], [1, 2], [3, 2]]) db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,?)').run(voteId, voteId, userId);
});

after(async () => {
  if (server) {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
  if (db) { db.dirty = false; db.db.close(); }
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('school-wall-account-statistics-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(userId = 1, { route = '/auth/statistics', versioned = false, wall = null, token, claims = {} } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = 'Bearer ' + (token ?? jwt.sign({ id: userId, tv: 0, ...claims }, process.env.JWT_SECRET, { expiresIn: '5m' }));
  if (wall !== null) headers['X-Wall-Id'] = String(wall);
  const response = await fetch(baseUrl + (versioned ? '/api/v1' : '/api') + route, { headers, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('statistics requires a valid current account session', async () => {
  for (const options of [{ token: null }, { token: 'invalid-token' }, { claims: { exp: 1 }, token: jwt.sign({ id: 1, tv: 0, exp: 1 }, process.env.JWT_SECRET) }]) {
    assert.equal((await request(1, options)).status, 401);
  }
  assert.equal((await request(999)).status, 401);
  db.prepare('UPDATE users SET token_version=1 WHERE id=1').run();
  assert.equal((await request()).status, 401);
});

test('statistics preserves existing disabled and globally banned account guards', async () => {
  for (const status of ['disabled', 'banned']) {
    db.prepare("UPDATE users SET status=?,ban_level='login',ban_until='' WHERE id=1").run(status);
    assert.equal((await request()).status, 403);
  }
});

test('empty no-wall account returns null registration and every zero count', async () => {
  const result = await request(5);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { registered_at: null, counts: zeroCounts });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('statistics returns only the authenticated global account aggregates', async () => {
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { registered_at: registeredAt, counts: ownCounts });
  for (const count of Object.values(result.body.counts)) assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.doesNotMatch(JSON.stringify(result.body), /sensitive|private|author|nickname|content|user_id|anonymous/);
});

test('active joined walls exclude pending, disabled, banned and dangling memberships', async () => {
  assert.equal((await request()).body.counts.walls_joined, 2);
  db.prepare("UPDATE wall_members SET status='pending' WHERE wall_id=2 AND user_id=1").run();
  assert.equal((await request()).body.counts.walls_joined, 1);
  db.prepare("UPDATE walls SET status='pending' WHERE id=1").run();
  assert.equal((await request()).body.counts.walls_joined, 0);
});

test('accepted friends deduplicate opposite directions and ignore pending/blocked/self/orphan rows', async () => {
  assert.equal((await request()).body.counts.friends, 2);
  db.prepare("UPDATE users SET status='banned' WHERE id=3").run();
  assert.equal((await request()).body.counts.friends, 2);
  db.prepare('DELETE FROM friends WHERE user_id=1 AND friend_id=2').run();
  assert.equal((await request()).body.counts.friends, 2);
  db.prepare("UPDATE friends SET status='pending' WHERE user_id=2 AND friend_id=1").run();
  assert.equal((await request()).body.counts.friends, 1);
});

test('named posts never infer anonymous ownership, including legacy retained author IDs', async () => {
  const before = (await request()).body;
  db.prepare("INSERT INTO posts (wall_id,author_id,is_anonymous,content,author_ip) VALUES (1,NULL,1,'anonymous secret','private-ip-hash')").run();
  db.prepare("INSERT INTO posts (wall_id,author_id,is_anonymous,content,author_ip) VALUES (1,1,1,'legacy anonymous secret','private-ip-hash')").run();
  assert.deepEqual((await request()).body, before);
});

test('bookmarks exclude posts that no longer exist', async () => {
  assert.equal((await request()).body.counts.bookmarks, 2);
  db.prepare('DELETE FROM posts WHERE id=3').run();
  assert.equal((await request()).body.counts.bookmarks, 1);
});

test('vote participation deduplicates legacy records and excludes nonexistent votes', async () => {
  db.exec('SAVEPOINT legacy_vote_statistics');
  try {
    // Legacy data without the modern UNIQUE/FK constraints must not inflate counts.
    db.exec('ALTER TABLE vote_records RENAME TO constrained_vote_records');
    db.exec('CREATE TABLE vote_records AS SELECT * FROM constrained_vote_records');
    db.exec('INSERT INTO vote_records SELECT * FROM constrained_vote_records WHERE user_id=1');
    db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (999,1,1)').run();
    assert.equal((await request()).body.counts.votes_participated, 2);
  } finally {
    db.exec('ROLLBACK TO SAVEPOINT legacy_vote_statistics');
    db.exec('RELEASE SAVEPOINT legacy_vote_statistics');
  }
});

test('changing current wall or removing every membership cannot rescope account activity', async () => {
  for (const wall of [null, 1, 2, 3, 7, 999, 'invalid-wall']) {
    assert.deepEqual((await request(1, { wall })).body, { registered_at: registeredAt, counts: ownCounts });
  }
  db.prepare('DELETE FROM wall_members WHERE user_id=1').run();
  assert.deepEqual((await request(1, { wall: 999 })).body.counts, { ...ownCounts, walls_joined: 0 });
});

test('cross-account requests are isolated and user_id queries are explicitly rejected', async () => {
  const other = await request(2);
  assert.deepEqual(other.body.counts, { walls_joined: 1, friends: 1, named_posts: 1, comments: 1, bookmarks: 1, votes_participated: 2 });
  for (const query of ['user_id=1', 'user_id=2', 'user_id=', 'user_id=999', 'user_id[]=2', 'user_id[x]=2']) {
    const rejected = await request(1, { route: '/auth/statistics?' + query });
    assert.equal(rejected.status, 400, query);
    assert.match(rejected.body.error, /user_id/);
    assert.equal(rejected.body.counts, undefined);
  }
});

test('v1 uses the same statistics, private cache policy and standard errors', async () => {
  const result = await request(1, { versioned: true, wall: 999 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { registered_at: registeredAt, counts: ownCounts });
  assert.equal(result.body.error, null);
  assert.equal(result.body.meta.apiVersion, '1');
  assert.equal(result.headers.get('x-request-id'), result.body.meta.requestId);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const unauthenticated = await request(1, { versioned: true, token: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');
  const rejected = await request(1, { versioned: true, route: '/auth/statistics?user_id=2' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'INVALID_REQUEST');
  assert.equal(rejected.body.data, null);
});

test('only the explicit statistics path exists; user and nested lookalikes stay 404', async () => {
  for (const route of ['/auth/statistics/2', '/auth/user/2/statistics', '/auth/statistic', '/auth/2/statistics']) {
    for (const versioned of [false, true]) {
      const result = await request(1, { route, versioned });
      assert.equal(result.status, 404, route);
      if (versioned) { assert.equal(result.body.error.code, 'NOT_FOUND'); assert.equal(result.body.data, null); }
      else assert.deepEqual(result.body, { error: '接口不存在' });
    }
  }
});
