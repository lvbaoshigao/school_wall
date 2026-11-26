'use strict';

const express = require('express');
const { authRequired } = require('../middleware/auth');
const { activeWallMember, primeWallMembers } = require('../lib/treeAccess');
const { presentMessages } = require('../lib/messagePresentation');
const {
  positiveId, wallContextId, rootMessage, blocked, visibleRoot, interactiveRoot,
  transaction, requestSummary,
} = require('../lib/confessions');

const router = express.Router();
router.use(authRequired);
router.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: '请求参数无效' });
  }
  const wallId = wallContextId(req);
  if (wallId < 0) return res.status(400).json({ error: '校园墙上下文无效' });
  if (wallId && !activeWallMember(req, wallId, req.user.id)) return res.status(403).json({ error: '无权访问此校园墙' });
  req.confessionWallId = wallId;
  next();
});

function validKeys(body, allowed) {
  return Object.keys(body).every(key => allowed.includes(key) || key === 'wall_id');
}

function clientId(body) {
  if (body.client_message_id === undefined || body.client_message_id === null) return null;
  return typeof body.client_message_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(body.client_message_id) ? body.client_message_id : false;
}

function storedMessage(req, id) {
  return req.db.prepare('SELECT m.*,u.nickname AS sender_nickname,u.avatar AS sender_avatar,v.nickname AS receiver_nickname FROM messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN users v ON v.id=m.receiver_id WHERE m.id=?').get(id);
}

function acknowledge(req, res, stored, deduplicated = false) {
  return res.json({ id: stored.id, message: '发送成功', client_message_id: stored.client_message_id || null,
    deduplicated, message_item: presentMessages(req, [stored])[0] });
}

function existingSend(req, id) {
  return id ? req.db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_message_id=?').get(req.user.id, id) : null;
}

function sendConflict(res) {
  return res.status(409).json({ error: '客户端消息 ID 已被使用或原消息已不可用', code: 'CLIENT_MESSAGE_CONFLICT' });
}

function authorizedRoot(req, res, id, interactive = false) {
  const root = rootMessage(req, id);
  if (!root || !visibleRoot(req, root)) {
    res.status(403).json({ error: '无权访问此表白信' });
    return null;
  }
  const wallId = wallContextId(req);
  if (wallId < 0 || (wallId > 0 && root.wall_id !== wallId) || (interactive && !interactiveRoot(req, root))) {
    res.status(403).json({ error: '表白信已不可操作或校园墙上下文不符' });
    return null;
  }
  return root;
}

function receivedFilter(req) {
  // Settle expired wall bans once before the scoped SQL membership predicate.
  const memberships = req.db.prepare('SELECT wall_id FROM wall_members WHERE user_id=?').all(req.user.id);
  primeWallMembers(req, memberships.map(row => [row.wall_id, req.user.id]));
  let sql = "m.type='confession' AND m.confession_root_id=0 AND m.confession_kind IN ('letter','direct') AND COALESCE(m.reply_to_id,0)=0 AND m.receiver_id=? AND m.receiver_deleted=0 AND m.is_revoked=0 AND EXISTS (SELECT 1 FROM walls w JOIN wall_members wm ON wm.wall_id=w.id WHERE w.id=m.wall_id AND w.status='active' AND wm.user_id=? AND wm.status='active')";
  const params = [req.user.id, req.user.id];
  if (req.confessionWallId) { sql += ' AND m.wall_id=?'; params.push(req.confessionWallId); }
  return { sql, params };
}

router.get('/stats', (req, res) => {
  const { sql, params } = receivedFilter(req);
  const counts = req.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN m.is_anonymous=1 THEN 1 ELSE 0 END),0) AS anonymous FROM messages m WHERE ' + sql).get(...params);
  res.json({ anonymous: counts.anonymous, named: counts.total - counts.anonymous, total: counts.total });
});

router.get('/received', (req, res) => {
  const page = req.query.page === undefined ? 1 : positiveId(req.query.page);
  const limit = req.query.limit === undefined ? 20 : positiveId(req.query.limit);
  const anonymous = req.query.anonymous === undefined ? 'all' : req.query.anonymous;
  if (!page || !limit || limit > 100 || !Number.isSafeInteger((page - 1) * limit) || !['all', '0', '1'].includes(anonymous)) return res.status(400).json({ error: '分页或筛选参数无效' });
  let { sql, params } = receivedFilter(req);
  if (anonymous !== 'all') { sql += ' AND m.is_anonymous=?'; params.push(Number(anonymous)); }
  const total = req.db.prepare('SELECT COUNT(*) AS total FROM messages m WHERE ' + sql).get(...params).total;
  const rows = req.db.prepare('SELECT m.*,u.nickname AS sender_nickname,u.avatar AS sender_avatar FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE ' + sql + ' ORDER BY m.id DESC LIMIT ? OFFSET ?').all(...params, limit, (page - 1) * limit);
  res.json({ messages: presentMessages(req, rows), total, page, limit, hasMore: page * limit < total });
});

