const express = require('express');
const { authRequired, wallContext } = require('../middleware/auth');

const router = express.Router();

// 公开公告（当前墙）
router.get('/', authRequired, wallContext, (req, res) => {
  // 读取公告只筛选到期记录，不能让任意墙成员的 GET 删除其它墙的数据。
  res.json(req.db.prepare(`
    SELECT a.id, a.title, a.content, a.is_pinned, a.is_markdown, a.scope, a.created_at, a.delete_at, u.nickname as author_name
    FROM announcements a JOIN users u ON a.author_id=u.id
    WHERE (a.wall_id=? OR a.scope='global')
      AND (a.delete_at IS NULL OR a.delete_at='' OR datetime(a.delete_at) >
        CASE WHEN a.delete_at GLOB '*Z' OR a.delete_at GLOB '*[+-][0-9][0-9]:[0-9][0-9]'
          THEN datetime('now') ELSE datetime('now','localtime') END)
    ORDER BY a.scope='global' DESC, a.is_pinned DESC, a.created_at DESC, a.id DESC LIMIT 20
  `).all(req.wallId));
});

module.exports = router;
