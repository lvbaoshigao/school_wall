'use strict';

// Real routers, authentication and SQLite run against memory only. Never call initDB().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const initSqlJs = require('sql.js');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'content-security-isolated-test-secret-not-for-production';
const { SECRET } = require('../middleware/auth');
const { verifyImageTicket } = require('../lib/uploads');
const routers = {
  posts: require('../routes/posts'), votes: require('../routes/votes'),
  announcements: require('../routes/announcements'), reports: require('../routes/reports'),
  'bug-reports': require('../routes/bugReports'),
};
const sqlReady = initSqlJs();
const schemaSource = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const schema = schemaSource.split('wrapper.exec(' + String.fromCharCode(96))[1]?.split(String.fromCharCode(96) + ');')[0];
assert.ok(schema, 'Locate the actual CREATE TABLE schema without initializing production data');

function wrap(memory) {
  return {
    fail: null,
    exec(sql) { memory.run(sql); },
    prepare(sql) {
      const execute = (params, mode) => {
        const statement = memory.prepare(sql);
        try {
          statement.bind(params);
          if (mode === 'get') return statement.step() ? statement.getAsObject() : undefined;
          const rows = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally { statement.free(); }
      };
      const wrapper = this;
      return {
        get: (...params) => execute(params, 'get'),
        all: (...params) => execute(params, 'all'),
        run(...params) {
          if (wrapper.fail?.test(sql)) throw new Error('Injected database write failure');
          memory.run(sql, params);
          const row = memory.exec('SELECT last_insert_rowid(), changes()')[0].values[0];
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
  const db = wrap(memory);
  for (let id = 1; id <= 9; id++) {
    db.prepare('INSERT INTO users (id,username,password_hash,nickname,role,avatar,class_number) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'user' + id, 'fixture-only', 'nickname' + id, id === 5 ? 'admin' : id === 6 ? 'super_admin' : 'user', '/avatar' + id, 202600 + id);
  }
  db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,?)').run(1, 'wall-one', 3);
  db.prepare('INSERT INTO walls (id,name,owner_id) VALUES (?,?,?)').run(2, 'wall-two', 4);
  for (const [wall, user, role] of [[1,1,'member'],[1,2,'member'],[1,3,'owner'],[1,4,'member'],[1,8,'admin'],[2,4,'owner'],[2,9,'member']]) {
    db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (?,?,?,'active')").run(wall, user, role);
  }
  for (const permission of ['wall.safety.report', 'wall.post.report']) {
    db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (8,1,?,'deny')").run(permission);
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  for (const [mount, router] of Object.entries(routers)) app.use('/api/' + mount, router);
  app.use((error, req, res, next) => { res.status(500).json({ error: 'Internal test error' }); });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    memory.close();
  });
  const tokens = new Map();
  async function request(url, { user = 1, wall = 1, method = 'GET', body } = {}) {
    const headers = {};
    if (user !== null) {
      if (!tokens.has(user)) tokens.set(user, jwt.sign({ id: user, tv: 0 }, SECRET, { expiresIn: '1h' }));
      headers.Authorization = 'Bearer ' + tokens.get(user);
    }
    if (wall !== null) headers['X-Wall-Id'] = String(wall);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/' + url, method, headers }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers }); } catch (error) { reject(error); } });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  function post({ wall = 1, author = 2, anonymous = 0, content = '校园内容', category = '分享' } = {}) {
    return db.prepare('INSERT INTO posts (wall_id,content,category,author_id,is_anonymous,author_ip) VALUES (?,?,?,?,?,?)')
      .run(wall, content, category, author, anonymous, 'never-return-this-ip-hash').lastInsertRowid;
  }
  function vote({ wall = 1, author = 2, anonymous = 0, end = '' } = {}) {
    const id = db.prepare('INSERT INTO votes (wall_id,title,author_id,is_anonymous,author_ip,end_at) VALUES (?,?,?,?,?,?)')
      .run(wall, '校园投票', author, anonymous, 'never-return-this-ip-hash', end).lastInsertRowid;
    const options = ['选项甲', '选项乙'].map(text => db.prepare('INSERT INTO vote_options (vote_id,option_text) VALUES (?,?)').run(id, text).lastInsertRowid);
    return { id, options };
  }
  function report({ wall = 1, reporter = 1, anonymous = 1, status = 'pending', images = '', code } = {}) {
    code ||= 'RPT-2026' + String(db.prepare('SELECT COUNT(*) c FROM reports').get().c + 1).padStart(8, '0');
    const id = db.prepare('INSERT INTO reports (wall_id,tracking_code,reporter_id,report_types,content,images,is_anonymous,status) VALUES (?,?,?,?,?,?,?,?)')
      .run(wall, code, reporter, '校园霸凌行为', 'sensitive-evidence', images, anonymous, status).lastInsertRowid;
    return { id, code };
  }
  return { db, request, post, vote, report };
}

function assertPrivateImages(response, images, db) {
  assert.equal(response.headers['cache-control'], 'no-store');
  const signed = JSON.parse(images);
  assert.ok(signed.length > 0);
  for (const url of signed) {
    const parsed = new URL(url, 'https://school.invalid');
    assert.ok(parsed.searchParams.get('ticket'));
    assert.equal(verifyImageTicket(parsed.searchParams.get('ticket'), parsed.pathname, db), true);
  }
}

test('content: anonymous posts and votes never disclose legacy stored author IDs or IPs', async t => {
  const { db, request, post, vote } = await fixture(t);
  const id = post({ anonymous: 1, content: '匿名内容可检索' });
  db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (1,?)').run(id);
  for (const url of ['posts', 'posts/search?q=' + encodeURIComponent('匿名'), 'posts/hot', 'posts/bookmarks/list']) {
    const res = await request(url);
    assert.equal(res.status, 200, url);
    const row = res.body.posts.find(row => row.id === id);
    assert.ok(row, url);
    for (const field of ['author_id', 'author_nickname', 'author_avatar', 'author_class']) assert.equal(row[field], null, url + ':' + field);
    assert.equal('author_ip' in row, false);
  }
  const detail = await request('posts/' + id);
  assert.equal(detail.body.post.author_id, null);
  const poll = vote({ anonymous: 1 });
  for (const url of ['votes', 'votes/' + poll.id]) {
    const res = await request(url);
    assert.equal(res.status, 200);
    const row = res.body.votes ? res.body.votes.find(row => row.id === poll.id) : res.body;
    assert.equal(row.author_id, null);
    assert.equal(row.author_nickname, null);
    assert.equal('author_ip' in row, false);
  }
});

test('content: current wall is enforced on every post and vote read/write', async t => {
  const { db, request, post, vote } = await fixture(t);
  const other = post({ wall: 2, author: 9 });
  const poll = vote({ wall: 2, author: 9 });
  const requests = [
    ['posts/' + other, 'GET'], ['posts/' + other, 'DELETE'],
    ['posts/' + other + '/comments', 'POST', { content: 'attempt' }],
    ['posts/' + other + '/like', 'POST'], ['posts/' + other + '/like', 'DELETE'],
    ['posts/' + other + '/report', 'POST', { reason: 'attempt' }],
    ['posts/' + other + '/bookmark', 'POST'], ['posts/' + other + '/bookmark', 'DELETE'],
    ['votes/' + poll.id, 'GET'], ['votes/' + poll.id, 'DELETE'],
    ['votes/' + poll.id + '/vote', 'POST', { option_id: poll.options[0] }],
  ];
  for (const [url, method, body] of requests) assert.equal((await request(url, { method, body })).status, 404, method + ' ' + url);
  assert.equal((await request('posts', { wall: 2 })).status, 403);
  assert.equal((await request('posts', { user: null })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM comments').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vote_records').get().c, 0);
});

test('content: author/moderator rules and comment-parent boundaries remain intact', async t => {
  const { db, request, post, vote } = await fixture(t);
  const a = post();
  const b = post();
  const comment = db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (?,'comment',2,'hash')").run(a).lastInsertRowid;
  assert.equal((await request('posts/' + a, { method: 'DELETE' })).status, 403);
  assert.equal((await request('posts/' + a + '/comments/' + comment, { method: 'DELETE' })).status, 403);
  assert.equal((await request('posts/' + b + '/comments/' + comment, { method: 'DELETE', user: 3 })).status, 404);
  assert.equal((await request('posts/' + a + '/comments/' + comment, { method: 'DELETE', user: 2 })).status, 200);
  const poll = vote();
  assert.equal((await request('votes/' + poll.id, { method: 'DELETE' })).status, 403);
  assert.equal((await request('votes/' + poll.id, { method: 'DELETE', user: 3 })).status, 200);
  db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (1,?)').run(a);
  assert.equal((await request('posts/' + a, { method: 'DELETE', user: 2 })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookmarks WHERE post_id=?').get(a).c, 0);
});

test('content: comments paginate with deterministic order only after post-wall authorization', async t => {
  const { db, request, post } = await fixture(t);
  const id = post();
  const other = post({ wall:2,author:9 });
  const insert = db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip,created_at) VALUES (?,?,2,'private-comment-ip','2026-01-01 12:00:00')");
  const ids = [];
  for (let i=0;i<205;i++) ids.push(insert.run(id,'comment-' + i).lastInsertRowid);
  insert.run(other,'other-wall-secret');
  const first = await request('posts/' + id);
  assert.equal(first.status,200);
  assert.equal(first.body.comments_total,205);
  assert.equal(first.body.comments_page,1);
  assert.equal(first.body.comments_limit,50);
  assert.deepEqual(first.body.comments.map(row=>row.id),ids.slice(0,50));
  assert.ok(first.body.comments.every(row=>!('author_ip' in row)));
  const next = await request('posts/' + id + '?comments_page=2&comments_limit=50');
  assert.equal(next.status,200);
  assert.deepEqual(next.body.comments.map(row=>row.id),ids.slice(50,100));
  const last = await request('posts/' + id + '?comments_page=3&comments_limit=100');
  assert.equal(last.status,200);
  assert.equal(last.body.comments_limit,100);
  assert.deepEqual(last.body.comments.map(row=>row.id),ids.slice(200));
  const past = await request('posts/' + id + '?comments_page=999999');
  assert.equal(past.status,200);
  assert.equal(past.body.comments_total,205);
  assert.deepEqual(past.body.comments,[]);
  for (const query of ['comments_page=0','comments_page=-1','comments_page=1000001','comments_page=1junk','comments_page[]=1','comments_limit=0','comments_limit=-1','comments_limit=101','comments_limit[]=1']) {
    assert.equal((await request('posts/' + id + '?' + query)).status,400,query);
    const denied = await request('posts/' + other + '?' + query);
    assert.equal(denied.status,404,'cross-wall before pagination: ' + query);
    assert.equal('comments_total' in denied.body,false);
  }
});

test('content: removed membership and inactive walls cannot leak bookmarked posts', async t => {
  const { db, request, post } = await fixture(t);
  const id = post();
  db.prepare('INSERT INTO bookmarks (user_id,post_id) VALUES (1,?)').run(id);
  assert.equal((await request('posts/bookmarks/list')).body.total, 1);
  db.prepare("UPDATE wall_members SET status='banned' WHERE user_id=1 AND wall_id=1").run();
  assert.equal((await request('posts/bookmarks/list')).body.total, 0);
  db.prepare("UPDATE wall_members SET status='active' WHERE user_id=1 AND wall_id=1").run();
  db.prepare("UPDATE walls SET status='disabled' WHERE id=1").run();
  assert.equal((await request('posts/bookmarks/list')).body.total, 0);
});

test('content: malformed text, flags, objects, IDs and query arrays produce 400', async t => {
  const { request, post, vote } = await fixture(t);
  const id = post();
  const poll = vote();
  const cases = [
    ['posts', { content: {} }], ['posts', { content: 'valid', category: [] }],
    ['posts', { content: 'valid', is_anonymous: 'false' }], ['posts', { content: 'valid', is_markdown: [] }],
    ['posts/' + id + '/comments', { content: ['bad'] }], ['posts/' + id + '/report', { reason: {} }],
    ['votes', { title: {}, options: ['a','b'] }], ['votes', { title: 'title', options: [{}, 'b'] }],
    ['votes', { title: 'title', options: ['a', ' a '] }], ['votes', { title: 'title', options: ['a','b'], description: {} }],
    ['votes/' + poll.id + '/vote', { option_id: [poll.options[0]] }],
    ['reports', { agreed: 'false', report_types: ['校园霸凌行为'], content: 'evidence' }],
    ['reports', { agreed: true, report_types: ['校园霸凌行为'], content: {} }],
    ['reports', { agreed: true, report_types: ['校园霸凌行为'], content: 'evidence', is_anonymous: 'true' }],
    ['bug-reports', { title: {}, content: 'detail' }], ['bug-reports', { title: 'title', content: {} }],
  ];
  for (const [url, body] of cases) assert.equal((await request(url, { method: 'POST', body })).status, 400, url + ':' + JSON.stringify(body));
  for (const url of ['posts', 'votes', 'reports', 'bug-reports']) assert.equal((await request(url, { method: 'POST', body: [] })).status, 400);
  for (const url of ['posts/1junk', 'votes/1e2', 'reports/1junk/status', 'bug-reports/1junk/status']) {
    assert.equal((await request(url, { method: url.includes('/status') ? 'PUT' : 'GET', body: { status: 'processing' }, user: 6 })).status, 400, url);
  }
  for (const url of ['posts/search?q[x]=bad', 'posts?category[x]=bad', 'posts?sort[]=hot']) assert.equal((await request(url)).status, 400, url);
});

test('content: posts search and feed validate query types and bounded pagination without breaking defaults', async t => {
  const { request, post } = await fixture(t);
  for (let i=0;i<65;i++) post({ content:'校园分页内容-' + i });
  for (const url of ['posts/search','posts/search?q=','posts/search?q=%20%20','posts/search?q=%09','posts/search?q=' + encodeURIComponent('校')]) {
    const res = await request(url);
    assert.equal(res.status,200,url);
    assert.deepEqual(res.body.posts,[],url);
    assert.equal(res.body.total,0,url);
  }
  const defaults = await request('posts');
  assert.equal(defaults.status,200);
  assert.equal(defaults.body.page,1);
  assert.equal(defaults.body.limit,20);
  assert.equal(defaults.body.posts.length,20);
  assert.equal(defaults.body.total,65);
  const first = await request('posts?page=1&limit=50&sort=latest&category=' + encodeURIComponent('全部'));
  const second = await request('posts?page=2&limit=50&sort=latest');
  assert.equal(first.status,200);
  assert.equal(first.body.posts.length,50);
  assert.equal(second.status,200);
  assert.equal(second.body.posts.length,15);
  assert.equal(new Set([...first.body.posts,...second.body.posts].map(row=>row.id)).size,65);
  const hot = await request('posts?sort=hot&category=' + encodeURIComponent('分享'));
  assert.equal(hot.status,200);
  assert.equal(hot.body.posts.length,20);
  const matching = await request('posts/search?q=' + encodeURIComponent('校园'));
  assert.equal(matching.status,200);
  assert.equal(matching.body.posts.length,50);
  assert.equal(matching.body.hasMore,true);
  for (const query of ['q[]=school','q[x]=school','q=school&q=wall']) {
    const res = await request('posts/search?' + query);
    assert.equal(res.status,400,query);
    assert.equal(typeof res.body.error,'string',query);
  }
  for (const query of [
    'category[x]=school','category[]=school','category=one&category=two',
    'sort[]=hot','sort[x]=hot','sort=latest&sort=hot','sort=unknown','sort=hot%3BDROP%20TABLE%20posts',
    'page=0','page=-1','page=1.5','page=1junk','page=NaN','page=Infinity','page=1000001','page=9007199254740992','page[]=1','page[x]=1','page=1&page=2',
    'limit=0','limit=-1','limit=1.5','limit=51','limit=9007199254740992','limit[]=20','limit[x]=20','limit=20&limit=30',
  ]) {
    const res = await request('posts?' + query);
    assert.equal(res.status,400,query);
    assert.equal(typeof res.body.error,'string',query);
  }
  assert.equal((await request('posts')).body.total,65,'rejected queries do not modify or break the default feed');
});

test('content: LIKE search treats SQL syntax, percent, underscore and backslash literally', async t => {
  const { db, request, post } = await fixture(t);
  post({ content: 'normal content' });
  const literal = post({ content: 'literal ' + String.fromCharCode(92) + '%_ token' });
  for (const query of ["' OR 1=1 --", String.fromCharCode(92) + '%_', '%_', 'normal']) {
    const res = await request('posts/search?q=' + encodeURIComponent(query));
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, query.startsWith("'") ? 0 : 1, query);
    if (query.includes('%')) assert.equal(res.body.posts[0].id, literal);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 2);
});

test('content: strict bounded pagination cannot disable LIMIT or overflow offsets', async t => {
  const { request, report, post, vote } = await fixture(t);
  for (let i = 0; i < 56; i++) { report(); post(); vote(); }
  for (const mount of ['posts', 'votes', 'reports', 'bug-reports', 'bug-reports/admin']) {
    for (const query of ['limit=-1', 'limit=0', 'limit=999999', 'page=nope', 'page=1junk', 'page=1e20', 'page=1000001', 'page[]=1']) {
      const res = await request(mount + '?' + query, { user: 6 });
      assert.equal(res.status, 400, mount + '?' + query);
    }
  }
  for (const [mount, key] of [['posts','posts'],['votes','votes'],['reports','reports']]) {
    const res = await request(mount + '?page=2&limit=5', { user: 6 });
    assert.equal(res.status, 200);
    assert.equal(res.body[key].length, 5);
    assert.equal(res.body.total, 56);
  }
});

test('content: safety tracking requires safety permission, not broad moderation', async t => {
  const { db, request, report } = await fixture(t);
  const row = report({ images: JSON.stringify(['/uploads/images/historical.png']) });
  for (const user of [1,3,6]) {
    const res = await request('reports/track/' + row.code, { user });
    assert.equal(res.status, 200, 'authorized ' + user);
    assert.equal('reporter_id' in res.body, false);
    assert.equal('wall_id' in res.body, false);
    assertPrivateImages(res, res.body.images, db);
  }
  for (const user of [2,4,5,7,8]) assert.equal((await request('reports/track/' + row.code, { user })).status, 404, 'denied ' + user);
  db.prepare("INSERT INTO user_permissions (user_id,wall_id,perm,effect) VALUES (7,0,'global.safety.handle','grant')").run();
  assert.equal((await request('reports/track/' + row.code, { user: 7 })).status, 200);
  const list = await request('reports?wall_id=1', { user: 3 });
  assert.equal(list.status, 200);
  assert.equal(list.body.reports[0].reporter_name, null);
  assert.equal(list.body.reports[0].reporter_username, null);
  assert.equal('reporter_id' in list.body.reports[0], false);
  assert.equal((await request('reports?wall_id=2', { user: 3 })).status, 403);
});

test('content: unauthorized safety status probes disclose no record state', async t => {
  const { request, report } = await fixture(t);
  const rows = ['pending','processing','resolved','rejected'].map(status => report({ status }));
  for (const row of [...rows, { id: 999999 }]) {
    const res = await request('reports/' + row.id + '/status', { method: 'PUT', user: 4, body: { status: 'resolved' } });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: '举报不存在' });
  }
  const id = rows[0].id;
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'resolved' } })).status, 400);
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'processing', status_note: {} } })).status, 400);
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'processing', status_note: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'processing' } })).status, 200);
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'resolved' } })).status, 200);
  assert.equal((await request('reports/' + id + '/status', { method: 'PUT', user: 3, body: { status: 'processing' } })).status, 400);
});

