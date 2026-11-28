'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { before, test } = require('node:test');
const express = require('express');
const sharp = require('sharp');
const { createWallpaperService, createWallpaperRouter } = require('../lib/wallpaper');

const ARCHIVE_URL = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN';
const IMAGE = { url: '/th?id=OHR.WallpaperFixture_1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp', copyright: 'Synthetic wallpaper' };
const IMAGE_URL = new URL(IMAGE.url, 'https://www.bing.com').href;
const fileFor = url => crypto.createHash('sha256').update(url).digest('hex') + '.jpg';
let jpeg, png, truncatedJpeg, excessivePixelsJpeg;

before(async () => {
  const image = () => sharp({ create: { width: 160, height: 120, channels: 3, background: '#abcdef' } });
  [jpeg, png] = await Promise.all([image().jpeg().toBuffer(), image().png().toBuffer()]);
  truncatedJpeg = jpeg.subarray(0, jpeg.length - 10);
  excessivePixelsJpeg = Buffer.from(jpeg);
  const frame = excessivePixelsJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame > 0, 'the synthetic JPEG has a baseline frame');
  excessivePixelsJpeg.writeUInt16BE(6000, frame + 5);
  excessivePixelsJpeg.writeUInt16BE(7000, frame + 7);
});

function archive(images = [IMAGE], type = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify({ images }), { headers: type ? { 'content-type': type } : {} });
}

function imageResponse(bytes = jpeg, type = 'image/jpeg', headers = {}) {
  return new Response(bytes, { headers: { 'content-type': type, ...headers } });
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'school-wall-wallpaper-test-'));
  const localDir = path.join(root, 'local'), cacheDir = path.join(root, 'cache');
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('school-wall-wallpaper-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(localDir);
  await fs.writeFile(path.join(localDir, '1.jpg'), jpeg);
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error', 'upstream redirects must stay disabled');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === ARCHIVE_URL) return archive();
    assert.equal(url, IMAGE_URL);
    return imageResponse();
  });
  const service = createWallpaperService({ localDir, cacheDir, ...options, fetchImpl });
  return { root, localDir, cacheDir, calls, service };
}

function assertLocal(result, fallback = true) {
  assert.deepEqual(result, { file: '1.jpg', url: '/rele/1.jpg', total: 1, idx: 0, source: 'local', fallback });
}

test('the observed Bing JSON MIME with charset and valid JPEG preserve the public API', async t => {
  for (const type of ['application/json; charset=utf-8', 'Application/JSON ; charset="utf-8"']) {
    await t.test(type, async t => {
      const requests = [];
      const f = await fixture(t, { fetchImpl: async (url, init) => {
        requests.push({ url, init });
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        return url === ARCHIVE_URL ? archive([IMAGE], type) : imageResponse(jpeg, 'IMAGE/JPEG; charset=binary');
      } });
      const result = await f.service.select({ source: 'bing', idx: '0' });
      const file = fileFor(IMAGE_URL);
      assert.deepEqual(result, { file, url: '/api/wallpaper/image/' + file, total: 1, idx: 0, source: 'bing', fallback: false, copyright: IMAGE.copyright });
      assert.deepEqual(requests.map(call => call.url), [ARCHIVE_URL, IMAGE_URL]);
      assert.deepEqual(requests.map(call => call.init.headers.Accept), ['application/json', 'image/jpeg']);
      assert.deepEqual(await fs.readFile(f.service.imagePath(file)), jpeg);
      assert.equal(f.service.imagePath('../' + file), null);
      assert.equal(f.service.imagePath('a'.repeat(64) + '.png'), null);
      assert.equal(f.service.imagePath(null), null);
    });
  }
});

