const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('rolling visitor and request counts expire old hits even while a visitor stays active', () => {
  let now = 1700000000000;
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/visits.js'), 'utf8'), { module, Date: Clock });
  const visits = module.exports;
  visits.track('a'); visits.track('a'); visits.track('b');
  assert.equal(visits.stats().requests, 3);
  assert.equal(visits.stats().visitors, 2);
  now += 3599000; visits.track('a');
  now += 2000;
  assert.equal(visits.stats().requests, 1);
  assert.equal(visits.stats().visitors, 1);
  now += 3600001;
  assert.equal(visits.stats().requests, 0);
  assert.equal(visits.stats().visitors, 0);
});

test('preferences ignore string booleans and the default accent agrees with the client', () => {
  const { sanitizePrefs, mergePrefs } = require('../lib/prefs');
  assert.deepEqual(sanitizePrefs({ reduce_motion: 'false', home: false, accent: 'teal' }), { home: false, accent: 'teal' });
  assert.equal(mergePrefs({}).accent, 'teal');
});

test('ban duration rejects coercible JSON values instead of silently creating permanent bans', () => {
  const { parseDuration } = require('../lib/ban');
  for (const value of [true, false, [], {}, ['3'], '1.2', 'Infinity', -1]) assert.equal(parseDuration(value).ok, false);
  assert.deepEqual(parseDuration('15'), { ok: true, minutes: 15 });
});
