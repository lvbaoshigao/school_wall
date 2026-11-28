'use strict';

const jwt = require('jsonwebtoken');
const { SECRET } = require('../middleware/auth');
const { loadConfig } = require('../config');

const COOKIE_NAME = 'sw_session';
const AUDIENCE = 'school-wall-session';
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function cookieOptions(req) {
  // Omit Domain so this credential is host-only, including behind trusted proxies.
  return { httpOnly: true, path: '/api', sameSite: 'lax', secure: req.secure };
}

function clearSessionCookie(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

function setSessionCookie(req, res, user) {
  // A temporary database must never mint a reusable persistent credential.
  if (req.db?.temporarySecret) return clearSessionCookie(req, res);
  const token = jwt.sign({ id: user.id, tv: user.token_version || 0, username: user.username }, SECRET, {
    algorithm: 'HS256', audience: AUDIENCE, expiresIn: LIFETIME_SECONDS,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: LIFETIME_SECONDS * 1000 });
}

function checkOrigin(req, res, next) {
  const origin = req.get('Origin');
  if (origin !== undefined && origin !== `${req.protocol}://${req.get('Host')}` &&
      !loadConfig().allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: '请求来源不受信任' });
  }
  next();
}

function sessionCsrf(req, res, next) {
  // SameSite alone cannot protect same-site cross-origin requests. Browsers need
  // a CORS preflight for this header; non-browser clients may omit Origin.
  if (req.get('X-Requested-With') !== 'school-wall') {
    return res.status(403).json({ error: '缺少有效的会话请求头' });
  }
  return checkOrigin(req, res, next);
}

function jsonSessionCsrf(req, res, next) {
  // Keep the existing login/register/setup JSON contract: cross-origin forms
  // cannot send application/json, and disallowed JSON Origins are rejected too.
  if (!req.is('application/json')) {
    return res.status(415).json({ error: '请求内容必须为 application/json' });
  }
  return checkOrigin(req, res, next);
}

function readSession(req) {
  if (req.db?.temporarySecret) return null;
  const header = req.get('Cookie');
  if (typeof header !== 'string') return null;
  const values = header.split(';').map(part => part.trim()).filter(part =>
    part.slice(0, part.indexOf('=')) === COOKIE_NAME).map(part => part.slice(part.indexOf('=') + 1));
  // Ambiguous duplicate cookies and unbounded/malformed input fail closed.
  if (values.length !== 1 || values[0].length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(values[0])) return null;
  let claims;
  try {
    claims = jwt.verify(values[0], SECRET, { algorithms: ['HS256'], audience: AUDIENCE, maxAge: '30d' });
  } catch {
    return null;
  }
  if (!claims || claims.aud !== AUDIENCE || !Number.isSafeInteger(claims.id) || claims.id <= 0 ||
      !Number.isSafeInteger(claims.tv) || claims.tv < 0 || typeof claims.username !== 'string' || !claims.username ||
      !Number.isSafeInteger(claims.iat) || claims.iat > Math.floor(Date.now() / 1000) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > LIFETIME_SECONDS) return null;
  // Database failures are server errors, not invalid credentials. Let Express
  // return 500 so clients preserve their session and can retry after recovery.
  const user = req.db.prepare('SELECT id, username, role, status, token_version FROM users WHERE id = ?').get(claims.id);
  if (!user || !['active', 'banned'].includes(user.status) || user.username !== claims.username ||
      (user.token_version || 0) !== claims.tv) return null;
  return { user, expiresAt: claims.exp };
}

module.exports = { setSessionCookie, clearSessionCookie, sessionCsrf, jsonSessionCsrf, readSession };
