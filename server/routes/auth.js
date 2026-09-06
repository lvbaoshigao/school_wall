const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { authRequired, settleBan, SECRET } = require('../middleware/auth');
const { getSetting } = require('../db');
const { hashPassword, verifyPassword } = require('../lib/password');
const { checkQuota } = require('../lib/uploads');

const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');

const router = express.Router();

// Express 4 不会捕获 async 处理器里的 Promise 拒绝 —— 不包一层的话，
// 一旦哈希或数据库调用抛错，请求会一直挂着直到客户端超时，且只在日志里留一条
// UnhandledPromiseRejection。所有 async 路由都必须经由它注册。
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ===== 用户偏好 =====
// 键名/类型/默认值集中定义在 lib/prefs.js，这里只负责读写与持久化
const { mergePrefs, sanitizePrefs } = require('../lib/prefs');

// 读取当前用户偏好
router.get('/prefs', authRequired, (req, res) => {
  try {
    const row = req.db.prepare("SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key='navbar'").get(req.user.id);
    let serverPrefs = {};
    if (row?.pref_value) {
      try { serverPrefs = JSON.parse(row.pref_value) || {}; } catch {}
    }
    res.json({ prefs: mergePrefs(serverPrefs) });
  } catch (e) {
    res.status(500).json({ error: '读取偏好失败' });
  }
});

// 保存当前用户偏好（增量：只覆盖本次传来的合法键，其余保持原样）
router.put('/prefs', authRequired, (req, res) => {
  const { prefs } = req.body || {};
  if (!prefs || typeof prefs !== 'object') {
    return res.status(400).json({ error: '缺少偏好数据' });
  }
  try {
    const row = req.db.prepare("SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key='navbar'").get(req.user.id);
    let existing = {};
    if (row?.pref_value) {
      try { existing = JSON.parse(row.pref_value) || {}; } catch {}
    }
    const stored = { ...existing, ...sanitizePrefs(prefs) };
    req.db.prepare(`
      INSERT OR REPLACE INTO user_prefs (user_id, pref_key, pref_value, updated_at)
      VALUES (?, 'navbar', ?, datetime('now','localtime'))
    `).run(req.user.id, JSON.stringify(stored));
    res.json({ prefs: mergePrefs(stored) });
  } catch (e) {
    res.status(500).json({ error: '保存偏好失败' });
  }
});

// 注册
router.post('/register', wrap(async (req, res) => {
  // 系统未初始化时禁止注册（必须先通过 /api/setup 完成首次设置）
  if (getSetting(req.db, 'initialized', '0') !== '1') {
    return res.status(403).json({ error: '系统未初始化，请先完成首次设置' });
  }

  const { username, password, nickname, real_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: '用户名长度3-20个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

  const exists = req.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已存在' });

  const hash = await hashPassword(password);
  let result;
  try {
    result = req.db.prepare(`
      INSERT INTO users (username, password_hash, nickname, real_name, role, status)
      VALUES (?, ?, ?, ?, 'user', 'active')
    `).run(username, hash, nickname || username, real_name || '');
  } catch (e) {
    // 上面的存在性检查与这条 INSERT 之间有窗口，并发注册同名会撞上 username 的 UNIQUE 约束。
    // 不在这里兜住的话 wrap() 会把它抛成 500，用户看到「服务器错误」而不是「用户名已存在」。
    if (/UNIQUE/i.test(e && e.message || '')) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    throw e;
  }

  const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'user' }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: result.lastInsertRowid, username, nickname: nickname || username, role: 'user' } });
}));

// 登录
router.post('/login', wrap(async (req, res) => {
  // 系统未初始化时禁止登录
  if (getSetting(req.db, 'initialized', '0') !== '1') {
    return res.status(403).json({ error: '系统未初始化，请先完成首次设置' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  const user = req.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // 用户不存在时直接返回，不做一次假哈希：这是权衡的结果 ——
  // 假哈希能消除用户名枚举的时间差，但也会让每一次无效登录都付出完整的哈希开销，
  // 正好放大了我们要防的那条 DoS 路径。枚举风险由登录限流兜底。
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const { ok, needsUpgrade } = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: '用户名或密码错误' });

  // 存量 bcrypt 哈希在登录成功后无感升级为 scrypt，用户不需要改密码
  if (needsUpgrade) {
    try {
      const upgraded = await hashPassword(password);
      req.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgraded, user.id);
    } catch (e) {
      console.error('[Auth] 口令哈希升级失败:', e.message);
    }
  }
  const banState = settleBan(req.db, user);
  if (banState.banned) {
    const when = banState.permanent
      ? '账号已被永久封禁'
      : `账号已被封禁，剩余 ${banState.remainingMinutes} 分钟`;
    return res.status(403).json({
      error: user.ban_reason ? `${when}。原因：${user.ban_reason}` : when,
      code: 'BANNED',
      scope: 'global',
      reason: user.ban_reason || '',
      permanent: banState.permanent,
      until: banState.until,
      remainingMinutes: banState.remainingMinutes,
      banLevel: banState.banLevel || 'login',
    });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: {
      id: user.id, username: user.username, nickname: user.nickname, real_name: user.real_name,
      show_real_name: user.show_real_name, avatar: user.avatar, bio: user.bio, gender: user.gender,
      contact_qq: user.contact_qq, contact_wechat: user.contact_wechat,
      contact_weibo: user.contact_weibo, contact_bilibili: user.contact_bilibili,
      show_contact: user.show_contact, class_number: user.class_number,
      is_graduate: user.is_graduate, graduation_year: user.graduation_year, role: user.role
    }
  });
}));