router.post('/direct', (req, res) => {
  if (!validKeys(req.body, ['receiver_id', 'client_message_id'])) return res.status(400).json({ error: '直接表白的文案和署名只能由服务端生成' });
  const receiverId = positiveId(req.body.receiver_id);
  const wallId = req.confessionWallId;
  const id = clientId(req.body);
  if (!receiverId || receiverId === req.user.id || !wallId || id === false) return res.status(400).json({ error: '收件人、校园墙或客户端消息 ID 无效' });
  const receiver = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(receiverId);
  if (!receiver) return res.status(404).json({ error: '收件人不存在或不可用' });
  if (!activeWallMember(req, wallId, receiverId) || blocked(req, req.user.id, receiverId)) return res.status(403).json({ error: '无法向该用户表白' });
  const existing = existingSend(req, id);
  if (existing) {
    if (existing.type !== 'confession' || existing.confession_kind !== 'direct' || existing.receiver_id !== receiverId || existing.wall_id !== wallId || existing.sender_deleted || existing.receiver_deleted || existing.is_revoked) return sendConflict(res);
    return acknowledge(req, res, storedMessage(req, existing.id), true);
  }
  const author = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const content = (author.nickname || '用户') + '在此网站的表白信界面对你进行表白';
  const inserted = req.db.prepare("INSERT INTO messages (sender_id,receiver_id,wall_id,type,title,content,is_anonymous,confession_kind,link,client_message_id) VALUES (?,?,?,'confession','直接表白',?,0,'direct',?,?)")
    .run(req.user.id, receiverId, wallId, content, '/user/' + req.user.id, id);
  req.db.markDirty?.();
  return acknowledge(req, res, storedMessage(req, inserted.lastInsertRowid));
});

router.get('/identity-requests', (req, res) => {
  let where = '(requester_id=? OR author_id=?)';
  const params = [req.user.id, req.user.id];
  if (req.confessionWallId) { where += ' AND wall_id=?'; params.push(req.confessionWallId); }
  if (req.query.status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(req.query.status)) return res.status(400).json({ error: '申请状态无效' });
    where += ' AND status=?'; params.push(req.query.status);
  }
  const requests = req.db.prepare('SELECT * FROM confession_identity_requests WHERE ' + where + ' ORDER BY id DESC LIMIT 500').all(...params);
  res.json({ requests: requests.filter(request => {
    const root = rootMessage(req, request.message_id);
    return root && root.is_anonymous && root.wall_id === request.wall_id && root.sender_id === request.author_id && root.receiver_id === request.requester_id && interactiveRoot(req, root);
  }).map(request => requestSummary(req, request)) });
});

router.put('/identity-requests/:requestId', (req, res) => {
  const id = positiveId(req.params.requestId);
  if (!id || !validKeys(req.body, ['decision']) || !['approve', 'reject'].includes(req.body.decision)) return res.status(400).json({ error: '申请 ID 或决定无效' });
  const request = req.db.prepare('SELECT * FROM confession_identity_requests WHERE id=? AND author_id=?').get(id, req.user.id);
  if (!request) return res.status(403).json({ error: '无权处理此申请' });
  const root = authorizedRoot(req, res, request.message_id, true);
  if (!root) return;
  if (!root.is_anonymous || root.sender_id !== request.author_id || root.receiver_id !== request.requester_id || root.wall_id !== request.wall_id) return res.status(403).json({ error: '申请与表白信不匹配' });
  if (request.status !== 'pending') return res.status(409).json({ error: '申请已处理', code: 'CONFESSION_REQUEST_ALREADY_DECIDED' });
  const approved = req.body.decision === 'approve';
  transaction(req.db, () => {
    req.db.prepare("UPDATE confession_identity_requests SET status=?,decided_at=datetime('now','localtime') WHERE id=? AND status='pending'").run(approved ? 'approved' : 'rejected', id);
    req.db.prepare("INSERT INTO messages (sender_id,receiver_id,wall_id,type,title,content,link) VALUES (NULL,?,?,'system',?,?,?)")
      .run(request.requester_id, root.wall_id, '表白信身份申请结果', approved ? '写信人已同意你的身份查看申请，请到原表白信查看。' : '写信人拒绝了你的身份查看申请。', '/inbox?tab=confession');
  });
  return res.json({ request: requestSummary(req, req.db.prepare('SELECT * FROM confession_identity_requests WHERE id=?').get(id)) });
});

