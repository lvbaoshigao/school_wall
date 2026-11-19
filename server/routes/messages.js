const express = require('express');
const crypto = require('crypto');
const { authRequired, wallContext } = require('../middleware/auth');
const { activeWallMember, treeConversation, canAccessTree, countAccessibleTreeUnread } = require('../lib/treeAccess');
const { userCan } = require('../lib/permissions');

const router = express.Router();

// 解析可选的墙上下文（用于表白信/树洞按墙隔离）
function positiveId(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 0;
  if (!/^[1-9]\d*$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : 0;
}

function optionalWallId(req) {
  const raw = [req.headers['x-wall-id'], req.query.wall_id, req.body?.wall_id].filter(v => v !== undefined);
  if (!raw.length) return 0;
  const ids = raw.map(positiveId);
  return ids.every(id => id > 0 && id === ids[0]) ? ids[0] : -1;
}

function isBlocked(req, a, b) {
  return !!req.db.prepare("SELECT 1 FROM friends WHERE status='blocked' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1").get(a, b, b, a);
}

function validateTreeAccess(req, res, next) {
  const first = treeConversation(req, req.params.conversationId);
  if (!canAccessTree(req, first)) return res.status(403).json({ error: '无权访问此对话' });
  req.treeConversation = first;
  next();
}

const validTypes = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];

// 获取与某用户的私信会话（仅双方消息，服务端过滤 + 分页）
// 原来客户端为了开一个会话要拉全量 /inbox + /sent 再在前端 filter，
// 长会话下每轮轮询都要把整箱消息搬一遍，等于把服务端已经能做的过滤丢给客户端。
router.get('/conversation/:userId', authRequired, (req, res) => {
  const otherId = positiveId(req.params.userId);
  if (!Number.isInteger(otherId) || otherId <= 0) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }
  const limit = req.query.limit === undefined ? 100 : positiveId(req.query.limit);
  const before = req.query.before === undefined ? 0 : positiveId(req.query.before);
  if (!limit || limit > 200 || (req.query.before !== undefined && !before)) return res.status(400).json({ error: '分页参数无效' });

  let sql = `
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.is_read, m.is_revoked,
           m.reply_to_id, m.reply_to_content, m.created_at
    FROM messages m
    WHERE m.type = 'private'
      AND ((m.sender_id = ? AND m.receiver_id = ? AND m.sender_deleted=0) OR (m.sender_id = ? AND m.receiver_id = ? AND m.receiver_deleted=0))
  `;
  const params = [req.user.id, otherId, otherId, req.user.id];
  if (before > 0) {
    sql += ' AND m.id < ?';
    params.push(before);
  }
  // 倒序取最近 limit 条，再在内存里翻正，避免大数据量下 ORDER BY ASC + LIMIT 取到最旧的
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(limit);

  const rows = req.db.prepare(sql).all(...params);
  const messages = rows.reverse();

  // 一次性把这批消息里发给我的标为已读，替代前端逐条 PUT
  const unreadIds = messages.filter(m => m.receiver_id === req.user.id && !m.is_read).map(m => m.id);
  if (unreadIds.length) {
    const holes = unreadIds.map(() => '?').join(',');
    req.db.prepare(`UPDATE messages SET is_read = 1 WHERE id IN (${holes}) AND receiver_id = ? AND receiver_deleted=0`)
      .run(...unreadIds, req.user.id);
    messages.forEach(m => { if (m.receiver_id === req.user.id) m.is_read = 1; });
  }

  const hasMore = rows.length === limit;
  res.json({ messages, hasMore, unreadMarked: unreadIds.length });
});

// 批量标记已读（会话用）
router.put('/read-batch', authRequired, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供消息 ID 列表' });
  }
  if (ids.length > 500) return res.status(400).json({ error: '单次最多 500 条' });
  const safe = [...new Set(ids.map(positiveId))];
  if (safe.some(id => !id)) return res.status(400).json({ error: '消息 ID 无效' });

  const holes = safe.map(() => '?').join(',');
  const result = req.db.prepare(
    `UPDATE messages SET is_read = 1 WHERE id IN (${holes}) AND receiver_id = ? AND receiver_deleted=0`
  ).run(...safe, req.user.id);

  res.json({ message: `已标记${result.changes}条消息为已读` });
});

