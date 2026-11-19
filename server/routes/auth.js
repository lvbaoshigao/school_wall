const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { authRequired, settleBan, SECRET } = require('../middleware/auth');
const { treeConversation, canAccessTree } = require('../lib/treeAccess');
const { getSetting } = require('../db');
const { hashPassword, verifyPassword, isPasswordInput } = require('../lib/password');
const { checkQuota, encodeValidatedImage } = require('../lib/uploads');
const { UPLOADS_DIR } = require('../lib/paths');

const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatars');

const router = express.Router();

// 所有写接口只接受 JSON 对象，避免数组/原始值穿过字段校验后进入 SQL 或字符串方法。
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.body === undefined) req.body = {};
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: '请求数据必须是对象' });
    }
  }
  next();
});

const validUsername = value => typeof value === 'string' && value.length >= 3 &&
  value.length <= 20 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

// 密码验证/KDF 的 await 期间可能发生改密、封禁、提权或删号，写入前重新认证。
function recheckSession(req, res) {
  let allowed = false;
  authRequired(req, res, () => { allowed = true; });
  return allowed;
}

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
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
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
  if (!validUsername(username)) return res.status(400).json({ error: '用户名须为3-20个字符，且不能含首尾空白或控制字符' });
  if (!isPasswordInput(password) || password.length < 6) return res.status(400).json({ error: '密码至少6个字符且不能超过1024字节' });
  if ((nickname != null && (typeof nickname !== 'string' || nickname.length > 30)) ||
      (real_name != null && (typeof real_name !== 'string' || real_name.length > 20))) {
    return res.status(400).json({ error: '昵称最多30个字符，真实姓名最多20个字符' });
  }

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

  const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'user', tv: 0 }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: result.lastInsertRowid, username, nickname: nickname || username, role: 'user' } });
}));

// 登录
router.post('/login', wrap(async (req, res) => {
  // 系统未初始化时禁止登录
  if (getSetting(req.db, 'initialized', '0') !== '1') {
    return res.status(403).json({ error: '系统未初始化，请先完成首次设置' });
  }

  const { username, password } = req.body;
  if (!validUsername(username) || !isPasswordInput(password)) {
    return res.status(400).json({ error: '请提供有效的用户名和密码（密码不能超过1024字节）' });
  }

  let user = req.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // 用户不存在时直接返回，不做一次假哈希：这是权衡的结果 ——
  // 假哈希能消除用户名枚举的时间差，但也会让每一次无效登录都付出完整的哈希开销，
  // 正好放大了我们要防的那条 DoS 路径。枚举风险由登录限流兜底。
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const { ok, needsUpgrade } = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: '用户名或密码错误' });

  // CAS 防止旧密码登录的哈希升级覆盖 await 期间已经提交的新密码。
  let verifiedHash = user.password_hash;
  const verifiedVersion = user.token_version || 0;
  if (needsUpgrade) {
    try {
      const upgraded = await hashPassword(password);
      const changed = req.db.prepare(`UPDATE users SET password_hash = ?
        WHERE id = ? AND password_hash = ? AND COALESCE(token_version, 0) = ?`)
        .run(upgraded, user.id, verifiedHash, verifiedVersion);
      if (changed.changes !== 1) return res.status(401).json({ error: '账号凭据已变更，请重新登录' });
      verifiedHash = upgraded;
    } catch (e) {
      console.error('[Auth] 口令哈希升级失败:', e.message);
    }
  }
  user = req.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!user || user.password_hash !== verifiedHash || (user.token_version || 0) !== verifiedVersion) {
    return res.status(401).json({ error: '账号凭据已变更，请重新登录' });
  }
  if (!['active', 'banned'].includes(user.status)) return res.status(403).json({ error: '账号当前不可用' });
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

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tv: user.token_version || 0 }, SECRET, { expiresIn: '7d' });
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
  if (!isPasswordInput(oldPassword) || !isPasswordInput(newPassword) || newPassword.length < 6) {
    return res.status(400).json({ error: '请填写有效的旧密码和新密码，新密码至少6个字符且不能超过1024字节' });
  }

  const user = req.db.prepare('SELECT password_hash, token_version FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  const { ok } = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: '旧密码错误' });

  const newHash = await hashPassword(newPassword);
  // 令牌版本 +1：JWT 固定 7 天有效期且无服务端会话表，改密码若不吊销，
  // 已泄露的旧 token 在有效期内照常可用。旧会话立即失效，当前会话
  // 用响应里的新 token 无缝续期（前端需保存返回的 token）。
  if (!recheckSession(req, res)) return;
  const changed = req.db.prepare(`UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 0) + 1
    WHERE id = ? AND password_hash = ? AND COALESCE(token_version, 0) = ?`)
    .run(newHash, req.user.id, user.password_hash, user.token_version || 0);
  if (changed.changes !== 1) return res.status(401).json({ error: '账号凭据已变更，请重新登录' });
  const fresh = req.db.prepare('SELECT username, role, token_version FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign(
    { id: req.user.id, username: fresh.username, role: fresh.role, tv: fresh.token_version || 0 },
    SECRET, { expiresIn: '7d' }
  );
  res.json({ message: '密码修改成功', token });
}));

