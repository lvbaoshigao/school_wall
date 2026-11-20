'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const specPath = path.resolve(__dirname, '../../docs/openapi.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function normalize(value) {
  return value.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '') || '/';
}

function documentedRoutes(spec) {
  const operations = [];
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const server = (operation.servers || item.servers || spec.servers)[0].url.replace(/\/+$/, '');
      if (server !== '/api/v1' && server !== '') throw new Error('Unexpected API server: ' + server);
      const prefix = server === '/api/v1' ? '/api' : '';
      operations.push({ key: method.toUpperCase() + ' ' + normalize(prefix + route), operation });
    }
  }
  return operations;
}

async function actualServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-phase3-coverage-'));
  const child = fork(path.join(__dirname, 'helpers/api-inventory.js'), [], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: directory, JWT_SECRET: crypto.randomBytes(48).toString('hex'),
      HOST: '127.0.0.1', PORT: '0', KEEP_DB: '1', NODE_ENV: 'production', TRUST_PROXY: '0', ADMIN_IP_WHITELIST: '', ALLOWED_ORIGINS: '' },
    silent: true,
  });
  let log = '';
  child.stdout.on('data', value => { log = (log + value).slice(-24000); });
  child.stderr.on('data', value => { log = (log + value).slice(-24000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.kill('SIGTERM');
      try { await exit; } finally { clearTimeout(timer); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { port, operations } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated server startup failed: ' + log)), 15000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated startup exited: ' + log)); });
  });
  const request = (url, { method = 'GET', body, token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const values = { ...headers };
    if (payload !== undefined) { values['Content-Type'] = 'application/json'; values['Content-Length'] = Buffer.byteLength(payload); }
    if (token) values.Authorization = 'Bearer ' + token;
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: values, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(bytes.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, json });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Isolated request timed out: ' + url)));
    req.on('error', reject);
    req.end(payload);
  });
  return { operations, request, directory, log: () => log };
}

test('phase3: OpenAPI covers exactly every mounted v1 and internal dashboard API operation', async t => {
  const app = await actualServer(t);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const actual = app.operations.map(op => op.method + ' ' + normalize(op.path));
  const declared = documentedRoutes(spec);
  const expected = declared.map(op => op.key);
  assert.equal(new Set(actual).size, actual.length, 'no repeated mounted method/path');
  assert.equal(new Set(expected).size, expected.length, 'no repeated documented method/path');
  assert.deepEqual([...expected].sort(), [...actual].sort(), 'adding or removing an API requires updating the contract');
  const ids = declared.map(item => item.operation.operationId);
  assert.ok(ids.every(value => typeof value === 'string' && value.length));
  assert.equal(new Set(ids).size, ids.length, 'every API operation has a unique SDK operation id');
  for (const { key, operation } of declared) {
    assert.ok(Object.keys(operation.responses || {}).length, key + ' declares real responses');
    if (key.includes('/dashboard/api/')) assert.equal(operation['x-internal'], true, key + ' remains private cookie/CSRF API');
  }
  console.log(JSON.stringify({ actualOperations: actual.length, documentedOperations: expected.length, missing: [], extra: [] }));
});

test('phase3: real API backup download keeps SQLite bytes and archive MIME in legacy and v1', async t => {
  const app = await actualServer(t);
  const setup = await app.request('/api/setup', { method: 'POST', body: {
    username: 'coverage-owner', password: 'Temporary-only-coverage-password', nickname: '隔离验证', wall_name: '验证校园',
  } });
  assert.equal(setup.status, 200);
  const token = setup.json.token;
  const saved = await app.request('/api/v1/admin/db/backup', { method: 'POST', body: {}, token });
  assert.equal(saved.status, 200);
  const name = saved.json.data.file;
  assert.equal(typeof name, 'string');
  for (const prefix of ['/api', '/api/v1']) {
    const archive = await app.request(prefix + '/admin/db/backups/' + encodeURIComponent(name) + '/download', { token });
    assert.equal(archive.status, 200);
    assert.match(archive.headers['content-type'], /^application\/octet-stream(?:;|$)/);
    assert.match(archive.headers['content-disposition'], /^attachment/);
    assert.equal(archive.bytes.subarray(0, 16).toString('binary'), 'SQLite format 3\0');
    assert.equal(Number(archive.headers['content-length']), archive.bytes.length);
  }
  const archive = await app.request('/api/v1/auth/export', { token });
  assert.equal(archive.status, 200);
  assert.match(archive.headers['content-type'], /^application\/gzip/);
  assert.ok(archive.bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])));
  assert.ok(!app.log().includes('is not defined'));
});

// No real data: test the protocol cache using an isolated document and ordinary HTTP.
test('phase3: the OpenAPI response reuses unchanged text and invalidates replaced, corrupt or missing files', async t => {
  const express = require('express');
  const { apiV1Middleware, apiV1Router } = require('../lib/apiV1');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-wall-phase3-openapi-'));
  const filename = path.join(directory, 'openapi.json');
  const initial = JSON.stringify({ openapi: '3.0.3', paths: {}, info: { title: 'isolated' } });
  fs.writeFileSync(filename, initial);
  const app = express(); app.use(apiV1Middleware()); app.use('/api', apiV1Router({ openApiPath: filename }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/openapi.json';
  const originalRead = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = function (file, ...args) { if (file === filename) reads++; return originalRead.call(this, file, ...args); };
  t.after(() => { fs.promises.readFile = originalRead; });
  for (const response of await Promise.all(Array.from({ length: 8 }, () => fetch(url)))) {
    assert.equal(response.status, 200); assert.equal(await response.text(), initial);
  }
  assert.equal(reads, 1, 'concurrent unchanged requests share a single read and parse');
  const replacement = JSON.stringify({ openapi: '3.0.3', paths: {}, info: { title: 'updated-doc' } });
  fs.writeFileSync(filename + '.next', replacement); fs.renameSync(filename + '.next', filename);
  assert.equal(await (await fetch(url)).text(), replacement);
  assert.equal(reads, 2);
  fs.writeFileSync(filename, '{');
  const invalid = await fetch(url); assert.equal(invalid.status, 503); assert.equal((await invalid.json()).error.code, 'OPENAPI_UNAVAILABLE');
  fs.unlinkSync(filename);
  assert.equal((await fetch(url)).status, 503);
});