test('content: new safety and bug evidence must belong to the submitter and signed reads stay private', async t => {
  const { db, request } = await fixture(t);
  const safe = { agreed: true, report_types: ['校园霸凌行为'], content: 'confidential-content', is_anonymous: true };
  const bug = { title: 'private-bug', content: 'details' };
  for (const [mount, body] of [['reports',safe],['bug-reports',bug]]) {
    for (const images of [['/uploads/bug-reports/bug_2_other.png'], ['/uploads/images/public.png'], ['https://outside.invalid/tracker.png'], [7], 'not-an-array']) {
      assert.equal((await request(mount, { method: 'POST', body: { ...body, images } })).status, 400, mount + ':' + JSON.stringify(images));
    }
    const own = '/uploads/bug-reports/bug_1_123_abcdef.png';
    const created = await request(mount, { method: 'POST', body: { ...body, images: [own] } });
    assert.equal(created.status, 200);
    const res = await request(mount === 'reports' ? 'reports/track/' + created.body.tracking_code : 'bug-reports');
    const row = Array.isArray(res.body) ? res.body[0] : res.body;
    assertPrivateImages(res, row.images, db);
  }
  assert.deepEqual((await request('bug-reports', { user: 2 })).body, []);
  assert.equal((await request('bug-reports/admin', { user: 2 })).status, 403);
  const admin = await request('bug-reports/admin', { user: 5 });
  assert.equal(admin.status, 200);
  assertPrivateImages(admin, admin.body[0].images, db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages WHERE receiver_id=8 AND type='report_notification'").get().c, 0);
  const notifications = db.prepare("SELECT sender_id, content FROM messages WHERE type='report_notification'").all();
  assert.ok(notifications.length > 0);
  assert.ok(notifications.every(row => row.sender_id === null && !row.content.includes('nickname1')));
});

test('content: repeated likes/unlikes and votes preserve single-user counts', async t => {
  const { db, request, post, vote } = await fixture(t);
  const id = post();
  const results = await Promise.all(Array.from({ length: 5 }, () => request('posts/' + id + '/like', { method: 'POST' })));
  assert.equal(results.filter(row => row.status === 200).length, 1);
  assert.equal(results.filter(row => row.status === 400).length, 4);
  assert.equal(db.prepare('SELECT like_count FROM posts WHERE id=?').get(id).like_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(id).c, 1);
  for (let i=0;i<3;i++) assert.equal((await request('posts/' + id + '/like', { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT like_count FROM posts WHERE id=?').get(id).like_count, 0);
  const a = vote(), b = vote();
  assert.equal((await request('votes/' + a.id + '/vote', { method: 'POST', body: { option_id: b.options[0] } })).status, 400);
  const votes = await Promise.all(Array.from({ length: 5 }, () => request('votes/' + a.id + '/vote', { method: 'POST', body: { option_id: a.options[0] } })));
  assert.equal(votes.filter(row => row.status === 200).length, 1);
  assert.equal(votes.filter(row => row.status === 400).length, 4);
  assert.equal(db.prepare('SELECT vote_count FROM vote_options WHERE id=?').get(a.options[0]).vote_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vote_records WHERE vote_id=?').get(a.id).c, 1);
});

test('content: vote deadlines reject invalid types, impossible dates and elapsed instants', async t => {
  const { db, request, vote } = await fixture(t);
  const body = { title: 'deadline', options: ['one','two'] };
  for (const end_at of [[], {}, null, 123, 'not-a-date', '2099-02-30T12:00', '2099-12-01T24:00', new Date(Date.now() - 1000).toISOString()]) {
    assert.equal((await request('votes', { method: 'POST', body: { ...body, end_at } })).status, 400, JSON.stringify(end_at));
  }
  for (const end of ['not-a-date', new Date(Date.now() - 1000).toISOString()]) {
    const row = vote({ end });
    assert.equal((await request('votes/' + row.id + '/vote', { method: 'POST', body: { option_id: row.options[0] } })).status, 400);
  }
  const future = new Date(Date.now() + 3600000).toISOString();
  const created = await request('votes', { method: 'POST', body: { ...body, end_at: future } });
  assert.equal(created.status, 200);
  assert.equal(db.prepare('SELECT end_at FROM votes WHERE id=?').get(created.body.id).end_at, future);
  const local = await request('votes', { method: 'POST', body: { ...body, end_at: '2099-12-01T12:00' } });
  assert.equal(local.status, 200);
  assert.ok(db.prepare('SELECT end_at FROM votes WHERE id=?').get(local.body.id).end_at.endsWith('Z'));
});

test('content: write failures roll back likes, comments, votes, reports and notifications', async t => {
  const { db, request, post, vote, report } = await fixture(t);
  const id = post();
  const poll = vote();
  const safety = report({ anonymous: 0 });
  for (const [url, method, body, fail, verify] of [
    ['posts/' + id + '/like','POST',undefined,/UPDATE posts SET like_count/,() => assert.equal(db.prepare('SELECT COUNT(*) c FROM likes').get().c,0)],
    ['posts/' + id + '/comments','POST',{content:'comment'},/INSERT INTO messages/,() => { assert.equal(db.prepare('SELECT COUNT(*) c FROM comments').get().c,0); assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id=?').get(id).comment_count,0); }],
    ['votes/' + poll.id + '/vote','POST',{option_id:poll.options[0]},/UPDATE vote_options/,() => assert.equal(db.prepare('SELECT COUNT(*) c FROM vote_records').get().c,0)],
    ['votes','POST',{title:'new poll',options:['a','b']},/INSERT INTO vote_options/,() => assert.equal(db.prepare('SELECT COUNT(*) c FROM votes').get().c,1)],
    ['reports','POST',{agreed:true,report_types:['校园霸凌行为'],content:'evidence'},/INSERT INTO messages/,() => assert.equal(db.prepare('SELECT COUNT(*) c FROM reports').get().c,1)],
    ['bug-reports','POST',{title:'bug',content:'detail'},/INSERT INTO messages/,() => assert.equal(db.prepare('SELECT COUNT(*) c FROM bug_reports').get().c,0)],
    ['reports/' + safety.id + '/status','PUT',{status:'processing'},/INSERT INTO messages/,() => assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(safety.id).status,'pending')],
  ]) {
    db.fail = fail;
    const res = await request(url, { method, body, user: url.includes('/status') ? 3 : 1 });
    db.fail = null;
    assert.equal(res.status, 500, url);
    verify();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c,0, url);
  }
  assert.equal((await request('posts/' + id + '/like', { method:'POST' })).status,200, 'retry succeeds after rollback');
  assert.equal((await request('votes/' + poll.id + '/vote', { method:'POST',body:{option_id:poll.options[0]} })).status,200, 'retry succeeds after rollback');
});

test('content: failed deletes and unlike operations keep dependent rows and counts intact', async t => {
  const { db, request, post, vote } = await fixture(t);
  const id = post();
  const comment = db.prepare("INSERT INTO comments (post_id,content,author_id,author_ip) VALUES (?,'comment',2,'hash')").run(id).lastInsertRowid;
  db.prepare('UPDATE posts SET comment_count=1, like_count=1 WHERE id=?').run(id);
  db.prepare('INSERT INTO likes (post_id,user_id) VALUES (?,1)').run(id);
  db.prepare('INSERT INTO bookmarks (post_id,user_id) VALUES (?,1)').run(id);
  db.prepare("INSERT INTO post_reports (wall_id,post_id,reporter_id,reason) VALUES (1,?,1,'reason')").run(id);
  db.fail = /UPDATE posts SET like_count/;
  assert.equal((await request('posts/' + id + '/like', { method:'DELETE' })).status,500);
  db.fail = null;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(id).c,1);
  assert.equal(db.prepare('SELECT like_count FROM posts WHERE id=?').get(id).like_count,1);
  db.fail = /UPDATE posts SET comment_count/;
  assert.equal((await request('posts/' + id + '/comments/' + comment, { method:'DELETE',user:2 })).status,500);
  db.fail = null;
  assert.ok(db.prepare('SELECT id FROM comments WHERE id=?').get(comment));
  assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id=?').get(id).comment_count,1);
  db.fail = /DELETE FROM posts WHERE id/;
  assert.equal((await request('posts/' + id, { method:'DELETE',user:2 })).status,500);
  db.fail = null;
  for (const table of ['comments','likes','bookmarks','post_reports']) {
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ' + table + ' WHERE post_id=?').get(id).c,1,table);
  }
  assert.ok(db.prepare('SELECT id FROM posts WHERE id=?').get(id));
  assert.equal((await request('posts/' + id, { method:'DELETE',user:2 })).status,200);
  const poll = vote();
  db.prepare('INSERT INTO vote_records (vote_id,option_id,user_id) VALUES (?,?,1)').run(poll.id,poll.options[0]);
  db.fail = /DELETE FROM votes WHERE id/;
  assert.equal((await request('votes/' + poll.id, { method:'DELETE',user:2 })).status,500);
  db.fail = null;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vote_records WHERE vote_id=?').get(poll.id).c,1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vote_options WHERE vote_id=?').get(poll.id).c,2);
  assert.ok(db.prepare('SELECT id FROM votes WHERE id=?').get(poll.id));
  assert.equal((await request('votes/' + poll.id, { method:'DELETE',user:2 })).status,200);
});

test('content: feedback replies validate size and may explicitly clear an old reply', async t => {
  const { db, request } = await fixture(t);
  const created = await request('bug-reports', { method:'POST',body:{title:'bug',content:'detail'} });
  const url = 'bug-reports/' + created.body.id + '/status';
  for (const reply of [{}, [], 'x'.repeat(5001)]) assert.equal((await request(url, {method:'PUT',user:5,body:{status:'processing',reply}})).status,400);
  assert.equal((await request(url, {method:'PUT',user:5,body:{status:'processing',reply:'response'}})).status,200);
  assert.equal((await request(url, {method:'PUT',user:5,body:{status:'processing',reply:''}})).status,200);
  assert.equal(db.prepare('SELECT reply FROM bug_reports WHERE id=?').get(created.body.id).reply,'');
});

test('content: announcement reads filter expiration and scope without deleting any wall data', async t => {
  const { db, request } = await fixture(t);
  const insert = db.prepare('INSERT INTO announcements (wall_id,title,content,author_id,scope,delete_at) VALUES (?,?,?,?,?,?)');
  insert.run(1,'current','body',3,'wall','');
  insert.run(2,'other-wall','body',4,'wall','');
  insert.run(0,'global','body',6,'global','');
  insert.run(1,'expired-current','body',3,'wall','2000-01-01T00:00');
  insert.run(2,'expired-other','body',4,'wall','2000-01-01T00:00');
  insert.run(1,'invalid-date','body',3,'wall','not-a-date');
  insert.run(1,'future-local','body',3,'wall','2099-01-01T00:00');
  insert.run(1,'future-utc','body',3,'wall','2099-01-01T00:00:00Z');
  const res = await request('announcements');
  assert.equal(res.status,200);
  assert.deepEqual(new Set(res.body.map(row=>row.title)),new Set(['current','global','future-local','future-utc']));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM announcements').get().c,8);
});
