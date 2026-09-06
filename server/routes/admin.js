const express = require('express');
const { authRequired, requirePerm, wallContext } = require('../middleware/auth');
const {
  parseDuration, banUntilFrom, formatUntil, logBan, notify, banNotice, unbanNotice,
} = require('../lib/ban');

const router = express.Router();

// ============================================================
// 全局后台（超级管理员 / 全局管理员）
// ============================================================
const globalRouter = express.Router();
// 只做登录校验，具体权限由每条路由各自声明 —— 一刀切的 adminRequired 会让
// 「只授予某一项全局权限」变得不可能（比如只给某人处理用户举报的权限）。
globalRouter.use(authRequired);

// 全局统计
globalRouter.get('/stats', requirePerm('global.moderate'), (req, res) => {
  const db = req.db;
  res.json({
    users: {
      total: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      active: db.prepare("SELECT COUNT(*) as c FROM users WHERE status='active'").get().c,
      banned: db.prepare("SELECT COUNT(*) as c FROM users WHERE status='banned'").get().c,
    },
    walls: {
      total: db.prepare('SELECT COUNT(*) as c FROM walls').get().c,
      active: db.prepare("SELECT COUNT(*) as c FROM walls WHERE status='active'").get().c,
      pendingApps: db.prepare("SELECT COUNT(*) as c FROM wall_applications WHERE status='pending'").get().c,
    },
    posts: {
      total: db.prepare('SELECT COUNT(*) as c FROM posts').get().c,
      anonymous: db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_anonymous=1').get().c,
      today: db.prepare("SELECT COUNT(*) as c FROM posts WHERE date(created_at)=date('now')").get().c,
    },
    comments: db.prepare('SELECT COUNT(*) as c FROM comments').get().c,
    messages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    todayNewUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at)=date('now')").get().c,
  });
});

// 全局用户列表
globalRouter.get('/users', requirePerm('global.user.manage'), (req, res) => {
  const { role, status, q, limit = 50 } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (role) { where += ' AND role=?'; params.push(role); }
  if (status) { where += ' AND status=?'; params.push(status); }
  if (q) { where += ' AND (username LIKE ? OR nickname LIKE ? OR real_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const total = req.db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(...params).c;
  const users = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, class_number, role, status, ban_until, created_at
    FROM users ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(100, parseInt(limit)));
  users.forEach(u => { if (!u.show_real_name) u.real_name = ''; });
  res.json({ users, total });
});

// 修改全局角色（user <-> admin，仅超管；super_admin 用 assign-role）
globalRouter.put('/users/:id/role', requirePerm('global.user.manage'), (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: '无效角色' });
  if (role === 'admin' && !req.can('global.user.role')) return res.status(403).json({ error: '仅超级管理员可设置全局管理员' });

  const user = req.db.prepare('SELECT id, role FROM users WHERE id=?').get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'super_admin') return res.status(403).json({ error: '不能修改超级管理员' });

  req.db.prepare('UPDATE users SET role=? WHERE id=?').run(role, parseInt(req.params.id));
  const label = role === 'admin' ? '全局管理员' : '普通用户';
  req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content) VALUES (NULL,?,'system',?,?)")
    .run(parseInt(req.params.id), '全局角色变更', `你的全局角色已被设置为：${label}`);
  res.json({ message: '角色已更新' });
});