// 获取当前用户信息
router.get('/me', authRequired, (req, res) => {
  const user = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, bio, gender,
           contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
           class_number, is_graduate, graduation_year, role, status, ban_until, ban_reason, ban_level,
           allow_search_by_id, allow_search_by_username, allow_search_by_nickname,
           allow_search_by_real_name, allow_discover,
           created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 到期自动解封（与 middleware / login 共用同一实现）
  settleBan(req.db, user);

  res.json(user);
});

// 修改密码
router.put('/password', authRequired, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少6个字符' });

  const user = req.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const { ok } = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: '旧密码错误' });

  const newHash = await hashPassword(newPassword);
  req.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  res.json({ message: '密码修改成功' });
}));

// 更新个人资料
router.put('/profile', authRequired, (req, res) => {
  const { nickname, real_name, show_real_name, bio, gender,
          contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
          class_number, is_graduate, graduation_year,
          allow_search_by_id, allow_search_by_username, allow_search_by_nickname,
          allow_search_by_real_name, allow_discover } = req.body;

  req.db.prepare(`
    UPDATE users SET
      nickname = COALESCE(?, nickname),
      real_name = COALESCE(?, real_name),
      show_real_name = COALESCE(?, show_real_name),
      bio = COALESCE(?, bio),
      gender = COALESCE(?, gender),
      contact_qq = COALESCE(?, contact_qq),
      contact_wechat = COALESCE(?, contact_wechat),
      contact_weibo = COALESCE(?, contact_weibo),
      contact_bilibili = COALESCE(?, contact_bilibili),
      show_contact = COALESCE(?, show_contact),
      class_number = COALESCE(?, class_number),
      is_graduate = COALESCE(?, is_graduate),
      graduation_year = COALESCE(?, graduation_year),
      allow_search_by_id = COALESCE(?, allow_search_by_id),
      allow_search_by_username = COALESCE(?, allow_search_by_username),
      allow_search_by_nickname = COALESCE(?, allow_search_by_nickname),
      allow_search_by_real_name = COALESCE(?, allow_search_by_real_name),
      allow_discover = COALESCE(?, allow_discover)
    WHERE id = ?
  `).run(
    nickname ?? null, real_name ?? null, show_real_name ?? null,
    bio ?? null, gender ?? null,
    contact_qq ?? null, contact_wechat ?? null, contact_weibo ?? null, contact_bilibili ?? null, show_contact ?? null,
    class_number ?? null, is_graduate ?? null, graduation_year ?? null,
    allow_search_by_id ?? null, allow_search_by_username ?? null, allow_search_by_nickname ?? null,
    allow_search_by_real_name ?? null, allow_discover ?? null,
    req.user.id
  );

  // 字段需与 GET /me 保持一致：前端 userStore.updateProfile 会整体覆盖 user 对象，
  // 少返回字段会导致本地 user 丢失 status / ban_until / created_at
  const user = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, bio, gender,
           contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
           class_number, is_graduate, graduation_year, role, status, ban_until, ban_reason, ban_level,
           allow_search_by_id, allow_search_by_username, allow_search_by_nickname,
           allow_search_by_real_name, allow_discover,
           created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  res.json(user);
});

