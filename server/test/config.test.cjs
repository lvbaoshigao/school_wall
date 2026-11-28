'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadConfig } = require('../config');

test('backend defaults to loopback, supports standalone mode and OS-assigned ports', () => {
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({}).serveClient, true);
  assert.deepEqual(loadConfig({ NODE_ENV: 'production', PORT: '0', SERVE_CLIENT: '0', HOST: '::1' }), {
    port: 0, host: '::1', serveClient: false, allowedOrigins: [],
  });
  assert.equal(loadConfig({ HOST: '0.0.0.0', PORT: '65535' }).port, 65535);
});

test('invalid ports cannot become Unix socket paths and configuration typos fail early', () => {
  for (const PORT of ['local.sock', '-1', '65536', '3.5', '1e3', '3000 ', '9999999999999999']) {
    assert.throws(() => loadConfig({ PORT }), /PORT/);
  }
  for (const HOST of ['http://localhost', '127.0.0.1:3000', 'local host', '../socket', '[::1]']) {
    assert.throws(() => loadConfig({ HOST }), /HOST/);
  }
  for (const SERVE_CLIENT of ['', 'yes', '2']) assert.throws(() => loadConfig({ SERVE_CLIENT }), /SERVE_CLIENT/);
});

test('CORS accepts only explicit HTTP origins and production has no development exemptions', () => {
  const config = loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: ' https://school.example/ ,https://school.example,http://127.0.0.1:5174 ' });
  assert.deepEqual(config.allowedOrigins, ['https://school.example', 'http://127.0.0.1:5174']);
  for (const ALLOWED_ORIGINS of ['*', 'null', 'file:///tmp', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#fragment']) {
    assert.throws(() => loadConfig({ ALLOWED_ORIGINS }), /ALLOWED_ORIGINS/);
  }
  assert.ok(loadConfig({}).allowedOrigins.includes('http://127.0.0.1:5173'));
  assert.deepEqual(loadConfig({ NODE_ENV: 'production' }).allowedOrigins, []);
});
