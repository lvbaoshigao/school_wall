'use strict';

const { isIP } = require('node:net');

// The backend is runnable without a client build. Keep deployment choices here,
// outside the route handlers, and reject typos before opening the database.
function loadConfig(env = process.env) {
  const rawPort = env.PORT || '3000';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535 (0 selects an available port)');
  }
  const host = env.HOST || '127.0.0.1';
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (!isIP(host) && !hostname.test(host)) {
    throw new Error('HOST must be an IP address or hostname, without a scheme or port');
  }
  const serveClient = env.SERVE_CLIENT ?? '1';
  if (!['0', '1'].includes(serveClient)) throw new Error('SERVE_CLIENT must be 0 or 1');

  const allowedOrigins = new Set();
  for (const value of (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(value); } catch { throw new Error('ALLOWED_ORIGINS must contain HTTP(S) origins separated by commas'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('ALLOWED_ORIGINS must contain HTTP(S) origins without credentials, paths, queries or fragments');
    }
    allowedOrigins.add(url.origin);
  }
  if (env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }
  return Object.freeze({ port: Number(rawPort), host, serveClient: serveClient === '1', allowedOrigins: [...allowedOrigins] });
}

module.exports = { loadConfig };