// 更新头像 - 仅接受 dataURL 图片或已有的 /uploads/avatars/ 路径（安全修复：不再存任意字符串）
router.put('/avatar', authRequired, (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: '请提供头像数据' });

  if (avatar.startsWith('data:image/')) {
    const matches = avatar.match(/^data:image\/(jpeg|png|gif|webp);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: '无效的图片格式' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 500 * 1024) return res.status(400).json({ error: '头像不能超过500KB' });

    const quota = checkQuota(req.user.id, buffer.length);
    if (!quota.ok) return res.status(quota.status).json({ error: quota.error });

    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
    const filename = `${req.user.id}_${hash}.${ext}`;
    const filepath = path.join(AVATAR_DIR, filename);
    const avatarUrl = `/uploads/avatars/${filename}`;

    const oldUser = req.db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
    if (oldUser?.avatar?.startsWith('/uploads/avatars/')) {
      try { fs.unlinkSync(path.join(__dirname, '..', oldUser.avatar)); } catch {}
    }

    if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
    fs.writeFileSync(filepath, buffer);
    quota.commit();
    req.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    return res.json({ message: '头像更新成功', avatar: avatarUrl });
  }

  // 允许沿用已上传的头像路径
  if (/^\/uploads\/avatars\/[\w.-]+$/.test(avatar)) {
    req.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
    return res.json({ message: '头像更新成功', avatar });
  }

  return res.status(400).json({ error: '无效的头像数据' });
});

