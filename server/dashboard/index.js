'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authRequired, requirePerm, SECRET } = require('../middleware/auth');
const { userCan } = require('../lib/permissions');
const { getOverview, parseOverviewQuery, OverviewError } = require('../lib/overview');
const dbops = require('../routes/dbops');

const router = express.Router();
const ASSET_DIR = path.join(__dirname, 'assets');
const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const PAGE_SIZES = Object.freeze({ users: 50, posts: 25, announcements: 25 });
const EXPORT_LIMIT = 10000;

// Dashboard responses contain privileged data. Never cache pages, API data, or assets.
router.use((req, res, next) => {
  if (req.path.startsWith('/dashboard') || req.path.startsWith('/api/dashboard/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
  }
  next();
});
router.use('/dashboard/assets', express.static(ASSET_DIR, {
  index: false,
  dotfiles: 'deny',
  fallthrough: true,
  setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); },
}));

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

// Compare normalized origins so a proxy's public scheme and default ports work correctly.
function isSameOrigin(req, origin) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  try {
    const candidate = new URL(origin);
    const expected = new URL(req.protocol + '://' + req.get('host'));
    return !candidate.username && !candidate.password && !candidate.search && !candidate.hash &&
      candidate.pathname === '/' && candidate.origin === expected.origin;
  } catch { return false; }
}

// This data endpoint is deliberately cookie-only; a short-lived Bearer token is not a substitute.
function sameOriginDashboardCookie(req, res, next) {
  if (!parseCookies(req).sw_dash) return res.status(401).json({ error: '请先登录' });
  if (req.headers.origin && !isSameOrigin(req, req.headers.origin)) {
    return res.status(403).json({ error: '不接受跨站管理请求' });
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: '不接受跨站管理请求' });
  }
  next();
}

function dashboardAuth(req, res, next) {
  const fail = (code, msg) => {
    if ((req.originalUrl || req.path).split('?')[0].startsWith('/dashboard/api/')) return res.status(code).json({ error: msg });
    return res.status(code).type('html').send('<h1>' + msg + '</h1><p>请回到校园墙前端重新进入 Dashboard</p>');
  };
  const cookie = parseCookies(req).sw_dash;
  const token = cookie || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return fail(401, '请先登录');
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'], audience: 'dashboard' });
    if (!Number.isSafeInteger(payload.id) || payload.id <= 0 || !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.tv) || payload.tv < 0 || typeof payload.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(payload.csrf)) {
      return fail(401, '票据无效或已过期');
    }
    const user = req.db.prepare('SELECT username, role, status, token_version FROM users WHERE id=?').get(payload.id);
    if (!user || payload.tv !== (user.token_version || 0)) return fail(401, '登录状态已失效');
    if (user.status !== 'active' || !userCan(req.db, payload.id, 'global.dashboard')) return fail(403, '权限不足或账号不可用');
    if (cookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = req.headers['x-dashboard-csrf'];
      if (typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) ||
          !crypto.timingSafeEqual(Buffer.from(csrf), Buffer.from(payload.csrf))) return fail(403, '请求校验失败，请重新打开看板');
      if (req.headers.origin && !isSameOrigin(req, req.headers.origin)) return fail(403, '不接受跨站管理请求');
    }
    req.user = { ...payload, username: user.username, role: user.role };
  } catch {
    return fail(401, '票据无效或已过期');
  }
  next();
}

// Exchange a bearer credential for an HttpOnly dashboard-scoped cookie.
router.post('/api/dashboard/session', authRequired, requirePerm('global.dashboard'), (req, res) => {
  const ticket = jwt.sign({ id: req.user.id, tv: req.user.tv, csrf: crypto.randomBytes(32).toString('hex') }, SECRET, { algorithm: 'HS256', audience: 'dashboard', expiresIn: '1h' });
  const secure = req.secure;
  res.setHeader('Set-Cookie', [
    'sw_dash=' + encodeURIComponent(ticket), 'HttpOnly', 'SameSite=Strict', 'Path=/dashboard', 'Max-Age=3600',
    ...(secure ? ['Secure'] : []),
  ].join('; '));
  res.json({ message: 'ok' });
});

