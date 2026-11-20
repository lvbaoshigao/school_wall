'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATUS_CODES } = require('node:http');
const express = require('express');

const STATE = Symbol('schoolWallApiV1');
const ERROR_PATH = '/api/__api_version_error__';
const OPENAPI_PATH = path.resolve(__dirname, '../../docs/openapi.json');
const HTTP_CODES = Object.freeze({
  400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'VALIDATION_ERROR', 425: 'TOO_EARLY',
  429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 503: 'SERVICE_UNAVAILABLE',
  507: 'INSUFFICIENT_STORAGE',
});

// This is a public protocol contract, never deployment state, user data or permission grants.
function getApiV1Capabilities() {
  return {
    apiVersion: '1', basePath: '/api/v1', legacyBasePath: '/api',
    authentication: { scheme: 'bearer', header: 'Authorization', format: 'Bearer <token>', wallHeader: 'X-Wall-Id' },
    pagination: {
      mode: 'endpoint-specific',
      posts: { style: 'page', defaultLimit: 20, maxLimit: 50 },
      votes: { style: 'page', defaultLimit: 20, maxLimit: 50 },
      conversations: { style: 'cursor', cursor: 'before', defaultLimit: 30, maxLimit: 100 },
      messages: { style: 'cursor', cursors: ['before', 'after', 'around_id'], defaultLimit: 100, maxLimit: 200 },
    },
    limits: { jsonBodyBytes: 128 * 1024, uploadJsonBodyBytes: 5 * 1024 * 1024,
      imageBytes: 2 * 1024 * 1024, avatarBytes: 500 * 1024, messageCharacters: 2000 },
    features: { legacyCompatibility: true, preferenceSchema: true, scopedPreferenceReset: true,
      privateChatReplies: true, conversationPagination: true, messageContext: true },
    openApi: '/api/v1/openapi.json',
  };
}