// 获取收件箱（支持按类型筛选）
router.get('/inbox', authRequired, (req, res) => {
  const { type, unread } = req.query;
  if (type !== undefined && !validTypes.includes(type)) return res.status(400).json({ error: '消息类型错误' });
  if (unread !== undefined && !['0', '1'].includes(unread)) return res.status(400).json({ error: '未读筛选无效' });

  let where = 'WHERE m.receiver_id = ? AND m.receiver_deleted=0';
  const params = [req.user.id];

  if (type && validTypes.includes(type)) {
    where += ' AND m.type = ?';
    params.push(type);
  }
  if (unread === '1') {
    where += ' AND m.is_read = 0';
  }

  let messages = req.db.prepare(`
    SELECT m.id, m.conversation_id,
      CASE WHEN m.is_anonymous = 1 THEN NULL ELSE m.sender_id END as sender_id,
      m.receiver_id, m.wall_id, m.type, m.title, m.content, m.is_anonymous, m.is_read, m.is_revoked, m.reply_to_id, m.reply_to_content, m.link, m.created_at,
      CASE
        WHEN m.type = 'announcement' THEN '管理员'
        WHEN m.is_anonymous = 1 OR m.sender_id IS NULL THEN NULL
        WHEN m.type = 'interaction' AND m.sender_id IS NOT NULL THEN u.nickname
        ELSE u.nickname
      END as sender_nickname,
      CASE WHEN m.is_anonymous = 1 OR m.sender_id IS NULL THEN NULL ELSE u.avatar END as sender_avatar
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    ${where}
    ORDER BY m.created_at DESC
    -- 安全上限：此前无 LIMIT，收件箱随时间无限膨胀，查询线性变慢。
    -- 前端目前没有翻页，500 条对收件箱是安全的展示上限。
    LIMIT 500
  `).all(...params);

  // 隐藏已失去资格的树洞会话，避免从普通收件箱绕过树洞的访问守卫。
  const treeAccess = new Map();
  const visibleTree = convId => {
    if (!treeAccess.has(convId)) treeAccess.set(convId, canAccessTree(req, treeConversation(req, convId)));
    return treeAccess.get(convId);
  };
  messages = messages.filter(m => m.type !== 'tree_hole' || visibleTree(m.conversation_id));
  messages.forEach(m => {
    if (m.type === 'tree_hole') {
      m.sender_id = null;
      m.sender_nickname = null;
      m.sender_avatar = null;
    }
  });

  // 各类型未读数
  const unreadCounts = {};
  validTypes.forEach(t => {
    const row = req.db.prepare(
      'SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND receiver_deleted=0 AND type = ? AND is_read = 0'
    ).get(req.user.id, t);
    unreadCounts[t] = row ? row.c : 0;
    if (t === 'tree_hole') {
      unreadCounts[t] = countAccessibleTreeUnread(req);
    }
  });
  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);

  res.json({ messages, unreadCounts, totalUnread });
});

// 待处理申请：只返回当前用户真正有权审批的条目，按类型分组。
// 数据取自各自的源表（friends / wall_members / wall_applications）而不是站内信，
// 这样在别处处理过之后收件箱里不会留下已失效的按钮。
router.get('/approvals', authRequired, (req, res) => {
  const me = req.user.id;
  // 「能审批任意墙的进墙申请」= 在全局作用域下持有该墙级权限
  const globalAdmin = req.can('wall.member.approve', 0);
  const superAdmin = req.can('global.wall.approve');

  const friend = req.db.prepare(`
    SELECT f.id, f.created_at, u.id as user_id, u.username, u.nickname, u.avatar
    FROM friends f JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC LIMIT 50
  `).all(me);

  // 我能审批哪些墙的进墙申请。全局作用域下持有该权限的人（原全局管理员）覆盖所有墙；
  // 其余人按「我加入的墙 + 被单独授权过的墙」逐个判定。
  const myWalls = globalAdmin
    ? req.db.prepare("SELECT id FROM walls WHERE status='active'").all().map(r => r.id)
    : req.db.prepare(`
        SELECT wall_id AS id FROM wall_members WHERE user_id=? AND status='active'
        UNION
        SELECT wall_id AS id FROM user_permissions WHERE user_id=? AND perm='wall.member.approve' AND wall_id>0
      `).all(me, me).map(r => r.id).filter(w => req.can('wall.member.approve', w));

  let wallJoin = [];
  if (myWalls.length) {
    const holes = myWalls.map(() => '?').join(',');
    wallJoin = req.db.prepare(`
      SELECT wm.id, wm.created_at, wm.wall_id, w.name as wall_name,
             u.id as user_id, u.username, u.nickname, u.avatar
      FROM wall_members wm
      JOIN walls w ON wm.wall_id = w.id
      JOIN users u ON wm.user_id = u.id
      WHERE wm.status = 'pending' AND wm.wall_id IN (${holes})
      ORDER BY wm.created_at DESC LIMIT 50
    `).all(...myWalls);
  }

  const wallCreate = superAdmin ? req.db.prepare(`
    SELECT wa.id, wa.created_at, wa.wall_name, wa.description,
           u.id as user_id, u.username, u.nickname, u.avatar
    FROM wall_applications wa JOIN users u ON wa.applicant_id = u.id
    WHERE wa.status = 'pending'
    ORDER BY wa.created_at DESC LIMIT 50
  `).all() : [];

  res.json({
    friend,
    wall_join: wallJoin,
    wall_create: wallCreate,
    total: friend.length + wallJoin.length + wallCreate.length,
  });
});

