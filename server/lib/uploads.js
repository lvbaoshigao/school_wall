const fs = require('fs');
const path = require('path');

const { UPLOADS_DIR } = require('./paths');
const crypto = require('crypto');
const sharp = require('sharp');
sharp.concurrency(2);

// 上传配额。
//
// 原先只有「单张 2MB」和「10 次/分钟/IP」两道限制，没有任何累计上限：
// 一个账号持续按额度上传就是 20MB/分钟，磁盘写满后连数据库落盘都会失败，
// 属于成本极低、后果极重的一类攻击。这里补两层：
//   1. 全局水位 —— uploads 目录总量触顶后拒绝新上传，保住数据库的落盘空间
//   2. 单用户滚动窗口 —— 限制每小时上传字节数，正常发帖远达不到
const MAX_TOTAL_MB = parseInt(process.env.UPLOAD_MAX_TOTAL_MB) || 2048;
const MAX_USER_MB_PER_HOUR = parseInt(process.env.UPLOAD_MAX_USER_MB_PER_HOUR) || 50;
const WINDOW_MS = 60 * 60 * 1000;

// 目录总量的计算要遍历文件，不能每次上传都做一遍，缓存 30 秒
let usageCache = { bytes: 0, at: 0 };
const USAGE_TTL = 30000;

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

function getUploadsUsage(force = false) {
  const now = Date.now();
  if (!force && now - usageCache.at < USAGE_TTL) return usageCache.bytes;
  usageCache = { bytes: dirSize(UPLOADS_DIR), at: now };
  return usageCache.bytes;
}

// 上传成功后把增量直接累加进缓存，避免刚写完就因为缓存过期而重新遍历整个目录
function noteWritten(bytes) {
  usageCache.bytes += bytes;
}

const userWindows = new Map();   // userId -> { bytes, resetAt }

function checkQuota(userId, byteLen) {
  const totalCap = MAX_TOTAL_MB * 1024 * 1024;
  if (getUploadsUsage() + byteLen > totalCap) {
    return { ok: false, status: 507, error: '服务器存储空间已满，暂时无法上传' };
  }

  const now = Date.now();
  let w = userWindows.get(userId);
  if (!w || now >= w.resetAt) {
    w = { bytes: 0, resetAt: now + WINDOW_MS };
    userWindows.set(userId, w);
  }
  const userCap = MAX_USER_MB_PER_HOUR * 1024 * 1024;
  if (w.bytes + byteLen > userCap) {
    const mins = Math.ceil((w.resetAt - now) / 60000);
    return { ok: false, status: 429, error: `上传量已达每小时上限（${MAX_USER_MB_PER_HOUR}MB），请 ${mins} 分钟后再试` };
  }

  return { ok: true, commit: () => { w.bytes += byteLen; noteWritten(byteLen); } };
}

// 定期清掉过期的用户窗口，避免 Map 随注册用户数无限增长
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userWindows) if (now >= v.resetAt) userWindows.delete(k);
}, WINDOW_MS);
if (sweep.unref) sweep.unref();

// 从帖子正文里提取本站上传的图片路径，用于删帖时清理孤儿文件。
// 只认 /uploads/images/ 下的文件名，避免被构造出的路径穿越到其它目录。
function extractLocalImages(content) {
  if (!content || typeof content !== 'string') return [];
  const out = [];
  const re = /\/uploads\/images\/([\w.-]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!m[1].includes('..')) out.push(m[1]);
  }
  return [...new Set(out)];
}

// 删除帖子关联的图片。同一张图可能被多条帖子引用，删前先确认没有其它帖子还在用。
function deletePostImages(db, content, excludePostId) {
  const names = extractLocalImages(content);
  if (names.length === 0) return 0;
  let removed = 0;
  for (const name of names) {
    try {
      const still = db.prepare(
        "SELECT COUNT(*) as c FROM posts WHERE id != ? AND content LIKE ?"
      ).get(excludePostId, `%/uploads/images/${name}%`).c;
      if (still > 0) continue;
      const full = path.join(UPLOADS_DIR, 'images', name);
      const size = fs.statSync(full).size;
      fs.unlinkSync(full);
      usageCache.bytes = Math.max(0, usageCache.bytes - size);
      removed++;
    } catch {}
  }
  return removed;
}