function decoded(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

// Validate once, but route the original encoded bytes. Normalizing with URL() or routing a
// decoded pathname would silently collapse dot segments or introduce a second decode.
function safePath(rawPath) {
  if (!rawPath.startsWith('/') || rawPath.includes('//') || /[\\?#\u0000-\u0020\u007f]/.test(rawPath)) return false;
  const parts = rawPath.split('/');
  for (let index = 1; index < parts.length; index++) {
    if (parts[index] === '' && index === parts.length - 1) continue;
    const value = decoded(parts[index]);
    if (value === null || value === '.' || value === '..' || /[/\\?#\u0000-\u001f\u007f]/.test(value) || /%[a-f0-9]{2}/i.test(value)) return false;
  }
  // Literal namespace and route-family names make upstream guards and Express agree.
  if (parts[1].toLowerCase() !== 'api' || parts[2].toLowerCase() !== 'v1') return false;
  if (parts[3] && decoded(parts[3]) !== parts[3]) return false;
  return true;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value); }
function validCode(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value); }

function envelope(payload, status, state) {
  const meta = { apiVersion: '1', requestId: state.requestId };
  if (status < 400) return { data: payload === undefined ? null : payload, error: null, meta };
  const object = isRecord(payload) ? payload : {};
  const businessError = isRecord(object.error) ? object.error : {};
  const code = validCode(object.code) ? object.code : validCode(businessError.code) ? businessError.code
    : HTTP_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
  const message = typeof object.error === 'string' ? object.error
    : typeof businessError.message === 'string' ? businessError.message
      : typeof object.message === 'string' ? object.message
        : typeof payload === 'string' ? payload : STATUS_CODES[status] || 'Request failed';
  const error = { code, message };
  const details = Object.create(null);
  for (const source of [businessError, object]) {
    for (const [key, value] of Object.entries(source)) {
      if (!['error', 'code', 'message'].includes(key)) details[key] = value;
    }
  }
  if (Object.keys(details).length) error.details = details;
  return { data: null, error, meta };
}

function attachment(res) { return /^attachment(?:;|$)/i.test(String(res.getHeader('Content-Disposition') || '')); }

// Install globally BEFORE body parsers, health, limiters and all legacy /api routes.
// No response is emitted here: discovery and version errors must pass the IP guard.
function apiV1Middleware() {
  return function apiV1Adapter(req, res, next) {
    if (req[STATE] || typeof req.url !== 'string') return next();
    const split = req.url.indexOf('?');
    const rawPath = split < 0 ? req.url : req.url.slice(0, split);
    const query = split < 0 ? '' : req.url.slice(split);
    const parts = rawPath.split('/');
    const namespace = decoded(parts[1] || '');
    const version = decoded(parts[2] || '');
    // /api/votes is an existing, unchanged resource. All v-prefixed version slots
    // besides that resource are reserved, including malformed/unsupported versions.
    const looksVersioned = version !== null ? /^v/i.test(version) && !/^votes$/i.test(version) : /^v/i.test(parts[2] || '');
    if (namespace?.toLowerCase() !== 'api' || !looksVersioned) return next();

    const state = { requestId: crypto.randomBytes(16).toString('hex'), rawJson: false, serializing: false, error: null };
    req[STATE] = state;
    req.apiVersion = '1';
    res.setHeader('X-API-Version', '1');
    res.setHeader('X-Request-ID', state.requestId);
    // Exposing metadata does not grant any Origin or enable credentials/CORS.
    const exposed = String(res.getHeader('Access-Control-Expose-Headers') || '').split(',').map(value => value.trim()).filter(Boolean);
    res.setHeader('Access-Control-Expose-Headers', [...new Set([...exposed, 'X-API-Version', 'X-Request-ID'])].join(', '));

    if (!/^v1$/i.test(version || '')) {
      state.error = { status: 404, code: 'UNSUPPORTED_API_VERSION', error: '不支持的 API 版本', supportedVersions: ['1'] };
      req.apiCanonicalPath = ERROR_PATH;
    } else if (!safePath(rawPath)) {
      state.error = { status: 400, code: 'INVALID_API_PATH', error: 'API 路径编码或结构无效' };
      req.apiCanonicalPath = ERROR_PATH;
    } else {
      req.apiCanonicalPath = '/api' + rawPath.slice(('/' + parts[1] + '/' + parts[2]).length);
    }
    // Preserve originalUrl for auditing; query bytes and parameter encoding stay untouched.
    req.url = req.apiCanonicalPath + query;

    const originalJson = res.json;
    const originalSend = res.send;
    res.json = function apiV1Json(payload) {
      if (state.rawJson || state.serializing || attachment(this)) return originalJson.call(this, payload);
      const response = envelope(payload, this.statusCode, state);
      state.serializing = true;
      try { return originalJson.call(this, response); } finally { state.serializing = false; }
    };
    res.send = function apiV1Send(payload) {
      // Objects go through Express.json above. Preserve buffers, streams, downloads,
      // HTML/text and every write/end call; never buffer a streaming response.
      const type = String(this.getHeader('Content-Type') || '');
      if (!state.rawJson && !state.serializing && !attachment(this) && typeof payload === 'string' && new RegExp('^application/(?:[a-z0-9.-]+[+])?json(?:;|$)', 'i').test(type)) {
        let parsed;
        try { parsed = JSON.parse(payload); } catch { return originalSend.call(this, payload); }
        return this.json(parsed);
      }
      return originalSend.call(this, payload);
    };
    next();
  };
}

// Mount app.use('/api', apiV1Router()) AFTER DB injection, whitelistGuard and
// apiLimiter. It intentionally does nothing for every legacy /api request.
function apiV1Router({ openApiPath = OPENAPI_PATH } = {}) {
  const router = express.Router();
  let cached;
  let loading;

  async function readOpenApi() {
    const file = await fs.promises.stat(openApiPath);
    const revision = [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':');
    if (cached?.revision === revision) return cached.source;
    if (!file.isFile()) throw new Error('Invalid OpenAPI file');
    const source = await fs.promises.readFile(openApiPath, 'utf8');
    const document = JSON.parse(source);
    if (!isRecord(document) || typeof document.openapi !== 'string' || !isRecord(document.paths)) {
      throw new Error('Invalid OpenAPI document');
    }
    cached = { revision, source };
    return source;
  }

  router.use((req, res, next) => {
    const state = req[STATE];
    if (!state) return next('router');
    if (state.error) {
      const { status, ...body } = state.error;
      return res.status(status).json(body);
    }
    next();
  });
  router.get(['/', '/capabilities'], (req, res) => res.json(getApiV1Capabilities()));
  router.get('/openapi.json', async (req, res, next) => {
    let source;
    try {
      loading ??= readOpenApi().finally(() => { loading = undefined; });
      source = await loading;
    } catch {
      return res.status(503).json({ code: 'OPENAPI_UNAVAILABLE', error: 'API 文档暂不可用' });
    }
    try {
      req[STATE].rawJson = true;
      return res.type('application/json').send(source);
    } catch (error) {
      req[STATE].rawJson = false;
      return next(error);
    }
  });
  router.use((req, res, next) => {
    const route = req.path.replace(/\/$/, '').toLowerCase();
    if (!['', '/capabilities', '/openapi.json'].includes(route)) return next();
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: '此接口仅支持 GET 或 HEAD' });
  });
  return router;
}

module.exports = { apiV1Middleware, apiV1Router, getApiV1Capabilities };
