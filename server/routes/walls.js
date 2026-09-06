const express = require('express');
const { authRequired, requirePerm, wallPathContext } = require('../middleware/auth');
const { parseDuration, banUntilFrom, formatUntil, logBan, banNotice, unbanNotice } = require('../lib/ban');

const router = express.Router();

const MAX_WALL_ADMINS = 5;

// link 是收件箱里这条通知的跳转目标（前端路径），留空则该消息不可点击。
// wallId 让前端在跳转前先切到对应的墙 —— /admin 的墙内面板都按当前墙加载，
// 不带这个的话管理员点进去看到的是自己当前所在墙的列表，而不是申请所属的墙。
function notify(db, userIds, title, content, link = '', wallId = 0) {
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (NULL,?,?,'system',?,?,?)");
  userIds.forEach(id => ins.run(id, wallId, title, content, link));
}

// 该墙的管理者（墙主+墙管理员）+ 全局超管，用于审批通知
function wallApprovers(db, wallId) {
  const wallMods = db.prepare(
    "SELECT user_id FROM wall_members WHERE wall_id=? AND status='active' AND wall_role IN ('owner','admin')"
  ).all(wallId).map(r => r.user_id);
  const supers = db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all().map(r => r.id);
  return [...new Set([...wallMods, ...supers])];
}

// ===== 我加入的墙 =====
router.get('/', authRequired, (req, res) => {
  const walls = req.db.prepare(`
    SELECT w.id, w.name, w.description, w.owner_id, w.require_join_approval, w.status,
           wm.wall_role, wm.status as member_status
    FROM wall_members wm
    JOIN walls w ON wm.wall_id = w.id
    WHERE wm.user_id = ? AND w.status = 'active'
    ORDER BY wm.created_at ASC
  `).all(req.user.id);
  res.json(walls);
});

// ===== 发现可加入的墙 =====
router.get('/discover', authRequired, (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const walls = req.db.prepare(`
    SELECT w.id, w.name, w.description, w.require_join_approval,
      (SELECT COUNT(*) FROM wall_members m WHERE m.wall_id=w.id AND m.status='active') as member_count,
      (SELECT status FROM wall_members m2 WHERE m2.wall_id=w.id AND m2.user_id=?) as my_status
    FROM walls w
    WHERE w.status='active' AND (? = '' OR w.name LIKE ?)
    ORDER BY member_count DESC LIMIT 50
  `).all(req.user.id, q, like);
  res.json(walls);
});

// ===== 单个墙信息 =====
router.get('/:id', authRequired, (req, res) => {
  const wall = req.db.prepare(`
    SELECT w.*, u.nickname as owner_name,
      (SELECT COUNT(*) FROM wall_members m WHERE m.wall_id=w.id AND m.status='active') as member_count
    FROM walls w LEFT JOIN users u ON w.owner_id=u.id WHERE w.id=?
  `).get(parseInt(req.params.id));
  if (!wall) return res.status(404).json({ error: '校园墙不存在' });
  const m = req.db.prepare("SELECT wall_role, status FROM wall_members WHERE wall_id=? AND user_id=?").get(wall.id, req.user.id);
  wall.my_role = m?.status === 'active' ? m.wall_role : null;
  wall.my_status = m?.status || null;
  res.json(wall);
});

