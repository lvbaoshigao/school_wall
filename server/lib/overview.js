'use strict';

const { effectivePerms, loadOverrides } = require('./permissions');
const visits = require('./visits');

const MAX_SCOPE_WALLS = 500;
const WALL_LIST_LIMIT = 100;
const TODO_LIST_LIMIT = 30;

class OverviewError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OverviewError';
    this.status = status;
    this.code = code;
  }
}

function positiveId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function normalizeDays(value = 7) {
  if (!['string', 'number'].includes(typeof value) || !/^(7|30|90)$/.test(String(value))) {
    throw new OverviewError(400, 'INVALID_OVERVIEW_DAYS', '统计天数只支持 7、30 或 90 天');
  }
  return Number(value);
}

// Automatically injected headers must not silently filter the global overview.
// For an explicit query filter, reject ambiguous or malformed headers instead.
function parseOverviewQuery(query = {}, headers = {}) {
  const days = normalizeDays(query.days);
  let wallId = null;
  if (query.wall_id !== undefined) {
    wallId = positiveId(query.wall_id);
    if (!wallId) throw new OverviewError(400, 'INVALID_OVERVIEW_WALL', '校园墙 ID 必须是有效的正整数');
    const header = headers['x-wall-id'];
    if (header !== undefined && positiveId(header) !== wallId) {
      throw new OverviewError(400, 'OVERVIEW_WALL_CONFLICT', '校园墙筛选与 X-Wall-Id 不一致');
    }
  }
  return { days, wallId };
}

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dateWindow(now, days) {
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const after = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dates = [];
  // Calendar arithmetic, not 24-hour arithmetic: DST days may be shorter/longer.
  for (let i = 0; i < days; i++) dates.push(localDate(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
  return {
    dates, start: localDate(first) + ' 00:00:00', after: localDate(after) + ' 00:00:00',
    range: {
      days, start_date: dates[0], end_date: dates[dates.length - 1],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      utc_offset_minutes: -now.getTimezoneOffset(),
      date_basis: 'server-local', includes_today: true,
      // SQLite DEFAULT datetime('now','localtime') has no offset. Historical
      // offsets or a previous server timezone cannot be reconstructed.
      timestamp_storage: 'local-naive',
    },
  };
}

function activeMembership(row, now) {
  if (row.member_status === 'active') return true;
  if (row.member_status !== 'banned' || !row.wall_ban_until) return false;
  const until = Date.parse(row.wall_ban_until);
  // Read-only equivalent of lazy ban expiry; viewing statistics never clears a
  // ban or dirties the DB. Invalid expiry dates remain banned.
  return Number.isFinite(until) && until < now.getTime();
}

function scopeContext(db, userId, wallId, now) {
  const user = db.prepare('SELECT id, role, status FROM users WHERE id=?').get(userId);
  if (!user) throw new OverviewError(401, 'OVERVIEW_ACCOUNT_MISSING', '登录账号不存在');
  if (user.status !== 'active') throw new OverviewError(403, 'OVERVIEW_ACCOUNT_UNAVAILABLE', '账号当前不可用');
  // No permissive fallback or cross-request permission cache. Revocation,
  // membership removal and permission-table errors must take effect at once.
  const overrides = loadOverrides(db, userId);
  const globalOverrides = [], wallOverrides = new Map();
  // Avoid scanning every other wall's overrides for every candidate wall.
  // The permission helper still owns precedence and known-permission checks.
  for (const override of overrides) {
    if (override.wall_id === 0) globalOverrides.push(override);
    else {
      if (!wallOverrides.has(override.wall_id)) wallOverrides.set(override.wall_id, []);
      wallOverrides.get(override.wall_id).push(override);
    }
  }
  const globalPerms = effectivePerms({ globalRole: user.role, overrides: globalOverrides, wallId: 0 });
  const globalModerate = globalPerms.has('global.moderate');
  if (!wallId && !globalModerate && !globalPerms.has('global.dashboard')) {
    throw new OverviewError(403, 'OVERVIEW_FORBIDDEN', '需要全局概览权限，或指定有统计权限的校园墙');
  }
  const select = 'SELECT w.id, substr(w.name,1,200) AS name, w.status, m.wall_role, m.status AS member_status, m.wall_ban_until FROM walls w LEFT JOIN wall_members m ON m.wall_id=w.id AND m.user_id=?';
  let candidates;
  if (wallId) {
    const wall = db.prepare(select + ' WHERE w.id=?').get(userId, wallId);
    if (!wall || wall.status !== 'active') throw new OverviewError(404, 'OVERVIEW_WALL_UNAVAILABLE', '校园墙不存在或已停用');
    candidates = [wall];
  } else {
    const restriction = globalModerate ? '' : " WHERE w.status='active' AND m.status IN ('active','banned')";
    candidates = db.prepare(select + restriction + ' ORDER BY w.id LIMIT ?').all(userId, MAX_SCOPE_WALLS + 1);
    if (candidates.length > MAX_SCOPE_WALLS) {
      throw new OverviewError(400, 'OVERVIEW_SCOPE_TOO_LARGE', '概览最多汇总 500 个候选校园墙，请通过 wall_id 指定校园墙');
    }
  }
  const walls = [];
  for (const wall of candidates) {
    const member = activeMembership(wall, now);
    if (!globalModerate && !member) continue;
    const scopedOverrides = wallOverrides.has(wall.id) ? globalOverrides.concat(wallOverrides.get(wall.id)) : globalOverrides;
    const perms = effectivePerms({ globalRole: user.role, wallRole: member ? wall.wall_role : null, overrides: scopedOverrides, wallId: wall.id });
    if (perms.has('wall.stats.view')) walls.push({ id: wall.id, name: wall.name, status: wall.status, perms });
  }
  if (wallId && walls.length === 0) throw new OverviewError(403, 'OVERVIEW_WALL_FORBIDDEN', '没有该校园墙的有效成员身份或统计权限');
  return { walls, globalPerms };
}

function grouped(db, ids, sql, before = [], after = []) {
  return ids.length ? db.prepare(sql.replace('@walls', ids.map(() => '?').join(','))).all(...before, ...ids, ...after) : [];
}
function indexRows(rows) { return new Map(rows.map(row => [row.wall_id, row])); }
function sum(rows, key) { return rows.reduce((total, row) => total + (row[key] || 0), 0); }

function systemOverview(db) {
  const memory = process.memoryUsage();
  const traffic = visits.stats();
  return {
    uptime_seconds: Math.floor(process.uptime()),
    memory: { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, heap_total_bytes: memory.heapTotal },
    database: { engine: 'sql.js', dirty: Boolean(db.dirty), temporary: Boolean(db.temporarySecret) },
    visits: {
      visitors: traffic.visitors, requests: traffic.requests, window_minutes: traffic.windowMinutes,
      scope: 'process', reset_on_restart: true,
      // Existing counters track API identities, not humans or page views;
      // identity capacity limits can undercount traffic.
      visitor_definition: 'authenticated-user-or-guest-ip', identity_limit: 50000,
      bounded: true, traffic: 'tracked-api-requests',
    },
  };
}

/**
 * Shared, synchronous, read-only builder for authenticated Bearer/cookie routes.
 * userId is a trusted authenticated ID, never an HTTP query field. Authorization
 * is independently reloaded; neither a role nor a dashboard ticket grants data.
 *
 * Totals count stored records, NOT durable audit events. Members count active
 * membership rows, not distinct people; their trend uses original creation dates.
 * Null means unavailable/not applicable; zero means an authorized empty count.
 * No message content, identity, IP, report details or filesystem paths are read.
 * At most 500 candidate walls, 100 wall rows, 90 date buckets and 30 todos;
 * fixed-count grouped SQL avoids N+1 queries and unbounded row materialization.
 */
function getOverview(db, { userId, days = 7, wallId = null, now = new Date() } = {}) {
  if (!positiveId(userId)) throw new OverviewError(401, 'OVERVIEW_AUTH_REQUIRED', '请先登录');
  days = normalizeDays(days);
  if (wallId !== null) {
    wallId = positiveId(wallId);
    if (!wallId) throw new OverviewError(400, 'INVALID_OVERVIEW_WALL', '校园墙 ID 必须是有效的正整数');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid overview clock');
  const { walls, globalPerms } = scopeContext(db, Number(userId), wallId, now);
  const window = dateWindow(now, days);
  const ids = walls.map(wall => wall.id);
  const globalStats = !wallId && (globalPerms.has('global.moderate') || globalPerms.has('global.user.manage'));
  const postRows = grouped(db, ids, 'SELECT wall_id, COUNT(*) AS posts, SUM(CASE WHEN is_anonymous=1 THEN 1 ELSE 0 END) AS anonymous_posts, SUM(CASE WHEN created_at>=? AND created_at<? THEN 1 ELSE 0 END) AS posts_in_range FROM posts WHERE wall_id IN (@walls) GROUP BY wall_id', [window.start, window.after]);
  const memberRows = grouped(db, ids, "SELECT wall_id, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS members, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_members FROM wall_members WHERE wall_id IN (@walls) GROUP BY wall_id");
  const commentRows = grouped(db, ids, 'SELECT p.wall_id, COUNT(*) AS comments FROM posts p JOIN comments c ON c.post_id=p.id WHERE p.wall_id IN (@walls) GROUP BY p.wall_id');
  // Actual like rows, not potentially stale denormalized post counters.
  const likeRows = grouped(db, ids, 'SELECT p.wall_id, COUNT(*) AS likes FROM posts p JOIN likes l ON l.post_id=p.id WHERE p.wall_id IN (@walls) GROUP BY p.wall_id');
  const voteRows = grouped(db, ids, 'SELECT wall_id, COUNT(*) AS votes FROM votes WHERE wall_id IN (@walls) GROUP BY wall_id');
  const announcementRows = grouped(db, ids, "SELECT wall_id, COUNT(*) AS announcements FROM announcements WHERE scope='wall' AND wall_id IN (@walls) GROUP BY wall_id");

  const daily = window.dates.map(date => ({ date, users: globalStats ? 0 : null, posts: 0, comments: 0, votes: 0, members: 0 }));
  const dailyByDate = new Map(daily.map(row => [row.date, row]));
  const trends = [
    ['posts', 'posts p', 'p.wall_id', 'p.created_at', ''],
    ['comments', 'comments c JOIN posts p ON p.id=c.post_id', 'p.wall_id', 'c.created_at', ''],
    ['votes', 'votes v', 'v.wall_id', 'v.created_at', ''],
    ['members', 'wall_members m', 'm.wall_id', 'm.created_at', " AND m.status='active'"],
  ];
  for (const [key, from, wallColumn, timeColumn, extra] of trends) {
    // Bare range predicates preserve wall/time indexes; date extraction is
    // applied only after filtering. SQL identifiers here are internal constants.
    const sql = 'SELECT substr(' + timeColumn + ',1,10) AS date, COUNT(*) AS count FROM ' + from + ' WHERE ' + wallColumn + ' IN (@walls) AND ' + timeColumn + '>=? AND ' + timeColumn + '<?' + extra + ' GROUP BY date';
    const rows = grouped(db, ids, sql, [], [window.start, window.after]);
    for (const row of rows) if (dailyByDate.has(row.date)) dailyByDate.get(row.date)[key] = row.count;
  }
  let users = null;
  if (globalStats) {
    users = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='banned' THEN 1 ELSE 0 END) AS banned FROM users").get();
    const rows = db.prepare('SELECT substr(created_at,1,10) AS date, COUNT(*) AS count FROM users WHERE created_at>=? AND created_at<? GROUP BY date').all(window.start, window.after);
    for (const row of rows) if (dailyByDate.has(row.date)) dailyByDate.get(row.date).users = row.count;
  }

  const approveIds = walls.filter(wall => wall.perms.has('wall.member.approve')).map(wall => wall.id);
  const postReportIds = walls.filter(wall => wall.perms.has('wall.post.report')).map(wall => wall.id);
  const safetyIds = walls.filter(wall => globalPerms.has('global.safety.handle') || wall.perms.has('wall.safety.report')).map(wall => wall.id);
  const postReportRows = grouped(db, postReportIds, "SELECT wall_id, COUNT(*) AS count FROM post_reports WHERE status='pending' AND wall_id IN (@walls) GROUP BY wall_id");
  const safetyRows = grouped(db, safetyIds, "SELECT wall_id, COUNT(*) AS count FROM reports WHERE status IN ('pending','processing') AND wall_id IN (@walls) GROUP BY wall_id");
  const approveSet = new Set(approveIds);
  const pending = {
    members: approveIds.length ? sum(memberRows.filter(row => approveSet.has(row.wall_id)), 'pending_members') : null,
    wall_applications: !wallId && globalPerms.has('global.wall.approve') ? db.prepare("SELECT COUNT(*) AS count FROM wall_applications WHERE status='pending'").get().count : null,
    post_reports: postReportIds.length ? sum(postReportRows, 'count') : null,
    safety_reports: safetyIds.length ? sum(safetyRows, 'count') : null,
    user_reports: globalPerms.has('global.report.handle') ? (wallId
      ? db.prepare("SELECT COUNT(*) AS count FROM user_reports WHERE status='pending' AND wall_id=?").get(wallId).count
      : db.prepare("SELECT COUNT(*) AS count FROM user_reports WHERE status='pending'").get().count) : null,
    bug_reports: !wallId && globalPerms.has('global.bug.handle') ? db.prepare("SELECT COUNT(*) AS count FROM bug_reports WHERE status IN ('pending','processing')").get().count : null,
  };
  pending.total = Object.values(pending).reduce((total, count) => total + (count || 0), 0);

  const posts = indexRows(postRows), members = indexRows(memberRows), comments = indexRows(commentRows), votes = indexRows(voteRows);
  const postReports = indexRows(postReportRows), safety = indexRows(safetyRows);
  const postReportSet = new Set(postReportIds), safetySet = new Set(safetyIds);
  const wallRows = walls.map(wall => ({
    id: wall.id, name: wall.name, status: wall.status,
    members: members.get(wall.id)?.members || 0,
    pending_members: approveSet.has(wall.id) ? (members.get(wall.id)?.pending_members || 0) : null,
    posts: posts.get(wall.id)?.posts || 0, comments: comments.get(wall.id)?.comments || 0,
    votes: votes.get(wall.id)?.votes || 0, posts_in_range: posts.get(wall.id)?.posts_in_range || 0,
    pending_post_reports: postReportSet.has(wall.id) ? (postReports.get(wall.id)?.count || 0) : null,
    pending_safety_reports: safetySet.has(wall.id) ? (safety.get(wall.id)?.count || 0) : null,
  }));
  const todos = [];
  const addTodo = (key, title, count, id, permission) => { if (count > 0) todos.push({ key, title, count, wall_id: id, permission }); };
  for (const wall of wallRows) {
    addTodo('members', '进墙申请', wall.pending_members, wall.id, 'wall.member.approve');
    addTodo('post_reports', '帖子举报', wall.pending_post_reports, wall.id, 'wall.post.report');
    addTodo('safety_reports', '安全举报', wall.pending_safety_reports, wall.id, globalPerms.has('global.safety.handle') ? 'global.safety.handle' : 'wall.safety.report');
  }
  addTodo('wall_applications', '建墙申请', pending.wall_applications, null, 'global.wall.approve');
  addTodo('user_reports', '用户举报', pending.user_reports, wallId, 'global.report.handle');
  addTodo('bug_reports', 'Bug 反馈', pending.bug_reports, null, 'global.bug.handle');
  todos.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key) || (a.wall_id || 0) - (b.wall_id || 0));
  wallRows.sort((a, b) => b.posts_in_range - a.posts_in_range || b.posts - a.posts || a.id - b.id);
  const { date: ignoredDate, ...today } = daily[daily.length - 1];
  return {
    schema_version: 1, generated_at: now.toISOString(),
    scope: { kind: wallId ? 'wall' : 'global', wall_id: wallId, available_wall_count: walls.length, global_stats: globalStats },
    range: window.range,
    totals: {
      users: users ? users.total : null, active_users: users ? (users.active || 0) : null, banned_users: users ? (users.banned || 0) : null,
      walls: walls.length, active_walls: walls.filter(wall => wall.status === 'active').length,
      members: sum(memberRows, 'members'), posts: sum(postRows, 'posts'), anonymous_posts: sum(postRows, 'anonymous_posts'),
      comments: sum(commentRows, 'comments'), votes: sum(voteRows, 'votes'), likes: sum(likeRows, 'likes'), announcements: sum(announcementRows, 'announcements'),
      pending: pending.total,
    },
    today, daily, walls: wallRows.slice(0, WALL_LIST_LIMIT),
    walls_meta: { limit: WALL_LIST_LIMIT, total: wallRows.length, truncated: wallRows.length > WALL_LIST_LIMIT },
    pending, todos: todos.slice(0, TODO_LIST_LIMIT),
    todos_meta: { limit: TODO_LIST_LIMIT, total: todos.length, truncated: todos.length > TODO_LIST_LIMIT },
    system: globalPerms.has('global.dashboard') ? systemOverview(db) : null,
  };
}

module.exports = { getOverview, parseOverviewQuery, OverviewError, MAX_SCOPE_WALLS, WALL_LIST_LIMIT, TODO_LIST_LIMIT };
