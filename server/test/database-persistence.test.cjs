'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-db-test-'));
process.env.DATA_DIR = directory;
process.env.KEEP_DB = '1';
const { initDB } = require('../db');
let db;

function foreignKeysEnabled() {
  return db.prepare('PRAGMA foreign_keys').get().foreign_keys;
}

before(async () => {
  db = await initDB();
});

after(() => {
  // Avoid a beforeExit flush after removing this test's isolated directory.
  if (db) db.dirty = false;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('initial persistence keeps foreign key validation enabled', () => {
  assert.equal(foreignKeysEnabled(), 1);
  assert.throws(() => {
    db.prepare('INSERT INTO vote_options (vote_id, option_text) VALUES (?, ?)').run(999999, 'orphan');
  }, /FOREIGN KEY constraint failed/);
});

test('repeated saves and backup exports preserve cascade deletion', () => {
  const vote = db.prepare('INSERT INTO votes (wall_id, title, author_ip) VALUES (?, ?, ?)').run(1, 'test vote', '127.0.0.1').lastInsertRowid;
  const option = db.prepare('INSERT INTO vote_options (vote_id, option_text) VALUES (?, ?)').run(vote, 'test option').lastInsertRowid;
  db.prepare('INSERT INTO vote_records (vote_id, option_id, user_id) VALUES (?, ?, ?)').run(vote, option, 1);

  for (let index = 0; index < 2; index++) {
    db.markDirty();
    assert.equal(db.saveNow(), true);
    assert.equal(foreignKeysEnabled(), 1);
    const bytes = db.exportBytes();
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.equal(foreignKeysEnabled(), 1);
  }

  db.prepare('DELETE FROM votes WHERE id=?').run(vote);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vote_options WHERE vote_id=?').get(vote).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vote_records WHERE vote_id=?').get(vote).count, 0);
});

test('failed disk writes retain dirty state and foreign key validation', () => {
  const temporaryFile = path.join(directory, 'data.db.tmp');
  fs.mkdirSync(temporaryFile);
  db.markDirty();
  try {
    assert.throws(() => db.saveNow(), error => ['EISDIR', 'EACCES', 'EPERM'].includes(error.code));
    assert.equal(db.dirty, true);
    assert.equal(foreignKeysEnabled(), 1);
  } finally {
    fs.rmdirSync(temporaryFile);
    db.saveNow();
  }
});

test('failed backup exports still restore foreign key validation', () => {
  const originalExport = db.db.export;
  db.db.export = function () {
    this.run('PRAGMA foreign_keys = OFF');
    throw new Error('simulated export failure');
  };
  try {
    assert.throws(() => db.exportBytes(), /simulated export failure/);
    assert.equal(foreignKeysEnabled(), 1);
  } finally {
    db.db.export = originalExport;
  }
});
