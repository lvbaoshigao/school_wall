const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../lib/paths');
const { effectivePerms, loadOverrides, isWallPerm } = require('../lib/permissions');
const requestAuth = require('../lib/requestAuth');

// ===== JWT 密钥 =====
// 优先使用环境变量；否则在 server/.jwt_secret 持久化一个随机密钥。
// 不再使用硬编码回退密钥（安全漏洞修复）。
function loadSecret() {
  if (process.env.JWT_SECRET !== undefined) {
    if (process.env.JWT_SECRET.trim().length < 16) {
      throw new Error('JWT_SECRET 至少需要16个非空白字符');
    }
    return process.env.JWT_SECRET;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const secretPath = path.join(DATA_DIR, '.jwt_secret');
  const readSecret = () => {
    const s = fs.readFileSync(secretPath, 'utf8').trim();
    if (s.length < 16) throw new Error('已保存的 JWT 密钥无效，请检查配置');
    fs.chmodSync(secretPath, 0o600);
    return s;
  };
  try { return readSecret(); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    // 排他创建：并发进程不得各自覆盖密钥，或悄悄使用不同的临时密钥。
    fs.writeFileSync(secretPath, generated, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return readSecret();
    throw new Error('无法持久化 JWT 密钥，请配置 JWT_SECRET 或修复密钥文件权限');
  }
  console.warn('[Auth] 已生成随机 JWT 密钥并保存到 server/.jwt_secret');
  return generated;
}

const SECRET = loadSecret();

// ===== 权限判定 =====
//
// 角色不再直接决定能否操作，只是 lib/permissions.js 里默认集的索引。
// authRequired 把 req.can 装好，路由要么用 requirePerm() 守卫，要么内联调用 req.can()。
//
// req.can(perm)            —— 墙级权限用 req.wallId 作为作用域（须先过 wallContext）
// req.can(perm, wallId)    —— 显式指定作用域；传 0 表示只问全局
//
// 注意：全局作用域下持有某个 wall.* 权限，语义是「对所有墙生效」。
// 全局管理员就是靠这条继续拥有跨墙审核能力的。
function attachPermissions(req) {
  let overrides;
  let overridesLoaded = false;
  const getOverrides = () => {
    if (!overridesLoaded) {
      // Cache only successful queries; permission-database errors remain fail-closed.
      overrides = loadOverrides(req.db, req.user.id);
      overridesLoaded = true;
    }
    return overrides;
  };
  const cache = new Map();

  // 取用户在某墙的角色。当前上下文的墙直接用 wallContext 解析好的值；
  // 其它墙现查 —— reports.js 这类路由会拿 query 里的 wall_id 直接判权限，
  // 不走 wallContext，没有这一步的话墙主查自己墙也会被判成没权限。
  const wallRoleOf = (wallId) => {
    if (wallId === req.wallId) return req.wallRole || null;
    const m = req.db.prepare(
      "SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=? AND status='active'"
    ).get(wallId, req.user.id);
    return m ? m.wall_role : null;
  };

  req.permsFor = (wallId = 0) => {
    const key = wallId || 0;
    if (!cache.has(key)) {
      cache.set(key, effectivePerms({
        globalRole: req.user.role,
        wallRole: key > 0 ? wallRoleOf(key) : null,
        overrides: getOverrides(),
        wallId: key,
      }));
    }
    return cache.get(key);
  };

  req.can = (perm, wallId) => {
    const scope = wallId !== undefined ? wallId : (isWallPerm(perm) ? (req.wallId || 0) : 0);
    return req.permsFor(scope).has(perm);
  };

  // wallContext 解析出墙身份后要丢掉缓存：在那之前算过的墙级结果没算上 wallRole
  req.resetPermCache = () => cache.clear();
}

// 权限守卫工厂。墙级权限须先经 wallContext / wallPathContext，
// 否则作用域为 0（只看全局授予），这对「全局管理员」是对的，对墙主则会漏判。
function requirePerm(perm) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (req.can(perm)) return next();
    return res.status(403).json({ error: '权限不足' });
  };
}