test('local selection is sorted, encoded and independent of Bing availability', async t => {
  const f = await fixture(t, { fetchImpl: () => assert.fail('local selection must not fetch') });
  await fs.writeFile(path.join(f.localDir, '2.png'), png);
  await fs.writeFile(path.join(f.localDir, '10 image.jpg'), jpeg);
  await fs.writeFile(path.join(f.localDir, '.hidden.jpg'), jpeg);
  await fs.writeFile(path.join(f.localDir, 'notes.txt'), 'synthetic');
  await fs.mkdir(path.join(f.localDir, 'directory.jpg'));
  await fs.symlink(path.join(f.localDir, '1.jpg'), path.join(f.localDir, 'link.jpg'));
  assert.deepEqual(await f.service.select({ source: 'local', idx: '2' }), { file: '10 image.jpg', url: '/rele/10%20image.jpg', total: 3, idx: 2, source: 'local', fallback: false });
  assert.equal((await f.service.select({ source: 'local', idx: '1000000' })).idx, 1);
  const empty = createWallpaperService({ localDir: path.join(f.root, 'missing'), cacheDir: f.cacheDir });
  assert.deepEqual(await empty.select({ source: 'local' }), { file: null, url: null, total: 0, idx: 0, source: 'local', fallback: false });
});

test('invalid sources and indices are rejected before upstream access', async t => {
  const f = await fixture(t, { fetchImpl: () => assert.fail('invalid input must not fetch') });
  for (const query of [{ source: 'https://127.0.0.1/' }, { source: ['bing'] }, { idx: '-1' }, { idx: '8' }, { idx: '1.5' }, { idx: ['0'] }, { idx: {} }, { idx: Infinity }, { idx: '00000000' }, { source: 'local', idx: '1000001' }]) {
    await assert.rejects(f.service.select(query), error => error.status === 400);
  }
});

test('archive URLs retain the fixed HTTPS origin, path and OHR ID allowlist', async t => {
  const invalid = [
    'http://www.bing.com/th?id=OHR.Bad.jpg', 'https://127.0.0.1/th?id=OHR.Bad.jpg',
    'https://www.bing.com.evil.invalid/th?id=OHR.Bad.jpg', '//evil.invalid/th?id=OHR.Bad.jpg',
    'https://user:pass@www.bing.com/th?id=OHR.Bad.jpg', 'https://www.bing.com:444/th?id=OHR.Bad.jpg',
    '/other?id=OHR.Bad.jpg', '/th?id=Other.jpg', '/th?id=OHR.Bad%2Fimage.jpg',
    '/th?id=OHR.Bad.jpg#fragment', '/th', 'javascript:alert(1)',
  ];
  for (let offset = 0; offset < invalid.length; offset += 6) {
    await t.test('unsafe URL batch ' + offset / 6, async t => {
      const requested = [];
      const f = await fixture(t, { fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'error');
        requested.push(url);
        return url === ARCHIVE_URL ? archive([...invalid.slice(offset, offset + 6).map(url => ({ url })), IMAGE]) : imageResponse();
      } });
      assert.equal((await f.service.select()).source, 'bing');
      assert.deepEqual(requested, [ARCHIVE_URL, IMAGE_URL]);
    });
  }
});

test('the archive is deduplicated and bounded to eight entries with bounded copyright', async t => {
  const images = Array.from({ length: 9 }, (_, index) => ({ url: '/th?id=OHR.Fixture' + index + '.jpg', copyright: 'x'.repeat(700) }));
  const f = await fixture(t, { fetchImpl: async url => url === ARCHIVE_URL ? archive(images) : imageResponse() });
  const result = await f.service.select({ idx: 7 });
  assert.equal(result.total, 8);
  assert.equal(result.copyright.length, 500);
  const duplicate = await fixture(t, { fetchImpl: async url => url === ARCHIVE_URL ? archive([IMAGE, IMAGE]) : imageResponse() });
  assert.equal((await duplicate.service.select()).total, 1);
});

