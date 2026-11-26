import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMobileClient } from '../mobile-client.mjs';
import { V1_OPERATIONS } from '../v1-operations.mjs';

const ok = data => new Response(JSON.stringify({ data, error: null, meta: { apiVersion: '1', requestId: 'confession-sdk-test' } }), { headers: { 'Content-Type': 'application/json' } });
function recordingClient(data = {}) {
  const requests = [];
  const client = createMobileClient({
    getToken: () => 'test-token', getWallId: () => 7,
    crypto: { randomUUID: () => 'stable-confession-uuid' },
    fetch: async (url, options) => { requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined }); return ok(data); },
  });
  return { client, requests };
}

test('confession collections inherit selected wall and permit explicit all-wall scope', async () => {
  const { client, requests } = recordingClient({ anonymous: 2, named: 3, total: 5 });
  assert.equal((await client.getConfessionStats()).data.total, 5);
  assert.equal(requests[0].url, '/api/v1/messages/confessions/stats');
  assert.equal(requests[0].options.headers['X-Wall-Id'], '7');
  await client.getConfessionStats({ wall_id: 9 });
  assert.equal(requests[1].url, '/api/v1/messages/confessions/stats?wall_id=9');
  assert.equal(Object.hasOwn(requests[1].options.headers, 'X-Wall-Id'), false);
  await client.getReceivedConfessions({ anonymous: '1', page: 2, limit: 10 }, { wallId: null });
  assert.equal(requests[2].url, '/api/v1/messages/confessions/received?anonymous=1&page=2&limit=10');
  assert.equal(Object.hasOwn(requests[2].options.headers, 'X-Wall-Id'), false);
  for (const { options } of requests) {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
  }
});

test('legacy message preparation preserves new confession reply opt-in and explicit wall', async () => {
  const { client, requests } = recordingClient({ id: 11 });
  const prepared = client.prepareMessage({ receiver_id: 2, content: '**hello**', type: 'confession', is_anonymous: true, allow_replies: true, wall_id: 9 });
  const sent = await client.sendMessage(prepared, { wallId: null });
  assert.equal(sent.clientMessageId, prepared.client_message_id);
  assert.equal(requests[0].body.allow_replies, true);
  assert.equal(requests[0].body.wall_id, 9);
  assert.equal(requests[0].body.is_anonymous, true);
});

test('direct and reply helpers preserve prepared idempotency keys without fabricating participants', async () => {
  const { client, requests } = recordingClient({ id: 12, deduplicated: false });
  const direct = client.prepareDirectConfession({ receiver_id: 2, wall_id: 9 });
  assert.equal(Object.isFrozen(direct), true);
  const result = await client.sendDirectConfession(direct);
  await client.sendDirectConfession(direct);
  assert.equal(result.clientMessageId, direct.client_message_id);
  assert.equal(requests[0].url, '/api/v1/messages/confessions/direct');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(Object.hasOwn(requests[0].body, 'content'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'is_anonymous'), false);
  assert.equal(Object.hasOwn(requests[0].options.headers, 'X-Wall-Id'), false);
  const reply = client.prepareConfessionReply({ content: 'reply', wall_id: 9, client_message_id: 'persisted-reply-id' });
  await client.replyToConfession(12, reply);
  assert.equal(requests[2].url, '/api/v1/messages/confessions/12/replies');
  assert.deepEqual(requests[2].body, reply);
  assert.equal(Object.hasOwn(requests[2].body, 'receiver_id'), false);
  assert.throws(() => client.prepareDirectConfession({ receiver_id: 2, content: 'forged' }), { code: 'CLIENT_VALIDATION' });
  assert.throws(() => client.prepareConfessionReply({ content: 'reply', sender_id: 8 }), { code: 'CLIENT_VALIDATION' });
  assert.throws(() => client.prepareConfessionReply({ content: ' ' }), { code: 'CLIENT_VALIDATION' });
});

test('failed confession sends expose the same stable key for a deliberate retry', async () => {
  let calls = 0;
  const client = createMobileClient({ fetch: async () => { calls++; throw new Error('connection lost'); } });
  await assert.rejects(client.sendDirectConfession({ receiver_id: 2, client_message_id: 'direct-retry' }), error => error.code === 'NETWORK_ERROR' && error.clientMessageId === 'direct-retry');
  await assert.rejects(client.replyToConfession(12, { content: 'reply', client_message_id: 'reply-retry' }), error => error.code === 'NETWORK_ERROR' && error.clientMessageId === 'reply-retry');
  assert.equal(calls, 2);
});