// 超管分配任意全局角色（含 super_admin）
globalRouter.put('/users/:id/assign-role', requirePerm('global.user.role'), (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'super_admin'].includes(role)) return res.status(400).json({ error: '无效角色' });

  const userId = parseInt(req.params.id);
  const user = req.db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'super_admin' && role !== 'super_admin') {
    const count = req.db.prepare("SELECT COUNT(*) as c FROM users WHERE role='super_admin'").get().c;
    if (count <= 1) return res.status(400).json({ error: '至少保留一名超级管理员' });
  }
  if (role === 'super_admin') {
    const count = req.db.prepare("SELECT COUNT(*) as c FROM users WHERE role='super_admin'").get().c;
    if (count >= 5) return res.status(400).json({ error: '超级管理员数量已达上限(5人)' });
  }

  req.db.prepare('UPDATE users SET role=? WHERE id=?').run(role, userId);
  const roleLabels = { super_admin: '超级管理员', admin: '全局管理员', user: '普通用户' };
  req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content) VALUES (NULL,?,'system',?,?)")
    .run(userId, '全局角色变更', `你的全局角色已被超级管理员设置为: ${roleLabels[role]}`);
  res.json({ message: `角色已设置为 ${roleLabels[role]}` });
});

// 封禁（全局）
globalRouter.put('/users/:id/ban', requirePerm('global.user.ban'), (req, res) => {
  const { banned, duration, reason, ban_level } = req.body;
  const userId = parseInt(req.params.id);
  const user = req.db.prepare('SELECT id, nickname, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 权限边界：不能封自己，超管不可被封，普通管理员不能封同级
  if (userId === req.user.id) return res.status(403).json({ error: '不能封禁自己' });
  if (user.role === 'super_admin') return res.status(403).json({ error: '不能封禁超级管理员' });
  if (user.role === 'admin' && !req.can('global.user.role')) {
    return res.status(403).json({ error: '只有超级管理员才能封禁全局管理员' });
  }

  if (banned) {
    const d = parseDuration(duration);
    if (!d.ok) return res.status(400).json({ error: d.error });

    const cleanReason = (reason || '').trim();
    const banUntil = banUntilFrom(d.minutes);
    const level = ['login', 'post', 'chat', 'all'].includes(ban_level) ? ban_level : 'login';
    req.db.prepare("UPDATE users SET status='banned', ban_until=?, ban_reason=?, ban_level=? WHERE id=?")
      .run(banUntil, cleanReason, level, userId);

    logBan(req.db, {
      scope: 'global', targetUserId: userId, operatorId: req.user.id,
      action: 'ban', durationMinutes: d.minutes, reason: cleanReason,
    });
    const note = banNotice({ scope: 'global', minutes: d.minutes, until: banUntil, reason: cleanReason });
    notify(req.db, userId, note.title, note.content);

    const levelLabels = { login: '禁止登录', post: '禁止发帖', chat: '禁止聊天', all: '全部禁止' };
    res.json({ message: `${levelLabels[level]}${banUntil ? '至 ' + formatUntil(banUntil) : '（永久）'}` });
  } else {
    req.db.prepare("UPDATE users SET status='active', ban_until='', ban_reason='', ban_level='login' WHERE id=?").run(userId);
    logBan(req.db, {
      scope: 'global', targetUserId: userId, operatorId: req.user.id, action: 'unban',
    });
    const note = unbanNotice({ scope: 'global' });
    notify(req.db, userId, note.title, note.content);
    res.json({ message: '已解封' });
  }
});

// 封禁审计日志（全局管理员可查；可按用户 / 墙筛选）
globalRouter.get('/ban-logs', requirePerm('global.moderate'), (req, res) => {
  const { user_id, wall_id, scope } = req.query;
  const where = [];
  const params = [];
  if (user_id) { where.push('b.target_user_id = ?'); params.push(parseInt(user_id)); }
  if (wall_id) { where.push('b.wall_id = ?'); params.push(parseInt(wall_id)); }
  if (scope === 'global' || scope === 'wall') { where.push('b.scope = ?'); params.push(scope); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const logs = req.db.prepare(`
    SELECT b.*, t.username AS target_username, t.nickname AS target_nickname,
           o.username AS operator_username, o.nickname AS operator_nickname,
           w.name AS wall_name
    FROM ban_logs b
    LEFT JOIN users t ON t.id = b.target_user_id
    LEFT JOIN users o ON o.id = b.operator_id
    LEFT JOIN walls w ON w.id = b.wall_id
    ${clause}
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT 200
  `).all(...params);
  res.json(logs);
});

// 删除用户（仅超管）
globalRouter.delete('/users/:id', requirePerm('global.user.delete'), (req, res) => {
  const userId = parseInt(req.params.id);
  const user = req.db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'super_admin') return res.status(403).json({ error: '不能删除超级管理员' });

  const ownedWall = req.db.prepare("SELECT name FROM walls WHERE owner_id=? AND status='active'").get(userId);
  if (ownedWall) return res.status(400).json({ error: `该用户是「${ownedWall.name}」的墙主，请先转让墙主` });

  req.db.prepare('DELETE FROM comments WHERE author_id=?').run(userId);
  req.db.prepare('DELETE FROM likes WHERE user_id=?').run(userId);
  req.db.prepare('DELETE FROM vote_records WHERE user_id=?').run(userId);
  req.db.prepare('DELETE FROM friends WHERE user_id=? OR friend_id=?').run(userId, userId);
  req.db.prepare('DELETE FROM messages WHERE sender_id=? OR receiver_id=?').run(userId, userId);
  req.db.prepare('DELETE FROM posts WHERE author_id=?').run(userId);
  req.db.prepare('DELETE FROM votes WHERE author_id=?').run(userId);
  req.db.prepare('DELETE FROM wall_members WHERE user_id=?').run(userId);
  req.db.prepare('DELETE FROM wall_applications WHERE applicant_id=?').run(userId);
  req.db.prepare('DELETE FROM post_reports WHERE reporter_id=?').run(userId);
  req.db.prepare('DELETE FROM user_reports WHERE reporter_id=? OR reported_user_id=?').run(userId, userId);
  req.db.prepare('DELETE FROM reports WHERE reporter_id=?').run(userId);
  req.db.prepare('DELETE FROM bug_reports WHERE reporter_id=?').run(userId);
  req.db.prepare('DELETE FROM bookmarks WHERE user_id=?').run(userId);
  req.db.prepare('DELETE FROM users WHERE id=?').run(userId);
  res.json({ message: '账号已删除' });
});

// 全局删除帖子（全局管理员可删任意墙）
globalRouter.delete('/posts/:id', requirePerm('global.moderate'), (req, res) => {
  const id = parseInt(req.params.id);
  req.db.prepare('DELETE FROM comments WHERE post_id=?').run(id);
  req.db.prepare('DELETE FROM likes WHERE post_id=?').run(id);
  req.db.prepare('DELETE FROM post_reports WHERE post_id=?').run(id);
  req.db.prepare('DELETE FROM posts WHERE id=?').run(id);
  res.json({ message: '帖子已删除' });
});

// ===== 用户举报管理（全局，跨墙） =====
globalRouter.get('/user-reports', requirePerm('global.report.handle'), (req, res) => {
  const { status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (status && ['pending', 'resolved', 'rejected'].includes(status)) {
    where += ' AND ur.status = ?';
    params.push(status);
  }
  const reports = req.db.prepare(`
    SELECT ur.*,
      reporter.nickname as reporter_name,
      reported.nickname as reported_name, reported.username as reported_username,
      w.name as wall_name,
      (SELECT COUNT(*) FROM user_reports WHERE reported_user_id = ur.reported_user_id) as total_reports_count
    FROM user_reports ur
    JOIN users reporter ON ur.reporter_id = reporter.id
    JOIN users reported ON ur.reported_user_id = reported.id
    LEFT JOIN walls w ON ur.wall_id = w.id
    ${where}
    ORDER BY ur.created_at DESC LIMIT 50
  `).all(...params);
  res.json(reports);
});

globalRouter.put('/user-reports/:id/review', requirePerm('global.report.handle'), (req, res) => {
  const { action, warning_text, feedback } = req.body;
  if (!['ban', 'permanent_ban', 'warn', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });

  const report = req.db.prepare('SELECT * FROM user_reports WHERE id=?').get(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: '举报不存在' });
  if (report.status !== 'pending') return res.status(400).json({ error: '该举报已处理' });

  let actionLabel = '';
  // 举报处置产生的封禁同样要记原因、写日志、通知本人
  const banReason = (req.body.reason || '').trim() || `举报处理：${report.reason || '违规内容'}`;
  if (action === 'ban' || action === 'permanent_ban') {
    let minutes = 0;
    if (action === 'ban') {
      const d = parseDuration(req.body.duration ?? 1440);
      if (!d.ok) return res.status(400).json({ error: d.error });
      minutes = d.minutes || 1440; // 定时封号未给时长时默认 1 天
    }
    const banUntil = banUntilFrom(minutes);
    req.db.prepare("UPDATE users SET status='banned', ban_until=?, ban_reason=? WHERE id=?")
      .run(banUntil, banReason, report.reported_user_id);

    logBan(req.db, {
      scope: 'global', targetUserId: report.reported_user_id, operatorId: req.user.id,
      action: 'ban', durationMinutes: minutes, reason: banReason,
    });
    const note = banNotice({ scope: 'global', minutes, until: banUntil, reason: banReason });
    notify(req.db, report.reported_user_id, note.title, note.content);

    actionLabel = minutes > 0 ? `封号${minutes}分钟` : '永久封号';
  } else if (action === 'warn') {
    if (!warning_text || !warning_text.trim()) return res.status(400).json({ error: '请填写警告内容' });
    notify(req.db, report.reported_user_id, '警告通知', warning_text.trim());
    actionLabel = '警告';
  } else {
    actionLabel = '驳回';
  }

  req.db.prepare(`
    UPDATE user_reports SET status='resolved', action_taken=?, reviewer_id=?, feedback=?, reviewed_at=datetime('now','localtime') WHERE id=?
  `).run(actionLabel, req.user.id, feedback || '', report.id);

  req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content) VALUES (NULL,?,'system',?,?)")
    .run(report.reporter_id, '举报处理结果', `你对用户的举报已处理。处理结果: ${actionLabel}${feedback && feedback.trim() ? '\n' + feedback.trim() : ''}`);

  res.json({ message: `已${actionLabel}` });
});