test('invalid archive responses fall back without downloading an image', async t => {
  const responses = {
    'HTML MIME': () => new Response('<html>upstream error</html>', { headers: { 'content-type': 'text/html' } }),
    'missing MIME': () => new Response(new Uint8Array(Buffer.from(JSON.stringify({ images: [IMAGE] })))),
    'malformed JSON': () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    'JSON null': () => new Response('null', { headers: { 'content-type': 'application/json' } }),
    'empty archive': () => archive([]),
    'untrusted archive': () => archive([{ url: 'https://evil.invalid/payload.jpg' }]),
    'HTTP error': () => new Response('failed', { status: 503, headers: { 'content-type': 'application/json' } }),
    'redirect response': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/', 'content-type': 'application/json' } }),
    'declared oversized archive': () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    'streamed oversized archive': () => archive([{ ...IMAGE, copyright: 'x'.repeat(65536) }]),
  };
  for (const [name, response] of Object.entries(responses)) await t.test(name, async t => {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async (url, init) => {
      assert.equal(url, ARCHIVE_URL);
      assert.equal(init.redirect, 'error');
      calls++;
      return response();
    } });
    assertLocal(await f.service.select());
    assertLocal(await f.service.select());
    assert.equal(calls, 1, 'failed archives observe the retry cooldown');
    assert.deepEqual(await fs.readdir(f.cacheDir), []);
  });
});

test('unsupported, mislabeled, corrupt and excessive-pixel images are never cached', async t => {
  // Header inspection alone accepts this truncated JPEG; the regression requires pixel decoding.
  assert.equal((await sharp(truncatedJpeg).metadata()).format, 'jpeg');
  await assert.rejects(sharp(truncatedJpeg).stats(), /premature end/i);
  const responses = {
    'PNG response': () => imageResponse(png, 'image/png'),
    'PNG labeled JPEG': () => imageResponse(png),
    'HTML labeled JPEG': () => imageResponse(Buffer.from('<html>not an image</html>')),
    'truncated JPEG': () => imageResponse(truncatedJpeg),
    'over forty million pixels': () => imageResponse(excessivePixelsJpeg),
    'empty JPEG': () => imageResponse(Buffer.alloc(0)),
  };
  for (const [name, response] of Object.entries(responses)) await t.test(name, async t => {
    let imageCalls = 0;
    const f = await fixture(t, { fetchImpl: async url => {
      if (url === ARCHIVE_URL) return archive();
      imageCalls++;
      return response();
    } });
    assertLocal(await f.service.select());
    assertLocal(await f.service.select());
    assert.equal(imageCalls, 1, 'failed images observe the retry cooldown');
    assert.deepEqual((await fs.readdir(f.cacheDir)).filter(name => name.endsWith('.jpg') || name.endsWith('.tmp')), []);
  });
});

test('image byte limits apply to both Content-Length and the streamed body', async t => {
  for (const declared of [false, true]) await t.test('declared=' + declared, async t => {
    const f = await fixture(t, { maxImageBytes: jpeg.length - 1, fetchImpl: async url => url === ARCHIVE_URL ? archive() : imageResponse(jpeg, 'image/jpeg', declared ? { 'content-length': String(jpeg.length) } : {}) });
    assertLocal(await f.service.select());
    assert.equal(await fs.stat(path.join(f.cacheDir, fileFor(IMAGE_URL))).then(() => true, () => false), false);
  });
  const f = await fixture(t, { maxImageBytes: jpeg.length });
  assert.equal((await f.service.select()).source, 'bing', 'the exact byte limit remains usable');
});

test('corrupt disk caches are repaired rather than returned as successful Bing images', async t => {
  for (const bytes of [Buffer.from('not an image'), truncatedJpeg]) await t.test('cached ' + bytes.length + ' bytes', async t => {
    const clock = 1000000;
    const requested = [];
    const f = await fixture(t, { now: () => clock, fetchImpl: async url => { requested.push(url); return imageResponse(); } });
    await fs.mkdir(f.cacheDir);
    await fs.writeFile(path.join(f.cacheDir, 'metadata.json'), JSON.stringify({ images: [IMAGE], fetchedAt: clock }));
    await fs.writeFile(path.join(f.cacheDir, fileFor(IMAGE_URL)), bytes);
    assert.equal((await f.service.select()).source, 'bing');
    assert.deepEqual(requested, [IMAGE_URL], 'a corrupt cache must be downloaded again');
    assert.deepEqual(await fs.readFile(f.service.imagePath(fileFor(IMAGE_URL))), jpeg);
  });
});

