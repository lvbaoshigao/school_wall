const express = require('express');
const crypto = require('crypto');
const { authRequired, wallContext, settleBan } = require('../middleware/auth');
const { activeWallMember, treeConversation, canAccessTree, countAccessibleTreeUnread, primeTreeAccess, primeWallMembers, treeVolunteer } = require('../lib/treeAccess');
const { effectivePerms, userCan } = require('../lib/permissions');
const { presentMessages, canQuoteMessage } = require('../lib/messagePresentation');

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

// Arguments are internal SQL expressions (placeholders or column names), never user input.
function blockedPairQuery(a, b) {
  return `SELECT 1 FROM friends f WHERE f.status='blocked' AND
    ((f.user_id=${a} AND f.friend_id=${b}) OR (f.user_id=${b} AND f.friend_id=${a}))`;
}

function isBlocked(req, a, b) {
  return !!req.db.prepare(blockedPairQuery('?', '?') + ' LIMIT 1').get(a, b, b, a);
}

function validateTreeAccess(req, res, next) {
  const first = treeConversation(req, req.params.conversationId);
  if (!canAccessTree(req, first)) return res.status(403).json({ error: '无权访问此对话' });
  req.treeConversation = first;
  next();
}

const validTypes = ['private', 'confession', 'system', 'announcement', 'interaction', 'tree_hole', 'report_notification', 'role_application'];

const messageColumns = 'm.id,m.sender_id,m.receiver_id,m.wall_id,m.type,m.title,m.content,m.is_anonymous,m.is_read,m.is_revoked,m.reply_to_id,m.reply_to_content,m.link,m.created_at,m.client_message_id';

function canSendPrivate(req, otherId) {
  if (req.user.banRestricted || isBlocked(req, req.user.id, otherId)) return false;
  const receiver = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(otherId);
  if (!receiver) return false;
  const friend = req.db.prepare("SELECT 1 FROM friends WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1").get(req.user.id, otherId, otherId, req.user.id);
  if (friend) return true;
  return !!req.db.prepare("SELECT 1 FROM wall_members a JOIN wall_members b ON a.wall_id=b.wall_id JOIN walls w ON w.id=a.wall_id WHERE a.user_id=? AND b.user_id=? AND a.status='active' AND b.status='active' AND w.status='active' LIMIT 1").get(req.user.id, otherId);
}

function markVisibleMessagesRead(req, messages) {
  const ids = messages.filter(m => m.receiver_id === req.user.id && !m.is_read).map(m => m.id);
  if (!ids.length) return 0;
  let changes = 0;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    changes += req.db.prepare('UPDATE messages SET is_read=1 WHERE id IN (' + batch.map(() => '?').join(',') + ') AND receiver_id=? AND receiver_deleted=0').run(...batch, req.user.id).changes;
  }
  if (changes > 0) req.db.markDirty?.();
  messages.forEach(m => { if (m.receiver_id === req.user.id) m.is_read = 1; });
  return changes;
}

// Internal SQL fragments only. Bulk actions obey the same current tree access
// as individual actions, without loading bodies or every ordinary message row.
function updateReceivedMessages(req, where, params, assignment) {
  const conversations = req.db.prepare("SELECT DISTINCT conversation_id FROM messages " + where + " AND type='tree_hole'").all(...params);
  primeTreeAccess(req, conversations.map(row => row.conversation_id));
  const allowed = conversations.filter(row => canAccessTree(req, treeConversation(req, row.conversation_id)))
    .map(row => row.conversation_id);
  const update = (filter, values = []) => req.db.prepare('UPDATE messages SET ' + assignment + ' ' + where + ' AND ' + filter)
    .run(...params, ...values).changes;
  req.db.exec('SAVEPOINT content_messages_received');
  try {
    let changes = update("type!='tree_hole'");
    for (let offset = 0; offset < allowed.length; offset += 400) {
      const batch = allowed.slice(offset, offset + 400);
      changes += update("type='tree_hole' AND conversation_id IN (" + batch.map(() => '?').join(',') + ')', batch);
    }
    req.db.exec('RELEASE SAVEPOINT content_messages_received');
    return changes;
  } catch (error) {
    req.db.exec('ROLLBACK TO SAVEPOINT content_messages_received');
    req.db.exec('RELEASE SAVEPOINT content_messages_received');
    throw error;
  }
}

