const { effectivePerms, loadOverrides } = require('./permissions');

// The cache belongs to one Express request, never to a user or process.
const accessState = Symbol('treeAccessState');
function stateFor(req) {
  if (!req[accessState]) req[accessState] = { roots: new Map(), members: new Map(), permissions: new Map(), overrides: null };
  return req[accessState];
}

function primeWallMembers(req, pairs) {
  const state = stateFor(req);
  const wanted = new Map();
  for (const [wallId, userId] of pairs) {
    const key = wallId + ':' + userId;
    if (!state.members.has(key)) wanted.set(key, [wallId, userId]);
  }
  const missing = [...wanted.values()];
  for (let offset = 0; offset < missing.length; offset += 200) {
    const batch = missing.slice(offset, offset + 200);
    const values = batch.map(() => '(?,?)').join(',');
    const rows = req.db.prepare('WITH wanted(wall_id,user_id) AS (VALUES ' + values + ') SELECT r.wall_id,r.user_id,w.status AS wall_status,m.id,m.wall_role,m.status,m.wall_ban_until,m.wall_ban_reason FROM wanted r LEFT JOIN walls w ON w.id=r.wall_id LEFT JOIN wall_members m ON m.wall_id=r.wall_id AND m.user_id=r.user_id').all(...batch.flat());
    const expired = rows.filter(row => row.wall_status === 'active' && row.status === 'banned' && row.wall_ban_until && new Date(row.wall_ban_until).getTime() < Date.now());
    if (expired.length) {
      const ids = expired.map(row => row.id);
      const result = req.db.prepare("UPDATE wall_members SET status='active',wall_ban_until='',wall_ban_reason='' WHERE status='banned' AND id IN (" + ids.map(() => '?').join(',') + ')').run(...ids);
      if (result.changes > 0) {
        req.db.markDirty?.();
        req.resetPermCache?.();
        for (const row of expired) {
          row.status = 'active';
          row.wall_ban_until = '';
          row.wall_ban_reason = '';
          state.permissions.delete(row.wall_id);
        }
      }
    }
    rows.forEach(row => state.members.set(row.wall_id + ':' + row.user_id, row));
  }
}

function activeWallMember(req, wallId, userId) {
  primeWallMembers(req, [[wallId, userId]]);
  const row = stateFor(req).members.get(wallId + ':' + userId);
  return row?.wall_status === 'active' && row.status === 'active';
}

function treeVolunteer(req, wallId) {
  if (!activeWallMember(req, wallId, req.user.id)) return false;
  const state = stateFor(req);
  if (!state.permissions.has(wallId)) {
    if (state.overrides === null) state.overrides = loadOverrides(req.db, req.user.id);
    const member = state.members.get(wallId + ':' + req.user.id);
    state.permissions.set(wallId, effectivePerms({ globalRole: req.user.role, wallRole: member.wall_role, overrides: state.overrides, wallId }).has('wall.tree_hole'));
  }
  return state.permissions.get(wallId);
}

function primeTreeAccess(req, conversationIds, knownRoots = []) {
  const state = stateFor(req);
  knownRoots.forEach(root => state.roots.set(root.conversation_id, root));
  const missing = [...new Set(conversationIds)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id) && !state.roots.has(id));
  for (let offset = 0; offset < missing.length; offset += 400) {
    const batch = missing.slice(offset, offset + 400);
    const holes = batch.map(() => '?').join(',');
    batch.forEach(id => state.roots.set(id, null));
    const roots = req.db.prepare("SELECT m.id,m.conversation_id,m.sender_id,m.receiver_id,m.wall_id,m.assignee_id,m.content,m.created_at FROM messages m JOIN (SELECT conversation_id,MIN(id) AS id FROM messages WHERE type='tree_hole' AND conversation_id IN (" + holes + ') GROUP BY conversation_id) first ON first.id=m.id').all(...batch);
    roots.forEach(root => state.roots.set(root.conversation_id, root));
  }
  const roots = conversationIds.map(id => state.roots.get(id)).filter(Boolean);
  primeWallMembers(req, roots.map(root => [root.wall_id, req.user.id]));
}

function treeConversation(req, convId) {
  if (typeof convId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(convId)) return null;
  primeTreeAccess(req, [convId]);
  return stateFor(req).roots.get(convId) || null;
}

// Membership and the current assignee are authoritative, including for old rows.
function canAccessTree(req, first) {
  if (!first || !activeWallMember(req, first.wall_id, req.user.id)) return false;
  if (first.sender_id === req.user.id) return true;
  return (first.assignee_id || first.receiver_id) === req.user.id && treeVolunteer(req, first.wall_id);
}

function countAccessibleTreeUnread(req, knownUnread) {
  const rows = knownUnread || req.db.prepare("SELECT conversation_id,COUNT(*) AS c FROM messages WHERE receiver_id=? AND receiver_deleted=0 AND type='tree_hole' AND is_read=0 GROUP BY conversation_id").all(req.user.id);
  primeTreeAccess(req, rows.map(row => row.conversation_id));
  return rows.reduce((count, row) => count + (canAccessTree(req, treeConversation(req, row.conversation_id)) ? row.c : 0), 0);
}

module.exports = { activeWallMember, treeConversation, canAccessTree, countAccessibleTreeUnread, primeTreeAccess, primeWallMembers, treeVolunteer };