test('a damaged disk cache falls back locally when repair is offline', async t => {
  const clock = 1000000;
  let attempts = 0;
  const f = await fixture(t, { now: () => clock, fetchImpl: async () => { attempts++; throw new Error('synthetic network failure'); } });
  await fs.mkdir(f.cacheDir);
  await fs.writeFile(path.join(f.cacheDir, 'metadata.json'), JSON.stringify({ images: [IMAGE], fetchedAt: clock }));
  await fs.writeFile(path.join(f.cacheDir, fileFor(IMAGE_URL)), truncatedJpeg);
  assertLocal(await f.service.select());
  assertLocal(await f.service.select());
  assert.equal(attempts, 1);
  await assert.rejects(fs.stat(path.join(f.cacheDir, fileFor(IMAGE_URL))), error => error.code === 'ENOENT');
});

test('validated memory and disk caches survive an offline archive refresh and restart', async t => {
  let clock = 1000000, offline = false, archiveCalls = 0, imageCalls = 0;
  const fetchImpl = async url => {
    if (url === ARCHIVE_URL) archiveCalls++; else imageCalls++;
    if (offline) throw new Error('synthetic offline state');
    return url === ARCHIVE_URL ? archive() : imageResponse();
  };
  const f = await fixture(t, { now: () => clock, metadataTtlMs: 100, retryMs: 50, fetchImpl });
  const first = await f.service.select();
  assert.equal(first.source, 'bing');
  assert.deepEqual(await f.service.select(), first);
  assert.deepEqual([archiveCalls, imageCalls], [1, 1]);
  offline = true; clock += 101;
  assert.deepEqual(await f.service.select(), first);
  assert.deepEqual(await f.service.select(), first);
  assert.deepEqual([archiveCalls, imageCalls], [2, 1]);
  clock += 51;
  assert.deepEqual(await f.service.select(), first);
  assert.equal(archiveCalls, 3);
  const restarted = createWallpaperService({ localDir: f.localDir, cacheDir: f.cacheDir, now: () => clock, metadataTtlMs: 100, fetchImpl });
  assert.deepEqual(await restarted.select(), first);
  assert.deepEqual([archiveCalls, imageCalls], [4, 1]);
});

test('unchanged caches avoid repeated full decoding and changed files are revalidated', async t => {
  const originalToBuffer = sharp.prototype.toBuffer;
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', function (...args) { return originalToBuffer.apply(this, args); });
  const f = await fixture(t);
  const first = await f.service.select();
  assert.deepEqual(await f.service.select(), first);
  assert.equal(decodes.mock.callCount(), 1, 'an unchanged verified cache is not decoded for every request');
  const destination = f.service.imagePath(first.file);
  await fs.writeFile(destination, truncatedJpeg);
  assert.deepEqual(await f.service.select(), first);
  assert.deepEqual(await fs.readFile(destination), jpeg);
  assert.equal(f.calls.filter(call => call.url === IMAGE_URL).length, 2);
  assert.equal(decodes.mock.callCount(), 3, 'the changed cache and its replacement both receive full validation');
});

test('persisted metadata cannot bypass upstream URL validation or timestamp and byte limits', async t => {
  const clock = 1000000;
  for (const [name, raw] of Object.entries({
    'external URL': JSON.stringify({ images: [{ url: 'https://127.0.0.1/th?id=OHR.Bad.jpg' }], fetchedAt: clock }),
    'future timestamp': JSON.stringify({ images: [IMAGE], fetchedAt: clock + 1 }),
    'oversized metadata': 'x'.repeat(65537),
    'null metadata': 'null',
  })) await t.test(name, async t => {
    const f = await fixture(t, { now: () => clock });
    await fs.mkdir(f.cacheDir);
    await fs.writeFile(path.join(f.cacheDir, 'metadata.json'), raw);
    assert.equal((await f.service.select()).source, 'bing');
    assert.deepEqual(f.calls.map(call => call.url), [ARCHIVE_URL, IMAGE_URL]);
  });
});

