const express = require('express');
const { authRequired, requirePerm } = require('../middleware/auth');
const {
  PERMISSIONS, GLOBAL_ROLE_PERMS, WALL_ROLE_PERMS,
  effectivePerms, loadOverrides, isKnownPerm, isWallPerm,
} = require('../lib/permissions');

const router = express.Router();

// 权限目录 + 各名号的默认集。前端拿它渲染勾选界面，
// 并在切换名号时即时显示「这个名号自带哪些权限」。
router.get('/catalog', authRequired, (req, res) => {
  res.json({
    permissions: PERMISSIONS,
    globalRolePerms: GLOBAL_ROLE_PERMS,
    wallRolePerms: WALL_ROLE_PERMS,
  });
});

// 当前用户的有效权限：全局一份 + 每个所属墙一份。
// 前端只用它决定「显示/隐藏」，真正的拦截在服务端。
router.get('/me', authRequired, (req, res) => {
  const walls = req.db.prepare(
    "SELECT wall_id FROM wall_members WHERE user_id=? AND status='active'"
  ).all(req.user.id).map(r => r.wall_id);

  const byWall = {};
  for (const w of walls) byWall[w] = [...req.permsFor(w)];

  res.json({ global: [...req.permsFor(0)], walls: byWall });
});

// 查看某人在某作用域下的权限：有效集合 + 名号带来的默认集 + 显式覆盖项。
// 前端用「有效 vs 默认」的差异把每条渲染成 继承/强制授予/强制拒绝 三态。
router.get('/user/:id', authRequired, requirePerm('global.permission.manage'), (req, res) => {
  const userId = parseInt(req.params.id);
  const wallId = Math.max(0, parseInt(req.query.wall_id) || 0);

  const user = req.db.prepare('SELECT id, username, nickname, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  let wallRole = null;
  if (wallId > 0) {
    const m = req.db.prepare(
      "SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=? AND status='active'"
    ).get(wallId, userId);
    wallRole = m ? m.wall_role : null;
  }

  const overrides = loadOverrides(req.db, userId);
  const effective = effectivePerms({ globalRole: user.role, wallRole, overrides, wallId });
  // 名号自带的部分（不含任何覆盖），用于在界面上区分「继承来的」与「手动改过的」
  const inherited = effectivePerms({ globalRole: user.role, wallRole, overrides: [], wallId });

  res.json({
    user, wall_id: wallId, wall_role: wallRole,
    effective: [...effective],
    inherited: [...inherited],
    overrides: overrides.filter(o => o.wall_id === wallId),
  });
});

// 批量写覆盖项。
// body: { wall_id, changes: { '<perm>': 'inherit' | 'grant' | 'deny' } }
// 'inherit' 表示删除该条覆盖，回到名号默认。
router.put('/user/:id', authRequired, requirePerm('global.permission.manage'), (req, res) => {
  const userId = parseInt(req.params.id);
  const wallId = Math.max(0, parseInt(req.body.wall_id) || 0);
  const changes = req.body.changes;

  if (!changes || typeof changes !== 'object') {
    return res.status(400).json({ error: '缺少变更内容' });
  }
  const user = req.db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  if (wallId > 0) {
    const wall = req.db.prepare('SELECT id FROM walls WHERE id=?').get(wallId);
    if (!wall) return res.status(404).json({ error: '校园墙不存在' });
  }

  const del = req.db.prepare('DELETE FROM user_permissions WHERE user_id=? AND wall_id=? AND perm=?');
  const ins = req.db.prepare(`
    INSERT OR REPLACE INTO user_permissions (user_id, wall_id, perm, effect, operator_id)
    VALUES (?,?,?,?,?)
  `);

  const applied = [];
  const rejected = [];
  for (const [perm, effect] of Object.entries(changes)) {
    if (!isKnownPerm(perm)) { rejected.push({ perm, reason: '未知权限' }); continue; }
    // 全局权限没有「只在某个墙生效」的说法，挡掉以免写进去却永远不被读到
    if (wallId > 0 && !isWallPerm(perm)) {
      rejected.push({ perm, reason: '该权限只能在全局作用域授予' });
      continue;
    }
    if (!['inherit', 'grant', 'deny'].includes(effect)) {
      rejected.push({ perm, reason: '无效的取值' });
      continue;
    }
    if (effect === 'inherit') { del.run(userId, wallId, perm); applied.push(perm); continue; }
    ins.run(userId, wallId, perm, effect, req.user.id);
    applied.push(perm);
  }

  // 兜底：改完之后系统里必须仍有人能分配权限，否则这次修改会把管理通道焊死。
  // effectivePerms 已经保证超管的这两条不可 deny，这里再从结果侧复核一次 ——
  // 万一将来 UNDENIABLE 被改动，这里会拦下来而不是等到没人能改权限时才发现。
  const stillManageable = req.db.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE role='super_admin' AND status='active'"
  ).get().c > 0;
  if (!stillManageable) {
    return res.status(400).json({ error: '系统中必须至少保留一名有效的超级管理员' });
  }

  res.json({ message: '权限已更新', applied, rejected });
});

module.exports = router;