// Convert a dashboard cookie into a short-lived in-memory-only token for legacy admin APIs.
router.post('/dashboard/api/token', dashboardAuth, (req, res) => {
  const u = req.db.prepare('SELECT username, role, token_version FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign({ id: req.user.id, username: u?.username || '', role: u?.role || 'user', tv: u?.token_version || 0 }, SECRET, { algorithm: 'HS256', expiresIn: '10m' });
  res.json({ token });
});

// Read-only dashboard overview reuses the same permission-aware builder as the public admin API.
router.get('/dashboard/api/overview', sameOriginDashboardCookie, dashboardAuth, (req, res, next) => {
  try {
    const query = parseOverviewQuery(req.query, req.headers);
    const result = getOverview(req.db, { userId: req.user.id, days: query.days, wallId: query.wallId });
    return res.json(result);
  } catch (error) {
    if (error instanceof OverviewError) return res.status(error.status).json({ error: error.message, code: error.code });
    return next(error);
  }
});

// CSV exports are permission-gated, bounded, no-store, and omit private messages, IPs,
// author IDs, and any identity behind an anonymous post.
router.get('/dashboard/api/export', sameOriginDashboardCookie, dashboardAuth, (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const can = permission => userCan(req.db, req.user.id, permission);
  const quoteCsv = value => {
    let text = String(value ?? '');
    if (/^[\t\r\n ]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const sendCsv = (filename, headers, rows) => {
    const body = '\uFEFF' + [headers, ...rows.map(row => row.map(quoteCsv))].map(row => row.join(',')).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '.csv"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(body);
  };
  const textFilter = value => typeof value === 'string' ? value.trim().slice(0, 100) : '';
  const likeValue = value => '%' + value.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
  const activeStatus = value => ['active', 'banned'].includes(value) ? value : '';

  let rows;
  if (type === 'users') {
    if (!can('global.user.manage')) return res.status(403).json({ error: '权限不足' });
    const query = textFilter(req.query.user_q);
    const role = ['user', 'admin', 'super_admin'].includes(req.query.user_role) ? req.query.user_role : '';
    const status = activeStatus(req.query.user_status);
    const where = [], params = [];
    if (query) { where.push("(username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')"); params.push(likeValue(query), likeValue(query)); }
    if (role) { where.push('role=?'); params.push(role); }
    if (status) { where.push('status=?'); params.push(status); }
    const predicate = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const count = req.db.prepare('SELECT COUNT(*) AS c FROM users' + predicate).get(...params).c;
    if (count > EXPORT_LIMIT) return res.status(413).json({ error: '筛选结果超过导出上限，请进一步缩小范围' });
    rows = req.db.prepare(`SELECT id, username, nickname, CASE WHEN show_real_name=1 THEN real_name ELSE '' END AS real_name, role, status, ban_until, created_at FROM users` + predicate + ' ORDER BY created_at DESC LIMIT ?').all(...params, EXPORT_LIMIT);
    return sendCsv('users', ['ID', '用户名', '昵称', '已公开真实姓名', '角色', '状态', '封禁截止', '注册时间'], rows.map(row => [row.id, row.username, row.nickname, row.real_name, row.role, row.status, row.ban_until, row.created_at]));
  }
  if (type === 'posts') {
    if (!can('global.moderate')) return res.status(403).json({ error: '权限不足' });
    const query = textFilter(req.query.post_q);
    const where = [], params = [];
    if (query) { where.push("(p.content LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\')"); params.push(likeValue(query), likeValue(query)); }
    const predicate = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const count = req.db.prepare('SELECT COUNT(*) AS c FROM posts p' + predicate).get(...params).c;
    if (count > EXPORT_LIMIT) return res.status(413).json({ error: '筛选结果超过导出上限，请进一步缩小范围' });
    rows = req.db.prepare("SELECT p.id, p.content, p.category, CASE WHEN p.is_anonymous=1 THEN '匿名' ELSE COALESCE(u.nickname,'') END AS author, p.like_count, p.comment_count, p.created_at FROM posts p LEFT JOIN users u ON p.author_id=u.id" + predicate + ' ORDER BY p.created_at DESC LIMIT ?').all(...params, EXPORT_LIMIT);
    return sendCsv('posts', ['ID', '内容', '分类', '作者显示', '赞', '评论', '发布时间'], rows.map(row => [row.id, row.content, row.category, row.author, row.like_count, row.comment_count, row.created_at]));
  }
  if (type === 'announcements') {
    if (!can('global.announcement')) return res.status(403).json({ error: '权限不足' });
    const query = textFilter(req.query.announcement_q);
    const where = ["a.scope='global'"], params = [];
    if (query) { where.push("a.title LIKE ? ESCAPE '\\'"); params.push(likeValue(query)); }
    const predicate = ' WHERE ' + where.join(' AND ');
    const count = req.db.prepare('SELECT COUNT(*) AS c FROM announcements a' + predicate).get(...params).c;
    if (count > EXPORT_LIMIT) return res.status(413).json({ error: '筛选结果超过导出上限，请进一步缩小范围' });
    rows = req.db.prepare('SELECT a.id, a.title, a.content, a.is_pinned, a.delete_at, a.created_at FROM announcements a' + predicate + ' ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT ?').all(...params, EXPORT_LIMIT);
    return sendCsv('announcements', ['ID', '标题', '内容', '置顶', '定时删除', '发布时间'], rows.map(row => [row.id, row.title, row.content, row.is_pinned ? '是' : '否', row.delete_at, row.created_at]));
  }
  return res.status(400).json({ error: '无效的导出类型' });
});

// Database operations retain the same cookie/CSRF guard and permission checks.
router.use('/dashboard/api/db', dbops.dashboardRouter(dashboardAuth));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function textParam(query, name, limit = 100) {
  const value = query && query[name];
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function validPage(value) {
  if (typeof value !== 'string' || !/^\d{1,8}$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000000) : 1;
}
function makePage(total, requested, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pages);
  return { total, pages, page, pageSize, offset: (page - 1) * pageSize };
}
function roleLabel(role) {
  return ({ super_admin: '超级管理员', admin: '全局管理员', user: '普通用户' })[role] || '未知角色';
}
function dateLabel(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}
function valueOrDash(value) { return value === null || value === undefined || value === '' ? '-' : String(value); }
function numeric(value) { return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? String(Number(value)) : '0'; }
function selectedOption(value, expected) { return value === expected ? ' selected' : ''; }

const FILTER_KEYS = ['user_q', 'user_role', 'user_status', 'users_page', 'post_q', 'posts_page', 'announcement_q', 'announcements_page'];
function normalizedFilters(query) {
  const role = ['user', 'admin', 'super_admin'].includes(query.user_role) ? query.user_role : '';
  const status = ['active', 'banned'].includes(query.user_status) ? query.user_status : '';
  return {
    user_q: textParam(query, 'user_q'), user_role: role, user_status: status, users_page: String(validPage(query.users_page)),
    post_q: textParam(query, 'post_q'), posts_page: String(validPage(query.posts_page)),
    announcement_q: textParam(query, 'announcement_q'), announcements_page: String(validPage(query.announcements_page)),
  };
}
function hiddenFields(filters, omit) {
  return FILTER_KEYS.filter(key => !omit.has(key) && filters[key] && !(key.endsWith('_page') && filters[key] === '1'))
    .map(key => '<input type="hidden" name="' + key + '" value="' + escapeHtml(filters[key]) + '">').join('');
}
function querySuffix(filters, keys) {
  const params = new URLSearchParams();
  for (const key of keys) if (filters[key] && !(key.endsWith('_page') && filters[key] === '1')) params.set(key, filters[key]);
  const value = params.toString();
  return value ? '&' + value.replace(/&/g, '&amp;') : '';
}
function pageUrl(filters, pageKey, page, anchor) {
  const copy = { ...filters, [pageKey]: String(page) };
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (copy[key] && !(key.endsWith('_page') && copy[key] === '1')) params.set(key, copy[key]);
  return '/dashboard' + (params.toString() ? '?' + params.toString() : '') + '#' + anchor;
}
function renderPagination(info, filters, pageKey, anchor) {
  const prev = info.page > 1 ? '<a href="' + escapeHtml(pageUrl(filters, pageKey, info.page - 1, anchor)) + '">上一页</a>' : '<span class="disabled">上一页</span>';
  const next = info.page < info.pages ? '<a href="' + escapeHtml(pageUrl(filters, pageKey, info.page + 1, anchor)) + '">下一页</a>' : '<span class="disabled">下一页</span>';
  const first = info.total ? info.offset + 1 : 0;
  const last = Math.min(info.offset + info.pageSize, info.total);
  return '<span>共 ' + numeric(info.total) + ' 条 · 第 ' + numeric(info.page) + ' / ' + numeric(info.pages) + ' 页（' + numeric(first) + '–' + numeric(last) + '）</span><nav aria-label="分页">' + prev + next + '</nav>';
}
function likeValue(value) { return '%' + value.replace(/[\\%_]/g, ch => '\\' + ch) + '%'; }

router.get('/dashboard', dashboardAuth, (req, res) => {
  const db = req.db;
  const can = permission => userCan(db, req.user.id, permission);
  const canModerate = can('global.moderate');
  const canUsers = can('global.user.manage');
  const canRole = can('global.user.role');
  const canBan = can('global.user.ban');
  const canAnnouncements = can('global.announcement');
  const canDb = can('global.db.manage');
  const filters = normalizedFilters(req.query || {});
  const announcementsQuery = filters.announcement_q;
  const announcementsWhere = ["a.scope='global'"];
  const announcementsParams = [];
  if (announcementsQuery) { announcementsWhere.push("a.title LIKE ? ESCAPE '\\'"); announcementsParams.push(likeValue(announcementsQuery)); }
  const announcementsPredicate = ' WHERE ' + announcementsWhere.join(' AND ');
  const announcementTotal = canAnnouncements ? db.prepare('SELECT COUNT(*) AS c FROM announcements a' + announcementsPredicate).get(...announcementsParams).c : 0;
  const announcementPage = makePage(announcementTotal, validPage(req.query.announcements_page), PAGE_SIZES.announcements);
  const announcements = canAnnouncements ? db.prepare('SELECT a.id,a.title,a.is_pinned,a.delete_at,a.created_at FROM announcements a' + announcementsPredicate + ' ORDER BY a.is_pinned DESC,a.created_at DESC LIMIT ? OFFSET ?')
    .all(...announcementsParams, announcementPage.pageSize, announcementPage.offset) : [];

  const userWhere = [], userParams = [];
  if (filters.user_q) { userWhere.push("(username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')"); userParams.push(likeValue(filters.user_q), likeValue(filters.user_q)); }
  if (filters.user_role) { userWhere.push('role=?'); userParams.push(filters.user_role); }
  if (filters.user_status) { userWhere.push('status=?'); userParams.push(filters.user_status); }
  const userPredicate = userWhere.length ? ' WHERE ' + userWhere.join(' AND ') : '';
  const userTotal = canUsers ? db.prepare('SELECT COUNT(*) AS c FROM users' + userPredicate).get(...userParams).c : 0;
  const userPage = makePage(userTotal, validPage(req.query.users_page), PAGE_SIZES.users);
  const users = canUsers ? db.prepare("SELECT id,username,nickname,CASE WHEN show_real_name=1 THEN real_name ELSE '' END AS real_name,role,status,ban_until,created_at FROM users" + userPredicate + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(...userParams, userPage.pageSize, userPage.offset) : [];

  const postWhere = [], postParams = [];
  if (filters.post_q) { postWhere.push("(p.content LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\')"); postParams.push(likeValue(filters.post_q), likeValue(filters.post_q)); }
  const postPredicate = postWhere.length ? ' WHERE ' + postWhere.join(' AND ') : '';
  const postTotal = canModerate ? db.prepare('SELECT COUNT(*) AS c FROM posts p' + postPredicate).get(...postParams).c : 0;
  const postPage = makePage(postTotal, validPage(req.query.posts_page), PAGE_SIZES.posts);
  const recentPosts = canModerate ? db.prepare("SELECT p.id,p.content,p.category,p.is_anonymous,p.like_count,p.comment_count,p.created_at,CASE WHEN p.is_anonymous=1 THEN '匿名' ELSE COALESCE(u.nickname,'') END AS author FROM posts p LEFT JOIN users u ON p.author_id=u.id" + postPredicate + ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?')
    .all(...postParams, postPage.pageSize, postPage.offset) : [];

  const roleLabelText = roleLabel(req.user.role);
  const userRows = users.map(user => {
    const role = String(user.role || '');
    const roleClass = ['super_admin', 'admin', 'user'].includes(role) ? role : 'user';
    const actions = role !== 'super_admin' && (canRole || canBan)
      ? '<button class="btn btn-primary btn-sm" data-action="showSettings" data-id="' + numeric(user.id) + '" data-username="' + escapeHtml(user.username) + '" data-role="' + escapeHtml(role) + '" data-status="' + escapeHtml(user.status) + '">设置</button>'
      : '<span class="overview-muted">' + (role === 'super_admin' ? '超级管理员' : '无操作权限') + '</span>';
    return '<tr><td>' + numeric(user.id) + '</td><td>' + escapeHtml(user.username) + '</td><td>' + escapeHtml(user.nickname || '-') + '</td><td>' + escapeHtml(user.real_name || '-') + '</td><td><span class="role-badge role-' + roleClass + '">' + escapeHtml(roleLabel(role)) + '</span></td><td>' + (user.status === 'banned' ? '<span class="status-banned">封禁</span>' : '正常') + '</td><td>' + escapeHtml(valueOrDash(user.ban_until)) + '</td><td>' + actions + '</td></tr>';
  }).join('') || '<tr><td colspan="8" class="overview-muted">暂无匹配用户</td></tr>';
  const postRows = recentPosts.map(post => '<tr><td>' + numeric(post.id) + '</td><td class="truncate">' + escapeHtml(post.content) + '</td><td>' + escapeHtml(post.category || '-') + '</td><td>' + (post.is_anonymous ? '<span class="overview-muted">匿名</span>' : escapeHtml(post.author || '-')) + '</td><td>' + numeric(post.like_count) + '</td><td>' + numeric(post.comment_count) + '</td><td>' + escapeHtml(dateLabel(post.created_at)) + '</td><td><button class="btn btn-danger btn-sm" data-action="deletePost" data-id="' + numeric(post.id) + '">删除</button></td></tr>').join('') || '<tr><td colspan="8" class="overview-muted">暂无匹配帖子</td></tr>';
  const announcementRows = announcements.map(item => '<tr><td>' + numeric(item.id) + '</td><td>' + escapeHtml(item.title) + '</td><td>' + (item.is_pinned ? '是' : '否') + '</td><td>' + escapeHtml(valueOrDash(item.delete_at)) + '</td><td>' + escapeHtml(dateLabel(item.created_at)) + '</td><td><button class="btn btn-danger btn-sm" data-action="deleteAnn" data-id="' + numeric(item.id) + '">删除</button></td></tr>').join('') || '<tr><td colspan="6" class="overview-muted">暂无匹配公告</td></tr>';

  const userFilterOmit = new Set(['user_q', 'user_role', 'user_status', 'users_page']);
  const postFilterOmit = new Set(['post_q', 'posts_page']);
  const announcementFilterOmit = new Set(['announcement_q', 'announcements_page']);
  const fields = {
    CSRF: escapeHtml(req.user.csrf), CAN_DB: canDb ? 'true' : 'false', USERNAME: escapeHtml(req.user.username), ROLE_LABEL: escapeHtml(roleLabelText),
    ANNOUNCEMENT_HIDDEN: canAnnouncements ? '' : 'hidden', USERS_HIDDEN: canUsers ? '' : 'hidden', POSTS_HIDDEN: canModerate ? '' : 'hidden', CAN_DB_HIDDEN: canDb ? '' : 'hidden',
    ROLE_DISABLED: canRole ? '' : 'disabled', ROLE_HIDDEN: canRole ? '' : 'hidden', BAN_HIDDEN: canBan ? '' : 'hidden',
    ANNOUNCEMENT_ROWS: announcementRows, USER_ROWS: userRows, POST_ROWS: postRows,
    ANNOUNCEMENT_QUERY: escapeHtml(announcementsQuery), USER_QUERY: escapeHtml(filters.user_q), POST_QUERY: escapeHtml(filters.post_q),
    USER_ROLE_OPTIONS: ['user', 'admin', 'super_admin'].map(role => '<option value="' + role + '"' + selectedOption(filters.user_role, role) + '>' + escapeHtml(roleLabel(role)) + '</option>').join(''),
    USER_STATUS_OPTIONS: [['active', '正常'], ['banned', '封禁']].map(([status, label]) => '<option value="' + status + '"' + selectedOption(filters.user_status, status) + '>' + label + '</option>').join(''),
    USER_HIDDEN_FIELDS: hiddenFields(filters, userFilterOmit), POST_HIDDEN_FIELDS: hiddenFields(filters, postFilterOmit), ANNOUNCEMENT_HIDDEN_FIELDS: hiddenFields(filters, announcementFilterOmit),
    USER_EXPORT_QUERY: querySuffix(filters, ['user_q', 'user_role', 'user_status']), POST_EXPORT_QUERY: querySuffix(filters, ['post_q']), ANNOUNCEMENT_EXPORT_QUERY: querySuffix(filters, ['announcement_q']),
    USER_PAGINATION: renderPagination(userPage, filters, 'users_page', 'users'), POST_PAGINATION: renderPagination(postPage, filters, 'posts_page', 'posts'), ANNOUNCEMENT_PAGINATION: renderPagination(announcementPage, filters, 'announcements_page', 'announcements'),
  };
  // Resolve only original template markers. A callback keeps user text such as
  // $& / $$ literal, and a single pass never expands markers inside stored data.
  const html = PAGE_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (marker, key) =>
    Object.hasOwn(fields, key) ? String(fields[key]) : marker);
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