test('failed image downloads can recover after the retry cooldown', async t => {
  let clock = 1000000, imageCalls = 0;
  const f = await fixture(t, { now: () => clock, retryMs: 50, fetchImpl: async url => {
    if (url === ARCHIVE_URL) return archive();
    imageCalls++;
    if (imageCalls === 1) throw new Error('synthetic offline state');
    return imageResponse();
  } });
  assertLocal(await f.service.select());
  assertLocal(await f.service.select());
  assert.equal(imageCalls, 1);
  clock += 51;
  assert.equal((await f.service.select()).source, 'bing');
  assert.equal(imageCalls, 2);
  assert.deepEqual((await fs.readdir(f.cacheDir)).filter(name => name.endsWith('.tmp')), []);
});

test('the shared deadline aborts stalled headers and stalled archive/image bodies', async t => {
  for (const stage of ['headers', 'archive body', 'image body']) await t.test(stage, async t => {
    let aborted = false;
    const f = await fixture(t, { timeoutMs: 30, fetchImpl: async (url, init) => {
      if (stage === 'image body' && url === ARCHIVE_URL) return archive();
      if (stage === 'headers') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')); }, { once: true }));
      const body = new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('synthetic abort')); }, { once: true }); } });
      return new Response(body, { headers: { 'content-type': stage === 'image body' ? 'image/jpeg' : 'application/json' } });
    } });
    const started = Date.now();
    assertLocal(await f.service.select());
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 1000, 'the timeout must include reading the body');
  });
});

test('full decoding observes the request deadline and expired queued decodes never start', { timeout: 5000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', async function () { entered(); await gate; return {}; });
  const images = [IMAGE, { url: '/th?id=OHR.Second.jpg' }];
  const f = await fixture(t, { timeoutMs: 200, fetchImpl: async url => url === ARCHIVE_URL ? archive(images) : imageResponse() });
  try {
    const first = f.service.select({ idx: 0 });
    await started;
    const second = f.service.select({ idx: 1 });
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.source, 'local');
      assert.equal(result.fallback, true);
    }
    assert.equal(decodes.mock.callCount(), 1, 'a timed out decoder keeps its slot until processing settles');
    assert.deepEqual((await fs.readdir(f.cacheDir)).filter(name => name.endsWith('.jpg') || name.endsWith('.tmp')), []);
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodes.mock.callCount(), 1, 'a queued request cannot decode after its deadline');
});

test('metadata validation observes the request deadline before full decode for downloads', { timeout: 5000 }, async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const metadataStarted = new Promise(resolve => { entered = resolve; });
  const originalMetadata = sharp.prototype.metadata;
  const metadata = t.mock.method(sharp.prototype, 'metadata', async function (...args) {
    entered();
    await gate;
    return originalMetadata.apply(this, args);
  });
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', async function () { return {}; });
  const f = await fixture(t, { timeoutMs: 50 });
  try {
    const started = Date.now();
    const selection = f.service.select({ idx: 0 });
    await metadataStarted;
    const result = await Promise.race([
      selection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('metadata exceeded request deadline')), 250)),
    ]);
    assertLocal(result);
    assert.ok(Date.now() - started < 200, 'metadata timeout must return near the request deadline');
    assert.equal(decodes.mock.callCount(), 0, 'expired metadata must not start full decoding');
  } finally {
    release();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metadata.mock.callCount(), 1);
  assert.equal(decodes.mock.callCount(), 0, 'a timed-out metadata job must not decode after settling');
});

