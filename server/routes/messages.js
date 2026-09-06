const express = require('express');
const crypto = require('crypto');
const { authRequired, wallContext } = require('../middleware/auth');
const { userCan } = require('../lib/permissions');

const router = express.Router();

// 解析可选的墙上下文（用于表白信/树洞按墙隔离）
function optionalWallId(req) {
  const raw = req.headers['x-wall-id'] || req.query.wall_id || req.body?.wall_id;
  const id = parseInt(raw);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

const validTypes = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];

// 获取收件箱（支持按类型筛选）
router.get('/inbox', authRequired, (req, res) => {
  const { type, unread } = req.query;

  let where = 'WHERE m.receiver_id = ?';
  const params = [req.user.id];

  if (type && validTypes.includes(type)) {
    where += ' AND m.type = ?';
    params.push(type);
  }
  if (unread === '1') {
    where += ' AND m.is_read = 0';
  }

  const messages = req.db.prepare(`
    SELECT m.id, m.conversation_id,
      CASE WHEN m.is_anonymous = 1 THEN NULL ELSE m.sender_id END as sender_id,
      m.receiver_id, m.wall_id, m.type, m.title, m.content, m.is_anonymous, m.is_read, m.is_revoked, m.reply_to_id, m.reply_to_content, m.link, m.created_at,
      CASE
        WHEN m.type = 'announcement' THEN '管理员'
        WHEN m.type = 'interaction' AND m.sender_id IS NOT NULL THEN u.nickname
        WHEN m.is_anonymous = 1 OR m.sender_id IS NULL THEN NULL
        ELSE u.nickname
      END as sender_nickname,
      CASE WHEN m.is_anonymous = 1 OR m.sender_id IS NULL THEN NULL ELSE u.avatar END as sender_avatar
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    ${where}
    ORDER BY m.created_at DESC
  `).all(...params);

  // 各类型未读数
  const unreadCounts = {};
  validTypes.forEach(t => {
    const row = req.db.prepare(
      'SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND type = ? AND is_read = 0'
    ).get(req.user.id, t);
    unreadCounts[t] = row ? row.c : 0;
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
    SELECT m.*, u.nickname as receiver_nickname
    FROM messages m
    JOIN users u ON m.receiver_id = u.id
    WHERE m.sender_id = ? AND m.type IN ('private', 'confession')
    ORDER BY m.created_at DESC
  `).all(req.user.id);

  res.json(messages);
});

// 发送私信/表白信
router.post('/', authRequired, (req, res) => {
  const { receiver_id, type, title, content, is_anonymous, reply_to_id } = req.body;

  if (!receiver_id || !content || !type) {
    return res.status(400).json({ error: '参数不完整' });
  }
  if (!['private', 'confession'].includes(type)) {
    return res.status(400).json({ error: '消息类型错误' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: '内容不能超过2000字' });
  }

  const receiver = req.db.prepare('SELECT id FROM users WHERE id = ?').get(parseInt(receiver_id));
  if (!receiver) return res.status(404).json({ error: '收件人不存在' });
  if (parseInt(receiver_id) === req.user.id) {
    return res.status(400).json({ error: '不能给自己发消息' });
  }

  const blocked = req.db.prepare("SELECT id FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'").get(parseInt(receiver_id), req.user.id);
  if (blocked) {
    return res.status(403).json({ error: '对方拒绝接受你的消息' });
  }

  // 表白信按墙隔离：发件人与收件人须同属该墙 active 成员
  let wallId = 0;
  if (type === 'confession') {
    wallId = optionalWallId(req);
    if (!wallId) return res.status(400).json({ error: '缺少校园墙上下文' });
    const meMember = req.db.prepare("SELECT id FROM wall_members WHERE wall_id=? AND user_id=? AND status='active'").get(wallId, req.user.id);
    if (!meMember) return res.status(403).json({ error: '你不是该校园墙的成员' });
    const rcvMember = req.db.prepare("SELECT id FROM wall_members WHERE wall_id=? AND user_id=? AND status='active'").get(wallId, parseInt(receiver_id));
    if (!rcvMember) return res.status(400).json({ error: '收件人不在该校园墙内' });
  }

  const senderId = (type === 'confession' && is_anonymous) ? null : req.user.id;

  let replyContent = '';
  if (reply_to_id) {
    const replyMsg = req.db.prepare('SELECT content, is_revoked, sender_id, receiver_id, type FROM messages WHERE id = ?').get(parseInt(reply_to_id));
    // 安全修复：校验发起方是否能看到这条消息 —— 必须是消息的参与者（发件人或收件人）
    if (replyMsg && !replyMsg.is_revoked) {
      const isParticipant = replyMsg.sender_id === req.user.id || replyMsg.receiver_id === req.user.id;
      if (isParticipant && replyMsg.type !== 'tree_hole') {
        replyContent = replyMsg.content.substring(0, 100);
      } else if (isParticipant && replyMsg.type === 'tree_hole') {
        // 树洞对话也允许引用
        replyContent = replyMsg.content.substring(0, 100);
      }
      // 不是参与者则忽略 reply_to_id（不报错，静默忽略）
    }
  }

  // 跳转目标：收件人点开就能直接进和发件人的私聊。
  // 判据必须是 is_anonymous 而不是 senderId —— private 类型即使标了匿名，
  // senderId 依然是本人（只有匿名表白信才置 null），拿它拼链接会把匿名发件人暴露出去。
  const link = is_anonymous ? '' : `/chat/${req.user.id}`;

  const result = req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, is_anonymous, reply_to_id, reply_to_content, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(senderId, parseInt(receiver_id), wallId, type, title || '', content.trim(), is_anonymous ? 1 : 0, reply_to_id || 0, replyContent, link);

  res.json({ id: result.lastInsertRowid, message: '发送成功' });
});

// 批量标记已读
router.put('/read-all', authRequired, (req, res) => {
  const { type } = req.body;
  let where = 'WHERE receiver_id = ? AND is_read = 0';
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
  let where = 'WHERE receiver_id = ?';
  const params = [req.user.id];
  const validTypesFilter2 = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];
  if (type && validTypesFilter2.includes(type)) {
    where += ' AND type = ?';
    params.push(type);
  }
  const result = req.db.prepare(`DELETE FROM messages ${where}`).run(...params);
  res.json({ message: `已删除${result.changes}条消息` });
});

// 清空与某用户的聊天记录
router.delete('/chat/:userId', authRequired, (req, res) => {
  const userId = parseInt(req.params.userId);
  // 删除双方的私信记录
  const result = req.db.prepare(`
    DELETE FROM messages WHERE type = 'private' AND (
      (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    )
  `).run(req.user.id, userId, userId, req.user.id);

  res.json({ message: `已清空${result.changes}条聊天记录` });
});

// 标记单条已读
router.put('/:id/read', authRequired, (req, res) => {
  const result = req.db.prepare(`
    UPDATE messages SET is_read = 1 WHERE id = ? AND receiver_id = ?
  `).run(parseInt(req.params.id), req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '消息不存在' });
  }
  res.json({ message: '已标记为已读' });
});

// 删除消息
router.delete('/:id', authRequired, (req, res) => {
  const result = req.db.prepare(`
    DELETE FROM messages WHERE id = ? AND (receiver_id = ? OR sender_id = ?)
  `).run(parseInt(req.params.id), req.user.id, req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '消息不存在' });
  }
  res.json({ message: '已删除' });
});

// 举报用户（私信界面）
router.post('/report-user', authRequired, (req, res) => {
  const { reported_user_id, reason, selected_message_ids } = req.body;
  if (!reported_user_id || !reason || !reason.trim()) {
    return res.status(400).json({ error: '请填写举报原因' });
  }
  if (reason.length > 1000) return res.status(400).json({ error: '描述不能超过1000字' });
  if (parseInt(reported_user_id) === req.user.id) return res.status(400).json({ error: '不能举报自己' });

  const targetUser = req.db.prepare('SELECT id, nickname FROM users WHERE id=?').get(parseInt(reported_user_id));
  if (!targetUser) return res.status(404).json({ error: '用户不存在' });

  let evidenceText = '';
  if (Array.isArray(selected_message_ids) && selected_message_ids.length > 0) {
    const placeholders = selected_message_ids.map(() => '?').join(',');
    const evidenceMsgs = req.db.prepare(
      `SELECT content, sender_id, created_at FROM messages WHERE id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...selected_message_ids.map(id => parseInt(id)));
    evidenceText = evidenceMsgs.map(m => {
      const who = m.sender_id === req.user.id ? '我' : '对方';
      return `[${who} ${m.created_at}] ${m.content}`;
    }).join('\n');
  }

  req.db.prepare(`
    INSERT INTO user_reports (wall_id, reporter_id, reported_user_id, reason, evidence_messages)
    VALUES (?, ?, ?, ?, ?)
  `).run(optionalWallId(req), req.user.id, parseInt(reported_user_id), reason.trim(), evidenceText);

  const admins = req.db.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin') AND status='active'").all();
  const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
  admins.forEach(a => ins.run(a.id, '用户举报', `${reporter?.nickname || '用户'} 举报了用户 ${targetUser.nickname || '未知'}，请前往管理后台处理`, '/admin?panel=userReports'));

  res.json({ message: '举报已提交，管理员会尽快处理' });
});

// 撤回消息（5分钟内）
router.put('/:id/revoke', authRequired, (req, res) => {
  const msg = req.db.prepare('SELECT id, sender_id, created_at, is_revoked FROM messages WHERE id = ?').get(parseInt(req.params.id));
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: '只能撤回自己的消息' });
  if (msg.is_revoked) return res.status(400).json({ error: '消息已撤回' });

  const created = new Date(msg.created_at.replace(' ', 'T')).getTime();
  if (Date.now() - created > 5 * 60 * 1000) {
    return res.status(400).json({ error: '只能撤回5分钟内的消息' });
  }

  req.db.prepare("UPDATE messages SET is_revoked = 1, content = '[消息已撤回]' WHERE id = ?").run(msg.id);
  res.json({ message: '已撤回' });
});

