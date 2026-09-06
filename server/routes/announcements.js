const express = require('express');
const { authRequired, wallContext } = require('../middleware/auth');

const router = express.Router();

// 公开公告（当前墙）
router.get('/', authRequired, wallContext, (req, res) => {
  try {
    req.db.prepare("DELETE FROM announcements WHERE delete_at IS NOT NULL AND delete_at != '' AND datetime(delete_at) < datetime('now')").run();
    res.json(req.db.prepare(`
      SELECT a.id, a.title, a.content, a.is_pinned, a.is_markdown, a.scope, a.created_at, a.delete_at, u.nickname as author_name
      FROM announcements a JOIN users u ON a.author_id=u.id
      WHERE a.wall_id=? OR a.scope='global'
      ORDER BY a.scope='global' DESC, a.is_pinned DESC, a.created_at DESC LIMIT 20
    `).all(req.wallId));
  } catch { res.json([]); }
});

module.exports = router;
