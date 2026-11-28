import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMobileClient } from '../mobile-client.mjs';
import { V1_OPERATIONS } from '../v1-operations.mjs';

const countKeys = ['members', 'wall_applications', 'ban_logs', 'posts', 'comments', 'likes', 'bookmarks', 'messages', 'announcements', 'votes', 'vote_options', 'vote_records', 'reports', 'post_reports', 'user_reports', 'user_permissions', 'attachments', 'deletable_attachments', 'retained_attachments'];
const counts = { ...Object.fromEntries(countKeys.map(key => [key, 0])), members: 3, posts: 2, attachments: 3, deletable_attachments: 0, retained_attachments: 3 };
const preview = {
  wall: { id: 8, name: '  示例校园墙 Ω  ', description: 'Deletion preview fixture', status: 'disabled', owner_id: null, created_at: '2026-11-28 08:09:10' },
  counts,
  warnings: ['All candidate attachments are retained; independent storage cleanup requires fresh reference checks.'],
  can_delete: true,
};
const confirmation = { confirm_name: preview.wall.name, password: 'operator-current-password ' };
const deleted = { message: 'Wall permanently deleted', deleted_wall_id: 8, counts, warnings: ['Database deletion committed; all candidate attachments remain on disk and independent storage cleanup requires fresh reference checks.'] };
const envelope = data => new Response(JSON.stringify({ data, error: null, meta: { apiVersion: '1', requestId: 'wall-deletion-sdk-test' } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function recordingClient(data = preview) {
  const requests = [];
  let wallReads = 0;
  const client = createMobileClient({
    getToken: () => 'deletion-session',
    getWallId: () => { wallReads++; throw new Error('Wall deletion must not read the selected wall'); },
    fetch: async (url, options) => { requests.push({ url, options }); return envelope(data); },
  });
  return { client, requests, wallReads: () => wallReads };
}

test('wall deletion operations use Bearer and path id without current-wall context', async () => {
  const { client, requests, wallReads } = recordingClient();
  await client.operations.adminGetWallDeletionPreview({ path: { id: 8 } });
  await client.callOperation('adminGetWallDeletionPreview', { path: { id: '8' }, wallId: 999 }, { wallId: 777, auth: false });
  await client.operations.adminDeleteWall({ path: { id: 8 }, body: confirmation, wallId: 999 }, { wallId: 777, auth: false });
  await client.callOperation('adminDeleteWall', { path: { id: '8' }, body: confirmation });
  assert.deepEqual(requests.map(request => request.url), ['/api/v1/walls/admin/8/deletion-preview', '/api/v1/walls/admin/8/deletion-preview', '/api/v1/walls/admin/8', '/api/v1/walls/admin/8']);
  assert.deepEqual(requests.map(request => request.options.method), ['GET', 'GET', 'DELETE', 'DELETE']);
  assert.equal(wallReads(), 0);
  for (const { options } of requests) {
    assert.equal(options.headers.Authorization, 'Bearer deletion-session');
    assert.equal(Object.hasOwn(options.headers, 'X-Wall-Id'), false);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
  }
  for (const request of requests.slice(0, 2)) assert.equal(request.options.body, undefined);
  for (const request of requests.slice(2)) {
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), confirmation);
    assert.equal(JSON.parse(request.options.body).confirm_name, '  示例校园墙 Ω  ');
    assert.equal(JSON.parse(request.options.body).password, 'operator-current-password ');
  }
});

test('preview and committed deletion preserve all counts, null ownership and warnings', async () => {
  const previewResult = await recordingClient().client.operations.adminGetWallDeletionPreview({ path: { id: 8 } });
  const deleteResult = await recordingClient(deleted).client.callOperation('adminDeleteWall', { path: { id: 8 }, body: confirmation });
  assert.deepEqual(previewResult.data, preview);
  assert.equal(previewResult.data.wall.owner_id, null);
  assert.equal(previewResult.data.wall.created_at, '2026-11-28 08:09:10');
  assert.deepEqual(Object.keys(previewResult.data.counts), countKeys);
  assert.equal(previewResult.data.counts.comments, 0);
  assert.equal(previewResult.data.can_delete, true);
  assert.deepEqual(deleteResult.data, deleted);
  assert.equal(deleteResult.data.deleted_wall_id, 8);
  assert.deepEqual(deleteResult.data.warnings, deleted.warnings);
  for (const result of [previewResult, deleteResult]) {
    assert.equal(result.data.counts.deletable_attachments, 0);
    assert.equal(result.data.counts.retained_attachments, result.data.counts.attachments);
  }
  assert.equal(deleteResult.headers.get('cache-control'), 'no-store');
});

test('wall deletion registry records strict path ids and a required DELETE JSON body', () => {
  const parameter = { name: 'id', in: 'path', required: true, type: 'integer' };
  assert.deepEqual(V1_OPERATIONS.adminGetWallDeletionPreview, { method: 'GET', path: '/walls/admin/{id}/deletion-preview', auth: true, response: 'json', params: [parameter], body: null, bodyRequired: false });
  assert.deepEqual(V1_OPERATIONS.adminDeleteWall, { method: 'DELETE', path: '/walls/admin/{id}', auth: true, response: 'json', params: [parameter], body: 'application/json', bodyRequired: true });
});

test('deletion operations reject invalid paths, undeclared queries and absent or nonobject bodies before fetch', () => {
  const { client, requests } = recordingClient();
  for (const operationId of ['adminGetWallDeletionPreview', 'adminDeleteWall']) {
    const body = operationId === 'adminDeleteWall' ? { body: confirmation } : {};
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '01', '1x', '1e2', '8/other', {}, null]) {
      assert.throws(() => client.callOperation(operationId, { path: { id }, ...body }), { code: 'CLIENT_VALIDATION' });
    }
    for (const params of [{ ...body }, { path: {}, ...body }, { path: { id: 8, other_id: 9 }, ...body }, { path: { id: 8 }, query: { wall_id: 8 }, ...body }, { path: { id: 8 }, query: { confirm_name: preview.wall.name }, ...body }]) {
      assert.throws(() => client.callOperation(operationId, params), { code: 'CLIENT_VALIDATION' });
    }
  }
  for (const params of [{ path: { id: 8 } }, { path: { id: 8 }, body: undefined }, { path: { id: 8 }, body: null }, { path: { id: 8 }, body: [] }, { path: { id: 8 }, body: 'confirmation' }]) {
    assert.throws(() => client.operations.adminDeleteWall(params), { code: 'CLIENT_VALIDATION' });
  }
  assert.throws(() => client.operations.adminGetWallDeletionPreview({ path: { id: 8 }, body: {} }), { code: 'CLIENT_VALIDATION' });
  assert.equal(requests.length, 0);
});