globalRouter.delete('/user-reports/:id', requirePerm('global.report.handle'), (req, res) => {
  const result = req.db.prepare('DELETE FROM user_reports WHERE id=?').run(parseInt(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '举报不存在' });
  res.json({ message: '已删除' });
});

// ============================================================
// 墙后台（墙主 / 墙管理员 / 全局管理员）—— 需 X-Wall-Id
// ============================================================
const wallRouter = express.Router();
// 同上：只解析墙上下文，权限逐条声明
wallRouter.use(authRequired, wallContext);

// 本墙统计
wallRouter.get('/stats', requirePerm('wall.stats.view'), (req, res) => {
  const db = req.db, wid = req.wallId;
  res.json({
    members: {
      total: db.prepare("SELECT COUNT(*) as c FROM wall_members WHERE wall_id=? AND status='active'").get(wid).c,
      pending: db.prepare("SELECT COUNT(*) as c FROM wall_members WHERE wall_id=? AND status='pending'").get(wid).c,
      admins: db.prepare("SELECT COUNT(*) as c FROM wall_members WHERE wall_id=? AND wall_role='admin' AND status='active'").get(wid).c,
    },
    posts: {
      total: db.prepare('SELECT COUNT(*) as c FROM posts WHERE wall_id=?').get(wid).c,
      today: db.prepare("SELECT COUNT(*) as c FROM posts WHERE wall_id=? AND date(created_at)=date('now')").get(wid).c,
    },
    votes: db.prepare('SELECT COUNT(*) as c FROM votes WHERE wall_id=?').get(wid).c,
    pendingPostReports: db.prepare("SELECT COUNT(*) as c FROM post_reports WHERE wall_id=? AND status='pending'").get(wid).c,
  });
});

