'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, stat, writeFile, copyFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { test } = require('node:test');
const { createWallpaperService, createWallpaperRouter } = require('../lib/wallpaper');

const JPEG = path.resolve(__dirname, '../../rele/1.jpg');

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'school-wall-wallpaper-'));
  const localDir = path.join(root, 'rele');
  const cacheDir = path.join(root, 'wallpaper-cache');
  await mkdir(localDir);
  await copyFile(JPEG, path.join(localDir, '1.jpg'));
  await copyFile(JPEG, path.join(localDir, '2.jpg'));
  await writeFile(path.join(localDir, 'notes.txt'), 'not an image');
  try { return await fn({ root, localDir, cacheDir, jpg: await readFile(JPEG) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function archiveResponse(items = [{ url: '/th?id=OHR.Test_1920x1080.jpg', copyright: 'test' }], headers = {}) {
  return new Response(JSON.stringify({ images: items }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function imageResponse(bytes, headers = {}) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });
}

function fakeFetch({ archive = archiveResponse(), image, archiveError, imageError, delay = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('HPImageArchive')) {
      if (archiveError) throw archiveError;
      return delay ? new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(archive), delay);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      }) : archive;
    }
    if (imageError) throw imageError;
    return image;
  };
  return { fetchImpl, calls };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { server, base: 'http://127.0.0.1:' + address.port };
}

test('accepts Bing JSON charset and JPEG bytes, then reuses validated cache', async () => {
  await fixture(async ({ localDir, cacheDir, jpg }) => {
    const fake = fakeFetch({ archive: archiveResponse(), image: imageResponse(jpg) });
    const service = createWallpaperService({ localDir, cacheDir, fetchImpl: fake.fetchImpl });
    const first = await service.select({ source: 'bing', idx: '0' });
    assert.match(first.url, /^\/api\/wallpaper\/image\/[a-f0-9]{64}\.jpg$/);
    assert.equal(first.source, 'bing');
    assert.equal(first.fallback, false);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].options.headers.Accept, 'application/json');
    assert.equal(fake.calls[1].options.headers.Accept, 'image/jpeg');
    const imagePath = service.imagePath(first.file);
    assert.ok(imagePath);
    assert.equal((await stat(imagePath)).size, jpg.length);
    const second = await service.select({ source: 'bing', idx: 0 });
    assert.equal(second.file, first.file);
    assert.equal(fake.calls.length, 2, 'metadata and validated image should be served from cache');
  });
});

test('rejects non-Bing archive URLs and falls back without contacting another origin', async () => {
  await fixture(async ({ localDir, cacheDir }) => {
    const fake = fakeFetch({
      archive: archiveResponse([
        { url: 'https://evil.example/th?id=OHR.Evil_1920x1080.jpg' },
        { url: '/other?id=OHR.Wrong_1920x1080.jpg' },
        { url: '/th?id=OHR.Valid_1920x1080.jpg' },
      ]),
      image: imageResponse(Buffer.from('not jpeg')),
    });
    const service = createWallpaperService({ localDir, cacheDir, fetchImpl: fake.fetchImpl });
    const result = await service.select({ source: 'bing', idx: 0 });
    assert.equal(result.source, 'local');
    assert.equal(result.fallback, true);
    assert.equal(result.url, '/rele/1.jpg');
    assert.ok(fake.calls.every(call => call.url.startsWith('https://www.bing.com/')));
  });
});

test('falls back only for upstream errors: network, MIME, invalid image, and size', async () => {
  await fixture(async ({ localDir, cacheDir, jpg }) => {
    const cases = [
      { archiveError: new Error('offline') },
      { archive: new Response(JSON.stringify({ images: [{ url: '/th?id=OHR.Test_1920x1080.jpg' }] }), { headers: { 'content-type': 'text/plain' } }), image: imageResponse(jpg) },
      { archive: archiveResponse(), image: imageResponse(Buffer.from('not jpeg')) },
      { archive: archiveResponse(), image: imageResponse(Buffer.concat([jpg, Buffer.alloc(64)]), { 'content-length': String(9 * 1024 * 1024) }) },
    ];
    for (const options of cases) {
      const fake = fakeFetch(options);
      const service = createWallpaperService({ localDir, cacheDir: path.join(cacheDir, String(Math.random())), fetchImpl: fake.fetchImpl, maxImageBytes: 8 * 1024 * 1024 });
      const result = await service.select({ source: 'bing' });
      assert.equal(result.source, 'local');
      assert.equal(result.fallback, true);
    }
  });
});

