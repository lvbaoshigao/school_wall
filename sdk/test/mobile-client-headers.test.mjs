import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createMobileClient } from '../mobile-client.mjs';

const imageFile = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';

test('getWallpaperImage forwards declared headers and preserves partial responses', async () => {
  let request;
  const client = createMobileClient({
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(Uint8Array.from([1, 2]), { status: 206, headers: { 'Content-Range': 'bytes 0-1/8' } });
    },
  });

  const result = await client.operations.getWallpaperImage({ path: { file: imageFile } }, {
    headers: { range: 'bytes=0-1', 'if-none-match': '"wallpaper-etag"' },
  });

  assert.equal(request.url, '/api/v1/wallpaper/image/' + imageFile);
  assert.equal(request.options.headers.Range, 'bytes=0-1');
  assert.equal(request.options.headers['If-None-Match'], '"wallpaper-etag"');
  assert.equal(Object.hasOwn(request.options.headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(request.options.headers, 'X-Wall-Id'), false);
  assert.equal(result.status, 206);
  assert.deepEqual(Array.from(new Uint8Array(result.data)), [1, 2]);
});

test('conditional binary 304 resolves with null data and response metadata', async () => {
  const client = createMobileClient({
    fetch: async () => new Response(null, { status: 304, headers: { ETag: '"wallpaper-etag"', 'X-Request-ID': 'request-304' } }),
  });

  const result = await client.operations.getWallpaperImage({ path: { file: imageFile } }, {
    headers: { 'IF-NONE-MATCH': '"wallpaper-etag"' },
  });

  assert.equal(result.data, null);
  assert.equal(result.status, 304);
  assert.equal(result.meta.requestId, 'request-304');
  assert.equal(result.headers.get('ETag'), '"wallpaper-etag"');
});

test('304 is not successful without a conditional binary request', async () => {
  const client = createMobileClient({ fetch: async () => new Response(null, { status: 304 }) });

  await assert.rejects(
    client.callOperation('getWallpaperImage', { path: { file: imageFile } }, { headers: { Range: 'bytes=0-1' } }),
    error => error.code === 'HTTP_ERROR' && error.status === 304,
  );
  await assert.rejects(
    client.callOperation('getApiInfo'),
    error => error.code === 'INVALID_RESPONSE' && error.status === 304,
  );
});

test('operation headers are OpenAPI-declared and reject reserved names case-insensitively', async () => {
  let fetchCount = 0;
  const client = createMobileClient({ fetch: async () => { fetchCount += 1; return new Response(null, { status: 304 }); } });
  const params = { path: { file: imageFile } };

  assert.throws(() => client.callOperation('getWallpaperImage', params, { headers: { 'If-Match': '"old"' } }), { code: 'CLIENT_VALIDATION' });
  for (const name of ['Authorization', 'authorization', 'X-Wall-Id', 'x-wall-id']) {
    assert.throws(() => client.callOperation('getWallpaperImage', params, { headers: { [name]: '1' } }), { code: 'CLIENT_VALIDATION' });
  }
  await assert.rejects(client.request('/capabilities', { auth: false, headers: { aUtHoRiZaTiOn: 'attacker' } }), { code: 'CLIENT_VALIDATION' });
  await assert.rejects(client.request('/capabilities', { auth: false, headers: { 'X-WALL-ID': '1' } }), { code: 'CLIENT_VALIDATION' });
  assert.equal(fetchCount, 0);
});

test('ordinary authenticated JSON requests retain no-store', async () => {
  let request;
  const client = createMobileClient({
    getToken: () => 'test-token',
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: {}, error: null, meta: { apiVersion: '1', requestId: 'request-json' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.getMe();
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
});

test('conditional public image revalidates over HTTP without credentials', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    if (request.headers['if-none-match'] === '"wallpaper-etag"'
      && request.headers['cache-control'] === 'max-age=0' && request.headers.pragma === undefined) {
      response.writeHead(304, { ETag: '"wallpaper-etag"' });
      response.end();
      return;
    }
    response.writeHead(200, { ETag: '"wallpaper-etag"', 'Content-Type': 'image/jpeg' });
    response.end(Buffer.from([255, 216, 255]));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  let tokenReads = 0;
  let wallReads = 0;
  const client = createMobileClient({
    baseURL: `http://127.0.0.1:${server.address().port}/api/v1`,
    getToken: () => { tokenReads += 1; return 'must-not-be-sent'; },
    getWallId: () => { wallReads += 1; return 7; },
    timeoutMs: 5000,
  });
  try {
    const first = await client.operations.getWallpaperImage({ path: { file: imageFile } });
    assert.equal(first.status, 200);
    assert.deepEqual(Array.from(new Uint8Array(first.data)), [255, 216, 255]);
    assert.equal(requests[0]['cache-control'], 'no-cache');
    assert.equal(requests[0].pragma, 'no-cache');

    const cached = await client.operations.getWallpaperImage({ path: { file: imageFile } }, {
      headers: { 'If-None-Match': '"wallpaper-etag"' },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.data, null);
    assert.equal(requests[1]['cache-control'], 'max-age=0');
    assert.equal(requests[1].pragma, undefined);
    for (const headers of requests) {
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-wall-id'], undefined);
      assert.equal(headers.cookie, undefined);
    }
    assert.equal(tokenReads, 0);
    assert.equal(wallReads, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
