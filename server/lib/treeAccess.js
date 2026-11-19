const { settleWallBan } = require('../middleware/auth');

function activeWallMember(req, wallId, userId) {
  const wall = req.db.prepare("SELECT id FROM walls WHERE id=? AND status='active'").get(wallId);
  if (!wall) return false;
  const member = req.db.prepare('SELECT status, wall_ban_until, wall_ban_reason FROM wall_members WHERE wall_id=? AND user_id=?').get(wallId, userId);
  if (member) settleWallBan(req.db, wallId, userId, member);
  return member?.status === 'active';
}

function treeConversation(req, convId) {
  if (typeof convId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(convId)) return null;
  return req.db.prepare("SELECT sender_id, receiver_id, wall_id, assignee_id FROM messages WHERE type='tree_hole' AND conversation_id=? ORDER BY id ASC LIMIT 1").get(convId) || null;
}

// 树洞资格随成员状态和权限实时撤销；旧消息中的收件人身份不授予永久访问权。
function canAccessTree(req, first) {
  if (!first || !activeWallMember(req, first.wall_id, req.user.id)) return false;
  if (first.sender_id === req.user.id) return true;
  return (first.assignee_id || first.receiver_id) === req.user.id && req.can('wall.tree_hole', first.wall_id);
}

// 与消息详情/收件箱共享授权规则；仅统计当前接收侧尚未隐藏的树洞未读。
// req 必须先经过 authRequired，具备 db、user、can。到期墙封禁按既有规则结算。
function countAccessibleTreeUnread(req) {
  const conversations = req.db.prepare(
    "SELECT conversation_id, COUNT(*) AS c FROM messages WHERE receiver_id=? AND receiver_deleted=0 AND type='tree_hole' AND is_read=0 GROUP BY conversation_id"
  ).all(req.user.id);
  return conversations.reduce((count, conversation) => {
    const first = treeConversation(req, conversation.conversation_id);
    return count + (canAccessTree(req, first) ? conversation.c : 0);
  }, 0);
}

module.exports = { activeWallMember, treeConversation, canAccessTree, countAccessibleTreeUnread };