test('wall deletion business and transport errors preserve server status and codes without retries', async () => {
  for (const [status, code] of [[400, 'INVALID_WALL_ID'], [400, 'INVALID_CONFIRMATION'], [401, 'UNAUTHENTICATED'], [403, 'PASSWORD_INVALID'], [403, 'PERMISSION_DENIED'], [404, 'WALL_NOT_FOUND'], [409, 'WALL_REFERENCE_CONFLICT'], [429, 'RATE_LIMITED'], [500, 'INTERNAL_ERROR']]) {
    let calls = 0;
    const client = createMobileClient({ fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ data: null, error: { code, message: 'Wall deletion unavailable' }, meta: { apiVersion: '1', requestId: 'wall-deletion-error' } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } });
    await assert.rejects(client.operations.adminDeleteWall({ path: { id: 8 }, body: confirmation }), error => error.status === status && error.code === code && error.requestId === 'wall-deletion-error');
    assert.equal(calls, 1, code);
  }
});

test('destructive deletion does not retry network failures, timeouts or canceled requests', async () => {
  let networkCalls = 0;
  const disconnected = createMobileClient({ fetch: async () => { networkCalls++; throw new Error('Connection lost after possible commit'); } });
  await assert.rejects(disconnected.callOperation('adminDeleteWall', { path: { id: 8 }, body: confirmation }), { code: 'NETWORK_ERROR', status: 0 });
  assert.equal(networkCalls, 1);
  let timeoutCalls = 0;
  const slow = createMobileClient({ timeoutMs: 10, fetch: () => { timeoutCalls++; return new Promise(() => {}); } });
  await assert.rejects(slow.operations.adminDeleteWall({ path: { id: 8 }, body: confirmation }), { code: 'TIMEOUT', status: 0 });
  assert.equal(timeoutCalls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slow.callOperation('adminDeleteWall', { path: { id: 8 }, body: confirmation }, { signal: controller.signal }), { code: 'ABORTED', status: 0 });
  assert.equal(timeoutCalls, 1);
});