// ===== 修改墙资料（墙主 / 超级管理员，或被单独授予 wall.edit 的人） =====
// 刻意不开放改 name：walls.name 有 UNIQUE 约束，而且墙名被写进了大量历史站内信正文，
// 改名会让那些通知对不上账，需要单独设计。
router.put('/:id', authRequired, wallPathContext, requirePerm('wall.edit'), (req, res) => {
  const { description, require_join_approval } = req.body;
  const sets = [];
  const params = [];

  if (description !== undefined) {
    const d = String(description || '').trim();
    if (d.length > 500) return res.status(400).json({ error: '墙介绍不能超过500字' });
    sets.push('description = ?');
    params.push(d);
  }
  if (require_join_approval !== undefined) {
    sets.push('require_join_approval = ?');
    params.push(require_join_approval ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: '没有要修改的内容' });

  params.push(req.wallId);
  req.db.prepare(`UPDATE walls SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const wall = req.db.prepare('SELECT id, name, description, require_join_approval FROM walls WHERE id=?').get(req.wallId);
  res.json({ message: '校园墙资料已更新', wall });
});

// ===== 申请创建新墙（发给超级管理员审批） =====
router.post('/apply-create', authRequired, (req, res) => {
  const { wall_name, description } = req.body;
  const name = (wall_name || '').trim();
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: '墙名称长度2-30个字符' });

  const exists = req.db.prepare('SELECT id FROM walls WHERE name=?').get(name);
  if (exists) return res.status(400).json({ error: '该校园墙名称已存在' });
  const dupApp = req.db.prepare("SELECT id FROM wall_applications WHERE wall_name=? AND status='pending'").get(name);
  if (dupApp) return res.status(400).json({ error: '已有同名的待审批申请' });

  req.db.prepare(`
    INSERT INTO wall_applications (applicant_id, wall_name, description) VALUES (?,?,?)
  `).run(req.user.id, name, (description || '').trim());

  const applicant = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all().map(r => r.id);
  notify(req.db, supers, '新建墙申请', `${applicant?.nickname || '用户'} 申请创建校园墙「${name}」，请前往管理后台审批`, '/admin?panel=wallApps');

  res.json({ message: '建墙申请已提交，请等待超级管理员审批' });
});

// ===== 申请加入墙 =====
router.post('/:id/join', authRequired, (req, res) => {
  const wallId = parseInt(req.params.id);
  const wall = req.db.prepare("SELECT id, name, require_join_approval, status FROM walls WHERE id=?").get(wallId);
  if (!wall || wall.status !== 'active') return res.status(404).json({ error: '校园墙不存在或已停用' });

  const existing = req.db.prepare("SELECT id, status FROM wall_members WHERE wall_id=? AND user_id=?").get(wallId, req.user.id);
  if (existing) {
    if (existing.status === 'active') return res.status(400).json({ error: '你已是该墙成员' });
    return res.status(400).json({ error: '你的加入申请正在审批中' });
  }

  const autoJoin = wall.require_join_approval === 0;
  const status = autoJoin ? 'active' : 'pending';
  req.db.prepare(
    "INSERT INTO wall_members (wall_id, user_id, wall_role, status) VALUES (?,?, 'member', ?)"
  ).run(wallId, req.user.id, status);

  if (autoJoin) {
    return res.json({ message: `已加入「${wall.name}」`, status: 'active' });
  }

  const applicant = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  notify(req.db, wallApprovers(req.db, wallId), '新的进墙申请', `${applicant?.nickname || '用户'} 申请加入「${wall.name}」，请前往管理后台审批`, '/admin?panel=members', wallId);
  res.json({ message: '进墙申请已提交，请等待审批', status: 'pending' });
});

// ===== 退出墙 =====
router.post('/:id/leave', authRequired, (req, res) => {
  const wallId = parseInt(req.params.id);
  const m = req.db.prepare("SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=?").get(wallId, req.user.id);
  if (!m) return res.status(404).json({ error: '你不是该墙成员' });
  if (m.wall_role === 'owner') return res.status(400).json({ error: '墙主不能退出，请先转让墙主' });
  req.db.prepare("DELETE FROM wall_members WHERE wall_id=? AND user_id=?").run(wallId, req.user.id);
  res.json({ message: '已退出该校园墙' });
});

// ===== 墙成员列表（墙管理者可见） =====
router.get('/:id/members', authRequired, wallPathContext, requirePerm('wall.member.view'), (req, res) => {
  const status = req.query.status;
  let where = 'WHERE wm.wall_id = ?';
  const params = [req.wallId];
  if (status && ['pending', 'active', 'banned'].includes(status)) { where += ' AND wm.status=?'; params.push(status); }

  const members = req.db.prepare(`
    SELECT wm.id, wm.user_id, wm.wall_role, wm.status, wm.created_at,
           wm.wall_ban_until, wm.wall_ban_reason,
           u.username, u.nickname, u.avatar, u.real_name, u.show_real_name
    FROM wall_members wm JOIN users u ON wm.user_id=u.id
    ${where}
    ORDER BY CASE wm.wall_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'tree_hole' THEN 2 ELSE 3 END, wm.created_at ASC
  `).all(...params);
  members.forEach(m => { if (!m.show_real_name) m.real_name = ''; });
  res.json(members);
});

// ===== 审批进墙申请 =====
router.post('/:id/members/:uid/approve', authRequired, wallPathContext, requirePerm('wall.member.approve'), (req, res) => {
  const uid = parseInt(req.params.uid);
  const m = req.db.prepare("SELECT id, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m || m.status !== 'pending') return res.status(404).json({ error: '没有待审批的申请' });

  req.db.prepare("UPDATE wall_members SET status='active' WHERE id=?").run(m.id);
  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  notify(req.db, [uid], '进墙申请已通过', `你加入「${wall?.name || '校园墙'}」的申请已通过`, '/walls');
  res.json({ message: '已通过' });
});

router.post('/:id/members/:uid/reject', authRequired, wallPathContext, requirePerm('wall.member.approve'), (req, res) => {
  const uid = parseInt(req.params.uid);
  const m = req.db.prepare("SELECT id, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m || m.status !== 'pending') return res.status(404).json({ error: '没有待审批的申请' });

  req.db.prepare("DELETE FROM wall_members WHERE id=?").run(m.id);
  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  notify(req.db, [uid], '进墙申请未通过', `你加入「${wall?.name || '校园墙'}」的申请未通过`, '/walls');
  res.json({ message: '已拒绝' });
});

// ===== 移除成员（墙主/超管） =====
router.post('/:id/members/:uid/remove', authRequired, wallPathContext, requirePerm('wall.member.remove'), (req, res) => {
  const uid = parseInt(req.params.uid);
  const m = req.db.prepare("SELECT id, wall_role FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m) return res.status(404).json({ error: '该用户不是墙成员' });
  if (m.wall_role === 'owner') return res.status(400).json({ error: '不能移除墙主' });
  req.db.prepare("DELETE FROM wall_members WHERE id=?").run(m.id);
  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  notify(req.db, [uid], '已被移出校园墙', `你已被移出「${wall?.name || '校园墙'}」`, '/walls');
  res.json({ message: '已移除' });
});

// ===== 墙内封禁（墙主/墙管理员/全局管理员） =====
// 与全局封禁相互独立：被墙内封禁的人在其它校园墙照常使用。
router.post('/:id/members/:uid/ban', authRequired, wallPathContext, requirePerm('wall.member.ban'), (req, res) => {
  const uid = parseInt(req.params.uid);
  const { duration, reason } = req.body;

  if (uid === req.user.id) return res.status(403).json({ error: '不能封禁自己' });

  const m = req.db.prepare("SELECT id, wall_role, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m) return res.status(404).json({ error: '该用户不是墙成员' });
  if (m.wall_role === 'owner') return res.status(403).json({ error: '不能封禁墙主' });
  // 墙管理员之间不能互封，只有墙主/超管可以处理管理员
  // 封禁墙内管理员比封禁普通成员高一级：原判据是「墙主或超级管理员」，
  // 对应到权限就是持有分配墙内角色的能力（墙管理员默认没有）。
  if (m.wall_role === 'admin' && !req.can('wall.member.role')) {
    return res.status(403).json({ error: '只有墙主或超级管理员才能封禁墙内管理员' });
  }

  const d = parseDuration(duration);
  if (!d.ok) return res.status(400).json({ error: d.error });

  const cleanReason = (reason || '').trim();
  const until = banUntilFrom(d.minutes);
  req.db.prepare("UPDATE wall_members SET status='banned', wall_ban_until=?, wall_ban_reason=? WHERE id=?")
    .run(until, cleanReason, m.id);

  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  logBan(req.db, {
    scope: 'wall', wallId: req.wallId, targetUserId: uid, operatorId: req.user.id,
    action: 'ban', durationMinutes: d.minutes, reason: cleanReason,
  });
  const note = banNotice({ scope: 'wall', wallName: wall?.name || '校园墙', minutes: d.minutes, until, reason: cleanReason });
  notify(req.db, [uid], note.title, note.content);

  res.json({ message: until ? `已封禁至 ${formatUntil(until)}` : '已永久封禁' });
});

// ===== 解除墙内封禁 =====
router.post('/:id/members/:uid/unban', authRequired, wallPathContext, requirePerm('wall.member.ban'), (req, res) => {
  const uid = parseInt(req.params.uid);
  const m = req.db.prepare("SELECT id, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m) return res.status(404).json({ error: '该用户不是墙成员' });
  if (m.status !== 'banned') return res.status(400).json({ error: '该成员当前未被封禁' });

  req.db.prepare("UPDATE wall_members SET status='active', wall_ban_until='', wall_ban_reason='' WHERE id=?").run(m.id);
  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  logBan(req.db, {
    scope: 'wall', wallId: req.wallId, targetUserId: uid, operatorId: req.user.id, action: 'unban',
  });
  const note = unbanNotice({ scope: 'wall', wallName: wall?.name || '校园墙' });
  notify(req.db, [uid], note.title, note.content);

  res.json({ message: '已解除封禁' });
});

// ===== 本墙封禁日志（墙主/墙管理员可查） =====
router.get('/:id/ban-logs', authRequired, wallPathContext, requirePerm('wall.ban_log.view'), (req, res) => {
  const logs = req.db.prepare(`
    SELECT b.*, t.username AS target_username, t.nickname AS target_nickname,
           o.username AS operator_username, o.nickname AS operator_nickname
    FROM ban_logs b
    LEFT JOIN users t ON t.id = b.target_user_id
    LEFT JOIN users o ON o.id = b.operator_id
    WHERE b.scope='wall' AND b.wall_id = ?
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT 200
  `).all(req.wallId);
  res.json(logs);
});

// ===== 分配墙内角色（墙主/超管） =====
// wall_role: admin | tree_hole | member  （owner 通过 transfer-owner 转让）
router.put('/:id/members/:uid/role', authRequired, wallPathContext, requirePerm('wall.member.role'), (req, res) => {
  const { wall_role } = req.body;
  if (!['admin', 'tree_hole', 'member'].includes(wall_role)) return res.status(400).json({ error: '无效的墙内角色' });

  const uid = parseInt(req.params.uid);
  const m = req.db.prepare("SELECT id, wall_role, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, uid);
  if (!m || m.status !== 'active') return res.status(404).json({ error: '该用户不是有效墙成员' });
  if (m.wall_role === 'owner') return res.status(400).json({ error: '不能修改墙主的角色，请使用转让墙主' });

  if (wall_role === 'admin' && m.wall_role !== 'admin') {
    const adminCount = req.db.prepare("SELECT COUNT(*) as c FROM wall_members WHERE wall_id=? AND wall_role='admin' AND status='active'").get(req.wallId).c;
    if (adminCount >= MAX_WALL_ADMINS) return res.status(400).json({ error: `校园墙管理员已达上限(${MAX_WALL_ADMINS}人)` });
  }

  req.db.prepare("UPDATE wall_members SET wall_role=? WHERE id=?").run(wall_role, m.id);
  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  const labels = { admin: `${wall?.name || ''}校园墙管理员`, tree_hole: '树洞志愿者', member: '成员' };
  notify(req.db, [uid], '墙内角色变更', `你在「${wall?.name || '校园墙'}」的身份已变更为：${labels[wall_role]}`);
  res.json({ message: '墙内角色已更新' });
});

// ===== 转让墙主（现任墙主或超级管理员） =====
router.put('/:id/transfer-owner', authRequired, wallPathContext, requirePerm('wall.transfer'), (req, res) => {
  const newOwnerId = parseInt(req.body.new_owner_id);
  if (!newOwnerId) return res.status(400).json({ error: '请指定新墙主' });

  const target = req.db.prepare("SELECT id, status FROM wall_members WHERE wall_id=? AND user_id=?").get(req.wallId, newOwnerId);
  if (!target || target.status !== 'active') return res.status(400).json({ error: '新墙主必须是该墙的有效成员' });

  const currentOwner = req.db.prepare("SELECT user_id FROM wall_members WHERE wall_id=? AND wall_role='owner'").get(req.wallId);
  // 旧墙主降为墙管理员（若名额已满则降为成员）
  if (currentOwner) {
    const adminCount = req.db.prepare("SELECT COUNT(*) as c FROM wall_members WHERE wall_id=? AND wall_role='admin' AND status='active'").get(req.wallId).c;
    const demoteRole = adminCount < MAX_WALL_ADMINS ? 'admin' : 'member';
    req.db.prepare("UPDATE wall_members SET wall_role=? WHERE wall_id=? AND user_id=?").run(demoteRole, req.wallId, currentOwner.user_id);
  }
  req.db.prepare("UPDATE wall_members SET wall_role='owner' WHERE wall_id=? AND user_id=?").run(req.wallId, newOwnerId);
  req.db.prepare("UPDATE walls SET owner_id=? WHERE id=?").run(newOwnerId, req.wallId);

  const wall = req.db.prepare("SELECT name FROM walls WHERE id=?").get(req.wallId);
  notify(req.db, [newOwnerId], '你已成为墙主', `你已成为「${wall?.name || '校园墙'}」的墙主`, '/admin', req.wallId);
  res.json({ message: '墙主已转让' });
});


module.exports = router;