test('aborts a stalled archive request at the configured deadline and uses local fallback', async () => {
  await fixture(async ({ localDir, cacheDir }) => {
    const fake = fakeFetch({ delay: 1000, archive: archiveResponse() });
    const service = createWallpaperService({ localDir, cacheDir, fetchImpl: fake.fetchImpl, timeoutMs: 25 });
    const started = Date.now();
    const result = await service.select({ source: 'bing' });
    assert.equal(result.source, 'local');
    assert.equal(result.fallback, true);
    assert.ok(Date.now() - started < 500, 'request should not wait for upstream promise');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].options.signal.aborted, true);
  });
});

test('serves a valid cached image while Bing is unavailable', async () => {
  await fixture(async ({ localDir, cacheDir, jpg }) => {
    const firstFetch = fakeFetch({ archive: archiveResponse(), image: imageResponse(jpg) });
    const firstService = createWallpaperService({ localDir, cacheDir, fetchImpl: firstFetch.fetchImpl });
    const first = await firstService.select({ source: 'bing' });
    const offline = fakeFetch({ archiveError: new Error('offline') });
    const secondService = createWallpaperService({ localDir, cacheDir, fetchImpl: offline.fetchImpl });
    const second = await secondService.select({ source: 'bing' });
    assert.equal(second.source, 'bing');
    assert.equal(second.file, first.file);
    assert.equal(offline.calls.length, 0, 'fresh metadata and validated image avoid network');
  });
});

test('replaces a corrupt bounded cache entry instead of returning it', async () => {
  await fixture(async ({ localDir, cacheDir, jpg }) => {
    const firstFetch = fakeFetch({ archive: archiveResponse(), image: imageResponse(jpg) });
    const firstService = createWallpaperService({ localDir, cacheDir, fetchImpl: firstFetch.fetchImpl });
    const first = await firstService.select({ source: 'bing' });
    await writeFile(firstService.imagePath(first.file), Buffer.from('corrupt'));
    const secondFetch = fakeFetch({ image: imageResponse(jpg) });
    const secondService = createWallpaperService({ localDir, cacheDir, fetchImpl: secondFetch.fetchImpl });
    const second = await secondService.select({ source: 'bing' });
    assert.equal(second.source, 'bing');
    assert.equal(second.file, first.file);
    assert.equal(secondFetch.calls.length, 1, 'only the invalid cached image should be redownloaded');
  });
});

test('does not misreport cache filesystem failures as an upstream outage', async () => {
  await fixture(async ({ localDir, root }) => {
    const cachePath = path.join(root, 'cache-file');
    await writeFile(cachePath, 'not a directory');
    const fake = fakeFetch({ archiveError: new Error('offline') });
    const service = createWallpaperService({ localDir, cacheDir: cachePath, fetchImpl: fake.fetchImpl });
    await assert.rejects(service.select({ source: 'bing' }), error => error.code === 'EEXIST' || error.code === 'ENOTDIR');
  });
});

test('keeps local source format and API/static routes compatible', async () => {
  await fixture(async ({ localDir, cacheDir }) => {
    const app = express();
    app.use(createWallpaperRouter({ localDir, cacheDir, fetchImpl: async () => { throw new Error('must not fetch local'); } }));
    const { server, base } = await listen(app);
    try {
      const metadata = await fetch(base + '/api/wallpaper?source=local&idx=0');
      assert.equal(metadata.status, 200);
      const body = await metadata.json();
      assert.deepEqual({ url: body.url, source: body.source, idx: body.idx, total: body.total, fallback: body.fallback }, { url: '/rele/1.jpg', source: 'local', idx: 0, total: 2, fallback: false });
      const image = await fetch(base + body.url);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/jpeg');
      assert.equal(Buffer.from(await image.arrayBuffer()).length > 0, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
