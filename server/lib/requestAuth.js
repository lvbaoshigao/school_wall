'use strict';

const jwt = require('jsonwebtoken');
const requestCache = new WeakMap();
const AUTHORIZATION = /^Bearer [^\s]{1,8192}$/;

function isValidClaims(claims) {
  return !!claims && claims.aud === undefined && Number.isSafeInteger(claims.id) && claims.id > 0 &&
    Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.tv ?? 0) && (claims.tv ?? 0) >= 0;
}

function makeRecord(req, db, secret) {
  const header = req?.headers?.authorization;
  let claims = null;
  let authError = 'invalid';
  if (typeof header === 'string' && AUTHORIZATION.test(header)) {
    try {
      const verified = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
      authError = 'claims';
      if (isValidClaims(verified)) {
        claims = Object.freeze({ ...verified });
        authError = '';
      }
    } catch {}
  } else if (!header) {
    authError = 'missing';
  }
  const record = { req, db, secret, header, claims, authError, userLoaded: false, rateUser: undefined, rateSnapshotAvailable: false, expiryScheduled: false };
  requestCache.set(req, record);
  return record;
}

function getRecord(req, db, secret) {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) return null;
  const header = req.headers?.authorization;
  let record = requestCache.get(req);
  if (!record || record.db !== db || record.secret !== secret || record.header !== header) record = makeRecord(req, db, secret);
  return record;
}

function copyUser(user) { return user ? { ...user } : undefined; }

// Caching a signature must not extend JWT validity across an asynchronous operation.
function isCurrent(claims) {
  if (!claims) return false;
  const now = Math.floor(Date.now() / 1000);
  return claims.exp > now && (claims.nbf === undefined || claims.nbf <= now);
}

function loadUser(record) {
  if (!record.claims) return undefined;
  return record.db.prepare('SELECT id, status, ban_until, ban_reason, ban_level, role, token_version FROM users WHERE id = ?')
    .get(record.claims.id);
}

// Intended for rate limiting. Returns a user id only for a currently active user
// whose database token version matches the signed HS256 API token; every other case
// safely falls back to an IP bucket. The initial row can be reused once by the first
// synchronous authRequired middleware in this Express request chain only.
function getRateUserId(req, db, secret) {
  try {
    const record = getRecord(req, db, secret);
    if (!isCurrent(record?.claims)) return null;
    if (!record.userLoaded || !record.rateSnapshotAvailable) {
      record.rateUser = copyUser(loadUser(record));
      record.userLoaded = true;
      record.rateSnapshotAvailable = true;
      if (!record.expiryScheduled) {
        record.expiryScheduled = true;
        queueMicrotask(() => { record.rateSnapshotAvailable = false; record.expiryScheduled = false; });
      }
    }
    const user = record.rateUser;
    if (!user || user.status !== 'active' || (user.token_version || 0) !== (record.claims.tv ?? 0)) return null;
    return record.claims.id;
  } catch {
    // Never grant a per-user limiter bucket when signature or database validation fails.
    return null;
  }
}

// Used by authRequired. Reuses the rate limiter's synchronous row snapshot once;
// after any async boundary or first authentication the status/tv/role query is fresh.
// The cached JWT claims are immutable and copied, so req.user additions cannot poison cache.
function getRequestAuth(req, db, secret, { reuseRateUser = true } = {}) {
  const record = getRecord(req, db, secret);
  if (!record) return { claims: null, user: undefined, error: 'invalid' };
  if (!record.claims) return { claims: null, user: undefined, error: record.authError };
  if (!isCurrent(record.claims)) return { claims: null, user: undefined, error: 'invalid' };
  let user;
  if (reuseRateUser && record.rateSnapshotAvailable && record.userLoaded) {
    record.rateSnapshotAvailable = false;
    user = copyUser(record.rateUser);
  } else {
    user = loadUser(record);
  }
  return { claims: { ...record.claims }, user, error: '' };
}

module.exports = { getRateUserId, getRequestAuth };