router.get('/:id/thread', (req, res) => {
  const id = positiveId(req.params.id);
  const before = req.query.before === undefined ? 0 : positiveId(req.query.before);
  const limit = req.query.limit === undefined ? 50 : positiveId(req.query.limit);
  if (!id || !limit || limit > 100 || (req.query.before !== undefined && !before)) return res.status(400).json({ error: '消息 ID 或分页参数无效' });
  const root = authorizedRoot(req, res, id);
  if (!root) return;
  let sql = "SELECT m.*,u.nickname AS sender_nickname,u.avatar AS sender_avatar FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.type='confession' AND m.confession_root_id=? AND m.wall_id=? AND ((m.sender_id=? AND m.sender_deleted=0) OR (m.receiver_id=? AND m.receiver_deleted=0))";
  const params = [id, root.wall_id, req.user.id, req.user.id];
  if (before) { sql += ' AND m.id<?'; params.push(before); }
  const rows = root.sender_deleted || root.receiver_deleted ? [] : req.db.prepare(sql + ' ORDER BY m.id DESC LIMIT ?').all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  res.json({ confession: presentMessages(req, [storedMessage(req, id)])[0], messages: presentMessages(req, page), hasMore, next_before_id: page[0]?.id || null });
});

function sendReply(req, res, root, { content, client_message_id: id = null, reply_to_id: quoteId = root.id } = {}) {
  if (!interactiveRoot(req, root) || !root.allow_replies || root.confession_kind === 'direct') return res.status(403).json({ error: '写信人未允许回复或表白信已不可操作', code: 'CONFESSION_REPLIES_DISABLED' });
  if (typeof content !== 'string' || !content.trim() || content.length > 2000) return res.status(400).json({ error: '回复须为1-2000字' });
  const receiverId = root.sender_id === req.user.id ? root.receiver_id : root.sender_id;
  const anonymous = root.sender_id === req.user.id && root.is_anonymous ? 1 : 0;
  const payload = { type: 'confession', receiver_id: receiverId, wall_id: root.wall_id, confession_kind: 'reply', confession_root_id: root.id, content: content.trimEnd(), is_anonymous: anonymous, reply_to_id: quoteId };
  const existing = existingSend(req, id);
  if (existing) {
    if (existing.sender_deleted || existing.receiver_deleted || existing.is_revoked || Object.entries(payload).some(([key, value]) => existing[key] !== value)) return sendConflict(res);
    return acknowledge(req, res, storedMessage(req, existing.id), true);
  }
  const inserted = req.db.prepare("INSERT INTO messages (sender_id,receiver_id,wall_id,type,content,is_anonymous,confession_kind,confession_root_id,reply_to_id,client_message_id) VALUES (?,?,?,'confession',?,?,'reply',?,?,?)")
    .run(req.user.id, receiverId, root.wall_id, payload.content, anonymous, root.id, quoteId, id);
  req.db.markDirty?.();
  return acknowledge(req, res, storedMessage(req, inserted.lastInsertRowid));
}

router.post('/:id/replies', (req, res) => {
  const id = positiveId(req.params.id);
  const client = clientId(req.body);
  if (!id || client === false || !validKeys(req.body, ['content', 'client_message_id'])) return res.status(400).json({ error: '回复参数无效，请勿指定匿名对方的用户信息' });
  const root = authorizedRoot(req, res, id, true);
  if (!root) return;
  return sendReply(req, res, root, { content: req.body.content, client_message_id: client });
});

router.post('/:id/identity-requests', (req, res) => {
  const id = positiveId(req.params.id);
  const message = req.body.message === undefined ? '' : req.body.message;
  if (!id || !validKeys(req.body, ['message', 'confirmed']) || req.body.confirmed !== true || typeof message !== 'string' || message.length > 2000) return res.status(400).json({ error: '请确认申请，附言最多2000字' });
  const root = authorizedRoot(req, res, id, true);
  if (!root) return;
  if (!root.is_anonymous || root.receiver_id !== req.user.id || root.confession_kind !== 'letter') return res.status(403).json({ error: '只有匿名表白信的收件人可以申请' });
  if (req.db.prepare('SELECT id FROM confession_identity_requests WHERE message_id=?').get(id)) return res.status(409).json({ error: '此表白信已申请过身份查看', code: 'CONFESSION_REQUEST_EXISTS' });
  const requestId = transaction(req.db, () => {
    const inserted = req.db.prepare('INSERT INTO confession_identity_requests (message_id,wall_id,requester_id,author_id,message) VALUES (?,?,?,?,?)').run(id, root.wall_id, req.user.id, root.sender_id, message.trimEnd());
    req.db.prepare("INSERT INTO messages (sender_id,receiver_id,wall_id,type,title,content,link) VALUES (NULL,?,?,'system',?,?,?)")
      .run(root.sender_id, root.wall_id, '表白信身份查看申请', '表白信收件人申请查看你的身份，你可以选择允许或拒绝。', '/inbox?tab=confession');
    return inserted.lastInsertRowid;
  });
  return res.json({ request: requestSummary(req, req.db.prepare('SELECT * FROM confession_identity_requests WHERE id=?').get(requestId)) });
});

module.exports = router;
module.exports.sendReply = sendReply;
module.exports.authorizedRoot = authorizedRoot;
