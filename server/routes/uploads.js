const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { authRequired } = require('../middleware/auth');
const { checkQuota } = require('../lib/uploads');

// 图片上传。三个端点前缀不同（/avatar/... 与 /upload/...），
// 所以整体挂在 /api 下，路径保持原样。
module.exports = (uploadLimiter, dirs) => {
  const { AVATAR_DIR, IMAGE_DIR, BUG_REPORT_IMAGE_DIR } = dirs;
  const router = express.Router();

  router.put('/avatar/upload', authRequired, uploadLimiter, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: '请提供头像数据' });

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
      const oldPath = path.join(__dirname, oldUser.avatar);
      try { fs.unlinkSync(oldPath); } catch {}
    }

    fs.writeFileSync(filepath, buffer);
    quota.commit();
    req.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    res.json({ message: '头像更新成功', avatar: avatarUrl });
  });

  // ===== 帖子图片上传 =====
  router.post('/upload/image', authRequired, uploadLimiter, (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '请提供图片数据' });

    const matches = image.match(/^data:image\/(jpeg|png|gif|webp);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: '无效的图片格式' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过2MB' });

    const quota = checkQuota(req.user.id, buffer.length);
    if (!quota.ok) return res.status(quota.status).json({ error: quota.error });

    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
    const filename = `${Date.now()}_${hash}.${ext}`;
    const filepath = path.join(IMAGE_DIR, filename);
    const imageUrl = `/uploads/images/${filename}`;

    fs.writeFileSync(filepath, buffer);
    quota.commit();
    res.json({ url: imageUrl });
  });

  // ===== Bug 反馈图片上传 =====
  router.post('/upload/bug-image', authRequired, uploadLimiter, (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '请提供图片数据' });

    const matches = image.match(/^data:image\/(jpeg|png|gif|webp);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: '无效的图片格式' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过2MB' });

    const quota = checkQuota(req.user.id, buffer.length);
    if (!quota.ok) return res.status(quota.status).json({ error: quota.error });

    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
    const filename = `bug_${req.user.id}_${Date.now()}_${hash}.${ext}`;
    const filepath = path.join(BUG_REPORT_IMAGE_DIR, filename);
    const imageUrl = `/uploads/bug-reports/${filename}`;

    fs.writeFileSync(filepath, buffer);
    quota.commit();
    res.json({ url: imageUrl });
  });

  return router;
};