// 校验前端提交的图片 URL 列表。
//
// 举报和 Bug 反馈原先都是 `Array.isArray(images) ? JSON.stringify(images) : ''`，
// 元素内容、条数、长度一概不查 —— 任意字符串都会被存下并原样回显给管理员。
// 这里只放行本站上传目录下的正常文件名：外链会在管理员查看时暴露其 IP，
// `javascript:` 之类的伪协议则可能随渲染方式变化变成可执行的东西。
const MAX_IMAGES = 9;

function sanitizeImageList(images, subdir) {
  if (!Array.isArray(images)) return '';
  const dirs = Array.isArray(subdir) ? subdir : [subdir];
  const allowedDirs = dirs.filter(dir => ['avatars', 'images', 'bug-reports'].includes(dir));
  const re = new RegExp(`^/uploads/(?:${allowedDirs.join('|')})/[\\w.-]+$`);
  const out = [];
  for (const item of images) {
    if (typeof item !== 'string') continue;
    const s = item.trim().split('?')[0];
    if (s.length > 256 || s.includes('..')) continue;
    if (!re.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_IMAGES) break;
  }
  return out.length ? JSON.stringify(out) : '';
}

// 魔数校验。
//
// 三个上传端点原本只信 `data:image/(jpeg|png|gif|webp);base64,` 这个前缀，
// 而前缀完全由客户端书写 —— 把任意 HTML/JS 以 base64 塞进去、前缀写成 image/png，
// 服务端就会以 image/png 存下并原样回给浏览器。配合 MIME 嗅探即可变成托管脚本。
// 这里核对真实文件头，并对 png/jpeg/gif/webp 额外做结构完整性检查。
const SIGS = {
  jpg:  (b) => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  png:  (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
              && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
  gif:  (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF'
              && (b.toString('ascii', 3, 6) === '87a' || b.toString('ascii', 3, 6) === '89a'),
  // RIFF....WEBP
  webp: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF'
              && b.toString('ascii', 8, 12) === 'WEBP',
};

/**
 * 校验 base64 图片的真实格式是否与声明的扩展名一致
 * @param {Buffer} buffer 解码后的字节
 * @param {string} ext 声明的扩展名（jpg/png/gif/webp）
 * @returns {boolean}
 */
function verifyImageMagic(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || !SIGS[ext]?.(buffer)) return false;
  const safeSize = (w, h) => w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 32000000;
  try {
    if (ext === 'png') {
      let offset = 8;
      let imageData = false;
      let header = false;
      while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        if (length > buffer.length - offset - 12) return false;
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (!header) {
          if (type !== 'IHDR' || length !== 13 || !safeSize(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12))) return false;
          header = true;
        }
        if (type === 'IDAT' && length > 0) imageData = true;
        offset += length + 12;
        if (type === 'IEND') return length === 0 && imageData && offset === buffer.length;
      }
      return false;
    }
    if (ext === 'gif') return buffer.length >= 14 && safeSize(buffer.readUInt16LE(6), buffer.readUInt16LE(8)) && buffer[buffer.length - 1] === 0x3b;
    if (ext === 'webp') {
      if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
      const kind = buffer.toString('ascii', 12, 16);
      if (!['VP8 ', 'VP8L', 'VP8X'].includes(kind) || buffer.readUInt32LE(16) > buffer.length - 20) return false;
      if (kind === 'VP8X') return safeSize(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
      if (kind === 'VP8L') return buffer[20] === 0x2f && safeSize(1 + (buffer.readUInt32LE(21) & 0x3fff), 1 + ((buffer.readUInt32LE(21) >>> 14) & 0x3fff));
      return buffer[23] === 0x9d && buffer[24] === 1 && buffer[25] === 0x2a && safeSize(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return false;
    let offset = 2;
    let dimensions = false;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) return false;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda) return dimensions;
      if (marker === 0xd9) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || !safeSize(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3))) return false;
        dimensions = true;
      }
      offset += length;
    }
  } catch { return false; }
  return false;
}

let activeDecodes = 0;

// Fully decode and rebuild raster uploads, dropping EXIF, text chunks and trailing payloads.
async function encodeValidatedImage(buffer, ext, maximumBytes = 2 * 1024 * 1024) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maximumBytes || !verifyImageMagic(buffer, ext)) return null;
  if (activeDecodes >= 2) {
    const error = new Error('图片处理繁忙，请稍后重试');
    error.code = 'IMAGE_BUSY';
    throw error;
  }
  activeDecodes++;
  try {
    const options = { failOn: 'warning', limitInputPixels: 32000000, animated: ext === 'gif' || ext === 'webp' };
    const image = sharp(buffer, options).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    const expected = ext === 'jpg' ? 'jpeg' : ext;
    if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > 8192 ||
        (metadata.pageHeight || metadata.height) > 8192 || metadata.width * metadata.height > 32000000 || (metadata.pages || 1) > 120) return null;
    const output = await image.rotate().toFormat(expected).toBuffer();
    return output.length <= maximumBytes ? { buffer: output, ext } : null;
  } catch (error) {
    if (error.code === 'IMAGE_BUSY') throw error;
    return null;
  } finally { activeDecodes--; }
}

