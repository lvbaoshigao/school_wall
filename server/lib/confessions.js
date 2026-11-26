'use strict';

const { activeWallMember, primeWallMembers } = require('./treeAccess');

function positiveId(raw) {
  if (!['string', 'number'].includes(typeof raw) || !/^[1-9]\d*$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : 0;
}

function wallContextId(req) {
  const values = [req.headers?.['x-wall-id'], req.query?.wall_id, req.body?.wall_id].filter(value => value !== undefined);
  if (!values.length) return 0;
  const ids = values.map(positiveId);
  return ids.every(id => id > 0 && id === ids[0]) ? ids[0] : -1;
}

// Fail closed on migration errors; a restart can safely run every operation again.
function migrateConfessions(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
  for (const [name, definition] of [
    ['confession_kind', "TEXT NOT NULL DEFAULT 'letter'"],
    ['confession_root_id', 'INTEGER NOT NULL DEFAULT 0'],
    ['allow_replies', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!columns.has(name)) db.exec('ALTER TABLE messages ADD COLUMN ' + name + ' ' + definition);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS confession_identity_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    wall_id INTEGER NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    decided_at DATETIME
  )`);
  // Historical quoted confessions were replies, never additional declarations.
  db.exec("UPDATE messages SET confession_kind='reply',confession_root_id=reply_to_id WHERE type='confession' AND reply_to_id>0 AND confession_root_id=0");
  // Resolve historical reply-to-reply chains to the original letter. A visited
  // path and depth bound make malformed legacy cycles harmless and finite.
  db.exec(`WITH RECURSIVE ancestry(message_id,ancestor_id,wall_id,path,depth) AS (
    SELECT id,confession_root_id,wall_id,',' || id || ',',0 FROM messages
      WHERE type='confession' AND confession_root_id>0
    UNION ALL
    SELECT a.message_id,p.confession_root_id,a.wall_id,a.path || p.id || ',',a.depth+1
      FROM ancestry a JOIN messages p ON p.id=a.ancestor_id AND p.wall_id=a.wall_id
      WHERE p.type='confession' AND p.confession_root_id>0 AND a.depth<1000
        AND instr(a.path,',' || p.id || ',')=0
  ), resolved AS (
    SELECT a.message_id,a.ancestor_id FROM ancestry a JOIN messages r ON r.id=a.ancestor_id
      AND r.wall_id=a.wall_id AND r.type='confession' AND r.confession_root_id=0 AND r.confession_kind!='reply'
  ) UPDATE messages SET confession_root_id=(SELECT ancestor_id FROM resolved WHERE message_id=messages.id)
    WHERE id IN (SELECT message_id FROM resolved) AND confession_root_id!=(SELECT ancestor_id FROM resolved WHERE message_id=messages.id)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_confessions_received ON messages(receiver_id,wall_id,id) WHERE type='confession' AND confession_root_id=0 AND receiver_deleted=0 AND is_revoked=0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_confessions_thread ON messages(confession_root_id,id) WHERE type='confession'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_confession_requests_author ON confession_identity_requests(author_id,status,id)');
}

function rootMessage(req, id) {
  const message = req.db.prepare("SELECT * FROM messages WHERE id=? AND type='confession'").get(id);
  if (!message || message.confession_root_id || message.confession_kind === 'reply') return null;
  return message;
}

function blocked(req, a, b) {
  return !!req.db.prepare("SELECT 1 FROM friends WHERE status='blocked' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1").get(a, b, b, a);
}

function visibleRoot(req, root) {
  if (!root || !activeWallMember(req, root.wall_id, req.user.id)) return false;
  return (root.sender_id === req.user.id && !root.sender_deleted) ||
    (root.receiver_id === req.user.id && !root.receiver_deleted);
}

function interactiveRoot(req, root) {
  if (!visibleRoot(req, root) || root.is_revoked || root.sender_deleted || root.receiver_deleted ||
      !activeWallMember(req, root.wall_id, root.sender_id) || !activeWallMember(req, root.wall_id, root.receiver_id) ||
      blocked(req, root.sender_id, root.receiver_id)) return false;
  const users = req.db.prepare("SELECT COUNT(*) AS count FROM users WHERE id IN (?,?) AND status='active'").get(root.sender_id, root.receiver_id);
  return users.count === 2;
}

function transaction(db, action) {
  db.exec('SAVEPOINT confession_action');
  try {
    const result = action();
    db.exec('RELEASE SAVEPOINT confession_action');
    db.markDirty?.();
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT confession_action');
    db.exec('RELEASE SAVEPOINT confession_action');
    throw error;
  }
}

function requestSummary(req, request) {
  const requester = req.db.prepare('SELECT id,nickname,avatar FROM users WHERE id=?').get(request.requester_id);
  return {
    id: request.id, message_id: request.message_id, wall_id: request.wall_id,
    message: request.message, status: request.status, created_at: request.created_at,
    decided_at: request.decided_at, is_author: request.author_id === req.user.id,
    requester: requester || null,
  };
}

function loadConfessionContext(req, rows) {
  const records = new Map();
  const ids = [...new Set(rows.filter(row => row.type === 'confession').map(row => row.id))];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    req.db.prepare('SELECT * FROM messages WHERE id IN (' + batch.map(() => '?').join(',') + ')').all(...batch).forEach(row => records.set(row.id, row));
  }
  const rootIds = [...new Set([...records.values()].map(row => row.confession_root_id || row.id))];
  const roots = new Map();
  const requests = new Map();
  for (let offset = 0; offset < rootIds.length; offset += 400) {
    const batch = rootIds.slice(offset, offset + 400);
    const holes = batch.map(() => '?').join(',');
    req.db.prepare("SELECT * FROM messages WHERE type='confession' AND confession_root_id=0 AND id IN (" + holes + ')').all(...batch).forEach(row => roots.set(row.id, row));
    req.db.prepare('SELECT * FROM confession_identity_requests WHERE message_id IN (' + holes + ')').all(...batch).forEach(row => requests.set(row.message_id, row));
  }
  primeWallMembers(req, [...roots.values()].flatMap(root => [[root.wall_id, req.user.id], [root.wall_id, root.sender_id], [root.wall_id, root.receiver_id]]));
  return { records, roots, requests, interactive: new Map() };
}

function presentConfession(req, output, context) {
  const record = context.records.get(output.id);
  const root = context.roots.get(record?.confession_root_id || record?.id);
  const wallId = wallContextId(req);
  if (!record || !visibleRoot(req, root) || record.wall_id !== root.wall_id || wallId < 0 || (wallId > 0 && wallId !== root.wall_id)) return null;
  if (record.id !== root.id && (root.sender_deleted || root.receiver_deleted)) return null;
  if (!context.interactive.has(root.id)) context.interactive.set(root.id, interactiveRoot(req, root));
  const available = context.interactive.get(root.id);
  const request = context.requests.get(root.id);
  output.is_mine = record.sender_id === req.user.id;
  output.confession_kind = record.confession_kind;
  output.confession_root_id = record.confession_root_id;
  output.allow_replies = root.confession_kind !== 'direct' && !!root.allow_replies;
  output.can_reply = output.allow_replies && available;
  output.identity_request = available && request ? {
    id: request.id, status: request.status, message: request.message,
    created_at: request.created_at, decided_at: request.decided_at,
  } : null;
  output.revealed_sender = null;
  if (root.is_anonymous && req.user.id === root.receiver_id) {
    // Hide the reverse routing address in the recipient's own replies, too.
    if (record.receiver_id === root.sender_id) {
      output.receiver_id = null;
      if ('receiver_nickname' in output) output.receiver_nickname = null;
      if ('receiver_avatar' in output) output.receiver_avatar = null;
    }
    if (record.sender_id === root.sender_id) {
      output.sender_id = null;
      output.sender_nickname = null;
      output.sender_avatar = null;
      output.link = '';
    }
    if (available && request?.status === 'approved' && request.requester_id === req.user.id && request.author_id === root.sender_id) {
      output.revealed_sender = req.db.prepare('SELECT id,nickname,avatar FROM users WHERE id=?').get(root.sender_id) || null;
    }
  }
  // Persisted client IDs and internal routing metadata never reveal another user.
  output.client_message_id = output.is_mine ? (record.client_message_id || null) : null;
  return output;
}


// An internal SQL predicate shared by legacy inbox, unread and bulk actions.
function confessionVisibility(req, alias = 'm') {
  const wallId = wallContextId(req);
  if (wallId < 0) return { sql: '0', params: [] };
  const memberships = req.db.prepare('SELECT wall_id FROM wall_members WHERE user_id=?').all(req.user.id);
  primeWallMembers(req, memberships.map(row => [row.wall_id, req.user.id]));
  let sql = "EXISTS (SELECT 1 FROM messages cr JOIN walls cw ON cw.id=cr.wall_id JOIN wall_members cm ON cm.wall_id=cw.id WHERE cr.id=CASE WHEN " + alias + '.confession_root_id>0 THEN ' + alias + '.confession_root_id ELSE ' + alias + ".id END AND cr.type='confession' AND cr.confession_root_id=0 AND " + alias + ".wall_id=cr.wall_id AND cw.status='active' AND cm.user_id=? AND cm.status='active' AND ((cr.sender_id=? AND cr.sender_deleted=0) OR (cr.receiver_id=? AND cr.receiver_deleted=0)) AND (" + alias + '.id=cr.id OR (cr.sender_deleted=0 AND cr.receiver_deleted=0))';
  const params = [req.user.id, req.user.id, req.user.id];
  if (wallId) { sql += ' AND cr.wall_id=?'; params.push(wallId); }
  return { sql: sql + ')', params };
}

function readableConfession(req, message) {
  const root = rootMessage(req, message.confession_root_id || message.id);
  const wallId = wallContextId(req);
  return visibleRoot(req, root) && message.wall_id === root.wall_id && wallId >= 0 && (!wallId || root.wall_id === wallId) &&
    (message.id === root.id || (!root.sender_deleted && !root.receiver_deleted));
}

module.exports = {
  confessionVisibility, readableConfession,
  positiveId, wallContextId, migrateConfessions, rootMessage, blocked,
  visibleRoot, interactiveRoot, transaction, requestSummary,
  loadConfessionContext, presentConfession,
};