// ===== 封禁结算 =====
// 「到期即自动解封」原本在 middleware、login、/me 三处各写了一遍，抽到这里统一。
// 传入含 status/ban_until 的用户行，若封禁已过期则落库解封并就地修正该对象。
// 返回 { banned, permanent, until, remainingMinutes, banLevel }。
function settleBan(db, user) {
  if (!user || user.status !== 'banned') {
    return { banned: false, permanent: false, until: '', remainingMinutes: 0, banLevel: '' };
  }
  const until = user.ban_until || '';
  if (until) {
    const ts = new Date(until).getTime();
    // 时间戳非法时按永久封禁处理，避免 NaN 比较静默放行
    if (!Number.isNaN(ts) && ts < Date.now()) {
      const updated = db.prepare("UPDATE users SET status='active', ban_until='', ban_reason='', ban_level='login' WHERE id=?").run(user.id);
      if (updated?.changes > 0) db.markDirty?.();
      user.status = 'active';
      user.ban_until = '';
      user.ban_reason = '';
      user.ban_level = 'login';
      return { banned: false, permanent: false, until: '', remainingMinutes: 0, banLevel: '' };
    }
    return {
      banned: true,
      permanent: false,
      until,
      remainingMinutes: Number.isNaN(ts) ? 0 : Math.max(1, Math.ceil((ts - Date.now()) / 60000)),
      banLevel: user.ban_level || 'login',
    };
  }
  return { banned: true, permanent: true, until: '', remainingMinutes: 0, banLevel: user.ban_level || 'login' };
}

// 统一的封禁 403 响应体：前端靠 code==='BANNED' 区分「被封」与普通权限不足
function banPayload(state, reason, scope = 'global') {
  return {
    error: scope === 'wall' ? '你已被移出该校园墙' : '账号已被封禁',
    code: 'BANNED',
    scope,
    reason: reason || '',
    permanent: state.permanent,
    until: state.until,
    remainingMinutes: state.remainingMinutes,
    banLevel: state.banLevel || 'login',
  };
}

