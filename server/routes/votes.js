const express = require('express');
const { authRequired, wallContext } = require('../middleware/auth');

const router = express.Router();

// 返回给客户端的投票列（不含 author_ip —— 安全修复）
const VOTE_SELECT = `
  v.id, v.wall_id, v.title, v.description, v.author_id, v.is_anonymous, v.end_at, v.created_at,
  CASE WHEN v.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_nickname,
  (SELECT COUNT(*) FROM vote_records WHERE vote_id = v.id) as total_votes
`;

// 获取投票列表（当前墙内）
router.get('/', authRequired, wallContext, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = req.db.prepare('SELECT COUNT(*) as c FROM votes WHERE wall_id=?').get(req.wallId).c;

  const votes = req.db.prepare(`
    SELECT ${VOTE_SELECT}
    FROM votes v
    LEFT JOIN users u ON v.author_id = u.id
    WHERE v.wall_id = ?
    ORDER BY v.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.wallId, limit, offset);

  votes.forEach(vote => {
    vote.options = req.db.prepare('SELECT * FROM vote_options WHERE vote_id = ? ORDER BY id').all(vote.id);
    if (req.user) {
      const record = req.db.prepare('SELECT option_id FROM vote_records WHERE vote_id = ? AND user_id = ?').get(vote.id, req.user.id);
      vote.voted = record ? record.option_id : null;
    }
  });

  res.json({ votes, total, page, limit });
});

// 创建投票（当前墙）
router.post('/', authRequired, wallContext, (req, res) => {
  const { title, description, options, is_anonymous, end_at } = req.body;

  if (!title || !options || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: '标题和至少2个选项是必须的' });
  }
  if (options.length > 10) {
    return res.status(400).json({ error: '选项最多10个' });
  }

  const ip = req.ip || req.connection.remoteAddress;
  const ipHash = require('crypto').createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
  const authorId = is_anonymous ? null : req.user.id;

  const result = req.db.prepare(`
    INSERT INTO votes (wall_id, title, description, author_id, is_anonymous, author_ip, end_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.wallId, title, description || '', authorId, is_anonymous ? 1 : 0, ipHash, end_at || '');

  const voteId = result.lastInsertRowid;

  const ins = req.db.prepare('INSERT INTO vote_options (vote_id, option_text) VALUES (?, ?)');
  options.forEach(opt => {
    if (opt && opt.trim()) ins.run(voteId, opt.trim());
  });

  res.json({ id: voteId, message: '投票已创建' });
});

// 获取投票详情（校验属于当前墙）
router.get('/:id', authRequired, wallContext, (req, res) => {
  const vote = req.db.prepare(`
    SELECT ${VOTE_SELECT}
    FROM votes v
    LEFT JOIN users u ON v.author_id = u.id
    WHERE v.id = ? AND v.wall_id = ?
  `).get(parseInt(req.params.id), req.wallId);

  if (!vote) return res.status(404).json({ error: '投票不存在' });

  vote.options = req.db.prepare('SELECT * FROM vote_options WHERE vote_id = ? ORDER BY id').all(vote.id);

  if (req.user) {
    const record = req.db.prepare('SELECT option_id FROM vote_records WHERE vote_id = ? AND user_id = ?').get(vote.id, req.user.id);
    vote.voted = record ? record.option_id : null;
  }

  res.json(vote);
});

// 投票
router.post('/:id/vote', authRequired, wallContext, (req, res) => {
  const { option_id } = req.body;
  const voteId = parseInt(req.params.id);
  const userId = req.user.id;

  const vote = req.db.prepare('SELECT id, end_at FROM votes WHERE id = ? AND wall_id = ?').get(voteId, req.wallId);
  if (!vote) return res.status(404).json({ error: '投票不存在' });

  if (vote.end_at && new Date(vote.end_at) < new Date()) {
    return res.status(400).json({ error: '投票已结束' });
  }

  const existing = req.db.prepare('SELECT id FROM vote_records WHERE vote_id = ? AND user_id = ?').get(voteId, userId);
  if (existing) return res.status(400).json({ error: '你已经投过票了' });

  const option = req.db.prepare('SELECT id FROM vote_options WHERE id = ? AND vote_id = ?').get(option_id, voteId);
  if (!option) return res.status(400).json({ error: '选项不存在' });

  req.db.prepare('INSERT INTO vote_records (vote_id, option_id, user_id) VALUES (?, ?, ?)').run(voteId, option_id, userId);
  req.db.prepare('UPDATE vote_options SET vote_count = vote_count + 1 WHERE id = ?').run(option_id);

  res.json({ message: '投票成功' });
});

// 删除投票（作者或墙管理者）
router.delete('/:id', authRequired, wallContext, (req, res) => {
  const voteId = parseInt(req.params.id);
  const vote = req.db.prepare('SELECT author_id FROM votes WHERE id = ? AND wall_id = ?').get(voteId, req.wallId);
  if (!vote) return res.status(404).json({ error: '投票不存在' });

  const isAuthor = vote.author_id === req.user.id;
  const isMod = req.can('wall.post.delete');
  if (!isAuthor && !isMod) return res.status(403).json({ error: '无权删除' });

  req.db.prepare('DELETE FROM vote_records WHERE vote_id = ?').run(voteId);
  req.db.prepare('DELETE FROM vote_options WHERE vote_id = ?').run(voteId);
  req.db.prepare('DELETE FROM votes WHERE id = ?').run(voteId);

  res.json({ message: '已删除' });
});

module.exports = router;