// 获取已发送的消息（包括私信、表白信）
router.get('/sent', authRequired, (req, res) => {
  const messages = req.db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.wall_id, m.type, m.title, m.content, m.is_anonymous, m.is_read, m.is_revoked, m.reply_to_id, m.reply_to_content, m.link, m.created_at, u.nickname as receiver_nickname
    FROM messages m
    JOIN users u ON m.receiver_id = u.id
    WHERE m.sender_id = ? AND m.sender_deleted=0 AND m.type IN ('private', 'confession')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(req.user.id);

  res.json(messages);
});

// 发送私信/表白信
router.post('/', authRequired, (req, res) => {
  const { type, content, reply_to_id } = req.body;
  const receiverId = positiveId(req.body.receiver_id);
  const title = req.body.title === undefined ? '' : req.body.title;
  const anonymous = req.body.is_anonymous;
  if (!receiverId || typeof content !== 'string' || !content.trim() || typeof title !== 'string') {
    return res.status(400).json({ error: '消息参数无效' });
  }
  if (!['private', 'confession'].includes(type)) return res.status(400).json({ error: '消息类型错误' });
  if (content.length > 2000 || title.length > 100) return res.status(400).json({ error: '内容不能超过2000字，标题不能超过100字' });
  if (anonymous !== undefined && ![true, false, 0, 1].includes(anonymous)) return res.status(400).json({ error: '匿名参数无效' });
  if (type === 'private' && anonymous) return res.status(400).json({ error: '私信不支持匿名，请使用表白信' });
  const isAnonymous = type === 'confession' && !!anonymous;
  const receiver = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(receiverId);
  if (!receiver) return res.status(404).json({ error: '收件人不存在或不可用' });
  if (receiverId === req.user.id) return res.status(400).json({ error: '不能给自己发消息' });
  if (isBlocked(req, req.user.id, receiverId)) return res.status(403).json({ error: '无法向该用户发送消息' });

  let wallId = 0;
  if (type === 'confession') {
    wallId = optionalWallId(req);
    if (wallId <= 0) return res.status(400).json({ error: '校园墙上下文无效' });
    if (!activeWallMember(req, wallId, req.user.id) || !activeWallMember(req, wallId, receiverId)) {
      return res.status(403).json({ error: '双方必须是同一有效校园墙的成员' });
    }
  } else {
    const friend = req.db.prepare("SELECT 1 FROM friends WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1").get(req.user.id, receiverId, receiverId, req.user.id);
    const shared = req.db.prepare("SELECT 1 FROM wall_members a JOIN wall_members b ON a.wall_id=b.wall_id JOIN walls w ON w.id=a.wall_id WHERE a.user_id=? AND b.user_id=? AND a.status='active' AND b.status='active' AND w.status='active' LIMIT 1").get(req.user.id, receiverId);
    if (!friend && !shared) return res.status(403).json({ error: '只能私信好友或同一校园墙的成员' });
  }

  let replyId = 0;
  let replyContent = '';
  if (reply_to_id !== undefined && reply_to_id !== null && reply_to_id !== 0) {
    replyId = positiveId(reply_to_id);
    if (!replyId) return res.status(400).json({ error: '引用消息 ID 无效' });
    const reply = req.db.prepare('SELECT content, is_revoked, sender_id, receiver_id, type, wall_id, is_anonymous, sender_deleted, receiver_deleted FROM messages WHERE id=?').get(replyId);
    // 引用只能留在原双方和消息类型内；参与者也不能将另一段私密会话转发给第三人。
    const samePair = reply && ((reply.sender_id === req.user.id && reply.receiver_id === receiverId) || (reply.sender_id === receiverId && reply.receiver_id === req.user.id));
    if (!samePair || reply.type !== type || reply.wall_id !== wallId || reply.is_revoked || reply.is_anonymous || (reply.sender_id === req.user.id ? reply.sender_deleted : reply.receiver_deleted)) {
      return res.status(403).json({ error: '不能引用此消息' });
    }
    replyContent = reply.content.substring(0, 100);
  }

  // 匿名只影响展示，保留服务端归属供撤回、举报和本人发件箱使用。
  const link = isAnonymous ? '' : '/chat/' + req.user.id;
  const result = req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, is_anonymous, reply_to_id, reply_to_content, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, receiverId, wallId, type, title.trim(), content.trim(), isAnonymous ? 1 : 0, replyId, replyContent, link);
  res.json({ id: result.lastInsertRowid, message: '发送成功' });
});

