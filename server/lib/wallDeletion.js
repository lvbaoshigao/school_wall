'use strict';

const COUNT_KEYS = [
  'members', 'wall_applications', 'ban_logs', 'posts', 'comments', 'likes',
  'bookmarks', 'messages', 'announcements', 'votes', 'vote_options',
  'vote_records', 'reports', 'post_reports', 'user_reports', 'user_permissions',
  'attachments', 'deletable_attachments', 'retained_attachments',
];

function integerCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function countRows(db, sql, ...params) {
  return integerCount(db.prepare(sql).get(...params)?.c);
}

function emptyCounts() {
  return Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
}

function localAttachmentPaths(value) {
  if (typeof value !== 'string' || !value) return [];
  const paths = new Set();
  const expression = /\/uploads\/(?:images|bug-reports)\/[\w.-]+/g;
  let match;
  while ((match = expression.exec(value))) paths.add(match[0].split('?')[0]);
  return [...paths];
}

function attachmentCandidates(db, wallId, wallName, posts, reports) {
  const paths = new Set();
  const collect = (rows, fields) => {
    for (const row of rows) for (const field of fields) {
      for (const value of localAttachmentPaths(row[field])) paths.add(value);
    }
  };
  collect(posts, ['content']);
  collect(reports, ['images']);
  collect(db.prepare('SELECT c.content FROM comments c JOIN posts p ON p.id=c.post_id WHERE p.wall_id=?').all(wallId), ['content']);
  collect(db.prepare('SELECT title,content,reply_to_content FROM messages WHERE wall_id=?').all(wallId), ['title', 'content', 'reply_to_content']);
  collect(db.prepare("SELECT title,content,reply_to_content FROM messages WHERE type='interaction' AND link IN (SELECT '/post/' || id FROM posts WHERE wall_id=?)").all(wallId), ['title', 'content', 'reply_to_content']);
  collect(db.prepare("SELECT title,content FROM announcements WHERE wall_id=? AND COALESCE(scope,'wall')!='global'").all(wallId), ['title', 'content']);
  collect(db.prepare('SELECT title,description FROM votes WHERE wall_id=?').all(wallId), ['title', 'description']);
  collect(db.prepare('SELECT reason,evidence_messages,feedback FROM user_reports WHERE wall_id=?').all(wallId), ['reason', 'evidence_messages', 'feedback']);
  collect(db.prepare('SELECT reason FROM ban_logs WHERE scope=\'wall\' AND wall_id=?').all(wallId), ['reason']);
  collect(db.prepare('SELECT pr.reason FROM post_reports pr LEFT JOIN posts p ON p.id=pr.post_id WHERE p.wall_id=? OR (p.id IS NULL AND pr.wall_id=?)').all(wallId, wallId), ['reason']);
  collect(db.prepare("SELECT description FROM wall_applications WHERE status='approved' AND wall_name=?").all(wallName), ['description']);
  return [...paths].sort();
}

function attachmentPlan(db, wallId, wallName, posts, reports) {
  const candidates = attachmentCandidates(db, wallId, wallName, posts, reports);
  return { candidates, deletable: [], retained: candidates };
}

function deletionPlan(db, wallId) {
  const wall = db.prepare('SELECT id, name, description, status, owner_id, created_at FROM walls WHERE id=?').get(wallId);
  if (!wall) return null;
  const posts = db.prepare('SELECT id, content FROM posts WHERE wall_id=?').all(wallId);
  const reports = db.prepare('SELECT id, tracking_code, images FROM reports WHERE wall_id=?').all(wallId);
  const treePrefix = 'th_' + wallId + '_';
  const messageWhere = "(wall_id=? OR (type='tree_hole' AND substr(conversation_id,1,?)=?) OR (type='interaction' AND link IN (SELECT '/post/' || id FROM posts WHERE wall_id=?)))";
  const messageParams = [wallId, treePrefix.length, treePrefix, wallId];
  const counts = emptyCounts();
  counts.members = countRows(db, 'SELECT COUNT(*) AS c FROM wall_members WHERE wall_id=?', wallId);
  // wall_applications has no wall_id. Only approved exact-name applications are attributable.
  counts.wall_applications = countRows(db, "SELECT COUNT(*) AS c FROM wall_applications WHERE status='approved' AND wall_name=?", wall.name);
  counts.ban_logs = countRows(db, "SELECT COUNT(*) AS c FROM ban_logs WHERE scope='wall' AND wall_id=?", wallId);
  counts.posts = countRows(db, 'SELECT COUNT(*) AS c FROM posts WHERE wall_id=?', wallId);
  counts.comments = countRows(db, 'SELECT COUNT(*) AS c FROM comments c JOIN posts p ON p.id=c.post_id WHERE p.wall_id=?', wallId);
  counts.likes = countRows(db, 'SELECT COUNT(*) AS c FROM likes WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?)', wallId);
  counts.bookmarks = countRows(db, 'SELECT COUNT(*) AS c FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?)', wallId);
  counts.messages = countRows(db, 'SELECT COUNT(*) AS c FROM messages WHERE ' + messageWhere, ...messageParams);
  counts.announcements = countRows(db, "SELECT COUNT(*) AS c FROM announcements WHERE wall_id=? AND COALESCE(scope,'wall')!='global'", wallId);
  counts.votes = countRows(db, 'SELECT COUNT(*) AS c FROM votes WHERE wall_id=?', wallId);
  counts.vote_options = countRows(db, 'SELECT COUNT(*) AS c FROM vote_options WHERE vote_id IN (SELECT id FROM votes WHERE wall_id=?)', wallId);
  counts.vote_records = countRows(db, 'SELECT COUNT(*) AS c FROM vote_records WHERE vote_id IN (SELECT id FROM votes WHERE wall_id=?)', wallId);
  counts.reports = reports.length;
  // Post reports follow the post owner; only rows orphaned with this wall_id use the denormalized field.
  counts.post_reports = countRows(db, 'SELECT COUNT(*) AS c FROM post_reports pr LEFT JOIN posts p ON p.id=pr.post_id WHERE p.wall_id=? OR (p.id IS NULL AND pr.wall_id=?)', wallId, wallId);
  counts.user_reports = countRows(db, 'SELECT COUNT(*) AS c FROM user_reports WHERE wall_id=?', wallId);
  counts.user_permissions = countRows(db, 'SELECT COUNT(*) AS c FROM user_permissions WHERE wall_id=?', wallId);
  const attachments = attachmentPlan(db, wallId, wall.name, posts, reports);
  counts.attachments = attachments.candidates.length;
  counts.deletable_attachments = 0;
  counts.retained_attachments = attachments.candidates.length;
  const warnings = [
    '成员账号、好友、账号偏好、全局设置与全局权限会保留',
    '当前版本保留附件文件，需在独立存储清理流程核对',
  ];
  const unlinked = countRows(db, "SELECT COUNT(*) AS c FROM wall_applications WHERE wall_name=? AND status!='approved'", wall.name);
  if (unlinked) warnings.push(unlinked + ' 条同名未通过建墙申请不会删除');
  return {
    wall: { id: wall.id, name: wall.name, description: wall.description ?? '', status: wall.status, owner_id: wall.owner_id ?? null, created_at: wall.created_at ?? '' },
    counts, warnings, can_delete: true,
  };
}

