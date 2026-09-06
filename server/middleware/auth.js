const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { effectivePerms, loadOverrides, isWallPerm } = require('../lib/permissions');

// ===== JWT 密钥 =====
// 优先使用环境变量；否则在 server/.jwt_secret 持久化一个随机密钥。
// 不再使用硬编码回退密钥（安全漏洞修复）。
function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  const secretPath = path.join(__dirname, '..', '.jwt_secret');
  try {
    if (fs.existsSync(secretPath)) {
      const s = fs.readFileSync(secretPath, 'utf8').trim();
      if (s.length >= 16) return s;
    }
  } catch {}
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    // 先检查文件是否存在，存在则只读权限（不覆盖）
    if (fs.existsSync(secretPath)) {
      const s = fs.readFileSync(secretPath, 'utf8').trim();
      if (s.length >= 16) return s;
    }
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    // writeFileSync 的 mode 只在新建文件时生效，补一次确保权限正确
    try { fs.chmodSync(secretPath, 0o600); } catch {};
    console.warn('[Auth] 未设置 JWT_SECRET 环境变量，已生成随机密钥并保存到 server/.jwt_secret');
    console.warn('[Auth] 生产环境请设置 JWT_SECRET 环境变量以固定密钥。');
  } catch (e) {
    console.warn('[Auth] 无法持久化 JWT 密钥，本次运行使用临时密钥（重启后 token 将失效）。');
  }
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
  const overrides = loadOverrides(req.db, req.user.id);
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
        overrides,
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
      db.prepare("UPDATE users SET status='active', ban_until='', ban_reason='', ban_level='login' WHERE id=?").run(user.id);
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
  const level = state.banLevel || 'login';
  if (level === 'login' || level === 'all') return true;
  if (level === 'post' && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return true;
  if (level === 'chat') {
    const chatPaths = ['/api/messages', '/api/friends', '/api/chat'];
    if (chatPaths.some(p => req.path.startsWith(p))) return true;
  }
  return false;
}

// 必须登录且账号正常
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, SECRET);
    // 从库实时读取全局角色与状态
    const user = req.db.prepare('SELECT id, status, ban_until, ban_reason, ban_level, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: '用户不存在' });

    const state = settleBan(req.db, user);
    if (state.banned) {
      if (banLevelCheck(req, user, state)) {
        return res.status(403).json(banPayload(state, user.ban_reason));
      }
      // 非完全拦截级别（如 post/chat），允许通过但标记
      req.user.banRestricted = state.banLevel;
    }
    req.user.role = user.role;
    attachPermissions(req);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ===== 校园墙上下文 =====
// 解析墙 ID。默认只认 X-Wall-Id 头 / query / body。
//
// 注意不能无条件把路径参数 :id 当墙 ID：posts.js 里
// `GET /api/posts/:id`、`POST /api/posts/:id/like` 等九条路由也挂了 wallContext，
// 那里的 :id 是帖子 ID。只有 walls.js 的 `/:id/...` 路由里它才是墙 ID，
// 所以由 wallPathContext 显式传 fromPath 开启。
function resolveWallId(req, { fromPath = false } = {}) {
  const toId = (raw) => {
    const id = parseInt(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  const fromCtx = toId(req.headers['x-wall-id'] || req.query.wall_id || req.body?.wall_id);
  if (!fromPath) return { id: fromCtx, conflict: false };

  const pathId = toId(req.params?.id);
  // 路径与头同时存在且不一致时直接拒绝，而不是默默取其中一个：
  // 这种请求要么是客户端有 bug，要么是有人在试探，两种都不该当成正常请求处理。
  if (pathId && fromCtx && pathId !== fromCtx) return { id: null, conflict: true };
  return { id: pathId || fromCtx, conflict: false };
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
      db.prepare("UPDATE wall_members SET status='active', wall_ban_until='', wall_ban_reason='' WHERE wall_id=? AND user_id=?")
        .run(wallId, userId);
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
  if (resolved.conflict) {
    return res.status(400).json({ error: 'URL 中的校园墙与 X-Wall-Id 不一致' });
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
  SECRET,
};
