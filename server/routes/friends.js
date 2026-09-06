const express = require('express');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// 发送好友请求
router.post('/add', authRequired, (req, res) => {
  const { friend_id } = req.body;
  if (!friend_id) return res.status(400).json({ error: '参数不完整' });
  if (parseInt(friend_id) === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });

  const friend = req.db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(parseInt(friend_id));
  if (!friend) return res.status(404).json({ error: '用户不存在' });

  // 检查是否被拉黑
  const blocked = req.db.prepare("SELECT id FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'").get(parseInt(friend_id), req.user.id);
  if (blocked) return res.status(400).json({ error: '无法添加该用户' });

  const existing = req.db.prepare('SELECT id, status FROM friends WHERE user_id = ? AND friend_id = ?').get(req.user.id, parseInt(friend_id));
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: '已经是好友了' });
    if (existing.status === 'blocked') return res.status(400).json({ error: '该用户已被拉黑' });
    return res.status(400).json({ error: '已发送过好友请求' });
  }

  req.db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(req.user.id, parseInt(friend_id), 'pending');

  const sender = req.db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.user.id);
  req.db.prepare('INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, parseInt(friend_id), 'system', '好友请求', `${sender.nickname || '用户'} 请求添加你为好友`, '/chat');

  res.json({ message: '好友请求已发送' });
});

// 获取好友列表
router.get('/', authRequired, (req, res) => {
  const friends = req.db.prepare(`
    SELECT f.id, f.status, f.created_at,
      CASE WHEN f.user_id = ? THEN u2.id ELSE u1.id END as friend_id,
      CASE WHEN f.user_id = ? THEN u2.nickname ELSE u1.nickname END as friend_nickname,
      CASE WHEN f.user_id = ? THEN u2.avatar ELSE u1.avatar END as friend_avatar
    FROM friends f
    JOIN users u1 ON f.user_id = u1.id
    JOIN users u2 ON f.friend_id = u2.id
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
    ORDER BY f.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);

  res.json(friends);
});

// 获取黑名单
router.get('/blocked', authRequired, (req, res) => {
  const blocked = req.db.prepare(`
    SELECT f.id, f.created_at, u.id as blocked_id, u.nickname as blocked_nickname, u.avatar as blocked_avatar
    FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.status = 'blocked'
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  res.json(blocked);
});

// 获取待处理的好友请求
router.get('/pending', authRequired, (req, res) => {
  const requests = req.db.prepare(`
    SELECT f.id, f.created_at, u.id as sender_id, u.nickname as sender_nickname, u.avatar as sender_avatar
    FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  res.json(requests);
});

// 接受/拒绝好友请求
router.put('/:id/respond', authRequired, (req, res) => {
  const { action } = req.body;
  const friendRecord = req.db.prepare('SELECT * FROM friends WHERE id = ? AND friend_id = ?').get(parseInt(req.params.id), req.user.id);

  if (!friendRecord) return res.status(404).json({ error: '请求不存在' });

  if (action === 'accept') {
    req.db.prepare("UPDATE friends SET status = 'accepted' WHERE id = ?").run(friendRecord.id);
    req.db.prepare('INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, friendRecord.user_id, 'system', '好友已添加', '对方接受了你的好友请求', `/chat/${req.user.id}`);
    res.json({ message: '已接受好友请求' });
  } else if (action === 'reject') {
    req.db.prepare('DELETE FROM friends WHERE id = ?').run(friendRecord.id);
    res.json({ message: '已拒绝好友请求' });
  } else {
    return res.status(400).json({ error: '无效操作' });
  }
});

// 拉黑用户
router.post('/block', authRequired, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: '参数不完整' });
  if (parseInt(user_id) === req.user.id) return res.status(400).json({ error: '不能拉黑自己' });

  // 删除现有好友关系
  req.db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
    .run(req.user.id, parseInt(user_id), parseInt(user_id), req.user.id);

  // 添加拉黑记录
  req.db.prepare("INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'blocked')").run(req.user.id, parseInt(user_id));

  res.json({ message: '已拉黑该用户' });
});

// 取消拉黑
router.post('/unblock', authRequired, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: '参数不完整' });

  const result = req.db.prepare("DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'")
    .run(req.user.id, parseInt(user_id));

  if (result.changes === 0) return res.status(404).json({ error: '该用户不在黑名单中' });
  res.json({ message: '已取消拉黑' });
});

// 删除好友
router.delete('/:id', authRequired, (req, res) => {
  const result = req.db.prepare('DELETE FROM friends WHERE id = ? AND (user_id = ? OR friend_id = ?)')
    .run(parseInt(req.params.id), req.user.id, req.user.id);

  if (result.changes === 0) return res.status(404).json({ error: '好友关系不存在' });
  res.json({ message: '已删除好友' });
});

module.exports = router;