test('metadata cache validation timeout keeps a valid cached file available', { timeout: 5000 }, async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const metadataStarted = new Promise(resolve => { entered = resolve; });
  const originalMetadata = sharp.prototype.metadata;
  const metadata = t.mock.method(sharp.prototype, 'metadata', async function (...args) {
    entered();
    await gate;
    return originalMetadata.apply(this, args);
  });
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', async function () { return {}; });
  const clock = 1000000;
  const f = await fixture(t, { timeoutMs: 50, now: () => clock, fetchImpl: () => assert.fail('timed-out cache validation must not fetch') });
  await fs.mkdir(f.cacheDir);
  await fs.writeFile(path.join(f.cacheDir, 'metadata.json'), JSON.stringify({ images: [IMAGE], fetchedAt: clock }));
  const destination = path.join(f.cacheDir, fileFor(IMAGE_URL));
  await fs.writeFile(destination, jpeg);
  try {
    const started = Date.now();
    const selection = f.service.select();
    await metadataStarted;
    const result = await Promise.race([
      selection,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cached metadata exceeded request deadline')), 250)),
    ]);
    assertLocal(result);
    assert.ok(Date.now() - started < 200, 'cached metadata timeout must return near the request deadline');
    assert.equal(decodes.mock.callCount(), 0, 'expired cached metadata must not start full decoding');
    assert.deepEqual(await fs.readFile(destination), jpeg, 'metadata timeout must not delete a valid cache');
  } finally {
    release();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metadata.mock.callCount(), 1);
  assert.equal(decodes.mock.callCount(), 0, 'a timed-out cache metadata job must not decode after settling');
  assert.deepEqual(await fs.readFile(destination), jpeg);
});

test('metadata and full decode validation share the bounded concurrency slots', async t => {
  let active = 0;
  let maximum = 0;
  const enter = () => { maximum = Math.max(maximum, ++active); };
  const leave = () => { active--; };
  const originalMetadata = sharp.prototype.metadata;
  const originalToBuffer = sharp.prototype.toBuffer;
  t.mock.method(sharp.prototype, 'metadata', async function (...args) {
    enter();
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      return await originalMetadata.apply(this, args);
    } finally { leave(); }
  });
  t.mock.method(sharp.prototype, 'toBuffer', async function (...args) {
    enter();
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      return await originalToBuffer.apply(this, args);
    } finally { leave(); }
  });
  const images = Array.from({ length: 8 }, (_, index) => ({ url: '/th?id=OHR.MetadataConcurrent' + index + '.jpg' }));
  const f = await fixture(t, { fetchImpl: async url => url === ARCHIVE_URL ? archive(images) : imageResponse() });
  const results = await Promise.all(images.map((image, idx) => f.service.select({ idx })));
  assert.ok(results.every(result => result.source === 'bing'));
  assert.ok(maximum <= 1, 'metadata and full decode must share one validation slot');
});

test('a cache verification deadline keeps a valid file available for the next attempt', { timeout: 5000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', async function () { await gate; return {}; });
  const clock = 1000000;
  const f = await fixture(t, { timeoutMs: 100, now: () => clock, fetchImpl: () => assert.fail('fresh valid cache must not fetch') });
  await fs.mkdir(f.cacheDir);
  await fs.writeFile(path.join(f.cacheDir, 'metadata.json'), JSON.stringify({ images: [IMAGE], fetchedAt: clock }));
  const destination = path.join(f.cacheDir, fileFor(IMAGE_URL));
  await fs.writeFile(destination, jpeg);
  try {
    assertLocal(await f.service.select());
    assert.equal(decodes.mock.callCount(), 1);
    assert.deepEqual(await fs.readFile(destination), jpeg, 'a deadline is not evidence of corrupt cache bytes');
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
});

test('distinct image requests bound simultaneous full pixel decodes', async t => {
  let active = 0, maximum = 0;
  const originalToBuffer = sharp.prototype.toBuffer;
  const decodes = t.mock.method(sharp.prototype, 'toBuffer', async function () {
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      return await originalToBuffer.call(this);
    } finally { active--; }
  });
  const images = Array.from({ length: 8 }, (_, index) => ({ url: '/th?id=OHR.Concurrent' + index + '.jpg' }));
  const f = await fixture(t, { fetchImpl: async url => url === ARCHIVE_URL ? archive(images) : imageResponse() });
  const results = await Promise.all(images.map((image, idx) => f.service.select({ idx })));
  assert.ok(results.every(result => result.source === 'bing'));
  assert.equal(decodes.mock.callCount(), 8);
  assert.ok(maximum <= 2, 'bounded pixel counts must not be multiplied by eight parallel decoders');
});