// 批量标记已读
router.put('/read-all', authRequired, (req, res) => {
  const { type } = req.body;
  if (type !== undefined && !validTypes.includes(type)) return res.status(400).json({ error: '消息类型错误' });
  let where = 'WHERE receiver_id = ? AND receiver_deleted=0 AND is_read = 0';
  const params = [req.user.id];
  const validTypesFilter = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];
  if (type && validTypesFilter.includes(type)) {
    where += ' AND type = ?';
    params.push(type);
  }
  const result = req.db.prepare(`UPDATE messages SET is_read = 1 ${where}`).run(...params);
  res.json({ message: `已标记${result.changes}条消息为已读` });
});

// 批量删除收件箱消息
router.delete('/inbox/all', authRequired, (req, res) => {
  const { type } = req.query;
  if (type !== undefined && !validTypes.includes(type)) return res.status(400).json({ error: '消息类型错误' });
  let where = 'WHERE receiver_id = ? AND receiver_deleted=0';
  const params = [req.user.id];
  const validTypesFilter2 = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];
  if (type && validTypesFilter2.includes(type)) {
    where += ' AND type = ?';
    params.push(type);
  }
  const result = req.db.prepare(`UPDATE messages SET receiver_deleted=1 ${where}`).run(...params);
  res.json({ message: `已删除${result.changes}条消息` });
});

// 单方清空聊天记录：只隐藏当前用户一侧，保留对方的副本和会话元数据。
router.delete('/chat/:userId', authRequired, (req, res) => {
  const userId = positiveId(req.params.userId);
  if (!userId) return res.status(400).json({ error: '用户 ID 无效' });
  const result = req.db.prepare("UPDATE messages SET sender_deleted=CASE WHEN sender_id=? THEN 1 ELSE sender_deleted END, receiver_deleted=CASE WHEN receiver_id=? THEN 1 ELSE receiver_deleted END WHERE type='private' AND ((sender_id=? AND receiver_id=? AND sender_deleted=0) OR (sender_id=? AND receiver_id=? AND receiver_deleted=0))")
    .run(req.user.id, req.user.id, req.user.id, userId, userId, req.user.id);
  res.json({ message: '已清空你的' + result.changes + '条聊天记录' });
});

// 标记单条已读
router.put('/:id/read', authRequired, (req, res) => {
  if (!positiveId(req.params.id)) return res.status(400).json({ error: '消息 ID 无效' });
  const result = req.db.prepare(`
    UPDATE messages SET is_read = 1 WHERE id = ? AND receiver_id = ? AND receiver_deleted=0
  `).run(parseInt(req.params.id), req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '消息不存在' });
  }
  res.json({ message: '已标记为已读' });
});

// 删除消息
router.delete('/:id', authRequired, (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: '消息 ID 无效' });
  const msg = req.db.prepare('SELECT type, conversation_id FROM messages WHERE id=? AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0))').get(id, req.user.id, req.user.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.type === 'tree_hole' && !canAccessTree(req, treeConversation(req, msg.conversation_id))) return res.status(403).json({ error: '无权操作此对话' });
  req.db.prepare('UPDATE messages SET sender_deleted=CASE WHEN sender_id=? THEN 1 ELSE sender_deleted END, receiver_deleted=CASE WHEN receiver_id=? THEN 1 ELSE receiver_deleted END WHERE id=?').run(req.user.id, req.user.id, id);
  res.json({ message: '已删除' });
});