// ===== 树洞匿名倾诉 =====

// 发起倾诉（当前墙内，路由到本墙树洞志愿者/墙管理者）
router.post('/tree-hole', authRequired, wallContext, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '内容不能超过2000字' });

  // 候选人按「是否拥有 wall.tree_hole」筛，而不是直接查 wall_role ——
  // 后者会漏掉通过权限覆盖单独授予的志愿者，也不会剔除被 deny 掉的人。
  const members = req.db.prepare(
    "SELECT user_id AS id FROM wall_members WHERE wall_id=? AND status='active' AND user_id != ?"
  ).all(req.wallId, req.user.id);
  const volunteers = members.filter(m => userCan(req.db, m.id, 'wall.tree_hole', req.wallId));

  if (!volunteers.length) return res.status(400).json({ error: '本校园墙暂无树洞志愿者，请稍后再试' });
  const treeHole = volunteers[Math.floor(Math.random() * volunteers.length)];

  const convId = 'th_' + req.wallId + '_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex');

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
  const myConversations = req.db.prepare(`
    SELECT conversation_id,
      MAX(created_at) as last_time,
      COUNT(*) as msg_count,
      SUM(CASE WHEN receiver_id = ? AND is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM messages
    WHERE type = 'tree_hole' AND conversation_id != '' AND (sender_id = ? OR receiver_id = ?)
    GROUP BY conversation_id
    ORDER BY last_time DESC
  `).all(userId, userId, userId);

  myConversations.forEach(conv => {
    const lastMsg = req.db.prepare(
      "SELECT content, sender_id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(conv.conversation_id);
    conv.last_message = lastMsg ? lastMsg.content.substring(0, 50) : '';
    conv.is_mine = lastMsg ? lastMsg.sender_id === userId : false;

    const firstMsg = req.db.prepare(
      "SELECT sender_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1"
    ).get(conv.conversation_id);
    conv.initiator_id = firstMsg ? firstMsg.sender_id : null;
    conv.is_initiator = firstMsg ? firstMsg.sender_id === userId : false;

    const closed = req.db.prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
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
  const myWallIds = candidateWalls.filter(w => req.can('wall.tree_hole', w));
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

    pendingConversations.forEach(conv => {
      const firstMsg = req.db.prepare(
        "SELECT content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1"
      ).get(conv.conversation_id);
      conv.first_message = firstMsg ? firstMsg.content.substring(0, 80) : '';
    });
  }

  res.json({ my: myConversations, pending: pendingConversations });
});

