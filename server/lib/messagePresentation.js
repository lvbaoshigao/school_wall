// Never trust persisted reply previews: visibility and revocation can change later.
function visibleToUser(message, userId) {
  return !!message && ((message.sender_id === userId && !message.sender_deleted) ||
    (message.receiver_id === userId && !message.receiver_deleted));
}

function sameParticipants(a, b) {
  return !!a && !!b && ((a.sender_id === b.sender_id && a.receiver_id === b.receiver_id) ||
    (a.sender_id === b.receiver_id && a.receiver_id === b.sender_id));
}

function canQuoteMessage(req, source, target) {
  if (!source || !target || target.is_revoked || !visibleToUser(target, req.user.id) || !visibleToUser(source, req.user.id) || source.is_anonymous ||
      source.type !== target.type || !['private', 'confession'].includes(source.type) ||
      (source.wall_id || 0) !== (target.wall_id || 0) || !sameParticipants(source, target)) return false;
  if (source.type === 'confession') {
    return !!req.db.prepare("SELECT 1 FROM walls w JOIN wall_members wm ON wm.wall_id=w.id WHERE w.id=? AND w.status='active' AND wm.user_id=? AND wm.status='active'")
      .get(source.wall_id, req.user.id);
  }
  return true;
}

function presentMessages(req, rows) {
  const ids = [...new Set(rows.filter(row => row.reply_to_id > 0).flatMap(row => [row.id, row.reply_to_id]))];
  const originals = new Map();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => '?').join(',');
    const records = req.db.prepare('SELECT * FROM messages WHERE id IN (' + placeholders + ')').all(...batch);
    records.forEach(record => originals.set(record.id, record));
  }
  const names = new Map();
  return rows.map(row => {
    const output = { ...row };
    delete output.sender_deleted;
    delete output.receiver_deleted;
    delete output.assignee_id;
    const original = originals.get(row.id) || row;
    output.is_mine = original.sender_id === req.user.id;
    output.client_message_id = output.is_mine ? (row.client_message_id || null) : null;
    if (row.is_anonymous && !output.is_mine) {
      output.sender_id = null;
      if ('sender_nickname' in output) output.sender_nickname = null;
      if ('sender_avatar' in output) output.sender_avatar = null;
    }
    output.reply_to = null;
    output.reply_to_missing = false;
    output.reply_to_revoked = false;
    output.reply_to_sender_id = null;
    output.reply_to_sender_name = null;
    output.reply_to_content = '';
    if (!(row.reply_to_id > 0)) return output;

    const source = originals.get(row.reply_to_id);
    const allowed = canQuoteMessage(req, source, original);
    const revoked = allowed && !!source.is_revoked;
    const available = allowed && !revoked;
    let nickname = null;
    if (available) {
      if (!names.has(source.sender_id)) names.set(source.sender_id, req.db.prepare('SELECT nickname FROM users WHERE id=?').get(source.sender_id)?.nickname || '用户');
      nickname = names.get(source.sender_id);
    }
    output.reply_to = {
      id: row.reply_to_id,
      available,
      content: available ? source.content.substring(0, 100) : '',
      is_mine: available ? source.sender_id === req.user.id : null,
      sender_id: available ? source.sender_id : null,
      sender_nickname: nickname,
      created_at: available ? source.created_at : null,
      is_revoked: revoked,
      reason: available ? null : (revoked ? 'revoked' : 'unavailable'),
    };
    output.reply_to_missing = !available && !revoked;
    output.reply_to_revoked = revoked;
    output.reply_to_sender_id = output.reply_to.sender_id;
    output.reply_to_sender_name = nickname;
    output.reply_to_content = available ? output.reply_to.content : (revoked ? '[消息已撤回]' : '');
    return output;
  });
}

module.exports = { presentMessages, canQuoteMessage, visibleToUser };
