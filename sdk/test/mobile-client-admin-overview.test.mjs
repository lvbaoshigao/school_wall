import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMobileClient } from '../mobile-client.mjs';
import { V1_OPERATIONS } from '../v1-operations.mjs';

const pendingKeys = ['members', 'wall_applications', 'post_reports', 'safety_reports', 'user_reports', 'bug_reports'];
const activity = { users: null, posts: 0, comments: 0, votes: 0, members: 0 };
const restricted = {
  schema_version: 1,
  generated_at: '2026-11-28T09:00:00.000Z',
  scope: { kind: 'wall', wall_id: 8, available_wall_count: 1, global_stats: false },
  range: { days: 7, start_date: '2026-11-22', end_date: '2026-11-28', timezone: 'Asia/Shanghai', utc_offset_minutes: 480, date_basis: 'server-local', includes_today: true, timestamp_storage: 'local-naive' },
  totals: { users: null, active_users: null, banned_users: null, walls: 1, active_walls: 1, members: 2, posts: 0, anonymous_posts: 0, comments: 0, votes: 0, likes: 0, announcements: 0, pending: 0 },
  today: activity,
  daily: Array.from({ length: 7 }, (_, index) => ({ date: '2026-11-' + (22 + index), ...activity })),
  walls: [{ id: 8, name: 'Statistics-only wall', status: 'active', members: 2, pending_members: null, posts: 0, comments: 0, votes: 0, posts_in_range: 0, pending_post_reports: null, pending_safety_reports: null }],
  walls_meta: { limit: 100, total: 1, truncated: false },
  pending: { ...Object.fromEntries(pendingKeys.map(key => [key, null])), total: 0 },
  todos: [],
  todos_meta: { limit: 30, total: 0, truncated: false },
  system: null,
};
const envelope = data => new Response(JSON.stringify({ data, error: null, meta: { apiVersion: '1', requestId: 'overview-sdk-test' } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function recordingClient(data = restricted) {
  const requests = [];
  let wallReads = 0;
  const client = createMobileClient({
    getToken: () => 'overview-session',
    getWallId: () => { wallReads++; throw new Error('Overview scope must be selected explicitly by query'); },
    fetch: async (url, options) => { requests.push({ url, options }); return envelope(data); },
  });
  return { client, requests, wallReads: () => wallReads };
}

test('overview registry and generated helpers select scope by query without reading current wall', async () => {
  const { client, requests, wallReads } = recordingClient();
  await client.operations.adminGetOverview();
  await client.callOperation('adminGetOverview', { query: { days: 30 } });
  await client.adminGetOverview({ query: { days: 90, wall_id: 8 }, wallId: 999 }, { wallId: 777 });
  assert.deepEqual(requests.map(request => request.url), [
    '/api/v1/admin/overview',
    '/api/v1/admin/overview?days=30',
    '/api/v1/admin/overview?days=90&wall_id=8',
  ]);
  assert.equal(wallReads(), 0);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer overview-session');
    assert.equal(Object.hasOwn(options.headers, 'X-Wall-Id'), false);
    assert.equal(options.body, undefined);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
  }
  assert.deepEqual(V1_OPERATIONS.adminGetOverview, {
    method: 'GET', path: '/admin/overview', auth: true, response: 'json',
    params: [
      { name: 'days', in: 'query', required: false, type: 'integer', enum: [7, 30, 90] },
      { name: 'wall_id', in: 'query', required: false, type: 'integer' },
    ],
    body: null, bodyRequired: false,
  });
});

test('overview SDK preserves restricted null counts, local date metadata and zero activity', async () => {
  const { client } = recordingClient();
  const result = await client.operations.adminGetOverview({ query: { wall_id: 8 } });
  assert.deepEqual(result.data, restricted);
  assert.equal(result.data.totals.users, null);
  assert.equal(result.data.totals.posts, 0);
  assert.equal(result.data.daily[0].users, null);
  assert.equal(result.data.walls[0].pending_members, null);
  assert.equal(result.data.pending.members, null);
  assert.equal(result.data.system, null);
  assert.equal(result.data.range.start_date, '2026-11-22');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('overview SDK preserves full aggregates independently from truncated display lists', async () => {
  const complete = { ...restricted, totals: { ...restricted.totals, walls: 120, posts: 240 }, walls_meta: { limit: 100, total: 120, truncated: true }, pending: { ...restricted.pending, members: 200, total: 200 }, todos: [{ key: 'members', title: 'Pending members', count: 5, wall_id: 8, permission: 'wall.member.approve' }], todos_meta: { limit: 30, total: 40, truncated: true } };
  const { client } = recordingClient(complete);
  const result = await client.operations.adminGetOverview();
  assert.deepEqual(result.data, complete);
  assert.equal(result.data.totals.walls, 120);
  assert.equal(result.data.walls_meta.truncated, true);
  assert.equal(result.data.todos_meta.total, 40);
  assert.equal(result.data.pending.total, 200);
});

test('overview operation rejects undeclared input and noninteger days before fetching', () => {
  const { client, requests } = recordingClient();
  for (const params of [{ query: { user_id: 2 } }, { query: { days: [] } }, { query: { days: 7.5 } }, { path: { wall_id: 8 } }, { body: {} }]) {
    assert.throws(() => client.callOperation('adminGetOverview', params), { code: 'CLIENT_VALIDATION' });
  }
  assert.equal(requests.length, 0);
});

test('overview validation, authorization and scope-limit errors retain server codes', async () => {
  for (const [status, code] of [[400, 'INVALID_OVERVIEW_DAYS'], [400, 'OVERVIEW_SCOPE_TOO_LARGE'], [401, 'UNAUTHENTICATED'], [403, 'OVERVIEW_FORBIDDEN'], [404, 'OVERVIEW_WALL_UNAVAILABLE'], [500, 'INTERNAL_ERROR']]) {
    const client = createMobileClient({ fetch: async () => new Response(JSON.stringify({ data: null, error: { code, message: 'Overview unavailable' }, meta: { apiVersion: '1', requestId: 'overview-error' } }), { status, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(client.operations.adminGetOverview(), error => error.status === status && error.code === code && error.requestId === 'overview-error');
  }
});

test('overview OpenAPI expresses authenticated scope, nullable counts, date basis and bounded lists', async () => {
  const [source, declarations, mobileDocs] = await Promise.all([
    readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
    readFile(new URL('../v1-operations.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/MOBILE-API.md', import.meta.url), 'utf8'),
  ]);
  const spec = JSON.parse(source);
  const operation = spec.paths['/admin/overview'].get;
  const schemas = spec.components.schemas;
  assert.equal(operation.operationId, 'adminGetOverview');
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  assert.deepEqual(operation.parameters.map(parameter => [parameter.in, parameter.name]), [['query', 'days'], ['query', 'wall_id']]);
  assert.deepEqual(operation.parameters[0].schema.enum, [7, 30, 90]);
  assert.equal(operation.parameters[0].schema.default, 7);
  assert.equal(operation.parameters[1].schema.minimum, 1);
  assert.equal(operation.parameters[1].schema.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(operation.requestBody, undefined);
  assert.equal(operation.responses['200'].content['application/json'].schema.properties.data.$ref, '#/components/schemas/AdminOverview');
  assert.deepEqual(operation.responses['200'].headers['Cache-Control'].schema.enum, ['no-store']);
  for (const status of ['400', '401', '403', '404', '405', '429', '500']) assert.ok(operation.responses[status]);
  assert.deepEqual(operation['x-permission-rules'].global.anyOf, ['global.moderate', 'global.dashboard']);
  assert.deepEqual(operation['x-permission-rules'].wall.allOf, ['wall.stats.view']);
  assert.deepEqual(operation['x-permission-rules'].system.allOf, ['global.dashboard']);
  assert.deepEqual(schemas.AdminOverview.required, Object.keys(restricted));
  assert.equal(schemas.AdminOverview.additionalProperties, false);
  assert.deepEqual(schemas.AdminOverview.properties.schema_version.enum, [1]);
  assert.equal(schemas.AdminOverview.properties.generated_at.format, 'date-time');
  assert.equal(schemas.AdminOverviewNullableCount.type, 'integer');
  assert.equal(schemas.AdminOverviewNullableCount.nullable, true);
  assert.equal(schemas.AdminOverviewNullableCount.minimum, 0);
  for (const key of ['users', 'active_users', 'banned_users']) assert.equal(schemas.AdminOverviewTotals.properties[key].$ref, '#/components/schemas/AdminOverviewNullableCount');
  for (const key of pendingKeys) assert.equal(schemas.AdminOverviewPending.properties[key].allOf[0].$ref, '#/components/schemas/AdminOverviewNullableCount');
  assert.equal(schemas.AdminOverviewSystem.nullable, true);
  assert.deepEqual(schemas.AdminOverviewRange.properties.date_basis.enum, ['server-local']);
  assert.deepEqual(schemas.AdminOverviewRange.properties.timestamp_storage.enum, ['local-naive']);
  assert.equal(schemas.AdminOverview.properties.walls.maxItems, 100);
  assert.equal(schemas.AdminOverview.properties.todos.maxItems, 30);
  assert.deepEqual(schemas.AdminOverviewWallsMeta.properties.limit.enum, [100]);
  assert.deepEqual(schemas.AdminOverviewTodosMeta.properties.limit.enum, [30]);
  assert.equal(schemas.AdminOverviewTodo.properties.count.minimum, 1);
  assert.equal(schemas.AdminOverviewWall.properties.name.maxLength, 200);
  assert.deepEqual(schemas.AdminOverviewSystem.properties.visits.properties.identity_limit.enum, [50000]);
  assert.match(operation.description, /500 candidate walls, counted before per-wall permission filtering/);
  assert.match(declarations, /"adminGetOverview"/);
  for (const phrase of ['GET /api/v1/admin/overview', 'adminGetOverview', 'OVERVIEW_SCOPE_TOO_LARGE', '逐墙权限筛选前', 'local-naive']) assert.ok(mobileDocs.includes(phrase), phrase);
});

test('new dashboard read endpoints remain cookie-only, raw and excluded from the public SDK', async () => {
  const [source, declarations, mobileDocs] = await Promise.all([
    readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
    readFile(new URL('../v1-operations.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/MOBILE-API.md', import.meta.url), 'utf8'),
  ]);
  const spec = JSON.parse(source);
  const { client, requests } = recordingClient();
  for (const [path, id] of [['/dashboard/api/overview', 'dashboardGetOverview'], ['/dashboard/api/export', 'dashboardExportCsv']]) {
    const operation = spec.paths[path].get;
    assert.equal(operation.operationId, id);
    assert.equal(operation['x-internal'], true);
    assert.equal(operation['x-cookie-only'], true);
    assert.deepEqual(operation.security, [{ DashboardCookieAuth: [] }]);
    assert.deepEqual(operation.servers, [{ url: '/' }]);
    assert.deepEqual(operation['x-required-permissions'], ['global.dashboard']);
    assert.match(operation.description, /Bearer-only.*401/);
    assert.ok(operation.parameters.some(parameter => parameter.in === 'header' && parameter.name === 'Origin'));
    assert.deepEqual(operation.parameters.find(parameter => parameter.name === 'Sec-Fetch-Site').schema.enum, ['same-origin', 'none']);
    assert.deepEqual(operation.responses['200'].headers['Cache-Control'].schema.enum, ['no-store']);
    assert.equal(Object.hasOwn(V1_OPERATIONS, id), false);
    assert.equal(Object.hasOwn(client.operations, id), false);
    assert.equal(declarations.includes('"' + id + '"'), false);
    assert.throws(() => client.callOperation(id), { code: 'CLIENT_VALIDATION' });
  }
  assert.equal(requests.length, 0);
  assert.equal(spec.paths['/dashboard/api/overview'].get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminOverview');
  const csv = spec.paths['/dashboard/api/export'].get;
  assert.deepEqual(csv.responses['200'].content['text/csv'].schema, { type: 'string', format: 'binary' });
  assert.equal(csv['x-export-row-limit'], 10000);
  assert.ok(csv.responses['413']);
  assert.deepEqual(csv.parameters.find(parameter => parameter.name === 'type').schema.enum, ['users', 'posts', 'announcements']);
  assert.equal(csv.parameters.find(parameter => parameter.name === 'type').required, true);
  for (const [kind, permission] of [['users', 'global.user.manage'], ['posts', 'global.moderate'], ['announcements', 'global.announcement']]) {
    assert.deepEqual(csv['x-permission-rules'][kind].allOf, ['global.dashboard', permission]);
  }
  assert.ok(spec.paths['/dashboard/api/db/status'].get.security.some(requirement => Object.hasOwn(requirement, 'DashboardTicketAuth')));
  assert.ok(spec.components.securitySchemes.DashboardTicketAuth.description.includes('Does not authenticate /dashboard/api/overview or /dashboard/api/export'));
  assert.ok(mobileDocs.includes('12 个 /dashboard/api 内部注册'));
  assert.ok(mobileDocs.includes('13 个看板票据或内部操作明确排除'));
  assert.ok(mobileDocs.includes('Cookie-only 例外'));
});

