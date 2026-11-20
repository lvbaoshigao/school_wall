const express = require('express');
const { authRequired, wallContext } = require('../middleware/auth');

const router = express.Router();

function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}

router.use((req, res, next) => {
  for (const [key, max] of [['page', 1000000], ['limit', 50]]) {
    if (req.query[key] !== undefined && !positiveInteger(req.query[key], max)) {
      return res.status(400).json({ error: '分页参数无效' });
    }
  }
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: '请求内容必须是对象' });
  }
  const anonymous = req.body?.is_anonymous;
  if (anonymous !== undefined && typeof anonymous !== 'boolean' && anonymous !== 0 && anonymous !== 1) {
    return res.status(400).json({ error: '匿名标记必须是布尔值' });
  }
  next();
});

router.param('id', (req, res, next, value) => {
  if (!positiveInteger(value)) return res.status(400).json({ error: '投票编号无效' });
  next();
});

function atomic(db, action) {
  db.exec('SAVEPOINT content_votes');
  try {
    const result = action();
    db.exec('RELEASE SAVEPOINT content_votes');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT content_votes');
    db.exec('RELEASE SAVEPOINT content_votes');
    throw error;
  }
}

// datetime-local 与带时区的 ISO 时间均接受，落库统一为 UTC；拒绝日期自动进位。
function parseDeadline(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1).map(value => Number(value || 0));
  if (year < 1000 || month < 1 || month > 12 || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}

// 返回给客户端的投票列（不含 author_ip —— 安全修复）
const VOTE_SELECT = `
  v.id, v.wall_id, v.title, v.description,
  CASE WHEN v.is_anonymous = 1 THEN NULL ELSE v.author_id END as author_id,
  v.is_anonymous, v.end_at, v.created_at,
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
    WITH page AS (
      SELECT * FROM votes WHERE wall_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    ),
    vote_totals AS (
      SELECT vote_id, COUNT(*) AS total_votes
      FROM vote_records WHERE vote_id IN (SELECT id FROM page)
      GROUP BY vote_id
    )
    SELECT v.id, v.wall_id, v.title, v.description,
      CASE WHEN v.is_anonymous = 1 THEN NULL ELSE v.author_id END AS author_id,
      v.is_anonymous, v.end_at, v.created_at,
      CASE WHEN v.is_anonymous = 1 THEN NULL ELSE u.nickname END AS author_nickname,
      COALESCE(vote_totals.total_votes, 0) AS total_votes,
      my_record.option_id AS voted
    FROM page v
    LEFT JOIN users u ON v.author_id = u.id
    LEFT JOIN vote_totals ON vote_totals.vote_id = v.id
    LEFT JOIN vote_records my_record ON my_record.vote_id = v.id AND my_record.user_id = ?
    ORDER BY v.created_at DESC, v.id DESC
  `).all(req.wallId, limit, offset, req.user.id);
  if (votes.length) {
    const placeholders = votes.map(() => '?').join(', ');
    const ids = votes.map(vote => vote.id);
    const optionByVote = new Map(ids.map(id => [id, []]));
    const choices = req.db.prepare(
      'SELECT * FROM vote_options WHERE vote_id IN (' + placeholders + ') ORDER BY vote_id, id'
    ).all(...ids);
    for (const option of choices) optionByVote.get(option.vote_id).push(option);
    for (const vote of votes) vote.options = optionByVote.get(vote.id);
  }
  res.json({ votes, total, page, limit });
});