test('concurrent selections share metadata and image downloads', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.select()));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(results[0].source, 'bing');
  assert.deepEqual(f.calls.map(call => call.url), [ARCHIVE_URL, IMAGE_URL]);
});

test('cache initialization retries after a temporary filesystem failure', async t => {
  let clock = 1000000;
  const f = await fixture(t, { now: () => clock, retryMs: 50 });
  await fs.writeFile(f.cacheDir, 'synthetic obstruction');
  await assert.rejects(f.service.select(), error => error.code === 'EEXIST');
  await assert.rejects(f.service.select(), /initialization is cooling down/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cacheDir, path.join(f.root, 'cache'));
  await fs.rm(f.cacheDir);
  clock += 51;
  assert.equal((await f.service.select()).source, 'bing');
});

test('cache pruning retains at most sixteen generated JPEGs and preserves unrelated files', async t => {
  let sequence = 0;
  const f = await fixture(t, { metadataTtlMs: 0, fetchImpl: async url => url === ARCHIVE_URL ? archive([{ url: '/th?id=OHR.Cache' + sequence++ + '.jpg' }]) : imageResponse() });
  await fs.mkdir(f.cacheDir);
  await fs.writeFile(path.join(f.cacheDir, 'keep.txt'), 'synthetic unrelated file');
  for (let index = 0; index < 19; index++) assert.equal((await f.service.select()).source, 'bing');
  const names = await fs.readdir(f.cacheDir);
  assert.equal(names.filter(name => /^[a-f0-9]{64}\.jpg$/.test(name)).length, 16);
  assert.equal(await fs.readFile(path.join(f.cacheDir, 'keep.txt'), 'utf8'), 'synthetic unrelated file');
  assert.equal(names.some(name => name.endsWith('.tmp')), false);
});

test('router serves selected cached and local images with the existing URLs and cache headers', async t => {
  const f = await fixture(t);
  const app = express();
  app.use(createWallpaperRouter({ localDir: f.localDir, cacheDir: f.cacheDir, fetchImpl: async url => url === ARCHIVE_URL ? archive() : imageResponse() }));
  const blockedCache = path.join(f.root, 'blocked-cache');
  await fs.writeFile(blockedCache, 'synthetic obstruction');
  app.use('/fault', createWallpaperRouter({ localDir: f.localDir, cacheDir: blockedCache }));
  app.use((error, req, res, next) => res.status(500).json({ error: 'Synthetic internal failure' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const selected = await fetch(base + '/api/wallpaper?source=bing&idx=0');
    assert.equal(selected.status, 200);
    assert.equal(selected.headers.get('cache-control'), 'no-store');
    const result = await selected.json();
    const image = await fetch(base + result.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    const local = await fetch(base + '/rele/1.jpg');
    assert.equal(local.status, 200);
    assert.deepEqual(Buffer.from(await local.arrayBuffer()), jpeg);
    assert.equal((await fetch(base + '/api/wallpaper?source=bing&idx=8')).status, 400);
    assert.equal((await fetch(base + '/api/wallpaper/image/not-a-generated-image.jpg')).status, 404);
    const missing = await fetch(base + '/api/wallpaper/image/' + '0'.repeat(64) + '.jpg');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    const failed = await fetch(base + '/fault/api/wallpaper');
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await failed.json(), { error: 'Synthetic internal failure' });
  } finally {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});