// 举报用户（私信界面）
router.post('/report-user', authRequired, (req, res) => {
  const { reason, selected_message_ids, conversation_id } = req.body;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) return res.status(400).json({ error: '举报原因长度须为1-1000字' });
  let targetId = positiveId(req.body.reported_user_id);
  let wallId = optionalWallId(req);
  let tree = null;
  if (conversation_id !== undefined) {
    tree = treeConversation(req, conversation_id);
    if (!canAccessTree(req, tree)) return res.status(403).json({ error: '无权举报此对话' });
    const otherId = tree.sender_id === req.user.id ? (tree.assignee_id || tree.receiver_id) : tree.sender_id;
    // 不接受匿名对话的显式用户 ID，避免通过尝试不同 ID 的成功/失败探测真实身份。
    if (req.body.reported_user_id !== undefined) return res.status(400).json({ error: '匿名对话请仅提供会话 ID' });
    targetId = otherId;
    wallId = tree.wall_id;
  } else if (wallId < 0 || (wallId > 0 && !activeWallMember(req, wallId, req.user.id))) {
    return res.status(403).json({ error: '校园墙上下文无效' });
  }
  if (!targetId || targetId === req.user.id) return res.status(400).json({ error: '举报对象无效' });
  const targetUser = req.db.prepare('SELECT id, nickname FROM users WHERE id=?').get(targetId);
  if (!targetUser) return res.status(404).json({ error: '用户不存在' });
  if (selected_message_ids !== undefined && (!Array.isArray(selected_message_ids) || selected_message_ids.length > 50 || selected_message_ids.some(id => !positiveId(id)))) {
    return res.status(400).json({ error: '证据消息 ID 列表无效（最多50条）' });
  }

  let evidenceText = '';
  const safeIds = [...new Set((selected_message_ids || []).map(positiveId))];
  if (safeIds.length) {
    const placeholders = safeIds.map(() => '?').join(',');
    const sql = "SELECT content, sender_id, created_at FROM messages WHERE id IN (" + placeholders + ") AND is_revoked=0 AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)) AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0)) AND " + (tree ? "type='tree_hole' AND conversation_id=?" : "type='private'") + ' ORDER BY id ASC';
    const params = [...safeIds, req.user.id, targetId, targetId, req.user.id, req.user.id, req.user.id];
    if (tree) params.push(conversation_id);
    const evidenceMsgs = req.db.prepare(sql).all(...params);
    evidenceText = evidenceMsgs.map(m => '[' + (m.sender_id === req.user.id ? '我' : '对方') + ' ' + m.created_at + '] ' + m.content).join('\n');
  }
  req.db.prepare('INSERT INTO user_reports (wall_id, reporter_id, reported_user_id, reason, evidence_messages) VALUES (?, ?, ?, ?, ?)')
    .run(wallId, req.user.id, targetId, reason.trim(), evidenceText);

  const admins = req.db.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin') AND status='active'").all();
  const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
  admins.forEach(a => ins.run(a.id, '用户举报', `${reporter?.nickname || '用户'} 举报了用户 ${targetUser.nickname || '未知'}，请前往管理后台处理`, '/admin?panel=userReports'));

  res.json({ message: '举报已提交，管理员会尽快处理' });
});

// 撤回消息（5分钟内）
router.put('/:id/revoke', authRequired, (req, res) => {
  if (!positiveId(req.params.id)) return res.status(400).json({ error: '消息 ID 无效' });
  const msg = req.db.prepare('SELECT id, sender_id, created_at, is_revoked, type, conversation_id FROM messages WHERE id = ?').get(parseInt(req.params.id));
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: '只能撤回自己的消息' });
  if (msg.type === 'tree_hole' && !canAccessTree(req, treeConversation(req, msg.conversation_id))) return res.status(403).json({ error: '无权操作此对话' });
  if (!['private', 'confession', 'tree_hole'].includes(msg.type)) return res.status(403).json({ error: '此消息不支持撤回' });
  if (msg.is_revoked) return res.status(400).json({ error: '消息已撤回' });

  const created = new Date(msg.created_at.replace(' ', 'T')).getTime();
  if (!Number.isFinite(created) || created > Date.now() || Date.now() - created > 5 * 60 * 1000) {
    return res.status(400).json({ error: '只能撤回5分钟内的消息' });
  }

  req.db.prepare("UPDATE messages SET is_revoked = 1, content = '[消息已撤回]' WHERE id = ?").run(msg.id);
  req.db.prepare("UPDATE messages SET reply_to_content='[消息已撤回]' WHERE reply_to_id=?").run(msg.id);
  res.json({ message: '已撤回' });
});

// ===== 树洞匿名倾诉 =====