// 本墙公告
wallRouter.get('/announcements', requirePerm('wall.announcement'), (req, res) => {
  req.db.prepare("DELETE FROM announcements WHERE delete_at IS NOT NULL AND delete_at != '' AND datetime(delete_at) < datetime('now')").run();
  res.json(req.db.prepare(`
    SELECT a.*, u.nickname as author_name FROM announcements a JOIN users u ON a.author_id=u.id
    WHERE a.wall_id=? OR a.scope='global'
    ORDER BY a.scope='global' DESC, a.is_pinned DESC, a.created_at DESC
  `).all(req.wallId));
});

// 一条全局公告要给全站每个人写一条站内信。现在只有个位数用户无所谓，
// 但这是个会随注册量线性增长的同步循环 —— 超过这个数就拒绝，
// 免得某天一条公告把事件循环卡死几十秒。真要广播需要改成后台分批。
const BROADCAST_LIMIT = 2000;

wallRouter.post('/announcements', (req, res) => {
  const { title, content, is_pinned, delete_at, is_markdown } = req.body;
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });

  // 作用域：'wall' 只发本墙，'global' 全站。两者要的权限不同。
  const scope = req.body.scope === 'global' ? 'global' : 'wall';
  const needed = scope === 'global' ? 'global.announcement' : 'wall.announcement';
  if (!req.can(needed)) {
    return res.status(403).json({
      error: scope === 'global' ? '需要发布全局公告的权限' : '需要本墙公告管理权限',
    });
  }

  // 全局公告不属于任何墙，wall_id 存 0
  const wallId = scope === 'global' ? 0 : req.wallId;

  const recipients = scope === 'global'
    ? req.db.prepare("SELECT id FROM users WHERE status='active'").all()
    : req.db.prepare("SELECT user_id AS id FROM wall_members WHERE wall_id=? AND status='active'").all(req.wallId);

  if (recipients.length > BROADCAST_LIMIT) {
    return res.status(400).json({
      error: `接收人数(${recipients.length})超过单次广播上限(${BROADCAST_LIMIT})，请联系维护者改用后台分批下发`,
    });
  }

  const result = req.db.prepare(`
    INSERT INTO announcements (wall_id, title, content, author_id, is_pinned, delete_at, is_markdown, scope)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(wallId, title, content, req.user.id, is_pinned ? 1 : 0, delete_at || '', is_markdown ? 1 : 0, scope);

  // 收件箱里只放节选，且不提供跳转入口 —— 补一句话指向顶栏的公告入口。
  const preview = content.length > 200
    ? content.substring(0, 200) + '\n\n…（内容较长，完整公告见顶栏的公告入口）'
    : content;
  const msgTitle = scope === 'global' ? `[全站公告] ${title}` : title;
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content) VALUES (NULL,?,?,'announcement',?,?)");
  recipients.forEach(u => ins.run(u.id, wallId, msgTitle, preview));

  res.json({ id: result.lastInsertRowid, message: scope === 'global' ? '全站公告已发布' : '公告已发布' });
});

wallRouter.delete('/announcements/:id', (req, res) => {
  const ann = req.db.prepare('SELECT id, wall_id, scope FROM announcements WHERE id=?').get(parseInt(req.params.id));
  if (!ann) return res.status(404).json({ error: '公告不存在' });
  // 全局公告不属于任何墙，只能由持有全局公告权限的人删
  const needed = ann.scope === 'global' ? 'global.announcement' : 'wall.announcement';
  if (!req.can(needed) || (ann.scope !== 'global' && ann.wall_id !== req.wallId)) {
    return res.status(403).json({ error: '权限不足' });
  }
  const r = req.db.prepare('DELETE FROM announcements WHERE id=?').run(ann.id);
  if (r.changes === 0) return res.status(404).json({ error: '公告不存在' });
  res.json({ message: '已删除' });
});

// 本墙分类
wallRouter.get('/categories', requirePerm('wall.category'), (req, res) => {
  const cats = req.db.prepare('SELECT category, COUNT(*) as count FROM posts WHERE wall_id=? GROUP BY category ORDER BY count DESC').all(req.wallId);
  res.json(cats);
});

wallRouter.delete('/categories/:name', requirePerm('wall.category'), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const defaultCategories = ['吐槽', '分享', '求助', '讨论', '其他'];
  if (defaultCategories.includes(name)) {
    return res.status(400).json({ error: '不能删除默认分类' });
  }
  const result = req.db.prepare("UPDATE posts SET category='其他' WHERE wall_id=? AND category=?").run(req.wallId, name);
  res.json({ message: `已删除分类"${name}"，${result.changes}个帖子已移至"其他"` });
});

// 本墙帖子举报
wallRouter.get('/post-reports', requirePerm('wall.post.report'), (req, res) => {
  const { status } = req.query;
  let where = 'WHERE pr.wall_id = ?';
  const params = [req.wallId];
  if (status && ['pending', 'resolved', 'rejected'].includes(status)) {
    where += ' AND pr.status = ?';
    params.push(status);
  }
  const reports = req.db.prepare(`
    SELECT pr.*, u.nickname as reporter_name, p.content as post_content, p.category as post_category
    FROM post_reports pr
    JOIN users u ON pr.reporter_id = u.id
    LEFT JOIN posts p ON pr.post_id = p.id
    ${where}
    ORDER BY pr.created_at DESC LIMIT 50
  `).all(...params);
  res.json(reports);
});

wallRouter.put('/post-reports/:id/review', requirePerm('wall.post.report'), (req, res) => {
  const { action } = req.body;
  if (!['resolve', 'reject', 'delete_post'].includes(action)) return res.status(400).json({ error: '无效操作' });

  const report = req.db.prepare('SELECT * FROM post_reports WHERE id=? AND wall_id=?').get(parseInt(req.params.id), req.wallId);
  if (!report) return res.status(404).json({ error: '举报不存在' });

  if (action === 'delete_post') {
    req.db.prepare('DELETE FROM comments WHERE post_id=?').run(report.post_id);
    req.db.prepare('DELETE FROM likes WHERE post_id=?').run(report.post_id);
    req.db.prepare('DELETE FROM posts WHERE id=?').run(report.post_id);
    req.db.prepare("UPDATE post_reports SET status='resolved', reviewer_id=?, reviewed_at=datetime('now','localtime') WHERE id=?")
      .run(req.user.id, report.id);
    res.json({ message: '帖子已删除，举报已处理' });
  } else if (action === 'resolve') {
    req.db.prepare("UPDATE post_reports SET status='resolved', reviewer_id=?, reviewed_at=datetime('now','localtime') WHERE id=?")
      .run(req.user.id, report.id);
    res.json({ message: '举报已标记为已处理' });
  } else {
    req.db.prepare("UPDATE post_reports SET status='rejected', reviewer_id=?, reviewed_at=datetime('now','localtime') WHERE id=?")
      .run(req.user.id, report.id);
    res.json({ message: '举报已驳回' });
  }
});

wallRouter.delete('/post-reports/:id', requirePerm('wall.post.report'), (req, res) => {
  const result = req.db.prepare('DELETE FROM post_reports WHERE id=? AND wall_id=?').run(parseInt(req.params.id), req.wallId);
  if (result.changes === 0) return res.status(404).json({ error: '举报不存在' });
  res.json({ message: '已删除' });
});

// 挂载：/api/admin/wall/* 为墙后台；其余为全局后台
router.use('/wall', wallRouter);
router.use('/', globalRouter);

module.exports = router;
