'use strict';
// Parse only deployment configuration; never load app modules or the database.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'server');
const envFile = path.join(server, '.env');
try {
  const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const env = parseEnv(text);
  // Keep path/security settings in the subset shared by Node and systemd env files.
  // In particular, systemd does not treat trailing # text as an inline comment.
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(export\s+)?(DATA_DIR|HOST|PORT|TRUST_PROXY|KEEP_DB|NODE_ENV)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[2];
    let value = match[3].trim();
    if ((value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) value = value.slice(1, -1);
    if (match[1] || seen.has(key) || value !== env[key] || value.includes(String.fromCharCode(92))) {
      throw new Error(key + ' must appear once as a simple KEY=value, without inline comments, export or escapes');
    }
    seen.add(key);
  }
  const fixed = { HOST: '127.0.0.1', PORT: '3000', TRUST_PROXY: '1', KEEP_DB: '1', NODE_ENV: 'production' };
  for (const [key, expected] of Object.entries(fixed)) {
    if (Object.hasOwn(env, key) && env[key] !== expected) {
      throw new Error('server/.env must not override ' + key + ' for this service template');
    }
  }
  if (env.DATA_DIR && !path.isAbsolute(env.DATA_DIR)) throw new Error('Service DATA_DIR must be an absolute path');
  const data = path.resolve(server, env.DATA_DIR || server);
  // Restrict generated systemd paths to simple, absolute Linux paths.
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(data)) throw new Error('DATA_DIR must use a simple absolute path without spaces or systemd specifiers');
  if (data !== server && (data === root || data.startsWith(root + path.sep) || root.startsWith(data + path.sep) || data === '/')) {
    throw new Error('Custom DATA_DIR must be outside the checkout and must not contain the checkout');
  }
  let ancestor = data;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error('DATA_DIR must not traverse symlinked directories');
  if (fs.existsSync(data)) {
    const stat = fs.lstatSync(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DATA_DIR must be a real directory, not a symlink');
    if (stat.uid !== process.getuid()) throw new Error('Existing DATA_DIR must belong to the service user');
    if (fs.realpathSync(data) !== data) throw new Error('DATA_DIR must not traverse symlinked directories');
  }
  console.log(data);
} catch (error) {
  console.error('Invalid service configuration: ' + error.message);
  process.exitCode = 1;
}