// 获取对话消息
router.get('/tree-hole/:conversationId', authRequired, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const check = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!check) return res.status(403).json({ error: '无权访问此对话' });

  const messages = req.db.prepare(
    "SELECT id, sender_id, receiver_id, content, is_read, is_revoked, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  ).all(convId);

  req.db.prepare(
    "UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND receiver_id = ? AND is_read = 0"
  ).run(convId, userId);

  const closed = messages.some(m => m.content === '[对话已关闭]' && m.is_revoked === 1);
  const firstMsg = messages[0];
  const isInitiator = firstMsg ? firstMsg.sender_id === userId : false;
  // 获取对方用户 ID（用于举报）
  const otherUserId = firstMsg ? (firstMsg.sender_id === userId ? firstMsg.receiver_id : firstMsg.sender_id) : null;

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
    other_user_id: otherUserId,
  });
});

// 回复树洞对话
router.post('/tree-hole/:conversationId/reply', authRequired, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '内容不能超过2000字' });

  const userId = req.user.id;
  const convId = req.params.conversationId;

  // 会话元信息一律以首条消息为准（它记录了发起人和被分配的志愿者）。
  // 参与者判定则必须扫全部消息 —— 志愿者接手后只会成为后续消息的一方，
  // 只看首条会把接手的人挡在外面。
  const first = req.db.prepare(
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get(convId);
  if (!first) return res.status(404).json({ error: '对话不存在' });

  const isParticipant = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!isParticipant) return res.status(403).json({ error: '无权参与此对话' });

  const closed = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
  ).get(convId);
  if (closed) return res.status(400).json({ error: '对话已关闭，无法继续回复' });

  const initiatorId = first.sender_id;
  const volunteerId = first.assignee_id || first.receiver_id;
  const receiverId = userId === initiatorId ? volunteerId : initiatorId;

  // assignee_id 必须继承会话的值。原先这里硬写 0，导致有过回复的对话
  // 在别的志愿者那儿被算成「待响应」，点进去又必然失败。
  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, conversation_id, assignee_id, link)
    VALUES (?, ?, ?, 'tree_hole', ?, 1, ?, ?, ?)
  `).run(userId, receiverId, first.wall_id || 0, content.trim(), convId, first.assignee_id || 0, `/tree-hole/chat/${convId}`);

  res.json({ message: '已发送' });
});

// 关闭树洞对话（双方均可关闭，改为验证用户是对话参与者）
router.post('/tree-hole/:conversationId/close', authRequired, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const firstMsg = req.db.prepare(
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get(convId);
  if (!firstMsg) return res.status(404).json({ error: '对话不存在' });
  // 双方均可关闭。判定要扫全部消息：志愿者接手后只出现在后续消息里，
  // 只看首条的话接手的人无权关闭自己正在跟进的对话。
  const canClose = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!canClose) {
    return res.status(403).json({ error: '无权操作此对话' });
  }

  const alreadyClosed = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
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
    "SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get(convId);
  if (!firstMsg) return res.status(404).json({ error: '对话不存在' });

  // 已经在这个对话里的人不必再接入。判定要扫全部消息，不能只看首条。
  const isParticipant = !!req.db.prepare(
    "SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (isParticipant) return res.status(400).json({ error: '你已经是该对话的参与者' });

  // 检查当前用户是否是该墙的志愿者
  const wallId = firstMsg.wall_id || 0;
  if (!req.can('wall.tree_hole', wallId)) {
    return res.status(403).json({ error: '你不是该校园墙的树洞志愿者' });
  }

  const closed = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND content = '[对话已关闭]' AND is_revoked = 1 LIMIT 1"
  ).get(convId);
  if (closed) return res.status(400).json({ error: '该对话已关闭' });

  // 「有没有人在跟进」看的是被分配的志愿者是否真的开口过，而不是 assignee_id 是否为 0。
  // 发起倾诉时就会随机分配一名志愿者，assignee_id 从一开始就非 0 ——
  // 按旧写法这里永远命中「已被响应」，响应功能从来没生效过。
  const answered = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id=? AND assignee_id != 0 AND sender_id = assignee_id LIMIT 1"
  ).get(convId);
  if (answered) return res.status(400).json({ error: '该对话已有志愿者在跟进' });

  const initiatorId = firstMsg.sender_id;

  // 接手：既要改 assignee_id，也要接替原志愿者成为对话的另一方。
  // 只改 assignee_id 不够 —— 读取和回复都按 sender_id/receiver_id 判定参与者，
  // 不改 receiver_id 的话，接手的人转头就会被自己接的对话 403 挡在门外。
  req.db.prepare("UPDATE messages SET assignee_id=? WHERE conversation_id=?").run(userId, convId);
  req.db.prepare("UPDATE messages SET receiver_id=? WHERE conversation_id=? AND sender_id=?")
    .run(userId, convId, initiatorId);

  // 发送一条系统消息通知倾诉者
  req.db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, conversation_id, assignee_id, link)
    VALUES (NULL, ?, ?, 'tree_hole', '有树洞志愿者来陪你聊聊了', 0, ?, ?, ?)
  `).run(initiatorId, wallId, convId, userId, `/tree-hole/chat/${convId}`);

  res.json({ message: '已接入对话' });
});

// 删除树洞对话（参与者可删除）
router.delete('/tree-hole/:conversationId', authRequired, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;

  const check = req.db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
  ).get(convId, userId, userId);
  if (!check) return res.status(403).json({ error: '无权删除此对话' });

  const result = req.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  res.json({ message: `已删除 ${result.changes} 条消息` });
});

module.exports = router;
