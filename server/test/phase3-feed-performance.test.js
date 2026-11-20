'use strict'

// Routes, auth, and query plans use only sql.js in-memory fixtures; never initDB().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pathModule = require('node:path');
const http = require('node:http');
const initSqlJs = require('sql.js');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'phase3-content-performance-isolated-test-secret';
const { SECRET } = require('../middleware/auth');
const routers = {
  posts: require('../routes/posts'),
  votes: require('../routes/votes'),
  announcements: require('../routes/announcements'),
};
const sqlReady = initSqlJs();
const source = fs.readFileSync(pathModule.join(__dirname, '../db.js'), 'utf8');
const schema = source.split('wrapper.exec(' + String.fromCharCode(96))[1]?.split(String.fromCharCode(96) + ');')[0];
assert.ok(schema, 'Use the actual schema without initializing a persistent database');

function createDb(memory) {
  const queries = [];
  return {
    queries,
    resetQueries() { queries.length = 0; },
    exec(sql) { memory.run(sql); },
    prepare(sql) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      function execute(params, all) {
        const statement = memory.prepare(sql);
        try {
          statement.bind(params);
          if (!all) return statement.step() ? statement.getAsObject() : undefined;
          const rows = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally { statement.free(); }
      }
      return {
        get: (...params) => execute(params, false),
        all: (...params) => execute(params, true),
        run(...params) {
          memory.run(sql, params);
          const [row] = memory.exec('SELECT last_insert_rowid(), changes()')[0].values;
          return { lastInsertRowid: row[0], changes: row[1] };
        },
      };
    },
  };
}

async function fixture(t) {
  const SQL = await sqlReady;
  const memory = new SQL.Database();
  memory.run('PRAGMA foreign_keys=ON');
  memory.run(schema);
  const db = createDb(memory);
  for (const [id, nickname] of [[1, 'reader'], [2, 'owner']]) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,role,avatar,class_number) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'perf-user-' + id, 'isolated-only', nickname, 'user', '', null);
  }
  db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,?)').run(1, 'performance-wall', 2);
  for (const id of [1, 2]) db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,'member','active')").run(1, id);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  for (const [name, router] of Object.entries(routers)) app.use('/api/' + name, router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    memory.close();
  });
  const token = jwt.sign({ id: 1, tv: 0 }, SECRET, { expiresIn: '1h' });
  const request = (url, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: 'Bearer ' + token, 'X-Wall-Id': '1' };
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/' + url, method, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { db, memory, request };
}

function seedPosts(db, count = 75) {
  const posts = [];
  for (let index = 1; index <= count; index++) {
    const row = db.prepare('INSERT INTO posts (id,wall_id,content,category,author_id,is_anonymous,author_ip) VALUES (?,1,?,?,2,?,?)')
      .run(index, 'phase3 keyword post ' + index, index % 2 ? '分享' : '讨论', Number(index % 7 === 0), 'not-returned');
    posts.push(row.lastInsertRowid);
  }
  // Most rows belong to another actor; a result-page query must not hydrate them.
  for (let id = 1; id <= count; id++) {
    db.prepare('INSERT INTO likes (post_id,user_id) VALUES (?,2)').run(id);
    db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (2,?)').run(id);
  }
  for (const id of [63, 64, 65]) db.prepare('INSERT INTO likes (post_id,user_id) VALUES (?,1)').run(id);
  db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (1,?)').run(64);
  return posts;
}

function seedVotes(db, count = 25) {
  const ids = [];
  for (let index = 1; index <= count; index++) {
    const id = db.prepare('INSERT INTO votes (wall_id,title,description,author_id,is_anonymous,author_ip,end_at) VALUES (1,?,?,2,0,?,?)')
      .run('phase3 vote ' + index, 'description', 'not-returned', '').lastInsertRowid;
    ids.push(id);
    db.prepare('INSERT INTO vote_options (vote_id,option_text,vote_count) VALUES (?,?,?)').run(id, '甲', index);
    db.prepare('INSERT INTO vote_options (vote_id,option_text,vote_count) VALUES (?,?,?)').run(id, '乙', 0);
    db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,2)').run(id, id * 2 - 1);
    if (index % 2 === 0) db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,1)').run(id, id * 2);
  }
  return ids;
}