test('thread and identity helpers match registered paths and preserve explicit confirmation', async () => {
  const { client, requests } = recordingClient({ request: { id: 3, status: 'pending' } });
  await client.getConfessionThread(12, { before: 20, limit: 10, wall_id: 9 });
  assert.equal(requests[0].url, '/api/v1/messages/confessions/12/thread?before=20&limit=10&wall_id=9');
  await client.requestConfessionIdentity(12, { confirmed: true, message: '**Who?**', wall_id: 9 });
  assert.equal(requests[1].url, '/api/v1/messages/confessions/12/identity-requests');
  assert.equal(requests[1].body.confirmed, true);
  assert.equal(requests[1].body.message, '**Who?**');
  await client.getConfessionIdentityRequests({ wall_id: 9, status: 'pending' });
  assert.equal(requests[2].url, '/api/v1/messages/confessions/identity-requests?wall_id=9&status=pending');
  await client.decideConfessionIdentity(3, { decision: 'reject', wall_id: 9 });
  assert.equal(requests[3].url, '/api/v1/messages/confessions/identity-requests/3');
  assert.equal(requests[3].options.method, 'PUT');
  assert.equal(requests[3].body.decision, 'reject');
  assert.throws(() => client.callOperation('getConfessionStats', { query: { user_id: 8 } }), { code: 'CLIENT_VALIDATION' });
});

test('anonymous confession projections preserve null identities and approved-only disclosure', async () => {
  const projected = { id: 12, sender_id: null, receiver_id: null, type: 'confession', confession_kind: 'reply', confession_root_id: 5, can_reply: false, revealed_sender: null };
  const { client } = recordingClient({ confession: projected, messages: [projected], hasMore: false, next_before_id: null });
  const result = await client.getConfessionThread(5);
  assert.equal(result.data.messages[0].sender_id, null);
  assert.equal(result.data.messages[0].receiver_id, null);
  assert.equal(result.data.messages[0].revealed_sender, null);
});

test('tree helper accepts numeric mark_read and returns the anonymous tree contract', async () => {
  const data = { messages: [], conversation_id: 'th_sdk', hasMore: false, next_before_id: null, next_before: null, unreadMarked: 0, is_closed: false, is_initiator: true, other_user_id: null, can_report: true };
  const { client, requests } = recordingClient(data);
  const result = await client.getTreeMessages('th_sdk', { limit: 10, mark_read: 0 });
  assert.equal(requests[0].url, '/api/v1/messages/tree-hole/th_sdk?limit=10&mark_read=0');
  assert.deepEqual(result.data, data);
});

test('OpenAPI confession operations, local references and generated registry stay synchronized', async () => {
  const spec = JSON.parse(await readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
  const entries = [];
  for (const [path, item] of Object.entries(spec.paths)) for (const method of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
    const operation = item[method];
    if (!operation || operation['x-internal'] || path === '/dashboard/session') continue;
    entries.push([operation.operationId, method.toUpperCase(), path]);
  }
  assert.equal(new Set(entries.map(([operationId]) => operationId)).size, entries.length);
  assert.deepEqual(entries.map(([operationId]) => operationId).sort(), Object.keys(V1_OPERATIONS).sort());
  for (const [operationId, method, path] of entries) {
    assert.equal(V1_OPERATIONS[operationId].method, method);
    assert.equal(V1_OPERATIONS[operationId].path, path);
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref?.startsWith('#/')) assert.notEqual(value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec), undefined, value.$ref);
    Object.values(value).forEach(visit);
  };
  visit(spec);
  assert.equal(Object.values(spec.paths).flatMap(item => Object.values(item)).filter(operation => operation?.operationId && /Confession/.test(operation.operationId)).length, 8);
  assert.equal(spec.components.schemas.SendMessage.properties.allow_replies.default, false);
  assert.equal(spec.components.schemas.Message.properties.receiver_id.nullable, true);
  assert.equal(spec.components.schemas.DirectConfessionInput.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.ConfessionIdentityRequestInput.properties.confirmed.enum, [true]);
});

test('preference fields and defaults match the current server and TypeScript contract', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { getPrefsSchema } = require('../../server/lib/prefs.js');
  const live = getPrefsSchema();
  const spec = JSON.parse(await readFile(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
  const documented = spec.components.schemas.Preferences;
  assert.deepEqual(Object.keys(documented.properties).sort(), Object.keys(live.schema).sort());
  assert.deepEqual([...documented.required].sort(), Object.keys(live.schema).sort());
  assert.deepEqual([...spec.components.schemas.PreferencesResult.properties.storedKeys.items.enum].sort(), Object.keys(live.schema).sort());
  assert.deepEqual(Object.keys(spec.components.schemas.PreferencesUpdate.properties.prefs.properties).sort(), Object.keys(live.schema).sort());
  for (const [key, definition] of Object.entries(live.schema)) {
    assert.equal(documented.properties[key].default, definition.default, key);
    assert.equal(documented.properties[key].type, definition.type === 'bool' ? 'boolean' : 'string', key);
    if (definition.values) assert.deepEqual(documented.properties[key].enum, definition.values, key);
  }
  const declarations = await readFile(new URL('../mobile-client.d.ts', import.meta.url), 'utf8');
  const preferences = /export interface Preferences \{([\s\S]*?)\n\}/.exec(declarations)?.[1];
  assert.ok(preferences);
  assert.deepEqual([...preferences.matchAll(/\b([a-z_]+)\s*:/g)].map(match => match[1]).sort(), Object.keys(live.schema).sort());
});