function deleteWallData(db, plan) {
  const wallId = plan.wall.id;
  const treePrefix = 'th_' + wallId + '_';
  const messageWhere = "(wall_id=? OR (type='tree_hole' AND substr(conversation_id,1,?)=?) OR (type='interaction' AND link IN (SELECT '/post/' || id FROM posts WHERE wall_id=?)))";
  const messageParams = [wallId, treePrefix.length, treePrefix, wallId];
  db.exec('BEGIN');
  try {
    const conflictSql = "SELECT COUNT(*) AS c FROM vote_records vr " +
      "LEFT JOIN votes record_vote ON record_vote.id=vr.vote_id " +
      "LEFT JOIN vote_options opt ON opt.id=vr.option_id " +
      "LEFT JOIN votes option_vote ON option_vote.id=opt.vote_id " +
      "WHERE (record_vote.wall_id=? AND (option_vote.id IS NULL OR option_vote.id!=record_vote.id)) " +
      "OR (option_vote.wall_id=? AND (record_vote.id IS NULL OR record_vote.wall_id!=?))";
    const conflict = countRows(db, conflictSql, wallId, wallId, wallId);
    if (conflict) {
      const error = new Error('跨墙投票关联异常，已取消删除');
      error.code = 'WALL_REFERENCE_CONFLICT';
      throw error;
    }

    db.prepare("UPDATE messages SET reply_to_id=0, reply_to_content='' WHERE reply_to_id IN (SELECT id FROM messages WHERE " + messageWhere + ')').run(...messageParams);
    const clearLinks = "UPDATE messages SET link='' WHERE wall_id!=? AND NOT (type='interaction' AND link IN (SELECT '/post/' || id FROM posts WHERE wall_id=?)) AND (" +
      "link IN (SELECT '/post/' || id FROM posts WHERE wall_id=?) OR " +
      "link IN (SELECT '/report/status/' || tracking_code FROM reports WHERE wall_id=? AND tracking_code IS NOT NULL AND tracking_code!='') OR " +
      "link IN (SELECT '/tree-hole/chat/' || conversation_id FROM messages WHERE type='tree_hole' AND conversation_id!='' AND " + messageWhere + '))';
    db.prepare(clearLinks).run(wallId, wallId, wallId, wallId, ...messageParams);

    db.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?)').run(wallId);
    db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?)').run(wallId);
    db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?)').run(wallId);
    db.prepare("DELETE FROM post_reports WHERE post_id IN (SELECT id FROM posts WHERE wall_id=?) " +
      "OR (wall_id=? AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.id=post_reports.post_id))").run(wallId, wallId);
    db.prepare('DELETE FROM vote_records WHERE vote_id IN (SELECT id FROM votes WHERE wall_id=?)').run(wallId);
    db.prepare('DELETE FROM vote_options WHERE vote_id IN (SELECT id FROM votes WHERE wall_id=?)').run(wallId);
    db.prepare('DELETE FROM reports WHERE wall_id=?').run(wallId);
    db.prepare("DELETE FROM wall_applications WHERE status='approved' AND wall_name=?").run(plan.wall.name);
    db.prepare("DELETE FROM ban_logs WHERE scope='wall' AND wall_id=?").run(wallId);
    db.prepare("DELETE FROM announcements WHERE wall_id=? AND COALESCE(scope,'wall')!='global'").run(wallId);
    db.prepare('DELETE FROM messages WHERE ' + messageWhere).run(...messageParams);
    db.prepare('DELETE FROM user_reports WHERE wall_id=?').run(wallId);
    db.prepare('DELETE FROM user_permissions WHERE wall_id=?').run(wallId);
    db.prepare('DELETE FROM posts WHERE wall_id=?').run(wallId);
    db.prepare('DELETE FROM votes WHERE wall_id=?').run(wallId);
    db.prepare('DELETE FROM wall_members WHERE wall_id=?').run(wallId);
    db.prepare('DELETE FROM walls WHERE id=?').run(wallId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return plan;
}

module.exports = { COUNT_KEYS, deletionPlan, deleteWallData };
