const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { authRequired } = require('../middleware/auth');
const { checkQuota, verifyImageMagic, encodeValidatedImage, signImageUrl } = require('../lib/uploads');

async function decodeImage(value, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 64) return null;
  const match = /^data:image\/(jpeg|png|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
  if (!match || !match[2]) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maximum || !verifyImageMagic(buffer, ext)) return null;
  return encodeValidatedImage(buffer, ext, maximum);
}

const asyncRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
function stillAuthenticated(req, res) {
  let authenticated = false;
  authRequired(req, res, () => { authenticated = true; });
  return authenticated;
}

module.exports = (uploadLimiter, dirs) => {
  const { AVATAR_DIR, IMAGE_DIR, BUG_REPORT_IMAGE_DIR } = dirs;
  const router = express.Router();

  router.put('/avatar/upload', authRequired, uploadLimiter, asyncRoute(async (req, res, next) => {
    const image = await decodeImage(req.body?.avatar, 500 * 1024);
    if (!image) return res.status(400).json({ error: '请上传有效的 JPG、PNG、GIF 或 WebP 图片，头像不能超过500KB' });
    if (!stillAuthenticated(req, res)) return;
    const { buffer, ext } = image;
    const quota = checkQuota(req.user.id, buffer.length);
    if (!quota.ok) return res.status(quota.status).json({ error: quota.error });
    const filename = `${req.user.id}_${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const filepath = path.join(AVATAR_DIR, filename);
    const avatarUrl = `/uploads/avatars/${filename}`;
    const old = req.db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id)?.avatar;
    try {
      fs.writeFileSync(filepath, buffer, { flag: 'wx', mode: 0o600 });
      req.db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatarUrl, req.user.id);
      quota.commit();
      // Delete only this user's previous local file, after the replacement was stored.
      const oldName = typeof old === 'string' && old.startsWith('/uploads/avatars/') ? old.slice('/uploads/avatars/'.length) : '';
      const shared = typeof old === 'string' && req.db.prepare('SELECT COUNT(*) AS count FROM users WHERE id != ? AND avatar=?').get(req.user.id, old)?.count;
      if (!shared && new RegExp(`^${req.user.id}_[a-f0-9]+\\.(?:jpg|png|gif|webp)$`).test(oldName)) {
        try { fs.unlinkSync(path.join(AVATAR_DIR, oldName)); } catch {}
      }
      res.json({ message: '头像更新成功', avatar: avatarUrl });
    } catch (error) {
      try { fs.unlinkSync(filepath); } catch {}
      next(error);
    }
  }));

  function upload(directory, field, privateImage) {
    return asyncRoute(async (req, res, next) => {
      const image = await decodeImage(req.body?.[field], 2 * 1024 * 1024);
      if (!image) return res.status(400).json({ error: '请上传有效的 JPG、PNG、GIF 或 WebP 图片，大小不能超过2MB' });
      if (!stillAuthenticated(req, res)) return;
      const quota = checkQuota(req.user.id, image.buffer.length);
      if (!quota.ok) return res.status(quota.status).json({ error: quota.error });
      const filename = `${privateImage ? `bug_${req.user.id}_` : ''}${Date.now()}_${crypto.randomBytes(16).toString('hex')}.${image.ext}`;
      const filepath = path.join(directory, filename);
      const url = `/uploads/${privateImage ? 'bug-reports' : 'images'}/${filename}`;
      try {
        fs.writeFileSync(filepath, image.buffer, { flag: 'wx', mode: 0o600 });
        quota.commit();
        res.json({ url: privateImage ? signImageUrl(url, req) : url });
      } catch (error) {
        try { fs.unlinkSync(filepath); } catch {}
        next(error);
      }
    });
  }

  router.post('/upload/image', authRequired, uploadLimiter, upload(IMAGE_DIR, 'image', false));
  router.post('/upload/bug-image', authRequired, uploadLimiter, upload(BUG_REPORT_IMAGE_DIR, 'image', true));
  return router;
};
