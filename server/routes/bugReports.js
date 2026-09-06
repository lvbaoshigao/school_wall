const express = require('express');
const { authRequired, requirePerm } = require('../middleware/auth');
const { sanitizeImageList } = require('../lib/uploads');

const router = express.Router();

// 提交 Bug 反馈
router.post('/', authRequired, (req, res) => {
  const { title, content, images } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '请填写标题' });
  // 标题原先没有任何长度限制，而 content 有 5000 字上限 ——
  // 结果是可以提交一个约 128KB 的标题，还会被原样拼进发给每个超管的系统消息里。
  if (title.trim().length > 100) return res.status(400).json({ error: '标题不能超过100字' });
  if (!content || !content.trim()) return res.status(400).json({ error: '请填写反馈内容' });
  if (content.length > 5000) return res.status(400).json({ error: '内容不能超过5000字' });

  const imagesJson = sanitizeImageList(images, 'bug-reports');

  const result = req.db.prepare(`
    INSERT INTO bug_reports (reporter_id, title, content, images)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, title.trim(), content.trim(), imagesJson);

  // 通知所有超级管理员
  const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all();
  const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
  supers.forEach(s => ins.run(s.id, 'Bug 反馈', `用户 ${reporter?.nickname || '未知'} 提交了反馈：${title.trim()}`, '/admin?panel=bugReports'));

  res.json({ id: result.lastInsertRowid, message: '反馈已提交' });
});

// 用户查看自己的反馈
router.get('/', authRequired, (req, res) => {
  const reports = req.db.prepare(`
    SELECT id, title, content, images, status, reply, created_at, updated_at
    FROM bug_reports WHERE reporter_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(reports);
});

// 管理员查看所有反馈
router.get('/admin', authRequired, requirePerm('global.bug.handle'), (req, res) => {
  const { status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (status && ['pending', 'processing', 'resolved', 'rejected'].includes(status)) {
    where += ' AND b.status = ?';
    params.push(status);
  }
  const reports = req.db.prepare(`
    SELECT b.*, u.nickname as reporter_name, u.username as reporter_username
    FROM bug_reports b
    JOIN users u ON b.reporter_id = u.id
    ${where}
    ORDER BY b.created_at DESC LIMIT 100
  `).all(...params);
  res.json(reports);
});

// 管理员更新状态+回复
router.put('/:id/status', authRequired, requirePerm('global.bug.handle'), (req, res) => {
  const { status, reply } = req.body;
  if (!['pending', 'processing', 'resolved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: '无效状态' });
  }
  const report = req.db.prepare('SELECT id, reporter_id, title FROM bug_reports WHERE id=?').get(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: '反馈不存在' });

  req.db.prepare(`
    UPDATE bug_reports SET status=?, reply=COALESCE(?, reply), updated_at=datetime('now','localtime') WHERE id=?
  `).run(status, reply || null, report.id);

  if (reply) {
    req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)")
      .run(report.reporter_id, 'Bug 反馈回复', `你的反馈「${report.title}」有新的回复：${reply}`, '/bug-report');
  }

  res.json({ message: '已更新' });
});

module.exports = router;