// 更新个人资料
router.put('/profile', authRequired, (req, res) => {
  const { nickname, real_name, show_real_name, bio, gender,
          contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
          class_number, is_graduate, graduation_year,
          allow_search_by_id, allow_search_by_username, allow_search_by_nickname,
          allow_search_by_real_name, allow_discover } = req.body;

  // 长度与类型校验：此前所有字段无上限，128KB 的请求体几乎可以全塞进 bio/昵称。
  const FIELD_LIMITS = {
    nickname: 30, real_name: 20, bio: 200, gender: 10,
    contact_qq: 50, contact_wechat: 50, contact_weibo: 50, contact_bilibili: 50,
  };
  const FIELD_LABELS = {
    nickname: '昵称', real_name: '真实姓名', bio: '自我介绍', gender: '性别',
    contact_qq: 'QQ', contact_wechat: '微信', contact_weibo: '微博', contact_bilibili: 'B站',
  };
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const v = req.body?.[field];
    if (v != null && (typeof v !== 'string' || v.length > max)) {
      return res.status(400).json({ error: `${FIELD_LABELS[field]}必须是最多${max}个字符的文本` });
    }
  }
  const flagFields = ['show_real_name', 'show_contact', 'is_graduate', 'allow_search_by_id',
    'allow_search_by_username', 'allow_search_by_nickname', 'allow_search_by_real_name', 'allow_discover'];
  for (const field of flagFields) {
    const v = req.body[field];
    if (v != null && ![0, 1, false, true].includes(v)) {
      return res.status(400).json({ error: '隐私与毕业状态必须为布尔值或0/1' });
    }
  }
  const validInteger = (v, max) => (typeof v === 'number' || (typeof v === 'string' && /^\d{1,6}$/.test(v))) &&
    Number.isSafeInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max;
  if (class_number != null && class_number !== '' && !validInteger(class_number, 9999)) {
    return res.status(400).json({ error: '班级编号必须是0-9999之间的整数' });
  }
  if (graduation_year != null && graduation_year !== '' &&
      (!validInteger(graduation_year, 2100) || (Number(graduation_year) !== 0 && Number(graduation_year) < 1900))) {
    return res.status(400).json({ error: '毕业年份须为1900-2100之间的整数，或0表示未设置' });
  }
  if (gender != null && !['', 'male', 'female', 'other'].includes(gender)) {
    return res.status(400).json({ error: '无效的性别选项' });
  }
  const flagValue = v => v == null ? null : Number(v);
  const integerValue = v => v == null ? null : Number(v);

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
    nickname ?? null, real_name ?? null, flagValue(show_real_name),
    bio ?? null, gender ?? null,
    contact_qq ?? null, contact_wechat ?? null, contact_weibo ?? null, contact_bilibili ?? null, flagValue(show_contact),
    integerValue(class_number), flagValue(is_graduate), integerValue(graduation_year),
    flagValue(allow_search_by_id), flagValue(allow_search_by_username), flagValue(allow_search_by_nickname),
    flagValue(allow_search_by_real_name), flagValue(allow_discover),
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
router.put('/avatar', authRequired, wrap(async (req, res) => {
  const { avatar } = req.body;
  if (typeof avatar !== 'string' || !avatar) return res.status(400).json({ error: '请提供有效的头像数据' });
  const ownedAvatar = value => typeof value === 'string' &&
    new RegExp(`^/uploads/avatars/${req.user.id}_[a-f0-9]{12,64}\\.(jpg|png|gif|webp)$`).test(value);

  if (avatar.startsWith('data:image/')) {
    if (avatar.length > 700000) return res.status(400).json({ error: '头像不能超过500KB' });
    const matches = avatar.match(/^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!matches) return res.status(400).json({ error: '无效的图片格式' });

    const input = Buffer.from(matches[2], 'base64');
    const image = await encodeValidatedImage(input, matches[1] === 'jpeg' ? 'jpg' : matches[1], 500 * 1024);
    if (!image) return res.status(400).json({ error: '文件内容不是有效图片或超过500KB' });
    if (!recheckSession(req, res)) return;
    const { buffer, ext } = image;

    const quota = checkQuota(req.user.id, buffer.length);
    if (!quota.ok) return res.status(quota.status).json({ error: quota.error });

    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
    const filename = `${req.user.id}_${hash}.${ext}`;
    const filepath = path.join(AVATAR_DIR, filename);
    const avatarUrl = `/uploads/avatars/${filename}`;

    const oldUser = req.db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
    if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
    fs.writeFileSync(filepath, buffer);
    quota.commit();
    req.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    // 旧版本允许引用任意用户的头像。只清理本人文件，且确保未被其他资料引用。
    if (ownedAvatar(oldUser?.avatar) && oldUser.avatar !== avatarUrl &&
        !req.db.prepare('SELECT id FROM users WHERE avatar = ? AND id != ?').get(oldUser.avatar, req.user.id)) {
      try { fs.unlinkSync(path.join(AVATAR_DIR, path.basename(oldUser.avatar))); } catch {}
    }
    return res.json({ message: '头像更新成功', avatar: avatarUrl });
  }

  // 允许沿用已上传的头像路径
  if (ownedAvatar(avatar) && fs.existsSync(path.join(AVATAR_DIR, path.basename(avatar)))) {
    req.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
    return res.json({ message: '头像更新成功', avatar });
  }

  return res.status(400).json({ error: '无效的头像数据' });
}));

// 获取用户公开信息。
// 这里返回真实姓名、班级和 QQ/微信等联系方式（受用户自己的隐私开关约束），
// 原先没挂任何中间件 —— 未登录也能按 id 顺序遍历，等于把全校通讯录敞开。
//
// 二次修复（IDOR）：只挡未登录还不够。登录后按 id 顺序遍历，仍能读到
// 与自己毫无交集（不同墙、非好友）的用户档案。这里对齐 users.js 的严格版：
// 本人 / 已接受好友 / 至少共享一个 active 墙 / 可见的非匿名私信关系，四者其一才放行；
// 无权查看统一回 404，与「用户不存在」同响应，避免探测某个 id 是否存在。
router.get('/user/:id', authRequired, (req, res) => {
  const targetId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(404).json({ error: '用户不存在' });
  }
  const user = req.db.prepare(`
    SELECT id, username, nickname, real_name, show_real_name, avatar, bio, gender,
           contact_qq, contact_wechat, contact_weibo, contact_bilibili, show_contact,
           class_number, is_graduate, graduation_year, created_at
    FROM users WHERE id = ? AND (status = 'active' OR id = ?)
  `).get(targetId, req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  if (targetId !== req.user.id) {
    const blocked = req.db.prepare(`SELECT 1 FROM friends WHERE status = 'blocked'
      AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) LIMIT 1`)
      .get(req.user.id, targetId, targetId, req.user.id);
    if (blocked) return res.status(404).json({ error: '用户不存在' });
    const isFriend = !!req.db.prepare(`
      SELECT 1 AS ok FROM friends
      WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))
        AND status = 'accepted' LIMIT 1
    `).get(req.user.id, targetId, targetId, req.user.id);
    if (!isFriend) {
      const shared = req.db.prepare(`
        SELECT 1 AS ok FROM wall_members a
        JOIN wall_members b ON a.wall_id = b.wall_id
        JOIN walls w ON w.id = a.wall_id AND w.status = 'active'
        WHERE a.user_id = ? AND b.user_id = ? AND a.status = 'active' AND b.status = 'active'
        LIMIT 1
      `).get(req.user.id, targetId);
      if (!shared) {
        // 仅可见的实名私信/表白可建立资料关系；匿名消息不得变成按ID猜身份的探针。
        const chatted = !!req.db.prepare(`
          SELECT 1 AS ok FROM messages
          WHERE type IN ('private', 'confession') AND is_anonymous = 0
            AND ((sender_id = ? AND receiver_id = ? AND sender_deleted = 0)
              OR (sender_id = ? AND receiver_id = ? AND receiver_deleted = 0))
          LIMIT 1
        `).get(req.user.id, targetId, targetId, req.user.id);
        // 与「用户不存在」同一响应，不泄露该 id 是否存在
        if (!chatted) return res.status(404).json({ error: '用户不存在' });
      }
    }
  }

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
// 安全修复：这是全站破坏性最强的操作，服务端必须验证密码 ——
// 前端的「勾选须知 + 10 秒倒计时 + confirm()」都是客户端表演，
// 偷到 token 的人可以绕过一切直接删号毁数据。
router.delete('/account', authRequired, wrap(async (req, res) => {
  const userId = req.user.id;
  const { password } = req.body || {};
  if (!isPasswordInput(password)) return res.status(400).json({ error: '请输入有效密码以确认注销（最多1024字节）' });
  const user = req.db.prepare('SELECT role, password_hash, token_version FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  if (user.role === 'super_admin') {
    return res.status(403).json({ error: '超级管理员不能注销账号' });
  }
  const { ok } = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: '密码验证失败，请确认是你本人操作' });

  if (!recheckSession(req, res)) return;
  const fresh = req.db.prepare('SELECT role, password_hash, token_version FROM users WHERE id = ?').get(userId);
  if (!fresh || fresh.password_hash !== user.password_hash || (fresh.token_version || 0) !== (user.token_version || 0)) {
    return res.status(401).json({ error: '账号凭据已变更，请重新登录' });
  }
  if (fresh.role === 'super_admin') return res.status(403).json({ error: '超级管理员不能注销账号' });

  // 若为任何墙的墙主，需先转让/停用（避免墙无主）
  const ownedWall = req.db.prepare("SELECT id, name FROM walls WHERE owner_id = ? AND status='active'").get(userId);
  if (ownedWall) {
    return res.status(400).json({ error: `你还是「${ownedWall.name}」的墙主，请先联系超级管理员转让墙主再注销` });
  }

  // 同步事务内完成；任何 SQL 失败均回滚，不能留下一半已删除、一半仍存在的账号。
  req.db.db.run('BEGIN');
  try {
    req.db.prepare(`UPDATE posts SET comment_count = MAX(0, comment_count -
      (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id AND comments.author_id = ?))
      WHERE id IN (SELECT post_id FROM comments WHERE author_id = ?)`).run(userId, userId);
    req.db.prepare(`UPDATE posts SET like_count = MAX(0, like_count -
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?))
      WHERE id IN (SELECT post_id FROM likes WHERE user_id = ?)`).run(userId, userId);
    req.db.prepare('DELETE FROM comments WHERE author_id = ? OR post_id IN (SELECT id FROM posts WHERE author_id = ?)').run(userId, userId);
    req.db.prepare('DELETE FROM likes WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE author_id = ?)').run(userId, userId);
    req.db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').run(userId);
    req.db.prepare('DELETE FROM post_reports WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').run(userId);
    // 回减投票计数：直接删记录会让 vote_options.vote_count 与真实票数永久漂移，
    // 用户看到超过 100% 的百分比。先按记录逐项扣减再删除。
    const voteRecs = req.db.prepare('SELECT option_id FROM vote_records WHERE user_id = ?').all(userId);
    const decVote = req.db.prepare('UPDATE vote_options SET vote_count = MAX(0, vote_count - 1) WHERE id = ?');
    voteRecs.forEach(r => decVote.run(r.option_id));
    req.db.prepare('DELETE FROM vote_records WHERE user_id = ?').run(userId);
    req.db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(userId, userId);
    req.db.prepare('DELETE FROM friends WHERE user_id = ? OR friend_id = ?').run(userId, userId);
    req.db.prepare('DELETE FROM posts WHERE author_id = ?').run(userId);
    req.db.prepare('DELETE FROM vote_records WHERE vote_id IN (SELECT id FROM votes WHERE author_id = ?)').run(userId);
    req.db.prepare('DELETE FROM vote_options WHERE vote_id IN (SELECT id FROM votes WHERE author_id = ?)').run(userId);
    req.db.prepare('DELETE FROM votes WHERE author_id = ?').run(userId);
    req.db.prepare('DELETE FROM announcements WHERE author_id = ?').run(userId);
    req.db.prepare('DELETE FROM wall_members WHERE user_id = ?').run(userId);
    req.db.prepare('DELETE FROM wall_applications WHERE applicant_id = ?').run(userId);
    req.db.prepare('DELETE FROM post_reports WHERE reporter_id = ?').run(userId);
    req.db.prepare('DELETE FROM user_reports WHERE reporter_id = ? OR reported_user_id = ?').run(userId, userId);
    req.db.prepare('DELETE FROM reports WHERE reporter_id = ?').run(userId);
    req.db.prepare('DELETE FROM bug_reports WHERE reporter_id = ?').run(userId);
    req.db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(userId);
    req.db.prepare('DELETE FROM user_prefs WHERE user_id = ?').run(userId);
    req.db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    req.db.prepare('UPDATE walls SET owner_id = NULL WHERE owner_id = ?').run(userId);
    req.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    req.db.db.run('COMMIT');
  } catch (error) {
    req.db.db.run('ROLLBACK');
    throw error;
  }

  res.json({ message: '账号已注销，所有数据已删除' });
}));

// ===== 导出我的数据 =====
// 以 gzip 压缩的 .json.gz 附件返回。刻意不用 Content-Encoding: gzip ——
// 那样浏览器会在下载时自动解压，用户拿到的还是未压缩的大文件。
router.get('/export', authRequired, (req, res) => {
  const uid = req.user.id;
  const q = (sql, ...params) => req.db.prepare(sql).all(...params);
  const treeAccess = new Map();
  const exportMessages = rows => rows.filter(message => {
    if (message.type !== 'tree_hole') return true;
    const conversation = message.conversation_id;
    if (!treeAccess.has(conversation)) {
      treeAccess.set(conversation, canAccessTree(req, treeConversation(req, conversation)));
    }
    return treeAccess.get(conversation);
  }).map(({ conversation_id, ...message }) => message);

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
      // 树洞双方和匿名来信的真实身份不可从数据导出旁路恢复；已删消息与撤权会话不导出。
      messages_received: exportMessages(q(`SELECT id,
          CASE WHEN is_anonymous = 1 OR type = 'tree_hole' THEN NULL ELSE sender_id END AS sender_id,
          wall_id, type, title, content, is_read, is_revoked, conversation_id, created_at
        FROM messages WHERE receiver_id = ? AND receiver_deleted = 0 ORDER BY created_at`, uid)),
      messages_sent: exportMessages(q(`SELECT id, CASE WHEN type = 'tree_hole' THEN NULL ELSE receiver_id END AS receiver_id,
          wall_id, type, title, content, is_anonymous, is_revoked, conversation_id, created_at
        FROM messages WHERE sender_id = ? AND sender_deleted = 0 ORDER BY created_at`, uid)),
    };

    const json = JSON.stringify(payload, null, 2);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `schoolwall-${uid}-${stamp}.json.gz`;

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
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
    return res.status(400).json({ error: '请填写1000字以内的申诉理由' });
  }

  const user = req.db.prepare('SELECT id, nickname, status, ban_reason, ban_level, ban_until FROM users WHERE id=?').get(req.user.id);
  if (!user || user.status !== 'banned') return res.status(400).json({ error: '你当前没有被封禁' });

  const previous = req.db.prepare(`SELECT id FROM ban_logs WHERE target_user_id = ? AND action = 'appeal'
    AND created_at > datetime('now','localtime','-10 minutes') LIMIT 1`).get(req.user.id);
  if (previous) {
    res.setHeader('Retry-After', '600');
    return res.status(429).json({ error: '申诉已提交，请10分钟后再试' });
  }

  req.db.db.run('BEGIN');
  try {
    // 写入 ban_logs 作为申诉记录
    req.db.prepare(`
      INSERT INTO ban_logs (scope, wall_id, target_user_id, operator_id, action, duration_minutes, reason)
      VALUES ('global', 0, ?, NULL, 'appeal', 0, ?)
    `).run(req.user.id, reason.trim());

    // 通知所有超级管理员
    const supers = req.db.prepare("SELECT id FROM users WHERE role='super_admin' AND status='active'").all();
    const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, type, title, content, link) VALUES (NULL,?,'system',?,?,?)");
    supers.forEach(s => ins.run(s.id, '申诉通知', `用户 ${user.nickname || user.username} (ID:${user.id}) 提交了申诉：\n${reason.trim()}\n封禁原因：${user.ban_reason || '无'}\n封禁级别：${user.ban_level || 'login'}`, '/admin?panel=users'));
    req.db.db.run('COMMIT');
  } catch (error) {
    req.db.db.run('ROLLBACK');
    throw error;
  }

  res.json({ message: '申诉已提交，管理员会尽快处理' });
});

module.exports = router;
