const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const initSqlJs = require('sql.js')
const { readOne, readAll } = require('../lib/dbOptimizations')

const root = path.resolve(__dirname, '..')
const databaseSource = fs.readFileSync(path.join(root, 'db.js'), 'utf8')
// Keep the same schema extraction contract used by the migration/API regression suite.
const schema = databaseSource.match(/wrapper\.exec\(\x60([\s\S]*?)\x60\);/)[1]
const TEMP_ROOT = path.join(os.tmpdir(), 'school-wall-phase3-x6qutR')

function instrument(statement) {
  let calls = 0
  const original = statement.getColumnNames.bind(statement)
  statement.getColumnNames = () => { calls++; return original() }
  return { statement, count: () => calls }
}
function legacyAll(statement) {
  const rows = []
  while (statement.step()) {
    const columns = statement.getColumnNames()
    const values = statement.get()
    const row = {}
    columns.forEach((column, index) => { row[column] = values[index] })
    rows.push(row)
  }
  return rows
}
function plan(db, sql, params = []) {
  return db.exec('EXPLAIN QUERY PLAN ' + sql, params)[0]?.values.map(row => row.at(-1)) || []
}

test('optimized sql.js row conversion preserves get, empty results, aliases and SQL NULL', async t => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run('CREATE TABLE sample(id INTEGER, value TEXT); INSERT INTO sample VALUES(1,NULL),(2,\'two\')')
  const got = db.prepare('SELECT id AS row_id, value FROM sample WHERE id=1')
  try { assert.deepEqual(readOne(got), { row_id: 1, value: null }) } finally { got.free() }
  const empty = db.prepare('SELECT id AS row_id, value FROM sample WHERE id=99')
  try { assert.equal(readOne(empty), undefined) } finally { empty.free() }
  const noRows = db.prepare('SELECT id AS row_id, value FROM sample WHERE id>99')
  try { assert.deepEqual(readAll(noRows), []) } finally { noRows.free() }
  const all = db.prepare('SELECT id AS row_id, value FROM sample ORDER BY id')
  try { assert.deepEqual(readAll(all), [{ row_id: 1, value: null }, { row_id: 2, value: 'two' }]) } finally { all.free() }
})

test('row metadata is fetched once per statement rather than once per returned row', async t => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run('CREATE TABLE sample(id INTEGER, value TEXT); BEGIN')
  const insert = db.prepare('INSERT INTO sample VALUES(?,?)')
  for (let id = 0; id < 12000; id++) { insert.run([id, 'value-' + id]); insert.reset() }
  insert.free()
  db.run('COMMIT')
  const legacy = instrument(db.prepare('SELECT id AS alias, value FROM sample WHERE id < 12000 ORDER BY id'))
  const optimized = instrument(db.prepare('SELECT id AS alias, value FROM sample WHERE id < 12000 ORDER BY id'))
  let legacyRows, optimizedRows
  const legacyAt = process.hrtime.bigint()
  try { legacyRows = legacyAll(legacy.statement) } finally { legacy.statement.free() }
  const legacyMs = Number(process.hrtime.bigint() - legacyAt) / 1e6
  const optimizedAt = process.hrtime.bigint()
  try { optimizedRows = readAll(optimized.statement) } finally { optimized.statement.free() }
  const optimizedMs = Number(process.hrtime.bigint() - optimizedAt) / 1e6
  assert.deepEqual(optimizedRows, legacyRows)
  assert.equal(legacy.count(), 12000)
  assert.equal(optimized.count(), 1)
  console.log('[phase3-db] 12000-row conversion: legacy=' + legacyMs.toFixed(2) + 'ms optimized=' + optimizedMs.toFixed(2) + 'ms metadata calls ' + legacy.count() + ' -> ' + optimized.count())
})

