const express = require('express');
const { authRequired, wallContext } = require('../middleware/auth');

const router = express.Router();

// 注意路由顺序：/search 与 /discover 必须排在 /:id 之前，
// 否则会被后者当成 id='search' 吃掉。
// 用户搜索（当前墙内 active 成员；受搜索隐私开关约束）
// - ID/账号/昵称 各自要求 allow_search_by_xxx=1
// - 永不返回 real_name（即便 show_real_name=1），规避隐私
router.get('/search', authRequired, wallContext, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json([]);
  // 允许用户按 UI 提示输入「@账号」，剥掉前缀 @ 后再匹配 username
  const keyword = q.trim().replace(/^@+/, '');
  if (!keyword) return res.json([]);

  // ID 精确匹配：仅在目标 allow_search_by_id=1 时放行
  if (/^\d+$/.test(keyword)) {
    const byId = req.db.prepare(`
      SELECT u.id, u.username, u.nickname, u.avatar, u.class_number
      FROM users u
      JOIN wall_members wm ON wm.user_id = u.id
      WHERE wm.wall_id = ? AND wm.status='active' AND u.status='active'
        AND u.id = ? AND u.id != ? AND u.allow_search_by_id = 1
      LIMIT 20
    `).all(req.wallId, parseInt(keyword), req.user.id);
    return res.json(byId);
  }

  const like = `%${keyword}%`;
  const rows = req.db.prepare(`
    SELECT u.id, u.username, u.nickname, u.avatar, u.class_number
    FROM users u
    JOIN wall_members wm ON wm.user_id = u.id
    WHERE wm.wall_id = ? AND wm.status='active' AND u.status='active' AND u.id != ?
      AND (
        (u.username LIKE ? AND u.allow_search_by_username = 1)
        OR (u.nickname LIKE ? AND u.allow_search_by_nickname = 1)
        OR (IFNULL(u.real_name,'') != '' AND u.real_name LIKE ? AND u.allow_search_by_real_name = 1)
      )
    LIMIT 20
  `).all(req.wallId, req.user.id, like, like, like);
  res.json(rows);
});

// 发现好友（当前墙内 active 成员中允许被发现的用户）
router.get('/discover', authRequired, wallContext, (req, res) => {
  const rows = req.db.prepare(`
    SELECT u.id, u.username, u.nickname, u.avatar, u.class_number
    FROM users u
    JOIN wall_members wm ON wm.user_id = u.id
    WHERE wm.wall_id = ? AND wm.status='active' AND u.status='active'
      AND u.id != ? AND u.allow_discover = 1
    ORDER BY u.created_at DESC LIMIT 50
  `).all(req.wallId, req.user.id);
  res.json(rows);
});

// 用户公开信息
// 原为 authOptional —— 未登录也能按 id 遍历出真实姓名与班级，收紧为必须登录；
// 再补上墙上下文校验：不带任何墙归属的登录用户此前也能遍历全站用户档案（IDOR）。
// 当前墙成员、或与我存在好友关系的人，才可以查看。
router.get('/:id', authRequired, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }

  const user = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, class_number,
           is_graduate, graduation_year, created_at FROM users WHERE id = ?
  `).get(targetId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.show_real_name) user.real_name = '';

  if (targetId === req.user.id) return res.json(user);

  // 好友关系放行（不看墙，跨墙好友也应可见）
  const isFriend = !!req.db.prepare(
    "SELECT 1 AS ok FROM friends WHERE ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) AND status='accepted' LIMIT 1"
  ).get(req.user.id, targetId, targetId, req.user.id);
  if (isFriend) return res.json(user);

  // 否则要求与我共享至少一个 active 墙
  const shared = req.db.prepare(`
    SELECT 1 AS ok FROM wall_members a
    JOIN wall_members b ON a.wall_id = b.wall_id
    WHERE a.user_id = ? AND b.user_id = ? AND a.status = 'active' AND b.status = 'active'
    LIMIT 1
  `).get(req.user.id, targetId);
  if (!shared) {
    return res.status(403).json({ error: '无权查看该用户信息' });
  }
  res.json(user);
});

module.exports = router;