// Image capabilities are purpose-specific HMACs, never reusable as login tokens.
function imageSignature(payload) {
  const { SECRET } = require('../middleware/auth');
  return crypto.createHmac('sha256', SECRET).update(`private-upload:${payload}`).digest('base64url');
}

function signImageUrl(url, req) {
  const pathname = typeof url === 'string' ? url.split('?')[0] : '';
  if (!/^\/uploads\/(?:images|bug-reports)\/[\w.-]+$/.test(pathname) || pathname.includes('..')) return '';
  const user = req.db.prepare('SELECT token_version FROM users WHERE id=?').get(req.user.id);
  if (!user) return '';
  const payload = Buffer.from(JSON.stringify({ p: pathname, u: req.user.id, t: user.token_version || 0, e: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  return `${pathname}?ticket=${payload}.${imageSignature(payload)}`;
}

function signPrivateImages(images, req) {
  let values = images;
  try { if (typeof values === 'string') values = JSON.parse(values || '[]'); } catch { return ''; }
  if (!Array.isArray(values)) return '';
  const urls = values.slice(0, MAX_IMAGES).map(url => signImageUrl(url, req)).filter(Boolean);
  return urls.length ? JSON.stringify(urls) : '';
}

function verifyImageTicket(ticket, pathname, db) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return false;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return false;
  const expected = Buffer.from(imageSignature(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (data.p !== pathname || !Number.isSafeInteger(data.u) || !Number.isSafeInteger(data.e) || data.e <= now || data.e > now + 300) return false;
    const user = db.prepare('SELECT token_version, status FROM users WHERE id=?').get(data.u);
    if (!user || user.status !== 'active' || (user.token_version || 0) !== data.t) return false;
    if (pathname.startsWith(`/uploads/bug-reports/bug_${data.u}_`)) return true;
    const containsPath = row => { try { return JSON.parse(row.images || '[]').some(url => typeof url === 'string' && url.split('?')[0] === pathname); } catch { return false; } };
    const { userCan } = require('./permissions');
    const reports = db.prepare('SELECT reporter_id, wall_id, images FROM reports WHERE images LIKE ?').all(`%${pathname}%`).filter(containsPath);
    if (reports.some(row => row.reporter_id === data.u || userCan(db, data.u, 'global.safety.handle', 0) || userCan(db, data.u, 'wall.safety.report', row.wall_id))) return true;
    const bugs = db.prepare('SELECT reporter_id, images FROM bug_reports WHERE images LIKE ?').all(`%${pathname}%`).filter(containsPath);
    return bugs.some(row => row.reporter_id === data.u || userCan(db, data.u, 'global.bug.handle', 0));
  } catch { return false; }
}

function privateUploadGuard(req, res, next) {
  let relativePath;
  try { relativePath = path.posix.normalize(decodeURIComponent(req.path)); } catch { return res.status(400).json({ error: '无效图片路径' }); }
  if (relativePath.includes('\0') || !/^\/(?:avatars|images|bug-reports)\/[\w.-]+$/.test(relativePath) || relativePath.includes('..')) return res.status(404).json({ error: '图片不存在' });
  const pathname = `/uploads${relativePath}`;
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  let restricted = relativePath.startsWith('/bug-reports/');
  if (!restricted && relativePath.startsWith('/images/')) {
    const rows = req.db.prepare('SELECT images FROM reports WHERE images LIKE ?').all(`%${pathname}%`);
    restricted = rows.some(row => { try { return JSON.parse(row.images).some(url => typeof url === 'string' && url.split('?')[0] === pathname); } catch { return false; } });
  }
  if (!restricted) return next();
  res.locals.privateUpload = true;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!verifyImageTicket(req.query.ticket, pathname, req.db)) return res.status(404).json({ error: '图片不存在或访问链接已过期，请刷新页面' });
  next();
}

module.exports = { checkQuota, getUploadsUsage, noteWritten, extractLocalImages, deletePostImages, sanitizeImageList, verifyImageMagic, encodeValidatedImage, signImageUrl, signPrivateImages, verifyImageTicket, privateUploadGuard };