test('tree unread partial index removes the temporary grouping b-tree', async t => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run(schema)
  for (const index of ['CREATE INDEX idx_messages_receiver ON messages(receiver_id,is_read)', 'CREATE INDEX idx_messages_type ON messages(receiver_id,type)', 'CREATE INDEX idx_messages_conversation ON messages(conversation_id)']) db.run(index)
  db.run('BEGIN')
  const insert = db.prepare("INSERT INTO messages(sender_id,receiver_id,type,content,conversation_id,is_read,sender_deleted,receiver_deleted) VALUES(?,?,'tree_hole','x',?,?,?,?)")
  for (let id = 0; id < 24000; id++) { insert.run([id % 20 + 1, id % 2 + 1, 'conversation-' + (id % 1200), id % 3 === 0 ? 0 : 1, 0, 0]); insert.reset() }
  insert.free()
  db.run('COMMIT; ANALYZE')
  const query = "SELECT conversation_id, COUNT(*) AS c FROM messages WHERE receiver_id=? AND receiver_deleted=0 AND type='tree_hole' AND is_read=0 GROUP BY conversation_id"
  const before = plan(db, query, [1]).join(' | ')
  const addIndex = databaseSource.match(/wrapper\.exec\((\"CREATE INDEX IF NOT EXISTS idx_messages_tree_unread[^\n]+)\);/)
  assert.ok(addIndex, 'the targeted tree unread index is part of the post-migration index set')
  db.run(JSON.parse(addIndex[1]))
  db.run('ANALYZE')
  const after = plan(db, query, [1]).join(' | ')
  assert.match(after, /idx_messages_tree_unread/)
  assert.doesNotMatch(after, /TEMP B-TREE FOR GROUP BY/i)
  assert.match(before, /TEMP B-TREE FOR GROUP BY/i)
  console.log('[phase3-db] unread EXPLAIN before: ' + before)
  console.log('[phase3-db] unread EXPLAIN after:  ' + after)
})

test('tree root batch MIN query uses a covering partial index', async t => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run(schema)
  db.run('CREATE INDEX idx_messages_conversation ON messages(conversation_id)')
  db.run('BEGIN')
  const insert = db.prepare("INSERT INTO messages(sender_id,receiver_id,type,content,conversation_id) VALUES(1,2,'tree_hole','x',?)")
  for (let id = 0; id < 12000; id++) { insert.run(['conversation-' + (id % 600)]); insert.reset() }
  insert.free()
  db.run('COMMIT; ANALYZE')
  const query = "SELECT m.id,m.conversation_id,m.sender_id,m.receiver_id,m.wall_id,m.assignee_id,m.content,m.created_at FROM messages m JOIN (SELECT conversation_id,MIN(id) AS id FROM messages WHERE type='tree_hole' AND conversation_id IN (?,?,?,?) GROUP BY conversation_id) first ON first.id=m.id"
  const params = ['conversation-1','conversation-2','conversation-3','conversation-4']
  const before = plan(db, query, params).join(' | ')
  const rootIndex = databaseSource.match(/wrapper\.exec\((\"CREATE INDEX IF NOT EXISTS idx_messages_tree_root[^\n]+)\);/)
  assert.ok(rootIndex)
  db.run(JSON.parse(rootIndex[1])); db.run('ANALYZE')
  const after = plan(db, query, params).join(' | ')
  assert.match(before, /idx_messages_conversation/)
  assert.match(after, /USING COVERING INDEX idx_messages_tree_root/)
  console.log('[phase3-db] root EXPLAIN before: ' + before)
  console.log('[phase3-db] root EXPLAIN after:  ' + after)
})



test('vote option batch IN query seeks and streams in vote/id order', async t => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run(schema)
  db.run('BEGIN')
  const insert = db.prepare('INSERT INTO vote_options(vote_id,option_text,vote_count) VALUES(?,?,0)')
  for (let vote = 1; vote <= 800; vote++) for (let option = 1; option <= 5; option++) { insert.run([vote,'option-' + option]); insert.reset() }
  insert.free(); db.run('COMMIT; ANALYZE')
  const query = 'SELECT * FROM vote_options WHERE vote_id IN (?,?,?,?) ORDER BY vote_id,id'
  const before = plan(db, query, [12,11,10,9]).join(' | ')
  const voteIndex = databaseSource.match(/wrapper\.exec\((\'CREATE INDEX IF NOT EXISTS idx_vote_options_vote[^\n]+)\);/)
  assert.ok(voteIndex)
  db.run(voteIndex[1].slice(1,-1)); db.run('ANALYZE')
  const after = plan(db, query, [12,11,10,9]).join(' | ')
  assert.match(before, /SCAN vote_options/)
  assert.match(after, /idx_vote_options_vote/)
  assert.doesNotMatch(after, /TEMP B-TREE FOR ORDER BY/i)
  console.log('[phase3-db] vote options EXPLAIN before: ' + before)
  console.log('[phase3-db] vote options EXPLAIN after:  ' + after)
})

test('legacy on-disk schema migration retains results, last insert, changes and 0600 backup persistence', { timeout: 30000 }, async t => {
  fs.mkdirSync(TEMP_ROOT, { recursive: true, mode: 0o700 })
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, 'db-wrapper-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const SQL = await initSqlJs()
  const previous = new SQL.Database()
  const oldSchema = schema.replace(/\s*client_message_id TEXT DEFAULT NULL,/, '').replace(/\s*sender_deleted INTEGER NOT NULL DEFAULT 0,/, '').replace(/\s*receiver_deleted INTEGER NOT NULL DEFAULT 0,/, '')
  previous.run(oldSchema)
  previous.run("INSERT INTO users(id,username,password_hash,nickname) VALUES(1,'phase3a','unused','迁移样本A'),(2,'phase3b','unused','迁移样本B')")
  previous.run("INSERT INTO settings(key,value) VALUES('initialized','1')")
  previous.run("INSERT INTO messages(sender_id,receiver_id,type,content) VALUES(1,2,'private','legacy message')")
  fs.writeFileSync(path.join(directory, 'data.db'), Buffer.from(previous.export()), { mode: 0o600 })
  previous.close()
  const program = "const {initDB}=require(process.env.PHASE3_DB_MODULE);\n(async()=>{const db=await initDB();\nconst existing=db.prepare('SELECT id,content,client_message_id,sender_deleted,receiver_deleted FROM messages ORDER BY id').all();\nconst inserted=db.prepare(\"INSERT INTO messages(sender_id,receiver_id,type,content,client_message_id) VALUES(1,2,'private','new message','phase3-same-request')\").run();\nconst updated=db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(inserted.lastInsertRowid);\nconst noop=db.prepare('UPDATE messages SET is_read=1 WHERE id=999999').run();\nconst unread=db.prepare(\"SELECT COUNT(*) AS c FROM messages WHERE type='tree_hole' AND receiver_id=2 AND receiver_deleted=0 AND is_read=0\").get().c;\nconst indexes=db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_messages_private_incoming','idx_messages_private_outgoing','idx_messages_sender_client_id','idx_messages_tree_unread','idx_messages_tree_root','idx_vote_options_vote')\").all().map(row=>row.name);\ndb.saveNow();console.log('PHASE3_DB='+JSON.stringify({existing,inserted,updated,noop,unread,indexes,dirty:db.dirty}));\n})().catch(error=>{console.error(error);process.exitCode=1});"
  const output = execFileSync(process.execPath, ['-e', program], { cwd: root, env: { ...process.env, DATA_DIR: directory, KEEP_DB: '1', PHASE3_DB_MODULE: path.join(root, 'db.js') }, timeout: 20000, encoding: 'utf8' })
  const line = output.split('\n').find(value => value.startsWith('PHASE3_DB='))
  assert.ok(line, 'isolated child returned migration results')
  const result = JSON.parse(line.slice('PHASE3_DB='.length))
  assert.deepEqual(result.existing, [{ id: 1, content: 'legacy message', client_message_id: null, sender_deleted: 0, receiver_deleted: 0 }])
  assert.deepEqual(result.inserted, { lastInsertRowid: 2, changes: 1 })
  assert.deepEqual(result.updated, { lastInsertRowid: 2, changes: 1 })
  assert.deepEqual(result.noop, { lastInsertRowid: 2, changes: 0 })
  assert.equal(result.unread, 0)
  assert.deepEqual(result.indexes.sort(), ['idx_messages_private_incoming','idx_messages_private_outgoing','idx_messages_sender_client_id','idx_messages_tree_unread','idx_messages_tree_root','idx_vote_options_vote'].sort())
  assert.equal(result.dirty, false)
  assert.equal(fs.statSync(path.join(directory, 'data.db')).mode & 0o777, 0o600)
})
