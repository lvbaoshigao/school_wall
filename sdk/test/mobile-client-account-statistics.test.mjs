import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMobileClient } from '../mobile-client.mjs';
import { V1_OPERATIONS } from '../v1-operations.mjs';

const countKeys = ['walls_joined', 'friends', 'named_posts', 'comments', 'bookmarks', 'votes_participated'];
const statistics = { registered_at: '2024-03-02 13:14:15', counts: { walls_joined: 2, friends: 3, named_posts: 4, comments: 5, bookmarks: 6, votes_participated: 7 } };
const envelope = data => new Response(JSON.stringify({ data, error: null, meta: { apiVersion: '1', requestId: 'statistics-sdk-test' } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function recordingClient(data = statistics) {
  const requests = [];
  let wallReads = 0;
  const client = createMobileClient({
    getToken: () => 'statistics-session',
    getWallId: () => { wallReads++; throw new Error('Account statistics must not read current wall'); },
    fetch: async (url, options) => { requests.push({ url, options }); return envelope(data); },
  });
  return { client, requests, wallReads: () => wallReads };
}

test('account statistics helper and operation registry use self-only authentication without wall context', async () => {
  const { client, requests, wallReads } = recordingClient();
  const result = await client.getAccountStatistics();
  assert.deepEqual(result.data, statistics);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  await client.getAccountStatistics({ wallId: 8 });
  await client.operations.getAccountStatistics({}, { wallId: 9 });
  await client.callOperation('getAccountStatistics', { wallId: 10 });
  assert.equal(wallReads(), 0);
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.url, '/api/v1/auth/statistics');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer statistics-session');
    assert.equal(Object.hasOwn(request.options.headers, 'X-Wall-Id'), false);
    assert.equal(request.options.body, undefined);
    assert.equal(request.options.cache, 'no-store');
  }
  assert.deepEqual(V1_OPERATIONS.getAccountStatistics, { method: 'GET', path: '/auth/statistics', auth: true, response: 'json', params: [], body: null, bodyRequired: false });
});

test('null historical registration and empty counts pass through without inventing joined days', async () => {
  const empty = { registered_at: null, counts: Object.fromEntries(countKeys.map(key => [key, 0])) };
  const { client } = recordingClient(empty);
  assert.deepEqual((await client.getAccountStatistics()).data, empty);
  assert.equal(Object.hasOwn((await client.getAccountStatistics()).data, 'joined_days'), false);
});

test('account operations reject target account, query scope, extra paths and bodies before fetch', () => {
  const { client, requests } = recordingClient();
  for (const params of [{ query: { user_id: 2 } }, { query: { wall_id: 3 } }, { path: { userId: 2 } }, { body: { user_id: 2 } }]) {
    assert.throws(() => client.callOperation('getAccountStatistics', params), { code: 'CLIENT_VALIDATION' });
  }
  assert.equal(requests.length, 0);
});

test('changing account credentials requests fresh self-only statistics', async () => {
  let token = 'first-session';
  const tokens = [];
  const client = createMobileClient({
    getToken: () => token,
    fetch: async (url, options) => {
      tokens.push(options.headers.Authorization);
      return envelope(token === 'first-session' ? statistics : { registered_at: null, counts: Object.fromEntries(countKeys.map(key => [key, 0])) });
    },
  });
  assert.deepEqual((await client.getAccountStatistics()).data, statistics);
  token = 'second-session';
  assert.equal((await client.getAccountStatistics()).data.counts.named_posts, 0);
  assert.deepEqual(tokens, ['Bearer first-session', 'Bearer second-session']);
});

test('account statistics exposes v1 authentication, validation and missing-path errors', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [400, 'INVALID_REQUEST'], [404, 'NOT_FOUND']]) {
    const client = createMobileClient({ fetch: async () => new Response(JSON.stringify({ data: null, error: { code, message: 'statistics unavailable' }, meta: { apiVersion: '1', requestId: 'statistics-error' } }), { status, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(client.getAccountStatistics(), error => error.status === status && error.code === code && error.requestId === 'statistics-error');
  }
});

test('account OpenAPI, generated operations, TypeScript fields and documented operation counts agree', async () => {
  const [specText, declarations, mobileDocs] = await Promise.all([
    readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
    readFile(new URL('../mobile-client.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/MOBILE-API.md', import.meta.url), 'utf8'),
  ]);
  const spec = JSON.parse(specText);
  const operation = spec.paths['/auth/statistics'].get;
  assert.equal(operation.operationId, 'getAccountStatistics');
  assert.deepEqual(operation.security ?? spec.security, [{ bearerAuth: [] }]);
  assert.deepEqual(operation.parameters ?? [], []);
  assert.equal(operation.requestBody, undefined);
  assert.equal(operation.responses['200'].content['application/json'].schema.properties.data.$ref, '#/components/schemas/AccountStatistics');
  assert.deepEqual(operation.responses['200'].headers['Cache-Control'].schema.enum, ['no-store']);
  for (const status of ['400', '401', '403', '404']) assert.ok(operation.responses[status]);
  const schema = spec.components.schemas.AccountStatistics;
  assert.deepEqual(schema.required, ['registered_at', 'counts']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.registered_at.type, 'string');
  assert.equal(schema.properties.registered_at.nullable, true);
  assert.equal(schema.properties.registered_at.format, undefined);
  assert.deepEqual(Object.keys(schema.properties.counts.properties), countKeys);
  assert.deepEqual(schema.properties.counts.required, countKeys);
  assert.equal(schema.properties.counts.additionalProperties, false);
  for (const key of countKeys) {
    assert.equal(schema.properties.counts.properties[key].type, 'integer', key);
    assert.equal(schema.properties.counts.properties[key].minimum, 0, key);
    assert.ok(mobileDocs.includes('| ' + key + ' |'), key);
  }
  const typedCounts = /export interface AccountStatisticsCounts \{([\s\S]*?)\n\}/.exec(declarations)?.[1];
  assert.ok(typedCounts);
  assert.deepEqual([...typedCounts.matchAll(/\b([a-z_]+)\s*:\s*number/g)].map(match => match[1]), countKeys);
  assert.match(declarations, /registered_at: string \| null;/);
  assert.match(declarations, /getAccountStatistics\(options\?: RequestOptions\): Promise<ApiResponse<AccountStatistics>>/);
  const operations = Object.values(spec.paths).flatMap(item => Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)).map(([, operation]) => operation));
  const publicOperations = operations.filter(operation => !operation['x-internal'] && operation.operationId !== 'dashboardCreateSession');
  assert.equal(new Set(operations.map(operation => operation.operationId)).size, operations.length);
  assert.deepEqual(publicOperations.map(operation => operation.operationId).sort(), Object.keys(V1_OPERATIONS).sort());
  assert.ok(mobileDocs.includes('**' + operations.length + ' 个显式方法/路径组合、' + Object.keys(spec.paths).length + ' 个路径模板**'));
  assert.ok(mobileDocs.includes('公共 SDK 操作目录覆盖 **' + publicOperations.length + ' 个**'));
});