// 最近会话按本人仍可见的最后一条私信排序，不读取树洞或表白信的身份。
router.get('/conversations', authRequired, (req, res) => {
  const limit = req.query.limit === undefined ? 30 : positiveId(req.query.limit);
  const before = req.query.before === undefined ? 0 : positiveId(req.query.before);
  if (!limit || limit > 100 || (req.query.before !== undefined && !before) || ['after', 'around_id', 'q'].some(key => req.query[key] !== undefined)) return res.status(400).json({ error: '分页参数无效' });
  const params = [req.user.id, req.user.id, req.user.id, req.user.id];
  let sql = "SELECT peer_id AS user_id,MAX(id) AS last_message_id,SUM(CASE WHEN receiver_id=? AND is_read=0 THEN 1 ELSE 0 END) AS unread_count FROM (SELECT m.id,m.receiver_id,m.is_read,CASE WHEN m.sender_id=? THEN m.receiver_id ELSE m.sender_id END AS peer_id FROM messages m WHERE m.type='private' AND m.is_anonymous=0 AND m.sender_id IS NOT NULL AND m.sender_id!=m.receiver_id AND ((m.sender_id=? AND m.sender_deleted=0) OR (m.receiver_id=? AND m.receiver_deleted=0))) GROUP BY peer_id";
  if (before) { sql += ' HAVING MAX(id)<?'; params.push(before); }
  sql += ' ORDER BY last_message_id DESC LIMIT ?';
  params.push(limit + 1);
  // Each request reads current blocks, friendships and memberships in the same query.
  const query = 'WITH summaries AS (' + sql + "), relations AS (SELECT CASE WHEN user_id=? THEN friend_id ELSE user_id END AS peer_id,MAX(status='blocked') AS blocked,MAX(status='accepted') AS accepted FROM friends WHERE user_id=? OR friend_id=? GROUP BY peer_id), shared AS (SELECT DISTINCT b.user_id AS peer_id FROM wall_members a JOIN walls w ON w.id=a.wall_id AND w.status='active' JOIN wall_members b ON b.wall_id=a.wall_id AND b.status='active' WHERE a.user_id=? AND a.status='active' AND b.user_id IN (SELECT user_id FROM summaries)) SELECT " + messageColumns + ",s.user_id,s.last_message_id,s.unread_count,u.nickname AS peer_nickname,u.avatar AS peer_avatar,u.status AS peer_status,CASE WHEN u.status='active' AND COALESCE(r.blocked,0)=0 AND (COALESCE(r.accepted,0)=1 OR shared.peer_id IS NOT NULL) THEN 1 ELSE 0 END AS can_send FROM summaries s JOIN messages m ON m.id=s.last_message_id LEFT JOIN users u ON u.id=s.user_id LEFT JOIN relations r ON r.peer_id=s.user_id LEFT JOIN shared ON shared.peer_id=s.user_id ORDER BY s.last_message_id DESC";
  const rows = req.db.prepare(query).all(...params, req.user.id, req.user.id, req.user.id, req.user.id);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const fields = messageColumns.split(',').map(name => name.slice(2));
  const lastMessages = presentMessages(req, page.map(row => Object.fromEntries(fields.map(field => [field, row[field]]))));
  const conversations = page.map((row, index) => {
    const available = row.peer_status === 'active';
    return {
      user_id: row.user_id,
      other_user: { id: row.user_id, nickname: available ? (row.peer_nickname || '用户') : '用户暂不可用', avatar: available ? row.peer_avatar : '', available },
      last_message: lastMessages[index],
      last_message_id: row.last_message_id,
      last_time: row.created_at,
      unread_count: row.unread_count,
      can_send: !req.user.banRestricted && !!row.can_send,
    };
  });
  const next = conversations.at(-1)?.last_message_id || null;
  res.json({ conversations, hasMore, next_before_id: next, next_before: next });
});

