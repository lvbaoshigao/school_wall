const express = require('express');
const crypto = require('crypto');
const { authRequired, wallContext, requirePerm } = require('../middleware/auth');
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
  for (const [key, max] of [['page', 1000000], ['limit', 50], ['wall_id', Number.MAX_SAFE_INTEGER]]) {
    if (req.query[key] !== undefined && !positiveInteger(req.query[key], max)) {
      return res.status(400).json({ error: '分页或校园墙参数无效' });
    }
  }
  if (req.query.status !== undefined && !['pending', 'processing', 'resolved', 'rejected'].includes(req.query.status)) {
    return res.status(400).json({ error: '无效状态' });
  }
  next();
});

router.param('id', (req, res, next, value) => {
  if (!positiveInteger(value)) return res.status(400).json({ error: '举报编号无效' });
  next();
});

function atomic(db, action) {
  db.exec('SAVEPOINT content_reports');
  try {
    const result = action();
    db.exec('RELEASE SAVEPOINT content_reports');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT content_reports');
    db.exec('RELEASE SAVEPOINT content_reports');
    throw error;
  }
}

// 新证据只接受本人私密上传；历史 images 目录仅在已授权读取时签名兼容。
function ownedImages(images, userId) {
  if (images === undefined) return '';
  if (!Array.isArray(images) || images.length > 9 || images.some(image => typeof image !== 'string')) return null;
  const clean = JSON.parse(sanitizeImageList(images, 'bug-reports') || '[]');
  const paths = new Set(images.map(image => image.trim().split('?')[0]));
  if (clean.length !== paths.size || clean.some(image => !image.startsWith('/uploads/bug-reports/bug_' + userId + '_'))) return null;
  return clean.length ? JSON.stringify(clean) : '';
}

const VALID_REPORT_TYPES = ['校园霸凌行为', '校内抽烟行为'];

// 追踪码。随机部分原本只有 2 字节 —— 年份是可预测的，整个空间只有 65536 个，
// 配合当时无鉴权的 /track/:code 可以被完整穷举，把校园霸凌举报连同证据图 URL 全捞出来。
// 提到 4 字节（约 43 亿），并且 /track 已改为必须登录且只返回自己或本墙管理范围内的举报。
function generateTrackingCode(db) {
  const year = new Date().getFullYear();
  for (let i = 0; i < 5; i++) {
    const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `RPT-${year}${hex}`;
    const exists = db.prepare('SELECT id FROM reports WHERE tracking_code=?').get(code);
    if (!exists) return code;
  }
  const fallback = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `RPT-${year}${fallback}`;
}