// 获取用户公开信息
// 获取用户公开信息。
// 这里返回真实姓名、班级和 QQ/微信等联系方式（受用户自己的隐私开关约束），
// 原先没挂任何中间件 —— 未登录也能按 id 顺序遍历，等于把全校通讯录敞开。
router.get('/user/:id', authRequired, (req, res) => {
  const user = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, bio, gender,
           contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
           class_number, is_graduate, graduation_year, created_at
    FROM users WHERE id = ?
  `).get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 隐私设置
  if (!user.show_real_name) user.real_name = '';
  if (!user.show_contact) {
    user.contact_qq = '';
    user.contact_wechat = '';
    user.contact_weibo = '';
    user.contact_bilibili = '';
  }

  const postCount = req.db.prepare('SELECT COUNT(*) as c FROM posts WHERE author_id = ?').get(user.id).c;
  const voteCount = req.db.prepare('SELECT COUNT(*) as c FROM votes WHERE author_id = ?').get(user.id).c;

  res.json({ ...user, postCount, voteCount });
});

// 注销账号（永久删除）
router.delete('/account', authRequired, (req, res) => {
  const userId = req.user.id;
  const user = req.db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (user.role === 'super_admin') {
    return res.status(403).json({ error: '超级管理员不能注销账号' });
  }

  // 若为任何墙的墙主，需先转让/停用（避免墙无主）
  const ownedWall = req.db.prepare("SELECT id, name FROM walls WHERE owner_id = ? AND status='active'").get(userId);
  if (ownedWall) {
    return res.status(400).json({ error: `你还是「${ownedWall.name}」的墙主，请先联系超级管理员转让墙主再注销` });
  }

  // 删除所有相关数据（含多校园墙相关表，避免孤儿数据）
  req.db.prepare('DELETE FROM comments WHERE author_id = ?').run(userId);
  req.db.prepare('DELETE FROM likes WHERE user_id = ?').run(userId);
  req.db.prepare('DELETE FROM vote_records WHERE user_id = ?').run(userId);
  req.db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(userId, userId);
  req.db.prepare('DELETE FROM friends WHERE user_id = ? OR friend_id = ?').run(userId, userId);
  req.db.prepare('DELETE FROM posts WHERE author_id = ?').run(userId);
  req.db.prepare('DELETE FROM votes WHERE author_id = ?').run(userId);
  req.db.prepare('DELETE FROM wall_members WHERE user_id = ?').run(userId);
  req.db.prepare('DELETE FROM wall_applications WHERE applicant_id = ?').run(userId);
  req.db.prepare('DELETE FROM post_reports WHERE reporter_id = ?').run(userId);
  req.db.prepare('DELETE FROM user_reports WHERE reporter_id = ? OR reported_user_id = ?').run(userId, userId);
  req.db.prepare('DELETE FROM reports WHERE reporter_id = ?').run(userId);
  req.db.prepare('DELETE FROM bug_reports WHERE reporter_id = ?').run(userId);
  req.db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(userId);
  req.db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  res.json({ message: '账号已注销，所有数据已删除' });
});

// ===== 导出我的数据 =====
// 以 gzip 压缩的 .json.gz 附件返回。刻意不用 Content-Encoding: gzip ——
// 那样浏览器会在下载时自动解压，用户拿到的还是未压缩的大文件。
router.get('/export', authRequired, (req, res) => {
  const uid = req.user.id;
  const q = (sql, ...params) => req.db.prepare(sql).all(...params);

  try {
    const profile = req.db.prepare(`
      SELECT id, username, nickname, real_name, show_real_name, avatar, bio, gender,
             contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
             class_number, is_graduate, graduation_year, role, status, created_at
      FROM users WHERE id = ?
    `).get(uid);

    const payload = {
      // 导出说明放在最前面，便于以后加字段时对方知道版本
      _meta: {
        format: 'school-wall-export',
        version: 1,
        exported_at: new Date().toISOString(),
        note: '本文件由「设置 → 账号与数据 → 导出我的数据」生成，仅包含你本人的数据。密码不可导出。',
      },
      profile,
      prefs: mergePrefs((() => {
        const row = req.db.prepare("SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key='navbar'").get(uid);
        try { return row?.pref_value ? JSON.parse(row.pref_value) : {}; } catch { return {}; }
      })()),
      walls: q(`SELECT w.id, w.name, wm.wall_role, wm.status, wm.created_at AS joined_at
                FROM wall_members wm JOIN walls w ON wm.wall_id = w.id WHERE wm.user_id = ?`, uid),
      posts: q(`SELECT id, wall_id, content, category, is_anonymous, is_markdown,
                       like_count, comment_count, created_at
                FROM posts WHERE author_id = ? ORDER BY created_at`, uid),
      comments: q(`SELECT id, post_id, content, created_at FROM comments WHERE author_id = ? ORDER BY created_at`, uid),
      likes: q(`SELECT post_id, created_at FROM likes WHERE user_id = ? ORDER BY created_at`, uid),
      bookmarks: q(`SELECT post_id, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at`, uid),
      votes_created: q(`SELECT id, wall_id, title, description, is_anonymous, end_at, created_at
                        FROM votes WHERE author_id = ? ORDER BY created_at`, uid),
      votes_cast: q(`SELECT vr.vote_id, v.title, vo.option_text, vr.created_at
                     FROM vote_records vr
                     JOIN votes v ON vr.vote_id = v.id
                     LEFT JOIN vote_options vo ON vr.option_id = vo.id
                     WHERE vr.user_id = ? ORDER BY vr.created_at`, uid),
      friends: q(`SELECT f.status, f.created_at,
                         CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END AS other_user_id,
                         CASE WHEN f.user_id = ? THEN '我发起' ELSE '对方发起' END AS direction
                  FROM friends f WHERE f.user_id = ? OR f.friend_id = ?`, uid, uid, uid, uid),
      // 匿名收到的消息不带发件人，导出时同样不还原
      messages_received: q(`SELECT id, CASE WHEN is_anonymous = 1 THEN NULL ELSE sender_id END AS sender_id,
                                   wall_id, type, title, content, is_read, is_revoked, created_at
                            FROM messages WHERE receiver_id = ? ORDER BY created_at`, uid),
      messages_sent: q(`SELECT id, receiver_id, wall_id, type, title, content, is_anonymous, is_revoked, created_at
                        FROM messages WHERE sender_id = ? ORDER BY created_at`, uid),
    };

    const json = JSON.stringify(payload, null, 2);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `schoolwall-${profile?.username || uid}-${stamp}.json.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', gz.length);
    // 让前端能读到未压缩体积，用于展示压缩率
    res.setHeader('X-Uncompressed-Size', Buffer.byteLength(json, 'utf8'));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Uncompressed-Size');
    res.end(gz);
  } catch (e) {
    res.status(500).json({ error: '导出失败' });
  }
});

// 被禁用户申诉
router.post('/appeal', authRequired, (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: '请填写申诉理由' });

  const user = req.db.prepare('SELECT id, nickname, status, ban_reason, ban_level, ban_until FROM users WHERE id=?').get(req.user.id);
  if (!user || user.status !== 'banned') return res.status(400).json({ error: '你当前没有被封禁' });

  // 写入 ban_logs 作为申诉记录
  req.db.prepare(`
    INSERT INTO ban_logs (scope, wall_id, target_user_id, operator_id, action, duration_minutes, reason)
    VALUES ('global', 0, ?, NULL, 'appeal', 0, ?)
  `).run(req.user.id, reason.trim());

  // 通知所有超级管理员
  const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all();
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
  supers.forEach(s => ins.run(s.id, '申诉通知', `用户 ${user.nickname || user.username} (ID:${user.id}) 提交了申诉：\n${reason.trim()}\n封禁原因：${user.ban_reason || '无'}\n封禁级别：${user.ban_level || 'login'}`, '/admin?panel=users'));

  res.json({ message: '申诉已提交，管理员会尽快处理' });
});

module.exports = router;
