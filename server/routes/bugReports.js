const express = require('express');
const { authRequired, requirePerm } = require('../middleware/auth');
const { sanitizeImageList, signPrivateImages } = require('../lib/uploads');
const { userCan } = require('../lib/permissions');

const router = express.Router();

function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}

router.use((req, res, next) => {
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: '请求内容必须是对象' });
  }
  for (const [key, max] of [['page', 1000000], ['limit', 100]]) {
    if (req.query[key] !== undefined && !positiveInteger(req.query[key], max)) {
      return res.status(400).json({ error: '分页参数无效' });
    }
  }
  if (req.query.status !== undefined && !['pending', 'processing', 'resolved', 'rejected'].includes(req.query.status)) {
    return res.status(400).json({ error: '无效状态' });
  }
  next();
});

router.param('id', (req, res, next, value) => {
  if (!positiveInteger(value)) return res.status(400).json({ error: '反馈编号无效' });
  next();
});

function atomic(db, action) {
  db.exec('SAVEPOINT content_bug_reports');
  try {
    const result = action();
    db.exec('RELEASE SAVEPOINT content_bug_reports');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT content_bug_reports');
    db.exec('RELEASE SAVEPOINT content_bug_reports');
    throw error;
  }
}

function ownedImages(images, userId) {
  if (images === undefined) return '';
  if (!Array.isArray(images) || images.length > 9 || images.some(image => typeof image !== 'string')) return null;
  const clean = JSON.parse(sanitizeImageList(images, 'bug-reports') || '[]');
  const paths = new Set(images.map(image => image.trim().split('?')[0]));
  if (clean.length !== paths.size || clean.some(image => !image.startsWith('/uploads/bug-reports/bug_' + userId + '_'))) return null;
  return clean.length ? JSON.stringify(clean) : '';
}

function sendReports(req, res, reports) {
  reports.forEach(report => { report.images = signPrivateImages(report.images, req); });
  res.set('Cache-Control', 'no-store');
  res.json(reports);
}

// 提交 Bug 反馈
router.post('/', authRequired, (req, res) => {
  const { title, content, images } = req.body;
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '请填写标题' });
  // 标题原先没有任何长度限制，而 content 有 5000 字上限 ——
  // 结果是可以提交一个约 128KB 的标题，还会被原样拼进发给每个超管的系统消息里。
  if (title.trim().length > 100) return res.status(400).json({ error: '标题不能超过100字' });
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '请填写反馈内容' });
  if (content.length > 5000) return res.status(400).json({ error: '内容不能超过5000字' });

  const imagesJson = ownedImages(images, req.user.id);
  if (imagesJson === null) return res.status(400).json({ error: '反馈图片必须使用本人上传的私密图片，且最多9张' });

  const result = atomic(req.db, () => {
    const result = req.db.prepare(`
      INSERT INTO bug_reports (reporter_id, title, content, images)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, title.trim(), content.trim(), imagesJson);

    // 通知所有超级管理员
    const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all();
    const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
    const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
    supers.filter(s => userCan(req.db, s.id, 'global.bug.handle', 0))
      .forEach(s => ins.run(s.id, 'Bug 反馈', `用户 ${reporter?.nickname || '未知'} 提交了反馈：${title.trim()}`, '/admin?panel=bugReports'));
    return result;
  });

  res.json({ id: result.lastInsertRowid, message: '反馈已提交' });
});

// 用户查看自己的反馈
router.get('/', authRequired, (req, res) => {
  const limit = Math.min(50, Number(req.query.limit || 50));
  const offset = (Number(req.query.page || 1) - 1) * limit;
  const reports = req.db.prepare(`
    SELECT id, title, content, images, status, reply, created_at, updated_at
    FROM bug_reports WHERE reporter_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);
  sendReports(req, res, reports);
});

// 管理员查看所有反馈
router.get('/admin', authRequired, requirePerm('global.bug.handle'), (req, res) => {
  const limit = Number(req.query.limit || 100);
  const offset = (Number(req.query.page || 1) - 1) * limit;
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
    ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  sendReports(req, res, reports);
});

// 管理员更新状态+回复
router.put('/:id/status', authRequired, requirePerm('global.bug.handle'), (req, res) => {
  const { status, reply } = req.body;
  if (!['pending', 'processing', 'resolved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: '无效状态' });
  }
  if (reply !== undefined && (typeof reply !== 'string' || reply.length > 5000)) {
    return res.status(400).json({ error: '回复必须是5000字以内的文本' });
  }
  const report = req.db.prepare('SELECT id, reporter_id, title FROM bug_reports WHERE id=?').get(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: '反馈不存在' });

  atomic(req.db, () => {
    req.db.prepare(`
      UPDATE bug_reports SET status=?, reply=COALESCE(?, reply), updated_at=datetime('now','localtime') WHERE id=?
    `).run(status, reply === undefined ? null : reply, report.id);

    if (reply) {
      req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)")
        .run(report.reporter_id, 'Bug 反馈回复', `你的反馈「${report.title}」有新的回复：${reply}`, '/bug-report');
    }
  });

  res.json({ message: '已更新' });
});

module.exports = router;