// 近一小时访问统计。
//
// 只放在内存里：重启即清零。做持久化要么写库（每个请求一次写，成本远超这个功能本身），
// 要么解析 nginx 日志（需要 root，且与应用解耦得太远）。对「看一眼现在多少人在用」
// 这个诉求来说，内存计数是代价最低的做法 —— 代价是重启后要重新累积。
//
// 「一次访问」按访客计：同一个人一小时内刷再多页也只算 1 人。
// 访客 key 用登录用户 ID，未登录才退回 IP —— 校园网常常整栋楼共用一个出口 IP，
// 只按 IP 会把一群人算成一个。

const WINDOW_MS = 60 * 60 * 1000;
// 上限保护：每个访客一条记录，异常流量下不让这个 Map 无限增长
const MAX_KEYS = 50000;

const seen = new Map();   // key -> { first, last, hits }
let requests = 0;         // 窗口内的请求数（滚动清理时一并扣减）

function sweep(now) {
  const cutoff = now - WINDOW_MS;
  for (const [k, v] of seen) {
    if (v.last < cutoff) { requests -= v.hits; seen.delete(k); }
  }
  if (requests < 0) requests = 0;
}

/** 记一次访问。key 由调用方给（用户 ID 或 IP）。 */
function track(key) {
  const now = Date.now();
  // 每分钟清理一轮就够，不必每个请求都全量扫
  if (now % 60000 < 50 || seen.size >= MAX_KEYS) sweep(now);
  if (!seen.has(key)) {
    if (seen.size >= MAX_KEYS) return;   // 已满则只丢弃新访客，不影响已有统计
    seen.set(key, { first: now, last: now, hits: 0 });
  }
  const e = seen.get(key);
  e.last = now;
  e.hits++;
  requests++;
}

/** 近一小时的访客数与请求数 */
function stats() {
  const now = Date.now();
  sweep(now);
  return { visitors: seen.size, requests, windowMinutes: 60 };
}

module.exports = { track, stats };