// 创建投票（当前墙）
router.post('/', authRequired, wallContext, (req, res) => {
  const { title, description, options, is_anonymous, end_at } = req.body;

  if (typeof title !== 'string' || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: '标题和至少2个选项是必须的' });
  }
  if (options.length > 10) {
    return res.status(400).json({ error: '选项最多10个' });
  }

  // 长度与格式校验：此前 title/description/选项文本/end_at 一概不查，
  // 128KB 请求体可以把字段撑满；非法截止时间字符串会让结束判断永远为假
  const cleanTitle = title.trim();
  if (!cleanTitle) return res.status(400).json({ error: '标题不能为空' });
  if (cleanTitle.length > 100) return res.status(400).json({ error: '标题不能超过100字' });
  if (description !== undefined && typeof description !== 'string') return res.status(400).json({ error: '描述必须是文本' });
  const cleanDesc = (description || '').trim();
  if (cleanDesc.length > 500) return res.status(400).json({ error: '描述不能超过500字' });
  if (options.some(o => typeof o !== 'string' || !o.trim())) return res.status(400).json({ error: '选项必须是非空文本' });
  const cleanOptions = options.map(o => o.trim());
  if (new Set(cleanOptions).size !== cleanOptions.length) return res.status(400).json({ error: '选项不能重复' });
  if (cleanOptions.length < 2) return res.status(400).json({ error: '至少需要2个非空选项' });
  if (cleanOptions.some(o => o.length > 50)) return res.status(400).json({ error: '单个选项不能超过50字' });
  let cleanEndAt = '';
  if (end_at !== undefined && end_at !== '') {
    const deadline = parseDeadline(end_at);
    if (!Number.isFinite(deadline)) return res.status(400).json({ error: '截止时间格式无效' });
    if (deadline <= Date.now()) return res.status(400).json({ error: '截止时间必须晚于当前时间' });
    cleanEndAt = new Date(deadline).toISOString();
  }

  const ip = req.ip || req.connection?.remoteAddress;
  const ipHash = require('crypto').createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
  const authorId = is_anonymous ? null : req.user.id;

  const voteId = atomic(req.db, () => {
    const result = req.db.prepare(`
      INSERT INTO votes (wall_id, title, description, author_id, is_anonymous, author_ip, end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.wallId, cleanTitle, cleanDesc, authorId, is_anonymous ? 1 : 0, ipHash, cleanEndAt);

    const voteId = result.lastInsertRowid;

    const ins = req.db.prepare('INSERT INTO vote_options (vote_id, option_text) VALUES (?, ?)');
    cleanOptions.forEach(opt => ins.run(voteId, opt));
    return voteId;
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
  if (!(Number.isSafeInteger(option_id) && option_id > 0) && !positiveInteger(option_id)) {
    return res.status(400).json({ error: '选项编号无效' });
  }
  const voteId = parseInt(req.params.id);
  const userId = req.user.id;

  const vote = req.db.prepare('SELECT id, end_at FROM votes WHERE id = ? AND wall_id = ?').get(voteId, req.wallId);
  if (!vote) return res.status(404).json({ error: '投票不存在' });

  if (vote.end_at && (!Number.isFinite(Date.parse(vote.end_at)) || Date.parse(vote.end_at) <= Date.now())) {
    return res.status(400).json({ error: '投票已结束' });
  }

  const existing = req.db.prepare('SELECT id FROM vote_records WHERE vote_id = ? AND user_id = ?').get(voteId, userId);
  if (existing) return res.status(400).json({ error: '你已经投过票了' });

  const option = req.db.prepare('SELECT id FROM vote_options WHERE id = ? AND vote_id = ?').get(option_id, voteId);
  if (!option) return res.status(400).json({ error: '选项不存在' });

  try {
    atomic(req.db, () => {
      req.db.prepare('INSERT INTO vote_records (vote_id, option_id, user_id) VALUES (?, ?, ?)').run(voteId, option.id, userId);
      req.db.prepare('UPDATE vote_options SET vote_count = vote_count + 1 WHERE id = ? AND vote_id = ?').run(option.id, voteId);
    });
  } catch (error) {
    if (/UNIQUE/i.test(error?.message || '')) return res.status(400).json({ error: '你已经投过票了' });
    throw error;
  }

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

  atomic(req.db, () => {
    req.db.prepare('DELETE FROM vote_records WHERE vote_id = ?').run(voteId);
    req.db.prepare('DELETE FROM vote_options WHERE vote_id = ?').run(voteId);
    req.db.prepare('DELETE FROM votes WHERE id = ?').run(voteId);
  });

  res.json({ message: '已删除' });
});

module.exports = router;