test('OpenAPI specifies scoped deletion, confirmation, error codes and no-store on every response', async () => {
  const [source, declarations, mobileDocs] = await Promise.all([
    readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
    readFile(new URL('../v1-operations.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/MOBILE-API.md', import.meta.url), 'utf8'),
  ]);
  const spec = JSON.parse(source);
  const previewOperation = spec.paths['/walls/admin/{id}/deletion-preview'].get;
  const deleteOperation = spec.paths['/walls/admin/{id}'].delete;
  assert.equal(spec.servers[0].url, '/api/v1');
  for (const [operation, operationId] of [[previewOperation, 'adminGetWallDeletionPreview'], [deleteOperation, 'adminDeleteWall']]) {
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.deepEqual(operation['x-required-permissions'], ['global.wall.manage']);
    assert.equal(operation.parameters.length, 1);
    assert.equal(operation.parameters[0].name, 'id');
    assert.equal(operation.parameters[0].in, 'path');
    assert.equal(operation.parameters[0].required, true);
    assert.equal(operation.parameters[0].schema.type, 'integer');
    assert.equal(operation.parameters[0].schema.minimum, 1);
    assert.equal(operation.parameters[0].schema.maximum, Number.MAX_SAFE_INTEGER);
    for (const status of ['200', '400', '401', '403', '404', '429', '500']) assert.ok(operation.responses[status]);
    for (const response of Object.values(operation.responses)) assert.deepEqual(response.headers['Cache-Control'].schema.enum, ['no-store']);
    for (const [status, code] of [['400', 'INVALID_WALL_ID'], ['403', 'PERMISSION_DENIED'], ['404', 'WALL_NOT_FOUND']]) assert.ok(operation.responses[status].description.includes(code));
    assert.ok(declarations.includes('"' + operationId + '"'));
    assert.ok(mobileDocs.includes(operationId));
    assert.ok(operation.description.includes('/api/walls/admin/{id}'));
    assert.ok(operation.description.includes('not current-wall selection or membership'));
  }
  assert.equal(previewOperation.requestBody, undefined);
  assert.equal(deleteOperation.requestBody.required, true);
  assert.equal(deleteOperation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/AdminWallDeletionRequest');
  assert.ok(deleteOperation.responses['400'].description.includes('INVALID_CONFIRMATION'));
  assert.ok(deleteOperation.responses['403'].description.includes('PASSWORD_INVALID'));
  assert.ok(deleteOperation.responses['409'].description.includes('WALL_REFERENCE_CONFLICT'));
  for (const phrase of ['vote_records', 'option_id', 'vote_options', 'fully rolls back', 'preserving all data', 'no attachment cleanup']) assert.ok(deleteOperation.responses['409'].description.includes(phrase), phrase);
  assert.ok(mobileDocs.includes('| 409 | WALL_REFERENCE_CONFLICT |'));
  for (const phrase of ['deletable_attachments 恒为0', 'retained_attachments=attachments', '不执行物理 unlink', '独立存储清理']) assert.ok(mobileDocs.includes(phrase), phrase);
  for (const phrase of ['one database transaction', 'fully rolls back', 'account preferences', 'global data', 'other walls', 'last wall', 'does not reset setup', 'database records only', 'no physical files are unlinked', 'deletable_attachments=0', 'retained_attachments=attachments', 'fresh reference checks', 'warnings', 'Do not automatically retry']) assert.ok(deleteOperation.description.includes(phrase), phrase);
  for (const phrase of ['GET /api/v1/walls/admin/{id}/deletion-preview', 'DELETE /api/v1/walls/admin/{id}', 'global.wall.manage', 'INVALID_WALL_ID', 'INVALID_CONFIRMATION', 'PASSWORD_INVALID', 'PERMISSION_DENIED', 'WALL_NOT_FOUND', '单一事务', '全回滚', '不得自动重试']) assert.ok(mobileDocs.includes(phrase), phrase);
});

test('deletion schemas require exactly nineteen nonnegative counts and precise response shapes', async () => {
  const spec = JSON.parse(await readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
  const schemas = spec.components.schemas;
  assert.equal(countKeys.length, 19);
  assert.deepEqual(Object.keys(schemas.AdminWallDeletionCounts.properties), countKeys);
  assert.deepEqual(schemas.AdminWallDeletionCounts.required, countKeys);
  assert.equal(schemas.AdminWallDeletionCounts.additionalProperties, false);
  assert.deepEqual(schemas.AdminWallDeletionCounts.properties.deletable_attachments.enum, [0]);
  assert.equal(schemas.AdminWallDeletionCounts.properties.deletable_attachments.maximum, 0);
  assert.ok(schemas.AdminWallDeletionCounts.properties.retained_attachments.description.includes('retained_attachments=attachments'));
  for (const key of countKeys) {
    const count = schemas.AdminWallDeletionCounts.properties[key];
    assert.equal(count.type, 'integer', key);
    assert.equal(count.minimum, 0, key);
    assert.notEqual(count.nullable, true, key);
  }
  for (const [name, keys] of [['AdminWallDeletionWall', ['id', 'name', 'description', 'status', 'owner_id', 'created_at']], ['AdminWallDeletionPreview', ['wall', 'counts', 'warnings', 'can_delete']], ['AdminWallDeletionResult', ['message', 'deleted_wall_id', 'counts', 'warnings']]]) {
    assert.deepEqual(Object.keys(schemas[name].properties), keys);
    assert.deepEqual(schemas[name].required, keys);
    assert.equal(schemas[name].additionalProperties, false);
  }
  assert.equal(schemas.AdminWallDeletionWall.properties.owner_id.nullable, true);
  assert.equal(schemas.AdminWallDeletionWall.properties.created_at.format, undefined);
  assert.deepEqual(schemas.AdminWallDeletionPreview.properties.can_delete.enum, [true]);
  assert.deepEqual(schemas.AdminWallDeletionRequest.required, ['confirm_name', 'password']);
  for (const key of ['confirm_name', 'password']) {
    assert.equal(schemas.AdminWallDeletionRequest.properties[key].type, 'string');
    assert.equal(schemas.AdminWallDeletionRequest.properties[key].minLength, 1);
  }
  assert.equal(schemas.AdminWallDeletionRequest.properties.password.writeOnly, true);
  for (const name of ['AdminWallDeletionPreview', 'AdminWallDeletionResult']) {
    assert.equal(schemas[name].properties.counts.$ref, '#/components/schemas/AdminWallDeletionCounts');
    assert.equal(schemas[name].properties.warnings.type, 'array');
    assert.equal(schemas[name].properties.warnings.items.type, 'string');
  }
  for (const [path, method, name] of [['/walls/admin/{id}/deletion-preview', 'get', 'AdminWallDeletionPreview'], ['/walls/admin/{id}', 'delete', 'AdminWallDeletionResult']]) {
    const response = spec.paths[path][method].responses['200'].content['application/json'].schema;
    assert.deepEqual(response.required, ['data', 'error', 'meta']);
    assert.equal(response.properties.data.$ref, '#/components/schemas/' + name);
    assert.deepEqual(response.properties.error.enum, [null]);
  }
});