// 所有游标都在授权后的双人私信集合内工作，搜索和定位不会扩展可见范围。
router.get('/conversation/:userId', authRequired, (req, res) => {
  const otherId = positiveId(req.params.userId);
  if (!otherId) return res.status(400).json({ error: '用户 ID 无效' });
  const limit = req.query.limit === undefined ? 100 : positiveId(req.query.limit);
  const cursors = {};
  for (const name of ['before', 'after', 'around_id']) {
    if (req.query[name] !== undefined) {
      cursors[name] = positiveId(req.query[name]);
      if (!cursors[name]) return res.status(400).json({ error: '分页参数无效' });
    }
  }
  const markRead = req.query.mark_read === undefined ? '1' : req.query.mark_read;
  if (!limit || limit > 200 || Object.keys(cursors).length > 1 || !['0', '1'].includes(markRead)) return res.status(400).json({ error: '分页参数组合无效' });
  let keyword = null;
  if (req.query.q !== undefined) {
    if (typeof req.query.q !== 'string' || !req.query.q.trim() || req.query.q.length > 100 || cursors.after || cursors.around_id) return res.status(400).json({ error: '搜索参数组合无效' });
    keyword = req.query.q.trim();
  }
  const userId = req.user.id;
  const outgoing = 'm.sender_id=? AND m.receiver_id=? AND m.sender_deleted=0';
  const incoming = 'm.sender_id=? AND m.receiver_id=? AND m.receiver_deleted=0';
  let filter = "m.type='private' AND m.is_anonymous=0";
  const filterParams = [];
  if (keyword !== null) {
    filter += " AND m.content LIKE ? ESCAPE '\\'";
    filterParams.push('%' + keyword.replace(/[\\%_]/g, '\\$&') + '%');
  }
  const where = `(${outgoing} OR ${incoming}) AND ${filter}`;
  const params = [userId, otherId, otherId, userId, ...filterParams];
  const select = 'SELECT ' + messageColumns + ' FROM messages m WHERE ' + where;
  const fetchPage = (cursor, after, count) => {
    if (!count) return [];
    const order = after ? 'ASC' : 'DESC';
    const boundary = cursor ? (after ? ' AND m.id>?' : ' AND m.id<?') : '';
    const tail = [...filterParams, ...(cursor ? [cursor] : []), count];
    // Legacy self-messages can match both directions. Keep their single-row semantics.
    if (userId === otherId) {
      return req.db.prepare(`${select}${boundary} ORDER BY m.id ${order} LIMIT ?`)
        .all(userId, otherId, otherId, userId, ...tail);
    }
    // The pair indexes can stream each direction. Merge at most two pages of IDs
    // instead of sorting the entire matching OR history or materializing its bodies.
    const branch = visibility => `SELECT m.id FROM messages m WHERE ${visibility}
      AND ${filter}${boundary} ORDER BY m.id ${order} LIMIT ?`;
    return req.db.prepare(`SELECT ${messageColumns} FROM messages m JOIN (
      SELECT id FROM (${branch(outgoing)})
      UNION ALL
      SELECT id FROM (${branch(incoming)})
      ORDER BY id ${order} LIMIT ?
    ) page ON page.id=m.id ORDER BY m.id ${order}`)
      .all(userId, otherId, ...tail, otherId, userId, ...tail, count);
  };
  let messages;
  let moreInDirection = false;
  if (cursors.around_id) {
    const anchor = req.db.prepare(select + ' AND m.id=?').get(...params, cursors.around_id);
    if (!anchor) return res.status(404).json({ error: '消息不存在或不可见' });
    let lower = fetchPage(anchor.id, false, Math.floor((limit - 1) / 2));
    const higher = fetchPage(anchor.id, true, limit - 1 - lower.length);
    const remaining = limit - 1 - lower.length - higher.length;
    if (remaining) lower = lower.concat(fetchPage(lower.at(-1)?.id || anchor.id, false, remaining));
    messages = lower.reverse().concat(anchor, higher);
  } else {
    const after = !!cursors.after;
    const rows = fetchPage(cursors.after || cursors.before, after, limit + 1);
    moreInDirection = rows.length > limit;
    messages = rows.slice(0, limit);
    if (!after) messages.reverse();
  }
  const oldest = messages[0]?.id || null;
  const newest = messages.at(-1)?.id || null;
  const hasMoreBefore = oldest !== null && ((cursors.after || cursors.around_id)
    ? !!req.db.prepare('SELECT 1 FROM messages m WHERE ' + where + ' AND m.id<? LIMIT 1').get(...params, oldest) : moreInDirection);
  const hasMoreAfter = newest !== null && ((cursors.before || cursors.around_id)
    ? !!req.db.prepare('SELECT 1 FROM messages m WHERE ' + where + ' AND m.id>? LIMIT 1').get(...params, newest) : (!!cursors.after && moreInDirection));
  const unreadMarked = markRead === '1' ? markVisibleMessagesRead(req, messages) : 0;
  const hasMore = cursors.after ? hasMoreAfter : (cursors.around_id ? hasMoreBefore || hasMoreAfter : hasMoreBefore);
  res.json({
    messages: presentMessages(req, messages), hasMore, hasMoreBefore, hasMoreAfter,
    next_before_id: oldest, next_after_id: newest, next_before: oldest, unreadMarked,
  });
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
  const changes = updateReceivedMessages(req,
    `WHERE id IN (${holes}) AND receiver_id=? AND receiver_deleted=0 AND is_read=0`,
    [...safe, req.user.id], 'is_read=1');

  res.json({ message: `已标记${changes}条消息为已读` });
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
      m.receiver_id, m.wall_id, m.type, m.title, m.content, m.is_anonymous, m.is_read, m.is_revoked, m.reply_to_id, m.reply_to_content, m.link, m.created_at, m.client_message_id,
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

  const counts = req.db.prepare("SELECT type,CASE WHEN type='tree_hole' THEN conversation_id ELSE '' END AS conversation_id,COUNT(*) AS c FROM messages WHERE receiver_id=? AND receiver_deleted=0 AND is_read=0 GROUP BY type,CASE WHEN type='tree_hole' THEN conversation_id ELSE '' END").all(req.user.id);
  const treeUnread = counts.filter(row => row.type === 'tree_hole');
  primeTreeAccess(req, [...messages.filter(m => m.type === 'tree_hole').map(m => m.conversation_id), ...treeUnread.map(row => row.conversation_id)]);
  messages = messages.filter(m => m.type !== 'tree_hole' || canAccessTree(req, treeConversation(req, m.conversation_id)));
  messages.forEach(m => {
    if (m.type === 'tree_hole') {
      m.sender_id = null;
      m.sender_nickname = null;
      m.sender_avatar = null;
    }
  });

  const unreadCounts = Object.fromEntries(validTypes.map(type => [type, 0]));
  counts.forEach(row => { if (row.type !== 'tree_hole' && validTypes.includes(row.type)) unreadCounts[row.type] += row.c; });
  unreadCounts.tree_hole = countAccessibleTreeUnread(req, treeUnread);
  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);

  res.json({ messages: presentMessages(req, messages), unreadCounts, totalUnread });
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
    ? req.db.prepare("SELECT id FROM walls WHERE status='active'").all().map(r => r.id).filter(w => req.can('wall.member.approve', w))
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
    SELECT m.id, m.sender_id, m.receiver_id, m.wall_id, m.type, m.title, m.content, m.is_anonymous, m.is_read, m.is_revoked, m.reply_to_id, m.reply_to_content, m.link, m.created_at, m.client_message_id, u.nickname as receiver_nickname
    FROM messages m
    JOIN users u ON m.receiver_id = u.id
    WHERE m.sender_id = ? AND m.sender_deleted=0 AND m.type IN ('private', 'confession')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(req.user.id);

  res.json(presentMessages(req, messages));
});

