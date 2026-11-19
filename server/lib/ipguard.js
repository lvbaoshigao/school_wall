// ===== 访问 IP 白名单 =====
//
// 保护范围分两档（存 settings 表，管理员可在后台改）：
//   mode = 'admin'  只保护 /api/admin/* 与 /dashboard（管理面）
//   mode = 'all'    保护整个 /api（站点仅对白名单内 IP 开放，适合内网部署）
//
// 白名单来源取并集：
//   1. 环境变量 ADMIN_IP_WHITELIST（逗号分隔）—— 引导保护：即使数据库被清空
//      （比如刚执行完删库重置），env 里配过的 IP 仍可进入管理面。
//   2. settings 表 admin_ip_whitelist（JSON 数组）—— 管理员在界面上维护的部分。
//
// 条目语法：精确 IP（v4/v6）或通配符（如 192.168.*、10.0.0.*）。
// 健康检查 /api/health 永远放行，不影响 nginx/监控探活。

const { getSetting } = require('../db');

function normalizeIp(ip) {
  // IPv4-mapped IPv6（::ffff:1.2.3.4）统一成 v4 形式再比对
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

// 与 index.js 同样使用 Express 的受信代理链解析结果，不直接读取可伪造头。
function clientIpOf(req) {
  // req.ip already respects Express's configured trusted proxy chain.
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function entryToRegex(entry) {
  // '*' 通配任意段字符；其余按字面量转义
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : '\\' + ch));
  try { return new RegExp(`^${escaped}$`, 'i'); } catch { return null; }
}

function ipMatches(ip, list) {
  if (!ip || ip === 'unknown') return false;
  const candidates = [ip];
  // IPv6 回环 ::1 与 v4 互认，避免「配了 127.0.0.1 却用 localhost(IPv6) 访问」被拦
  if (ip === '127.0.0.1') candidates.push('::1');
  if (ip === '::1') candidates.push('127.0.0.1');
  return list.some(entry => {
    if (entry.includes('*')) {
      const re = entryToRegex(entry);
      return re ? candidates.some(c => re.test(c)) : false;
    }
    return candidates.includes(entry);
  });
}

function parseList(raw) {
  return String(raw || '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function getWhitelistConfig(db) {
  const envList = parseList(process.env.ADMIN_IP_WHITELIST || '');
  let cfgList = [];
  try {
    const parsed = JSON.parse(getSetting(db, 'admin_ip_whitelist', '[]') || '[]');
    if (Array.isArray(parsed)) cfgList = parsed.map(x => String(x).trim()).filter(Boolean);
  } catch {}
  const modeRaw = getSetting(db, 'ip_whitelist_mode', 'off') || 'off';
  const mode = ['off', 'admin', 'all'].includes(modeRaw) ? modeRaw : 'off';
  return { envList, cfgList, mode };
}

function deny(res, scope, path) {
  const isHtml = scope === 'admin' && path.startsWith('/dashboard') && !path.startsWith('/dashboard/api');
  if (isHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send('<!DOCTYPE html><html lang="zh-CN"><meta charset="UTF-8"><body style="font-family:sans-serif;background:#0f0f23;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0"><div style="text-align:center"><h1>403</h1><p>当前 IP 不在访问白名单内</p></div></body></html>');
  }
  return res.status(403).json({ error: '当前 IP 不在访问白名单内' });
}

// 挂在 req.db 注入之后、全部路由之前。静态资源与 SPA 页面不拦（mode='all' 也只管 API）。
function whitelistGuard(req, res, next) {
  const p = req.path.toLowerCase();
  if (p === '/api/health') return next();
  if (/^\/(?:api\/admin|dashboard)(?:\/|$)/.test(p) || /^\/api\/(?:walls\/admin|permissions\/user|bug-reports\/admin)(?:\/|$)/.test(p)) return checkScope(req, res, next, 'admin', p);
  if (p === '/api' || p.startsWith('/api/')) return checkScope(req, res, next, 'all', p);
  return next();
}

function checkScope(req, res, next, scope, p) {
  const { envList, cfgList, mode } = getWhitelistConfig(req.db);
  const needsGuard =
    mode === 'all' || (scope === 'admin' && (mode === 'admin' || envList.length > 0));
  if (!needsGuard) return next();

  const list = [...envList, ...cfgList];
  // 启用保护后名单为空时拒绝访问；配置接口应在保存前拒绝此状态。
  if (!list.length) return deny(res, scope, p);

  if (!ipMatches(clientIpOf(req), list)) return deny(res, scope, p);
  return next();
}

module.exports = { clientIpOf, normalizeIp, ipMatches, parseList, getWhitelistConfig, whitelistGuard };