test('page reads hydrate only result-page interactions with a fixed query count', async t => {
  const { db, request } = await fixture(t);
  const posts = seedPosts(db);
  for (const url of ['posts?page=2&limit=10', 'posts/search?q=keyword', 'posts/hot?limit=5', 'posts/bookmarks/list?limit=10']) {
    db.resetQueries();
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.ok(response.body.posts.length <= 50, url);
    const interactionReads = db.queries.filter(sql => /WITH page\(id\) AS \(VALUES/i.test(sql));
    assert.equal(interactionReads.length, response.body.posts.length ? 1 : 0, url + ' page-state query count: ' + JSON.stringify(interactionReads));
    const stateSql = interactionReads[0] || '';
    if (url.startsWith('posts/bookmarks')) assert.equal(response.body.posts.every(post => post.bookmarked === true), true);
    assert.doesNotMatch(stateSql, /SELECT post_id FROM (?:likes|bookmarks) WHERE user_id = \?/i, url + ' must not scan viewer history');
    if (response.body.posts.length) {
      assert.match(stateSql, /WITH page\(id\) AS \(VALUES/i, url + ' must constrain state to page IDs');
      assert.equal([...stateSql.matchAll(/\(\?\)/g)].length, response.body.posts.length, url + ' page state arity');
    }
  }
  db.resetQueries();
  const page = await request('posts?page=2&limit=10');
  const rows = page.body.posts;
  const byId = new Map(rows.map(post => [post.id, post]));
  assert.equal(byId.get(65).liked, true);
  assert.equal(byId.get(64).liked, true);
  assert.equal(byId.get(64).bookmarked, true);
  assert.equal(byId.get(65).bookmarked, false);
  assert.equal(rows.length, 10);
  assert.ok(posts.length > rows.length);
});

test('vote list executes a fixed number of statements and groups page options', async t => {
  const { db, request } = await fixture(t);
  const ids = seedVotes(db, 25);
  db.resetQueries();
  const response = await request('votes?page=1&limit=10');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 25);
  assert.equal(response.body.votes.length, 10);
  assert.equal(db.queries.filter(sql => !/FROM users WHERE id|FROM walls WHERE id|FROM wall_members WHERE/i.test(sql)).length, 3, db.queries.join('\n'));
  assert.equal(db.queries.length, 6, db.queries.join('\n'));
  const optionsSql = db.queries.find(sql => /FROM vote_options WHERE vote_id IN/i.test(sql));
  const votePageSql = db.queries.find(sql => /FROM page v/i.test(sql));
  assert.ok(optionsSql);
  assert.ok(votePageSql);
  assert.equal((optionsSql.match(/\?/g) || []).length, 10);
  assert.match(votePageSql, /vote_totals AS/);
  assert.match(votePageSql, /vote_records my_record ON my_record.vote_id = v.id AND my_record.user_id = \?/);
  assert.equal(db.queries.some(sql => /SELECT option_id FROM vote_records WHERE vote_id = \?/i.test(sql)), false);
  assert.deepEqual(response.body.votes[0].options.map(option => option.option_text), ['甲', '乙']);
  assert.equal(response.body.votes.find(vote => vote.id === ids[24]).voted, null);
  assert.equal(response.body.votes[0].voted, null);
  assert.equal(response.body.votes.find(vote => vote.id === ids[23]).voted, response.body.votes.find(vote => vote.id === ids[23]).options[1].id);
  assert.equal(response.body.votes.find(vote => vote.id === ids[23]).total_votes, 2);

  db.resetQueries();
  const empty = await request('votes?page=9&limit=10');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.votes, []);
  assert.equal(db.queries.length, 5, 'empty page skips options and page vote totals; includes three auth checks and two list queries');
});

test('vote option index removes full-table scan and explicit order sort', async t => {
  const { db, memory } = await fixture(t);
  seedVotes(db, 200);
  const query = 'EXPLAIN QUERY PLAN SELECT * FROM vote_options WHERE vote_id IN (?,?,?,?,?) ORDER BY vote_id, id';
  const before = db.prepare(query).all(10, 20, 30, 40, 50).map(row => row.detail);
  assert.ok(before.some(detail => /SCAN vote_options/i.test(detail)));
  assert.ok(before.some(detail => /TEMP B-TREE FOR ORDER BY/i.test(detail)));
  memory.run('CREATE INDEX idx_phase3_vote_options_vote_id_id ON vote_options(vote_id, id)');
  const after = db.prepare(query).all(10, 20, 30, 40, 50).map(row => row.detail);
  assert.ok(after.some(detail => /SEARCH vote_options USING INDEX idx_phase3_vote_options_vote_id_id/i.test(detail)));
  assert.equal(after.some(detail => /TEMP B-TREE FOR ORDER BY/i.test(detail)), false);
});
