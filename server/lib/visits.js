// In-memory rolling statistics; restarting the process clears this window.
const WINDOW_MS = 60 * 60 * 1000;
const BUCKET_MS = 1000;
const MAX_KEYS = 50000;
const seen = new Map();
const requests = new Map();
let lastSweep = 0;

function sweep(now) {
  const cutoff = now - WINDOW_MS;
  for (const [key, last] of seen) if (last <= cutoff) seen.delete(key);
  for (const time of requests.keys()) if (time + BUCKET_MS <= cutoff) requests.delete(time);
  lastSweep = now;
}

function track(key) {
  const now = Date.now();
  if (now - lastSweep >= 60000 || now < lastSweep || seen.size >= MAX_KEYS) sweep(now);
  if (!seen.has(key) && seen.size >= MAX_KEYS) return;
  seen.set(key, now);
  const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  requests.set(bucket, (requests.get(bucket) || 0) + 1);
}

function stats() {
  sweep(Date.now());
  return { visitors: seen.size, requests: [...requests.values()].reduce((sum, count) => sum + count, 0), windowMinutes: 60 };
}

module.exports = { track, stats };