// 提交举报（当前墙）
router.post('/', authRequired, wallContext, (req, res) => {
  const { report_types, content, is_anonymous, agreed } = req.body;

  if (agreed !== true && agreed !== 1) return res.status(400).json({ error: '请先勾选保证信息真实' });
  if (typeof content !== 'string' || content.trim().length === 0) return res.status(400).json({ error: '请填写举报内容' });
  if (content.length > 5000) return res.status(400).json({ error: '内容不能超过5000字' });

  if (!Array.isArray(report_types) || report_types.length === 0 || report_types.length > VALID_REPORT_TYPES.length) {
    return res.status(400).json({ error: '请选择至少一种举报类型' });
  }
  const invalid = report_types.filter(t => !VALID_REPORT_TYPES.includes(t));
  if (invalid.length > 0) return res.status(400).json({ error: '无效的举报类型' });

  if (is_anonymous !== undefined && typeof is_anonymous !== 'boolean' && is_anonymous !== 0 && is_anonymous !== 1) {
    return res.status(400).json({ error: '匿名标记必须是布尔值' });
  }
  const trackingCode = generateTrackingCode(req.db);
  const typesStr = [...new Set(report_types)].join(',');
  const imagesJson = ownedImages(req.body.images, req.user.id);
  if (imagesJson === null) return res.status(400).json({ error: '证据图片必须使用本人上传的私密图片，且最多9张' });

  atomic(req.db, () => {
    req.db.prepare(`
      INSERT INTO reports (wall_id, tracking_code, reporter_id, report_types, content, images, is_anonymous)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.wallId, trackingCode, req.user.id, typesStr, content.trim(), imagesJson, is_anonymous ? 1 : 0);

    // 通知本墙墙主/墙管理员 + 全局超管
    const wallMods = req.db.prepare(
      "SELECT user_id as id FROM wall_members WHERE wall_id=? AND status='active' AND wall_role IN ('owner','admin')"
    ).all(req.wallId);
    const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all();
    const ids = [...new Set([...wallMods.map(m => m.id), ...supers.map(a => a.id)])]
      .filter(id => userCan(req.db, id, 'global.safety.handle', 0) || userCan(req.db, id, 'wall.safety.report', req.wallId));
    const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
    const preview = content.trim().substring(0, 80) + (content.length > 80 ? '...' : '');
    const senderInfo = is_anonymous ? '匿名用户' : (reporter?.nickname || '用户');
    const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (NULL,?,?,'report_notification',?,?,?)");
    ids.forEach(id => ins.run(id, req.wallId, '新举报', `${senderInfo}提交了举报(${typesStr})：${preview}\n追踪码: ${trackingCode}`, '/admin?panel=safetyReports'));
  });

  res.json({ tracking_code: trackingCode, message: '举报已提交' });
});

// 按追踪码查询举报进度。
//
// 原先这个端点没有任何鉴权，只靠「猜不到追踪码」保护，而追踪码当时只有 16 位随机 ——
// 穷举即可拿到全部举报的类型、状态、管理员备注和证据图 URL（/uploads 无访问控制）。
// 必须登录，且只有举报人本人、对应墙安全举报处理者、全局安全举报处理者能查。
// 提交举报本来就需要登录（POST / 挂了 authRequired），所以这不影响正常流程；
// is_anonymous 只是对管理员隐藏身份，不代表举报人是未登录访客。
router.get('/track/:code', authRequired, (req, res) => {
  const report = req.db.prepare(`
    SELECT id, wall_id, reporter_id, tracking_code, report_types, status, status_note, images, created_at, updated_at
    FROM reports WHERE tracking_code = ?
  `).get(String(req.params.code || '').toUpperCase());

  // 找不到与无权查看返回同一个响应，避免用返回码差异探测某个追踪码是否存在
  const notFound = () => res.status(404).json({ error: '未找到该举报记录，请检查追踪码' });
  if (!report) return notFound();

  const allowed = report.reporter_id === req.user.id
    || req.can('global.safety.handle', 0)
    || (!!report.wall_id && req.can('wall.safety.report', report.wall_id));
  if (!allowed) return notFound();

  const { id, wall_id, reporter_id, ...safe } = report;
  safe.images = signPrivateImages(safe.images, req);
  res.set('Cache-Control', 'no-store');
  res.json(safe);
});

// 举报列表（超管跨墙；墙主/墙管理员限本墙）
router.get('/', authRequired, (req, res) => {
  const { status } = req.query;
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const offset = (page - 1) * limit;
  const rawWall = req.query.wall_id ?? req.headers['x-wall-id'];
  if (rawWall !== undefined && !positiveInteger(rawWall)) return res.status(400).json({ error: '校园墙编号无效' });
  const wid = rawWall === undefined ? null : Number(rawWall);

  let where = 'WHERE 1=1';
  const params = [];

  // 持有全局安全举报处理权限的人能看所有墙；否则必须指定墙且在该墙有处理权限
  if (req.can('global.safety.handle', 0)) {
    // 可选按墙过滤
    if (Number.isInteger(wid) && wid > 0) { where += ' AND r.wall_id = ?'; params.push(wid); }
  } else {
    // 必须是某墙的墙主/墙管理员
    if (!Number.isInteger(wid) || wid <= 0) return res.status(400).json({ error: '缺少校园墙上下文' });
    if (!req.can('wall.safety.report', wid)) return res.status(403).json({ error: '需要该校园墙的管理权限' });
    where += ' AND r.wall_id = ?'; params.push(wid);
  }

  if (status && ['pending', 'processing', 'resolved', 'rejected'].includes(status)) {
    where += ' AND r.status = ?';
    params.push(status);
  }

  const total = req.db.prepare(`SELECT COUNT(*) as c FROM reports r ${where}`).get(...params).c;
  const reports = req.db.prepare(`
    SELECT r.id, r.wall_id, r.tracking_code, r.report_types, r.content, r.images, r.is_anonymous, r.status, r.status_note, r.created_at, r.updated_at,
      CASE WHEN r.is_anonymous = 1 THEN NULL ELSE u.nickname END as reporter_name,
      CASE WHEN r.is_anonymous = 1 THEN NULL ELSE u.username END as reporter_username,
      w.name as wall_name
    FROM reports r LEFT JOIN users u ON r.reporter_id = u.id
    LEFT JOIN walls w ON r.wall_id = w.id
    ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  reports.forEach(report => { report.images = signPrivateImages(report.images, req); });
  res.set('Cache-Control', 'no-store');
  res.json({ reports, total, page, limit });
});

// 更新举报状态（超管跨墙；墙主/墙管理员限本墙）
// 状态机：pending -> processing -> resolved（终态）
//         pending -> rejected（终态）
//         processing -> resolved | rejected（终态）
// resolved/rejected 不可再修改
router.put('/:id/status', authRequired, (req, res) => {
  const { status, status_note } = req.body;
  const validStatuses = ['pending', 'processing', 'resolved', 'rejected'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: '无效状态' });

  const report = req.db.prepare('SELECT id, wall_id, reporter_id, is_anonymous, tracking_code, status as current_status FROM reports WHERE id=?').get(parseInt(req.params.id));
  if (!report || (!req.can('global.safety.handle', 0) && !req.can('wall.safety.report', report.wall_id))) {
    return res.status(404).json({ error: '举报不存在' });
  }

  // 终态检查
  if (['resolved', 'rejected'].includes(report.current_status)) {
    return res.status(400).json({ error: '该举报已完结，无法再修改状态' });
  }

  // 状态机约束
  const allowedTransitions = {
    pending: ['processing', 'rejected'],
    processing: ['resolved', 'rejected'],
  };
  const allowed = allowedTransitions[report.current_status] || [];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `当前状态(${report.current_status})不允许转为${status}` });
  }

  if (status_note !== undefined && (typeof status_note !== 'string' || status_note.length > 2000)) {
    return res.status(400).json({ error: '处理备注必须是2000字以内的文本' });
  }

  atomic(req.db, () => {
    req.db.prepare(`
      UPDATE reports SET status=?, status_note=?, updated_at=datetime('now','localtime') WHERE id=?
    `).run(status, status_note || '', report.id);

    if (!report.is_anonymous && report.reporter_id) {
      const statusLabels = { pending: '待处理', processing: '处理中', resolved: '已处理', rejected: '已驳回' };
      req.db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (NULL,?,?,'system',?,?,?)")
        .run(report.reporter_id, report.wall_id, '举报状态更新', `你的举报(${report.tracking_code})状态已更新为: ${statusLabels[status]}${status_note ? '\n备注: ' + status_note : ''}`, `/report/status/${report.tracking_code}`);
    }
  });

  res.json({ message: '状态已更新' });
});

// 删除举报（仅超管）
router.delete('/:id', authRequired, requirePerm('global.safety.handle'), (req, res) => {
  const result = req.db.prepare('DELETE FROM reports WHERE id=?').run(parseInt(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '举报不存在' });
  res.json({ message: '已删除' });
});

module.exports = router;
