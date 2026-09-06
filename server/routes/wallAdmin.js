const express = require('express');
const { authRequired, requirePerm } = require('../middleware/auth');

const router = express.Router();

// 需要「审批建墙申请」权限时用它给申请人发通知
function notify(db, userIds, title, content, link = '') {
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (NULL,?,0,'system',?,?,?)");
  userIds.forEach(id => ins.run(id, title, content, link));
}

// ================= 超级管理员：建墙申请审批 =================
router.get('/admin/applications', authRequired, requirePerm('global.wall.approve'), (req, res) => {
  const status = req.query.status || 'pending';
  const apps = req.db.prepare(`
    SELECT wa.*, u.nickname as applicant_name, u.username as applicant_username
    FROM wall_applications wa JOIN users u ON wa.applicant_id=u.id
    WHERE wa.status = ?
    ORDER BY wa.created_at DESC LIMIT 100
  `).all(status);
  res.json(apps);
});

router.put('/admin/applications/:appId/review', authRequired, requirePerm('global.wall.approve'), (req, res) => {
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });

  const app = req.db.prepare('SELECT * FROM wall_applications WHERE id=?').get(parseInt(req.params.appId));
  if (!app) return res.status(404).json({ error: '申请不存在' });
  if (app.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });

  if (action === 'reject') {
    req.db.prepare("UPDATE wall_applications SET status='rejected', reviewer_id=?, reviewed_at=datetime('now','localtime') WHERE id=?")
      .run(req.user.id, app.id);
    notify(req.db, [app.applicant_id], '建墙申请未通过', `你创建校园墙「${app.wall_name}」的申请未通过`, '/walls');
    return res.json({ message: '已拒绝' });
  }

  // 通过：创建墙，申请者为墙主
  const exists = req.db.prepare('SELECT id FROM walls WHERE name=?').get(app.wall_name);
  if (exists) return res.status(400).json({ error: '同名校园墙已存在，无法通过' });

  const wr = req.db.prepare(
    "INSERT INTO walls (name, description, owner_id, status, require_join_approval) VALUES (?,?,?,'active',1)"
  ).run(app.wall_name, app.description || '', app.applicant_id);
  const wallId = wr.lastInsertRowid;
  req.db.prepare("INSERT INTO wall_members (wall_id, user_id, wall_role, status) VALUES (?,?,'owner','active')")
    .run(wallId, app.applicant_id);

  req.db.prepare("UPDATE wall_applications SET status='approved', reviewer_id=?, reviewed_at=datetime('now','localtime') WHERE id=?")
    .run(req.user.id, app.id);
  notify(req.db, [app.applicant_id], '建墙申请已通过', `你创建的校园墙「${app.wall_name}」已开通，你已成为墙主`, '/walls');
  res.json({ message: '已通过并创建校园墙', wall_id: wallId });
});

// ================= 超级管理员：所有墙列表/管理 =================
router.get('/admin/all', authRequired, requirePerm('global.wall.manage'), (req, res) => {
  const walls = req.db.prepare(`
    SELECT w.*, u.nickname as owner_name,
      (SELECT COUNT(*) FROM wall_members m WHERE m.wall_id=w.id AND m.status='active') as member_count,
      (SELECT COUNT(*) FROM posts p WHERE p.wall_id=w.id) as post_count
    FROM walls w LEFT JOIN users u ON w.owner_id=u.id
    ORDER BY w.created_at DESC
  `).all();
  res.json(walls);
});

// 超管停用/启用墙
router.put('/admin/:id/status', authRequired, requirePerm('global.wall.manage'), (req, res) => {
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: '无效状态' });
  const wall = req.db.prepare('SELECT id FROM walls WHERE id=?').get(parseInt(req.params.id));
  if (!wall) return res.status(404).json({ error: '校园墙不存在' });
  req.db.prepare('UPDATE walls SET status=? WHERE id=?').run(status, wall.id);
  res.json({ message: status === 'active' ? '已启用' : '已停用' });
});

module.exports = router;