// 发起倾诉（当前墙内，路由到本墙树洞志愿者/墙管理者）
router.post('/tree-hole', authRequired, wallContext, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string' || content.trim().length === 0) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '内容不能超过2000字' });

  // 候选人按「是否拥有 wall.tree_hole」筛，而不是直接查 wall_role ——
  // 后者会漏掉通过权限覆盖单独授予的志愿者，也不会剔除被 deny 掉的人。
  const members = req.db.prepare(
    "SELECT user_id AS id FROM wall_members WHERE wall_id=? AND status='active' AND user_id != ?"
  ).all(req.wallId, req.user.id);
  const volunteers = members.filter(m => {
    const user = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(m.id);
    return user && !isBlocked(req, req.user.id, m.id) && userCan(req.db, m.id, 'wall.tree_hole', req.wallId);
  });

  if (!volunteers.length) return res.status(400).json({ error: '本校园墙暂无树洞志愿者，请稍后再试' });
  const treeHole = volunteers[Math.floor(Math.random() * volunteers.length)];

  const convId = 'th_' + req.wallId + '_' + Date.now() + '_' + crypto.randomBytes(16).toString('hex');

  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, is_anonymous, conversation_id, assignee_id, link)
    VALUES (?, ?, ?, 'tree_hole', '匿名倾诉', ?, 1, ?, ?, ?)
  `).run(req.user.id, treeHole.id, req.wallId, content.trim(), convId, treeHole.id, `/tree-hole/chat/${convId}`);

  res.json({ message: '已发送给树洞志愿者', conversation_id: convId });
});

// 树洞对话列表
// 返回：我的对话（我是参与者）+ 待响应的倾诉（在我做志愿者的墙里、我不是参与者、
// 且分配到的志愿者还没回应过的对话）
router.get('/tree-hole/conversations', authRequired, (req, res) => {
  const userId = req.user.id;

  // 我的对话
  let myConversations = req.db.prepare(`
    SELECT conversation_id,
      MAX(created_at) as last_time,
      COUNT(*) as msg_count,
      SUM(CASE WHEN receiver_id = ? AND is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM messages
    WHERE type = 'tree_hole' AND conversation_id != '' AND ((sender_id = ? AND sender_deleted=0) OR (receiver_id = ? AND receiver_deleted=0))
    GROUP BY conversation_id
    ORDER BY last_time DESC
  `).all(userId, userId, userId);

  myConversations = myConversations.filter(conv => canAccessTree(req, treeConversation(req, conv.conversation_id)));
  myConversations.forEach(conv => {
    const lastMsg = req.db.prepare(
      "SELECT content, sender_id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0)) ORDER BY id DESC LIMIT 1"
    ).get(conv.conversation_id, userId, userId);
    conv.last_message = lastMsg ? lastMsg.content.substring(0, 50) : '';
    conv.is_mine = lastMsg ? lastMsg.sender_id === userId : false;

    const firstMsg = req.db.prepare(
      "SELECT sender_id FROM messages WHERE type='tree_hole' AND conversation_id = ? ORDER BY id ASC LIMIT 1"
    ).get(conv.conversation_id);
    conv.is_initiator = firstMsg ? firstMsg.sender_id === userId : false;

    const closed = req.db.prepare(
      "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
    ).get(conv.conversation_id);
    conv.is_closed = !!closed;
  });

  // 待响应的倾诉：对话在我做志愿者的墙里、我不是参与者、没关闭，
  // 且「分配到的志愿者一句话都还没说」—— 也就是发起人等不到人回应的那些。
  // 旧写法用 assignee_id = 0 判定，而创建时就会分配志愿者（assignee_id 非 0），
  // 真正命中 0 的反倒是 reply/close 插入的行，于是队列里全是点进去必然失败的对话。
  // 我在哪些墙有树洞权限：候选取「我加入的墙」并上「被单独授权过的墙」，
  // 再逐个用 can() 判定，名号带来的与单独授予的都能覆盖到。
  const candidateWalls = req.db.prepare(`
    SELECT wall_id FROM wall_members WHERE user_id=? AND status='active'
    UNION
    SELECT wall_id FROM user_permissions WHERE user_id=? AND perm='wall.tree_hole' AND wall_id>0
  `).all(userId, userId).map(r => r.wall_id);
  const myWallIds = candidateWalls.filter(w => activeWallMember(req, w, userId) && req.can('wall.tree_hole', w));
  let pendingConversations = [];
  if (myWallIds.length > 0) {
    const holes = myWallIds.map(() => '?').join(',');
    pendingConversations = req.db.prepare(`
      SELECT m.conversation_id,
        MIN(m.created_at) as first_time,
        COUNT(*) as msg_count
      FROM messages m
      WHERE m.type = 'tree_hole' AND m.conversation_id != ''
        AND m.wall_id IN (${holes})
        AND m.conversation_id NOT IN (
          SELECT DISTINCT conversation_id FROM messages
          WHERE type = 'tree_hole' AND conversation_id != '' AND (sender_id = ? OR receiver_id = ?)
        )
        AND m.conversation_id NOT IN (
          SELECT DISTINCT conversation_id FROM messages
          WHERE type = 'tree_hole' AND conversation_id != ''
            AND assignee_id != 0 AND sender_id = assignee_id
        )
        AND m.conversation_id NOT IN (
          SELECT DISTINCT conversation_id FROM messages
          WHERE type = 'tree_hole' AND conversation_id != ''
            AND content = '[对话已关闭]' AND is_revoked = 1
        )
      GROUP BY m.conversation_id
      ORDER BY first_time DESC
    `).all(...myWallIds, userId, userId);

    pendingConversations = pendingConversations.filter(conv => {
      const first = treeConversation(req, conv.conversation_id);
      if (!first || !activeWallMember(req, first.wall_id, first.sender_id) || isBlocked(req, userId, first.sender_id)) return false;
      return !!req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(first.sender_id);
    });
    pendingConversations.forEach(conv => {
      const firstMsg = req.db.prepare(
        "SELECT content FROM messages WHERE type='tree_hole' AND conversation_id = ? ORDER BY created_at ASC LIMIT 1"
      ).get(conv.conversation_id);
      conv.first_message = firstMsg ? firstMsg.content.substring(0, 80) : '';
    });
  }

  res.json({ my: myConversations, pending: pendingConversations });
});

// 获取对话消息
router.get('/tree-hole/:conversationId', authRequired, validateTreeAccess, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const check = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!check) return res.status(403).json({ error: '无权访问此对话' });

  const messages = req.db.prepare(
    "SELECT id, sender_id, receiver_id, content, is_read, is_revoked, created_at FROM messages WHERE type='tree_hole' AND conversation_id = ? AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0)) ORDER BY id ASC"
  ).all(convId, userId, userId);

  req.db.prepare(
    "UPDATE messages SET is_read = 1 WHERE type='tree_hole' AND conversation_id = ? AND receiver_id = ? AND receiver_deleted=0 AND is_read = 0"
  ).run(convId, userId);

  const closed = !!req.db.prepare("SELECT 1 FROM messages WHERE type='tree_hole' AND conversation_id=? AND content='[对话已关闭]' AND is_revoked=1 LIMIT 1").get(convId);
  const firstMsg = req.treeConversation;
  const isInitiator = firstMsg ? firstMsg.sender_id === userId : false;
  // 举报由服务器根据会话解析对方，匿名页面不返回真实用户 ID。

  res.json({
    messages: messages.map(m => ({
      id: m.id,
      content: m.content,
      is_mine: m.sender_id === userId,
      is_read: m.is_read,
      is_revoked: m.is_revoked,
      created_at: m.created_at,
    })),
    is_closed: closed,
    is_initiator: isInitiator,
    other_user_id: null,
    can_report: true,
  });
});

// 回复树洞对话
router.post('/tree-hole/:conversationId/reply', authRequired, validateTreeAccess, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string' || content.trim().length === 0) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '内容不能超过2000字' });

  const userId = req.user.id;
  const convId = req.params.conversationId;

  // 会话元信息一律以首条消息为准（它记录了发起人和被分配的志愿者）。
  // 参与者判定则必须扫全部消息 —— 志愿者接手后只会成为后续消息的一方，
  // 只看首条会把接手的人挡在外面。
  const first = req.db.prepare(
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE type='tree_hole' AND conversation_id = ? ORDER BY id ASC LIMIT 1"
  ).get(convId);
  if (!first) return res.status(404).json({ error: '对话不存在' });

  const isParticipant = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE type='tree_hole' AND conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!isParticipant) return res.status(403).json({ error: '无权参与此对话' });

  const closed = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
  ).get(convId);
  if (closed) return res.status(400).json({ error: '对话已关闭，无法继续回复' });

  const initiatorId = first.sender_id;
  const volunteerId = first.assignee_id || first.receiver_id;
  const receiverId = userId === initiatorId ? volunteerId : initiatorId;
  if (!activeWallMember(req, first.wall_id, receiverId) || isBlocked(req, userId, receiverId)) return res.status(403).json({ error: '对方当前无法参与此对话' });
  if (userId === initiatorId && !userCan(req.db, volunteerId, 'wall.tree_hole', first.wall_id)) return res.status(403).json({ error: '志愿者当前无法参与此对话' });
  const receiver = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(receiverId);
  if (!receiver) return res.status(403).json({ error: '对方当前无法参与此对话' });

  // assignee_id 必须继承会话的值。原先这里硬写 0，导致有过回复的对话
  // 在别的志愿者那儿被算成「待响应」，点进去又必然失败。
  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, conversation_id, assignee_id, link)
    VALUES (?, ?, ?, 'tree_hole', ?, 1, ?, ?, ?)
  `).run(userId, receiverId, first.wall_id || 0, content.trim(), convId, first.assignee_id || 0, `/tree-hole/chat/${convId}`);

  res.json({ message: '已发送' });
});

