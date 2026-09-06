// 封禁相关的公共逻辑：时长校验、审计日志、站内信通知。
// 全局封禁（routes/admin.js）与墙内封禁（routes/walls.js）共用，避免两套实现走偏。

const MAX_BAN_MINUTES = 525600; // 365 天

/**
 * 校验封禁时长。
 * 原实现是 `parseInt(duration) || 0`：传负数会算出一个过去的 ban_until，
 * 下一次请求就被自动解封 —— 表面成功、实际是静默空操作。这里显式拒绝。
 *
 * @returns {{ ok: true, minutes: number } | { ok: false, error: string }}
 *          minutes 为 0 表示永久封禁
 */
function parseDuration(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, minutes: 0 };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { ok: false, error: '封禁时长必须是整数分钟' };
  if (n < 0) return { ok: false, error: '封禁时长不能为负数（0 表示永久封禁）' };
  if (n > MAX_BAN_MINUTES) return { ok: false, error: `封禁时长最长 ${MAX_BAN_MINUTES} 分钟（365 天），永久封禁请填 0` };
  return { ok: true, minutes: n };
}

/** minutes=0 → 永久（空字符串）；否则返回到期时刻的 ISO 串 */
function banUntilFrom(minutes) {
  return minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : '';
}

// 站内信里的时间显示。
//
// 必须显式指定时区：这段字符串是在**服务端**渲染后写进消息正文的，
// toLocaleString 默认跟随系统时区。线上服务器的系统时区一度是 America/New_York，
// 于是用户在北京时间 19:48 收到的通知写着「封禁至 07:48」—— 一个已经过去的时刻，
// 看上去就像封禁坏掉了。绑定到固定时区后，这段文案不再受服务器所在地影响。
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Shanghai';

function formatUntil(iso) {
  if (!iso) return '永久';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '永久';
  return d.toLocaleString('zh-CN', {
    timeZone: DISPLAY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/** 写入审计日志。任何封禁/解封都应经过这里。 */
function logBan(db, { scope, wallId = 0, targetUserId, operatorId, action, durationMinutes = 0, reason = '' }) {
  db.prepare(`
    INSERT INTO ban_logs (scope, wall_id, target_user_id, operator_id, action, duration_minutes, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(scope, wallId, targetUserId, operatorId ?? null, action, durationMinutes, reason || '');
}

/** 发系统站内信（沿用 messages 表既有的 type='system' 写法） */
function notify(db, userId, title, content) {
  db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content) VALUES (NULL,?,'system',?,?)")
    .run(userId, title, content);
}

/** 封禁通知文案（全局 / 墙内共用） */
function banNotice({ scope, wallName, minutes, until, reason }) {
  const where = scope === 'wall' ? `校园墙「${wallName}」` : '本站';
  const span = minutes > 0 ? `至 ${formatUntil(until)}` : '永久';
  const why = reason ? `\n原因：${reason}` : '';
  return {
    title: scope === 'wall' ? '校园墙封禁通知' : '账号封禁通知',
    content: `你已被${where}管理员封禁（${span}）。${why}\n如有异议请联系管理员申诉。`,
  };
}

function unbanNotice({ scope, wallName }) {
  const where = scope === 'wall' ? `校园墙「${wallName}」` : '本站';
  return {
    title: scope === 'wall' ? '校园墙封禁解除' : '账号封禁解除',
    content: `你在${where}的封禁已被管理员解除，现在可以正常使用了。`,
  };
}

module.exports = {
  MAX_BAN_MINUTES, parseDuration, banUntilFrom, formatUntil,
  logBan, notify, banNotice, unbanNotice,
};