// 发送私信/表白信
router.post('/', authRequired, (req, res) => {
  const { type, content, reply_to_id, client_message_id } = req.body;
  const receiverId = positiveId(req.body.receiver_id);
  const title = req.body.title === undefined ? '' : req.body.title;
  const anonymous = req.body.is_anonymous;
  if (!receiverId || typeof content !== 'string' || !content.trim() || typeof title !== 'string') return res.status(400).json({ error: '消息参数无效' });
  if (!['private', 'confession'].includes(type)) return res.status(400).json({ error: '消息类型错误' });
  if (content.length > 2000 || title.length > 100) return res.status(400).json({ error: '内容不能超过2000字，标题不能超过100字' });
  if (anonymous !== undefined && ![true, false, 0, 1].includes(anonymous)) return res.status(400).json({ error: '匿名参数无效' });
  if (type === 'private' && anonymous) return res.status(400).json({ error: '私信不支持匿名，请使用表白信' });
  if (receiverId === req.user.id) return res.status(400).json({ error: '不能给自己发消息' });
  let clientId = null;
  if (client_message_id !== undefined && client_message_id !== null) {
    if (typeof client_message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(client_message_id)) return res.status(400).json({ error: '客户端消息 ID 无效' });
    clientId = client_message_id;
  }
  const wallId = type === 'confession' ? optionalWallId(req) : 0;
  if (type === 'confession' && wallId <= 0) return res.status(400).json({ error: '校园墙上下文无效' });
  let replyId = 0;
  if (reply_to_id !== undefined && reply_to_id !== null && reply_to_id !== 0) {
    replyId = positiveId(reply_to_id);
    if (!replyId) return res.status(400).json({ error: '引用消息 ID 无效' });
  }
  const payload = { receiver_id: receiverId, type, wall_id: wallId, title: title.trim(), content: content.trim(), is_anonymous: type === 'confession' && anonymous ? 1 : 0, reply_to_id: replyId };
  const acknowledge = (stored, deduplicated) => res.json({
    id: stored.id, message: '发送成功', client_message_id: stored.client_message_id || null,
    deduplicated, message_item: presentMessages(req, [stored])[0],
  });
  const existingMessage = () => clientId ? req.db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_message_id=?').get(req.user.id, clientId) : null;
  const acknowledgeExisting = stored => {
    if (stored.sender_deleted || stored.is_revoked) return res.status(409).json({ error: '原消息已删除或撤回，请勿重复发送', code: 'CLIENT_MESSAGE_UNAVAILABLE' });
    if (Object.entries(payload).some(([key, value]) => stored[key] !== value)) return res.status(409).json({ error: '客户端消息 ID 已用于不同内容', code: 'CLIENT_MESSAGE_CONFLICT' });
    return acknowledge(stored, true);
  };
  // A retry acknowledges an already committed write; it never resends or revives it.
  const existing = existingMessage();
  if (existing) return acknowledgeExisting(existing);

  const receiver = req.db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(receiverId);
  if (!receiver) return res.status(404).json({ error: '收件人不存在或不可用' });
  if (isBlocked(req, req.user.id, receiverId)) return res.status(403).json({ error: '无法向该用户发送消息' });
  if (type === 'confession') {
    if (!activeWallMember(req, wallId, req.user.id) || !activeWallMember(req, wallId, receiverId)) return res.status(403).json({ error: '双方必须是同一有效校园墙的成员' });
  } else if (!canSendPrivate(req, receiverId)) {
    return res.status(403).json({ error: '只能私信好友或同一校园墙的成员' });
  }
  let replyContent = '';
  if (replyId) {
    const source = req.db.prepare('SELECT * FROM messages WHERE id=?').get(replyId);
    const target = { ...payload, sender_id: req.user.id };
    if (!canQuoteMessage(req, source, target) || source.is_revoked) return res.status(403).json({ error: '不能引用此消息' });
    replyContent = source.content.substring(0, 100);
  }
  const link = payload.is_anonymous ? '' : '/chat/' + req.user.id;
  let result;
  try {
    result = req.db.prepare('INSERT INTO messages (sender_id,receiver_id,wall_id,type,title,content,is_anonymous,reply_to_id,reply_to_content,link,client_message_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, receiverId, wallId, type, payload.title, payload.content, payload.is_anonymous, replyId, replyContent, link, clientId);
  } catch (error) {
    const raced = existingMessage();
    if (raced) return acknowledgeExisting(raced);
    throw error;
  }
  const stored = req.db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  return acknowledge(stored, false);
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
  const changes = updateReceivedMessages(req, where, params, 'is_read=1');
  res.json({ message: `已标记${changes}条消息为已读` });
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
  const changes = updateReceivedMessages(req, where, params, 'receiver_deleted=1');
  res.json({ message: `已删除${changes}条消息` });
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
  const id = positiveId(req.params.id);
  const msg = req.db.prepare('SELECT type,conversation_id FROM messages WHERE id=? AND receiver_id=? AND receiver_deleted=0').get(id, req.user.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.type === 'tree_hole' && !canAccessTree(req, treeConversation(req, msg.conversation_id))) return res.status(403).json({ error: '无权操作此对话' });
  req.db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND receiver_id=? AND receiver_deleted=0').run(id, req.user.id);
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

  req.db.prepare("UPDATE messages SET is_revoked = 1, title = '', content = '[消息已撤回]' WHERE id = ?").run(msg.id);
  req.db.prepare("UPDATE messages SET reply_to_content='[消息已撤回]' WHERE reply_to_id=?").run(msg.id);
  res.json({ message: '已撤回' });
});

// ===== 树洞匿名倾诉 =====

const treeTakeoverNotice = '有树洞志愿者来陪你聊聊了';
const treeVolunteerReplied = 'm.assignee_id!=0 AND m.sender_id=m.assignee_id';
// 使用既有系统通知识别显式接手，单方隐藏通知不会清除状态。
const treeTakeoverRecorded = 'm.assignee_id!=0 AND m.sender_id IS NULL AND m.content=?';
const treeAssignee = root => root.assignee_id || root.receiver_id;
const treeAssigneeKey = root => root.wall_id + ':' + treeAssignee(root);

function eligibleTreeAssignees(req, roots) {
  const pairs = new Map();
  for (const root of roots) {
    const id = treeAssignee(root);
    if (id) pairs.set(treeAssigneeKey(root), [root.wall_id, id]);
  }
  const wanted = [...pairs.values()];
  // 复用成员资格及墙内封禁到期结算。只给有接手记录的会话查资格。
  primeWallMembers(req, wanted);
  const active = wanted.filter(([wallId, userId]) => activeWallMember(req, wallId, userId));
  const eligible = new Set();
  const userActive = new Map();
  const perm = 'wall.tree_hole';
  for (let offset = 0; offset < active.length; offset += 200) {
    const batch = active.slice(offset, offset + 200);
    const values = batch.map(() => '(?,?)').join(',');
    const status = req.db.prepare(`
      WITH wanted(wall_id,user_id) AS (VALUES ${values})
      SELECT w.wall_id,u.id,u.role,u.status,u.ban_until,m.wall_role,
             g.effect AS global_effect,p.effect AS wall_effect
      FROM wanted w JOIN users u ON u.id=w.user_id
      JOIN wall_members m ON m.wall_id=w.wall_id AND m.user_id=w.user_id
      LEFT JOIN user_permissions g ON g.user_id=u.id AND g.wall_id=0 AND g.perm='wall.tree_hole'
      LEFT JOIN user_permissions p ON p.user_id=u.id AND p.wall_id=w.wall_id AND p.perm='wall.tree_hole'
    `).all(...batch.flat());
    for (const row of status) {
      if (!userActive.has(row.id)) {
        settleBan(req.db, row);
        userActive.set(row.id, row.status === 'active');
      }
      if (!userActive.get(row.id)) continue;
      const overrides = [
        { wall_id: 0, perm, effect: row.global_effect },
        { wall_id: row.wall_id, perm, effect: row.wall_effect },
      ];
      if (effectivePerms({ globalRole: row.role, wallRole: row.wall_role, overrides, wallId: row.wall_id }).has(perm)) {
        eligible.add(row.wall_id + ':' + row.id);
      }
    }
  }
  return eligible;
}

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
// 待响应只展示在我能做志愿者的墙内、我不是参与者且没有志愿者回复的对话；
// 已有接手通知时，只有现任志愿者失去资格或双方拉黑才重新排队。
router.get('/tree-hole/conversations', authRequired, (req, res) => {
  const userId = req.user.id;
  const mine = req.db.prepare("WITH mine AS (SELECT conversation_id,MAX(created_at) AS last_time,MAX(id) AS last_id,COUNT(*) AS msg_count,SUM(CASE WHEN receiver_id=? AND is_read=0 THEN 1 ELSE 0 END) AS unread_count FROM messages WHERE type='tree_hole' AND conversation_id!='' AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0)) GROUP BY conversation_id), states AS (SELECT m.conversation_id,MAX(CASE WHEN m.content='[对话已关闭]' AND m.is_revoked=1 THEN 1 ELSE 0 END) AS is_closed FROM messages m JOIN mine ON mine.conversation_id=m.conversation_id WHERE m.type='tree_hole' GROUP BY m.conversation_id) SELECT mine.conversation_id,mine.last_time,mine.msg_count,mine.unread_count,last.content AS last_message,last.sender_id AS last_sender_id,states.is_closed FROM mine JOIN messages last ON last.id=mine.last_id JOIN states ON states.conversation_id=mine.conversation_id ORDER BY mine.last_time DESC").all(userId, userId, userId);
  primeTreeAccess(req, mine.map(row => row.conversation_id));
  const myConversations = mine.filter(row => canAccessTree(req, treeConversation(req, row.conversation_id))).map(row => ({
    conversation_id: row.conversation_id,
    last_time: row.last_time,
    msg_count: row.msg_count,
    unread_count: row.unread_count,
    last_message: row.last_message ? row.last_message.substring(0, 50) : '',
    is_mine: row.last_sender_id === userId,
    is_initiator: treeConversation(req, row.conversation_id).sender_id === userId,
    is_closed: !!row.is_closed,
  }));

  const candidateWalls = req.db.prepare("SELECT wall_id FROM wall_members WHERE user_id=? AND status='active' UNION SELECT wall_id FROM user_permissions WHERE user_id=? AND perm='wall.tree_hole' AND wall_id>0").all(userId, userId).map(row => row.wall_id);
  primeWallMembers(req, candidateWalls.map(wallId => [wallId, userId]));
  const myWallIds = candidateWalls.filter(wallId => treeVolunteer(req, wallId));
  const pending = [];
  for (let offset = 0; offset < myWallIds.length; offset += 400) {
    const batch = myWallIds.slice(offset, offset + 400);
    const holes = batch.map(() => '?').join(',');
    const rows = req.db.prepare(`
      WITH candidates AS (
        SELECT conversation_id,MIN(created_at) AS first_time,COUNT(*) AS msg_count
        FROM messages
        WHERE type='tree_hole' AND conversation_id!='' AND wall_id IN (${holes})
        GROUP BY conversation_id
      ), states AS (
        SELECT m.conversation_id,MIN(m.id) AS first_id,
          MAX(CASE WHEN m.sender_id=? OR m.receiver_id=? THEN 1 ELSE 0 END) AS participated,
          MAX(CASE WHEN ${treeVolunteerReplied} THEN 1 ELSE 0 END) AS replied,
          MAX(CASE WHEN ${treeTakeoverRecorded} THEN 1 ELSE 0 END) AS taken_over,
          MAX(CASE WHEN m.content='[对话已关闭]' AND m.is_revoked=1 THEN 1 ELSE 0 END) AS closed
        FROM messages m JOIN candidates c ON c.conversation_id=m.conversation_id
        WHERE m.type='tree_hole' GROUP BY m.conversation_id
      )
      SELECT c.conversation_id,c.first_time,c.msg_count,first.id,first.sender_id,
        first.receiver_id,first.wall_id,first.assignee_id,first.content,first.created_at,
        CASE WHEN s.taken_over=1 THEN NOT EXISTS (
          ${blockedPairQuery('first.sender_id', 'COALESCE(NULLIF(first.assignee_id,0),first.receiver_id)')}
        ) ELSE 0 END AS unblocked_takeover
      FROM candidates c JOIN states s ON s.conversation_id=c.conversation_id
      JOIN messages first ON first.id=s.first_id JOIN users u ON u.id=first.sender_id AND u.status='active'
      WHERE s.participated=0 AND s.replied=0 AND s.closed=0 AND NOT EXISTS (
        ${blockedPairQuery('?', 'first.sender_id')}
      )
      ORDER BY c.first_time DESC
    `).all(...batch, userId, userId, treeTakeoverNotice, userId, userId);
    pending.push(...rows);
  }
  primeTreeAccess(req, pending.map(row => row.conversation_id), pending);
  primeWallMembers(req, pending.map(row => [row.wall_id, row.sender_id]));
  const allowed = pending.filter(row => treeVolunteer(req, row.wall_id) && activeWallMember(req, row.wall_id, row.sender_id));
  const held = eligibleTreeAssignees(req, allowed.filter(row => row.unblocked_takeover));
  const pendingConversations = allowed.filter(row => !row.unblocked_takeover || !held.has(treeAssigneeKey(row)))
    .sort((a, b) => String(b.first_time || '').localeCompare(String(a.first_time || ''))).map(row => ({
    conversation_id: row.conversation_id,
    first_time: row.first_time,
    msg_count: row.msg_count,
    first_message: row.content ? row.content.substring(0, 80) : '',
  }));
  res.json({ my: myConversations, pending: pendingConversations });
});

// 获取对话消息
router.get('/tree-hole/:conversationId', authRequired, validateTreeAccess, (req, res) => {
  const userId = req.user.id;
  const convId = req.params.conversationId;
  const paginated = req.query.limit !== undefined;
  const limit = paginated ? positiveId(req.query.limit) : 0;
  const before = req.query.before === undefined ? 0 : positiveId(req.query.before);
  const markRead = req.query.mark_read === undefined ? '1' : req.query.mark_read;
  if ((paginated && (!limit || limit > 200)) || (req.query.before !== undefined && (!before || !paginated)) || !['0', '1'].includes(markRead) || ['after', 'around_id', 'q'].some(key => req.query[key] !== undefined)) return res.status(400).json({ error: '分页参数无效' });
  let sql = "SELECT id,sender_id,receiver_id,content,is_read,is_revoked,created_at FROM messages WHERE type='tree_hole' AND conversation_id=? AND ((sender_id=? AND sender_deleted=0) OR (receiver_id=? AND receiver_deleted=0))";
  const params = [convId, userId, userId];
  if (before) { sql += ' AND id<?'; params.push(before); }
  sql += ' ORDER BY id ' + (paginated ? 'DESC LIMIT ?' : 'ASC');
  if (paginated) params.push(limit + 1);
  const rows = req.db.prepare(sql).all(...params);
  const hasMore = paginated && rows.length > limit;
  const messages = paginated ? rows.slice(0, limit).reverse() : rows;
  const unreadMarked = markRead === '1' ? markVisibleMessagesRead(req, messages) : 0;

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
    conversation_id: convId,
    hasMore,
    next_before_id: messages[0]?.id || null,
    next_before: messages[0]?.id || null,
    unreadMarked,
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

  // A real reply keeps its history binding. An unanswered explicit takeover
  // only holds while the current assignee can still reply to this initiator.
  const { state } = req.db.prepare(`
    SELECT CASE
      WHEN EXISTS(SELECT 1 FROM messages m WHERE m.type='tree_hole'
        AND m.conversation_id=? AND ${treeVolunteerReplied}) THEN 'replied'
      WHEN EXISTS(SELECT 1 FROM messages m WHERE m.type='tree_hole'
        AND m.conversation_id=? AND ${treeTakeoverRecorded}) THEN 'taken_over'
      ELSE 'unclaimed' END AS state
  `).get(convId, convId, treeTakeoverNotice);
  const held = state === 'taken_over' && !isBlocked(req, firstMsg.sender_id, treeAssignee(firstMsg)) &&
    eligibleTreeAssignees(req, [firstMsg]).has(treeAssigneeKey(firstMsg));
  if (state === 'replied' || held) {
    return res.status(400).json({ error: '该对话已有志愿者在跟进' });
  }

  const initiatorId = firstMsg.sender_id;
  // Reassign the visible copies and record the takeover notice as one operation.
  req.db.exec('SAVEPOINT tree_takeover');
  try {
    req.db.prepare("UPDATE messages SET assignee_id=? WHERE type='tree_hole' AND conversation_id=?").run(userId, convId);
    req.db.prepare("UPDATE messages SET receiver_id=?, receiver_deleted=0, is_read=0 WHERE type='tree_hole' AND conversation_id=? AND sender_id=?")
      .run(userId, convId, initiatorId);

    req.db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, wall_id, type, content, is_anonymous, conversation_id, assignee_id, link)
      VALUES (NULL, ?, ?, 'tree_hole', ?, 0, ?, ?, ?)
    `).run(initiatorId, wallId, treeTakeoverNotice, convId, userId, `/tree-hole/chat/${convId}`);
    req.db.exec('RELEASE SAVEPOINT tree_takeover');
  } catch (error) {
    req.db.exec('ROLLBACK TO SAVEPOINT tree_takeover');
    req.db.exec('RELEASE SAVEPOINT tree_takeover');
    throw error;
  }

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