// 关闭树洞对话（双方均可关闭，改为验证用户是对话参与者）
router.post('/tree-hole/:conversationId/close', authRequired, validateTreeAccess, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const firstMsg = req.db.prepare(
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE type='tree_hole' AND conversation_id = ? ORDER BY id ASC LIMIT 1"
  ).get(convId);
  if (!firstMsg) return res.status(404).json({ error: '对话不存在' });
  // 双方均可关闭。判定要扫全部消息：志愿者接手后只出现在后续消息里，
  // 只看首条的话接手的人无权关闭自己正在跟进的对话。
  const canClose = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE type='tree_hole' AND conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!canClose) {
    return res.status(403).json({ error: '无权操作此对话' });
  }

  const alreadyClosed = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
  ).get(convId);
  if (alreadyClosed) return res.status(400).json({ error: '对话已经关闭' });

  // 关闭通知发给对面那一方，并继承会话的 assignee_id / wall_id。
  // 原先固定发给 firstMsg.receiver_id（接手后已过时），
  // 且 firstMsg 根本没 select wall_id，`firstMsg.wall_id || 0` 恒为 0。
  const initiatorId = firstMsg.sender_id;
  const volunteerId = firstMsg.assignee_id || firstMsg.receiver_id;
  const otherId = userId === initiatorId ? volunteerId : initiatorId;

  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, is_revoked, conversation_id, assignee_id, link)
    VALUES (?, ?, ?, 'tree_hole', '[对话已关闭]', 1, 1, ?, ?, ?)
  `).run(userId, otherId, firstMsg.wall_id || 0, convId, firstMsg.assignee_id || 0, `/tree-hole/chat/${convId}`);

  res.json({ message: '对话已关闭' });
});

// 响应树洞倾诉（志愿者接入对话）
router.post('/tree-hole/:conversationId/assign', authRequired, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const firstMsg = req.db.prepare(
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE type='tree_hole' AND conversation_id = ? ORDER BY id ASC LIMIT 1"
  ).get(convId);
  if (!firstMsg) return res.status(404).json({ error: '对话不存在' });
  if (!req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(firstMsg.sender_id)) return res.status(403).json({ error: '该对话当前无法接入' });
  if (isBlocked(req, userId, firstMsg.sender_id)) return res.status(403).json({ error: '无法参与此对话' });

  // 已经在这个对话里的人不必再接入。判定要扫全部消息，不能只看首条。
  const isParticipant = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE type='tree_hole' AND conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (isParticipant) return res.status(400).json({ error: '你已经是该对话的参与者' });

  // 检查当前用户是否是该墙的志愿者
  const wallId = firstMsg.wall_id || 0;
  if (!activeWallMember(req, wallId, userId) || !req.can('wall.tree_hole', wallId) || !activeWallMember(req, wallId, firstMsg.sender_id)) {
    return res.status(403).json({ error: '你不是该校园墙的树洞志愿者' });
  }

  const closed = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
  ).get(convId);
  if (closed) return res.status(400).json({ error: '该对话已关闭' });

  // 「有没有人在跟进」看的是被分配的志愿者是否真的开口过，而不是 assignee_id 是否为 0。
  // 发起倾诉时就会随机分配一名志愿者，assignee_id 从一开始就非 0 ——
  // 按旧写法这里永远命中「已被响应」，响应功能从来没生效过。
  const answered = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id=? AND assignee_id != 0 AND sender_id = assignee_id LIMIT 1"
  ).get(convId);
  if (answered) return res.status(400).json({ error: '该对话已有志愿者在跟进' });

  const initiatorId = firstMsg.sender_id;

  // 接手：既要改 assignee_id，也要接替原志愿者成为对话的另一方。
  // 只改 assignee_id 不够 —— 读取和回复都按 sender_id/receiver_id 判定参与者，
  // 不改 receiver_id 的话，接手的人转头就会被自己接的对话 403 挡在门外。
  req.db.prepare("UPDATE messages SET assignee_id=? WHERE type='tree_hole' AND conversation_id=?").run(userId, convId);
  req.db.prepare("UPDATE messages SET receiver_id=?, receiver_deleted=0, is_read=0 WHERE type='tree_hole' AND conversation_id=? AND sender_id=?")
    .run(userId, convId, initiatorId);

  // 发送一条系统消息通知倾诉者
  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, conversation_id, assignee_id, link)
    VALUES (NULL, ?, ?, 'tree_hole', '有树洞志愿者来陪你聊聊了', 0, ?, ?, ?)
  `).run(initiatorId, wallId, convId, userId, `/tree-hole/chat/${convId}`);

  res.json({ message: '已接入对话' });
});

// 删除树洞对话（参与者可删除）
router.delete('/tree-hole/:conversationId', authRequired, validateTreeAccess, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const check = req.db.prepare(
    "SELECT id FROM messages WHERE type='tree_hole' AND conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!check) return res.status(403).json({ error: '无权删除此对话' });

  const result = req.db.prepare("UPDATE messages SET sender_deleted=CASE WHEN sender_id=? THEN 1 ELSE sender_deleted END, receiver_deleted=CASE WHEN receiver_id=? THEN 1 ELSE receiver_deleted END WHERE type='tree_hole' AND conversation_id=? AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0))").run(userId, userId, convId, userId, userId);
  res.json({ message: `已删除 ${result.changes} 条消息` });
});

module.exports = router;
