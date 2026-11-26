import { V1_OPERATIONS } from './v1-operations.mjs';

/** Portable v1 client. No persistence, dependency, login refresh or automatic retries. */
export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'CLIENT_ERROR';
    this.details = options.details ?? null;
    this.requestId = options.requestId ?? null;
    this.apiVersion = options.apiVersion ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.clientMessageId = options.clientMessageId ?? null;
  }
}

function invalid(message) { return new ApiError(message, { code: 'CLIENT_VALIDATION' }); }
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
const HEADER_TOKEN = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
const COMMON_HEADER_NAMES = new Map([
  ['accept', 'Accept'], ['content-type', 'Content-Type'], ['range', 'Range'],
  ['if-none-match', 'If-None-Match'], ['if-modified-since', 'If-Modified-Since'],
]);
function normalizeHeaders(value, allowedNames) {
  if (value === undefined) return {};
  if (!plainObject(value)) throw invalid('headers must be a plain object');
  const allowed = allowedNames === undefined ? null : new Map(allowedNames.map(name => [name.toLowerCase(), name]));
  const normalized = Object.create(null);
  const seen = new Set();
  for (const [name, headerValue] of Object.entries(value)) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'authorization' || lowerName === 'x-wall-id') {
      throw invalid('Authorization and X-Wall-Id are managed by the SDK');
    }
    if (!HEADER_TOKEN.test(name)) throw invalid('Invalid request header name: ' + name);
    if (seen.has(lowerName)) throw invalid('Duplicate request header: ' + name);
    const canonicalName = allowed ? allowed.get(lowerName) : (COMMON_HEADER_NAMES.get(lowerName) ?? name);
    if (!canonicalName) throw invalid('Undeclared operation header: ' + name);
    if (typeof headerValue !== 'string' || /[\u0000-\u001f\u007f]/.test(headerValue)) {
      throw invalid('Request header values must be strings without control characters');
    }
    if ((lowerName === 'if-none-match' || lowerName === 'if-modified-since') && !headerValue.trim()) {
      throw invalid('Conditional request headers must not be empty');
    }
    seen.add(lowerName);
    normalized[canonicalName] = headerValue;
  }
  return Object.fromEntries(Object.entries(normalized));
}
function prepareConfessionPayload(input, cryptoSource, direct) {
  const allowed = direct ? ['receiver_id', 'wall_id', 'client_message_id'] : ['content', 'wall_id', 'client_message_id'];
  if (!plainObject(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Unknown confession input field');
  if (direct) id(input.receiver_id);
  else if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 2000) throw invalid('Reply content must contain 1–2000 characters');
  if (input.wall_id !== undefined) id(input.wall_id);
  const clientId = input.client_message_id ?? createClientMessageId(cryptoSource);
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw invalid('Invalid client_message_id');
  return Object.freeze({ ...input, client_message_id: clientId });
}
function id(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value))
    || !Number.isSafeInteger(Number(value))) throw invalid('An ID must be a positive safe integer');
  return String(value);
}
function duration(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw invalid('timeoutMs must be an integer from 0 to 2147483647');
  return value;
}
function base(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\\?#\u0000-\u001f\u007f]/.test(value)) throw invalid('Invalid API baseURL');
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { throw invalid('Invalid HTTP(S) API baseURL'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw invalid('baseURL cannot contain credentials, query or fragment');
    return parsed.href.replace(/\/+$/, '');
  }
  if (!value.startsWith('/') || value.startsWith('//') || /[\r\n]/.test(value)) throw invalid('baseURL must be HTTP(S) or an origin-relative path');
  return value.replace(/\/+$/, '');
}
function route(value) {
  if (typeof value !== 'string' || (value !== '' && !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(value))
    || value.split('/').some(part => part === '.' || part === '..')) throw invalid('Use an API-relative path without query, fragment or traversal');
  return value;
}
function queryString(query) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw invalid('Query values must be finite scalars');
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? '?' + encoded : '';
}
function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('Aborted')); };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then(result => {
      signal.removeEventListener('abort', aborted); resolve(result);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

/** A stable idempotency key; never falls back to insecure Math.random(). */
export function createClientMessageId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return 'swm-' + cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    return 'swm-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new ApiError('Secure randomness is unavailable; provide a cryptographically generated client_message_id', { code: 'CRYPTO_UNAVAILABLE' });
}

export class SchoolWallClient {
  constructor(options = {}) {
    this.operations = Object.freeze(Object.fromEntries(Object.keys(V1_OPERATIONS).map(operationId => [operationId, (params = {}, requestOptions = {}) => this.callOperation(operationId, params, requestOptions)])));
    this.baseURL = base(options.baseURL ?? '/api/v1');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw invalid('A fetch implementation is required');
    this.getToken = options.getToken ?? (() => null);
    this.getWallId = options.getWallId ?? (() => null);
    if (typeof this.getToken !== 'function' || typeof this.getWallId !== 'function') throw invalid('getToken and getWallId must be functions');
    this.timeoutMs = duration(options.timeoutMs ?? 15000);
    this.crypto = options.crypto ?? globalThis.crypto;
  }

  async request(path, options = {}) {
    const url = this.baseURL + route(path) + queryString(options.query);
    const timeoutMs = duration(options.timeoutMs ?? this.timeoutMs);
    if (typeof AbortController !== 'function') throw new ApiError('AbortController is required', { code: 'UNSUPPORTED_RUNTIME' });
    const controller = new AbortController();
    let timedOut = false;
    const external = options.signal;
    const onAbort = () => controller.abort(external.reason);
    if (external?.aborted) onAbort();
    else external?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
    let response;
    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Aborted');
      const auth = options.auth !== false;
      const token = auth ? await abortable(options.token === undefined ? this.getToken() : options.token, controller.signal) : null;
      const wallId = await abortable(options.wallId === undefined ? this.getWallId() : options.wallId, controller.signal);
      const headers = { Accept: 'application/json', ...normalizeHeaders(options.headers) };
      const responseType = options.responseType ?? 'json';
      const conditionalPublicBinary = !auth && responseType === 'binary'
        && (Object.hasOwn(headers, 'If-None-Match') || Object.hasOwn(headers, 'If-Modified-Since'));
      if (token !== undefined && token !== null && token !== '') {
        if (typeof token !== 'string' || /\s/.test(token) || token.length > 8192) throw invalid('The token must be a nonempty bearer token without whitespace');
        headers.Authorization = 'Bearer ' + token;
      }
      if (wallId !== null && wallId !== undefined) headers['X-Wall-Id'] = id(wallId);
      let payload;
      if (options.body !== undefined) {
        try { payload = JSON.stringify(options.body); } catch (cause) { throw new ApiError('The body must be JSON serializable', { code: 'CLIENT_VALIDATION', cause }); }
        if (payload === undefined) throw invalid('The body must be JSON serializable');
        headers['Content-Type'] = 'application/json';
      }
      const fetchImpl = this.fetchImpl;
      response = await abortable(fetchImpl(url, {
        method: options.method ?? 'GET', headers, body: payload, signal: controller.signal,
        credentials: 'omit', redirect: 'error', cache: conditionalPublicBinary ? 'no-cache' : 'no-store',
      }), controller.signal);
      const requestId = response.headers?.get('X-Request-ID') ?? null;
       const apiVersion = response.headers?.get('X-API-Version') ?? null;
       const retryAfter = response.headers?.get('Retry-After') ?? null;
       const conditionalBinaryNotModified = responseType === 'binary' && response.status === 304
         && (Object.hasOwn(headers, 'If-None-Match') || Object.hasOwn(headers, 'If-Modified-Since'));
       if (!response.ok && responseType !== 'json' && !conditionalBinaryNotModified) {
         let errorEnvelope;
         try { errorEnvelope = JSON.parse(await abortable(response.clone().text(), controller.signal)); } catch (cause) {
           if (controller.signal.aborted) throw cause;
         }
         if (errorEnvelope && typeof errorEnvelope === 'object' && !Array.isArray(errorEnvelope)
           && errorEnvelope.meta?.apiVersion === '1' && typeof errorEnvelope.meta?.requestId === 'string'
           && errorEnvelope.error && typeof errorEnvelope.error === 'object') {
           throw new ApiError(typeof errorEnvelope.error.message === 'string' ? errorEnvelope.error.message : 'The API request failed', {
             code: typeof errorEnvelope.error.code === 'string' ? errorEnvelope.error.code : 'HTTP_ERROR',
             status: response.status, details: errorEnvelope.error.details,
             requestId: errorEnvelope.meta.requestId, apiVersion: errorEnvelope.meta.apiVersion, retryAfter,
           });
         }
         throw new ApiError('The API request failed', { code: 'HTTP_ERROR', status: response.status, requestId, apiVersion, retryAfter });
       }
       if (responseType === 'binary') {
         if (!response.ok && !conditionalBinaryNotModified) throw new ApiError('The API request failed', { code: 'HTTP_ERROR', status: response.status, requestId, apiVersion, retryAfter });
         return { data: conditionalBinaryNotModified ? null : await abortable(response.arrayBuffer(), controller.signal), error: null, meta: { apiVersion: apiVersion ?? '1', requestId: requestId ?? '' }, status: response.status, headers: response.headers };
       }
       let parsed;
       try { parsed = JSON.parse(await abortable(response.text(), controller.signal)); }
       catch (cause) {
         if (controller.signal.aborted) throw cause;
         throw new ApiError('The API did not return a JSON v1 response', { code: 'INVALID_RESPONSE', status: response.status, requestId, apiVersion, retryAfter, cause });
       }
       if (responseType === 'raw-json') {
         if (!response.ok) throw new ApiError('The API request failed', { code: 'HTTP_ERROR', status: response.status, requestId, apiVersion, retryAfter });
         return { data: parsed, error: null, meta: { apiVersion: apiVersion ?? '1', requestId: requestId ?? '' }, status: response.status, headers: response.headers };
       }
       const envelope = parsed;
       if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
         || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'error')
         || envelope.meta?.apiVersion !== '1' || typeof envelope.meta?.requestId !== 'string') {
         throw new ApiError('The API returned an invalid v1 envelope', { code: 'INVALID_RESPONSE', status: response.status, requestId, apiVersion, retryAfter });
       }
       if (!response.ok || envelope.error !== null) {
         throw new ApiError(typeof envelope.error?.message === 'string' ? envelope.error.message : 'The API request failed', {
           code: typeof envelope.error?.code === 'string' ? envelope.error.code : 'HTTP_ERROR',
           status: response.status, details: envelope.error?.details,
           requestId: envelope.meta.requestId, apiVersion: envelope.meta.apiVersion, retryAfter,
         });
       }
       return { data: envelope.data, error: null, meta: envelope.meta, status: response.status, headers: response.headers };
     } catch (cause) {
      if (controller.signal.aborted) throw new ApiError(timedOut ? 'The API request timed out' : 'The API request was aborted', { code: timedOut ? 'TIMEOUT' : 'ABORTED', cause });
      if (cause instanceof ApiError) throw cause;
      throw new ApiError('The API request could not be completed', { code: 'NETWORK_ERROR', cause });
    } finally {
      if (timer !== null) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  getCapabilities(options) { return this.request('/capabilities', { ...options, auth: false, wallId: null }); }
  login(credentials, options) { return this.request('/auth/login', { ...options, method: 'POST', body: credentials, auth: false, wallId: null }); }
  getMe(options) { return this.request('/auth/me', options); }
  getAccountStatistics(options) { return this.callOperation('getAccountStatistics', {}, options); }
  updateProfile(profile, options) { return this.request('/auth/profile', { ...options, method: 'PUT', body: profile }); }
  changePassword(passwords, options) { return this.request('/auth/password', { ...options, method: 'PUT', body: passwords }); }
  getPreferences(options) { return this.request('/auth/prefs', options); }
  getPreferencesSchema(options) { return this.request('/auth/prefs/schema', options); }
  updatePreferences(prefs, options) { return this.request('/auth/prefs', { ...options, method: 'PUT', body: { prefs } }); }
  resetPreferences(scope = 'all', options) { return this.request('/auth/prefs/reset', { ...options, method: 'POST', body: { scope } }); }
  getWalls(options) { return this.request('/walls', options); }
  discoverWalls(query, options) { return this.request('/walls/discover', { ...options, query }); }
  getWall(wallId, options) { return this.request('/walls/' + id(wallId), options); }
  joinWall(wallId, options) { return this.request('/walls/' + id(wallId) + '/join', { ...options, method: 'POST' }); }
  leaveWall(wallId, options) { return this.request('/walls/' + id(wallId) + '/leave', { ...options, method: 'POST' }); }
  getPosts(query, options) { return this.request('/posts', { ...options, query }); }
  searchPosts(q, options) { return this.request('/posts/search', { ...options, query: { q } }); }
  getPost(postId, query, options) { return this.request('/posts/' + id(postId), { ...options, query }); }
  createPost(post, options) { return this.request('/posts', { ...options, method: 'POST', body: post }); }
  createComment(postId, content, options) { return this.request('/posts/' + id(postId) + '/comments', { ...options, method: 'POST', body: { content } }); }
  getConversations(query, options) { return this.request('/messages/conversations', { ...options, query }); }
  getMessages(userId, query, options) { return this.request('/messages/conversation/' + id(userId), { ...options, query }); }

  prepareMessage(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A message object is required');
    id(input.receiver_id);
    if (typeof input.content !== 'string') throw invalid('Message content must be a string');
    const type = input.type ?? 'private';
    if (!['private', 'confession'].includes(type)) throw invalid('Only private and confession messages use this endpoint');
    const clientId = input.client_message_id ?? createClientMessageId(this.crypto);
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw invalid('Invalid client_message_id');
    return Object.freeze({ ...input, type, client_message_id: clientId });
  }

  async sendMessage(input, options) {
    const prepared = this.prepareMessage(input);
    try {
      const result = await this.request('/messages', { ...options, method: 'POST', body: prepared });
      return { ...result, clientMessageId: prepared.client_message_id };
    } catch (error) {
      if (error instanceof ApiError) error.clientMessageId = prepared.client_message_id;
      throw error;
    }
  }

  getConfessionStats(query, options) { return this.callOperation('getConfessionStats', { query }, options); }
  getReceivedConfessions(query, options) { return this.callOperation('getReceivedConfessions', { query }, options); }
  getConfessionThread(messageId, query, options) { return this.callOperation('getConfessionThread', { path: { id: messageId }, query }, options); }
  prepareDirectConfession(input) { return prepareConfessionPayload(input, this.crypto, true); }
  prepareConfessionReply(input) { return prepareConfessionPayload(input, this.crypto, false); }
  async sendDirectConfession(input, options) {
    const prepared = this.prepareDirectConfession(input);
    try { return { ...await this.callOperation('sendDirectConfession', { body: prepared }, options), clientMessageId: prepared.client_message_id }; }
    catch (error) { if (error instanceof ApiError) error.clientMessageId = prepared.client_message_id; throw error; }
  }
  async replyToConfession(messageId, input, options) {
    const prepared = this.prepareConfessionReply(input);
    try { return { ...await this.callOperation('replyToConfession', { path: { id: messageId }, body: prepared }, options), clientMessageId: prepared.client_message_id }; }
    catch (error) { if (error instanceof ApiError) error.clientMessageId = prepared.client_message_id; throw error; }
  }
  requestConfessionIdentity(messageId, input, options) { return this.callOperation('requestConfessionIdentity', { path: { id: messageId }, body: input }, options); }
  getConfessionIdentityRequests(query, options) { return this.callOperation('getConfessionIdentityRequests', { query }, options); }
  decideConfessionIdentity(requestId, input, options) { return this.callOperation('decideConfessionIdentity', { path: { requestId }, body: input }, options); }
  readMessage(messageId, options) { return this.request('/messages/' + id(messageId) + '/read', { ...options, method: 'PUT' }); }
  readMessages(ids, options) { return this.request('/messages/read-batch', { ...options, method: 'PUT', body: { ids } }); }
  readAllMessages(type, options) { return this.request('/messages/read-all', { ...options, method: 'PUT', body: type === undefined ? {} : { type } }); }
  deleteMessage(messageId, options) { return this.request('/messages/' + id(messageId), { ...options, method: 'DELETE' }); }
  deleteConversation(userId, options) { return this.request('/messages/chat/' + id(userId), { ...options, method: 'DELETE' }); }
  revokeMessage(messageId, options) { return this.request('/messages/' + id(messageId) + '/revoke', { ...options, method: 'PUT' }); }
  getFriends(options) { return this.request('/friends', options); }
  getPendingFriends(options) { return this.request('/friends/pending', options); }
  addFriend(friendId, options) { return this.request('/friends/add', { ...options, method: 'POST', body: { friend_id: friendId } }); }
  respondToFriend(relationshipId, action, options) { return this.request('/friends/' + id(relationshipId) + '/respond', { ...options, method: 'PUT', body: { action } }); }
  getVotes(query, options) { return this.request('/votes', { ...options, query }); }
  getVote(voteId, options) { return this.request('/votes/' + id(voteId), options); }
  createVote(vote, options) { return this.request('/votes', { ...options, method: 'POST', body: vote }); }
  castVote(voteId, optionId, options) { return this.request('/votes/' + id(voteId) + '/vote', { ...options, method: 'POST', body: { option_id: optionId } }); }
  uploadImage(image, options) { return this.request('/upload/image', { ...options, method: 'POST', body: { image } }); }
  uploadPrivateImage(image, options) { return this.request('/upload/bug-image', { ...options, method: 'POST', body: { image } }); }
  uploadAvatar(avatar, options) { return this.request('/avatar/upload', { ...options, method: 'PUT', body: { avatar } }); }

  /** Invoke an operation from the generated OpenAPI table. */
  callOperation(operationId, params = {}, options = {}) {
    if (typeof operationId !== 'string' || !Object.hasOwn(V1_OPERATIONS, operationId)) throw invalid('Unknown or disallowed v1 operationId: ' + operationId);
    const spec = V1_OPERATIONS[operationId];
    const declaredHeaders = spec.params.filter(parameter => parameter.in === 'header' && parameter.name.toLowerCase() !== 'x-wall-id').map(parameter => parameter.name);
    const headers = normalizeHeaders(options.headers, declaredHeaders);
    if (!plainObject(params) || Object.keys(params).some(key => !['path', 'query', 'body', 'wallId'].includes(key))) throw invalid('Operation parameters must be { path, query, body, wallId }');
    const pathValues = params.path ?? {};
    const queryValues = params.query ?? {};
    if (!plainObject(pathValues) || !plainObject(queryValues)) throw invalid('Operation path and query parameters must be plain objects');
    const pathParams = spec.params.filter(parameter => parameter.in === 'path');
    if (Object.keys(pathValues).some(key => !pathParams.some(parameter => parameter.name === key)) || pathParams.some(parameter => parameter.required && !Object.hasOwn(pathValues, parameter.name))) throw invalid('Missing or unknown path parameter');
    const wallParameter = spec.params.find(parameter => parameter.in === 'header' && parameter.name.toLowerCase() === 'x-wall-id');
    const queryParams = spec.params.filter(parameter => parameter.in === 'query');
    if (Object.keys(queryValues).some(key => !queryParams.some(parameter => parameter.name === key) && !(wallParameter && key === 'wall_id')) || queryParams.some(parameter => parameter.required && queryValues[parameter.name] == null)) throw invalid('Missing or unknown query parameter');
    for (const [key, value] of Object.entries(queryValues)) {
      if (value == null || key === 'wall_id') continue;
      const definition = queryParams.find(parameter => parameter.name === key);
      if (definition?.type === 'integer' && !((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))))) throw invalid('Query parameter must be a safe integer: ' + key);
      if (definition?.type === 'boolean' && typeof value !== 'boolean') throw invalid('Query parameter must be boolean: ' + key);
      if (definition?.type === 'string' && typeof value !== 'string') throw invalid('Query parameter must be a string: ' + key);
    }
    const hasBody = Object.hasOwn(params, 'body');
    if (spec.bodyRequired && !hasBody) throw invalid('This operation requires a JSON object body');
    if (hasBody && (!spec.body || !plainObject(params.body))) throw invalid('This operation does not accept this request body');
    const path = spec.path.replace(/\{([^}]+)\}/g, (_, name) => {
      const definition = pathParams.find(parameter => parameter.name === name);
      if (!definition) throw invalid('Undocumented path parameter: ' + name);
      return encodeURIComponent(definition.type === 'integer' ? id(pathValues[name]) : segment(pathValues[name]));
    });
    // Wall context may be supplied by the documented header or query/body alternative; authorization stays on the server.
    const wallId = wallParameter ? (params.wallId !== undefined ? params.wallId : options.wallId !== undefined ? options.wallId : (queryValues.wall_id != null || params.body?.wall_id != null ? null : undefined)) : null;
    const requestOptions = { ...options, method: spec.method, auth: spec.auth, query: queryValues, wallId, responseType: spec.response, headers };
    if (hasBody) requestOptions.body = params.body;
    else delete requestOptions.body;
    // This resource uses its path id as context, not an unrelated selected wall.
    if (!spec.auth || /^\/walls\/\{id\}(?:\/|$)/.test(spec.path)) { requestOptions.auth = spec.auth; requestOptions.wallId = null; }
    return this.request(path, requestOptions);
  }
  getApiInfo(options) { return this.callOperation('getApiInfo', {}, options); }
  getOpenApi(options) { return this.callOperation('getOpenApi', {}, options); }
  deleteAccount(password, options) { return this.callOperation('deleteAccount', { body: typeof password === 'object' ? password : { password } }, options); }
  exportOwnData(options) { return this.callOperation('exportOwnData', {}, options); }
  deletePost(postId, options) { return this.callOperation('deletePost', { path: { id: postId } }, options); }
  deleteComment(postId, commentId, options) { return this.callOperation('deleteComment', { path: { postId, commentId } }, options); }
  likePost(postId, options) { return this.callOperation('likePost', { path: { id: postId } }, options); }
  unlikePost(postId, options) { return this.callOperation('unlikePost', { path: { id: postId } }, options); }
  deleteFriend(friendId, options) { return this.callOperation('deleteFriend', { path: { id: friendId } }, options); }
  blockUser(userId, options) { return this.callOperation('blockUser', { body: { user_id: userId } }, options); }
  unblockUser(userId, options) { return this.callOperation('unblockUser', { body: { user_id: userId } }, options); }
  deleteVote(voteId, options) { return this.callOperation('deleteVote', { path: { id: voteId } }, options); }
  getTreeMessages(conversationId, query, options) {
    const normalized = query && (query.mark_read === 0 || query.mark_read === 1) ? { ...query, mark_read: String(query.mark_read) } : query;
    return this.callOperation('getTreeMessages', { path: { conversationId }, query: normalized }, options);
  }
}

function segment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value) || value === '.' || value === '..') throw invalid('A path segment must be a nonempty safe string');
  return value;
}

for (const [operationId] of Object.entries(V1_OPERATIONS)) {
  if (operationId in SchoolWallClient.prototype) continue;
  SchoolWallClient.prototype[operationId] = function generatedOperation(params = {}, options = {}) { return this.callOperation(operationId, params, options); };
}

export function createMobileClient(options) { return new SchoolWallClient(options); }