// 封禁级别拦截：login/all 完全拦截；post 只拦写请求；chat 只拦聊天相关
function banLevelCheck(req, user, state) {
  const requestPath = (req.apiCanonicalPath || req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`).split('?')[0].toLowerCase().replace(/\/+$/, '');
  // 全局封禁仍允许本人持有效会话提交申诉，除此以外不放宽封禁权限。
  if (req.method === 'POST' && requestPath === '/api/auth/appeal') return false;
  const level = state.banLevel || 'login';
  if (!['post', 'chat'].includes(level)) return true;
  if (level === 'post' && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return true;
  if (level === 'chat') {
    const chatPaths = ['/api/messages', '/api/friends', '/api/chat'];
    // Router 内 req.path 已去掉 /api/messages 前缀，必须使用挂载后的完整路径。
    if (chatPaths.some(p => requestPath === p || requestPath.startsWith(`${p}/`))) return true;
  }
  return false;
}

// 必须登录且账号正常
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    // Reuse only the immutable HS256 claims and one synchronous rate-limiter row.
    // Every later authRequired call reloads the current account state from the database.
    const authenticated = requestAuth.getRequestAuth(req, req.db, req.db?.temporarySecret ?? SECRET);
    if (!authenticated.claims) return res.status(401).json({ error: '登录已过期，请重新登录' });
    const { user } = authenticated;
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (!['active', 'banned'].includes(user.status)) {
      return res.status(403).json({ error: '账号当前不可用' });
    }
    const tokenTv = authenticated.claims.tv ?? 0;
    if (tokenTv !== (user.token_version || 0)) {
      return res.status(401).json({ error: '登录状态已失效，请重新登录' });
    }
    const state = settleBan(req.db, user);
    if (state.banned && banLevelCheck(req, user, state)) {
      return res.status(403).json(banPayload(state, user.ban_reason));
    }
    // Never mutate or retain the cached JWT payload as the route principal.
    req.user = { ...authenticated.claims, id: user.id, tv: tokenTv, role: user.role };
    if (state.banned) req.user.banRestricted = state.banLevel;
    attachPermissions(req);
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  next();
}

// Shared with the front controller's rate limiter; invalid/revoked credentials fall
// back to the IP bucket. The helper never grants a user bucket after a DB error.
function getRateUserId(req, db) {
  return requestAuth.getRateUserId(req, db, db?.temporarySecret ?? SECRET);
}

// ===== 校园墙上下文 =====
// 解析墙 ID。默认只认 X-Wall-Id 头 / query / body。
//
// 注意不能无条件把路径参数 :id 当墙 ID：posts.js 里
// `GET /api/posts/:id`、`POST /api/posts/:id/like` 等九条路由也挂了 wallContext，
// 那里的 :id 是帖子 ID。只有 walls.js 的 `/:id/...` 路由里它才是墙 ID，
// 所以由 wallPathContext 显式传 fromPath 开启。
function resolveWallId(req, { fromPath = false } = {}) {
  const toId = raw => {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^[1-9]\d*$/.test(String(raw))) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
  };
  const sources = [req.headers['x-wall-id'], req.query?.wall_id, req.body?.wall_id];
  if (fromPath) sources.push(req.params?.id);
  const provided = sources.filter(value => value !== undefined);
  if (!provided.length) return { id: null, conflict: false };
  const ids = provided.map(toId);
  if (ids.some(id => id === null)) return { id: null, invalid: true };
  if (ids.some(id => id !== ids[0])) return { id: null, conflict: true };
  return { id: ids[0], conflict: false };
}

// 墙内封禁结算：到期自动恢复为 active，逻辑与全局封禁对齐
function settleWallBan(db, wallId, userId, membership) {
  if (!membership || membership.status !== 'banned') {
    return { banned: false, permanent: false, until: '', remainingMinutes: 0 };
  }
  const until = membership.wall_ban_until || '';
  if (until) {
    const ts = new Date(until).getTime();
    if (!Number.isNaN(ts) && ts < Date.now()) {
      const updated = db.prepare("UPDATE wall_members SET status='active', wall_ban_until='', wall_ban_reason='' WHERE wall_id=? AND user_id=?")
        .run(wallId, userId);
      if (updated?.changes > 0) db.markDirty?.();
      membership.status = 'active';
      membership.wall_ban_until = '';
      membership.wall_ban_reason = '';
      return { banned: false, permanent: false, until: '', remainingMinutes: 0 };
    }
    return {
      banned: true,
      permanent: false,
      until,
      remainingMinutes: Number.isNaN(ts) ? 0 : Math.max(1, Math.ceil((ts - Date.now()) / 60000)),
    };
  }
  return { banned: true, permanent: true, until: '', remainingMinutes: 0 };
}

// 必须处于某墙上下文且为其 active 成员（全局管理员放行）
function wallContextWith(req, res, next, opts) {
  const resolved = resolveWallId(req, opts);
  if (resolved.invalid) return res.status(400).json({ error: '校园墙ID必须是有效的正整数' });
  if (resolved.conflict) {
    return res.status(400).json({ error: '校园墙上下文的多个来源不一致' });
  }
  const wallId = resolved.id;
  if (!wallId) return res.status(400).json({ error: '缺少校园墙上下文 (X-Wall-Id)' });

  const wall = req.db.prepare("SELECT id, status FROM walls WHERE id=?").get(wallId);
  if (!wall || wall.status !== 'active') return res.status(404).json({ error: '校园墙不存在或已停用' });

  const membership = req.db.prepare(
    "SELECT wall_role, status, wall_ban_until, wall_ban_reason FROM wall_members WHERE wall_id=? AND user_id=?"
  ).get(wallId, req.user.id);

  // 墙内封禁：先结算到期，仍在封禁中则明确告知原因，不与「非成员」混为一谈。
  // 全局审核权限（global.moderate）可以穿透墙内封禁进入管理。
  const wallBan = settleWallBan(req.db, wallId, req.user.id, membership);
  if (wallBan.banned && !req.can('global.moderate', 0)) {
    return res.status(403).json({
      ...banPayload(wallBan, membership.wall_ban_reason, 'wall'),
      error: '你已被该校园墙的管理员封禁',
      wallId,
    });
  }

  if (membership && membership.status === 'active') {
    req.wallId = wallId;
    req.wallRole = membership.wall_role;
    // 上面可能已经算过 wallId 作用域的权限（那时还没有 wallRole），必须作废重算
    req.resetPermCache();
    return next();
  }
  // 持有全局审核权限的人可进入任意墙进行管理，但不是普通成员
  if (req.can('global.moderate', 0)) {
    req.wallId = wallId;
    req.wallRole = null;
    req.resetPermCache();
    return next();
  }
  return res.status(403).json({ error: '你不是该校园墙的成员' });
}

// 墙 ID 来自请求头 / query / body。用于 posts、messages 等路由 ——
// 那里的路径参数 :id 是帖子、消息之类的 ID，不是墙。
function wallContext(req, res, next) {
  return wallContextWith(req, res, next, { fromPath: false });
}

// 墙 ID 来自路径 `/api/walls/:id/...`，同时校验它与 X-Wall-Id 不冲突。
// 只给 walls.js 的子路由用。
//
// 修的是这样一个问题：这些路由此前完全没读过路径上的 :id，只认请求头，
// 于是 `POST /api/walls/999/members/2/ban` 配上 `X-Wall-Id: 1`
// 会实实在在地封掉墙 1 的成员 —— URL 显示操作的是另一个墙，
// 审计日志里也只留下墙 1，对不上账。
// 前端的 X-Wall-Id 由拦截器统一注入「当前正在浏览的墙」，
// 而 Inbox 审批进墙申请时用的是申请自身的 wall_id，两者本来就会不同。
function wallPathContext(req, res, next) {
  return wallContextWith(req, res, next, { fromPath: true });
}

module.exports = {
  authRequired, requirePerm,
  wallContext, wallPathContext,
  settleBan, settleWallBan, banPayload,
  SECRET, getRateUserId,
};
