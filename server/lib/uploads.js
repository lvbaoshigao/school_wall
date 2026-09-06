const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

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
  const re = new RegExp(`^/uploads/${subdir}/[\\w.-]+$`);
  const out = [];
  for (const item of images) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s.length > 256 || s.includes('..')) continue;
    if (!re.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_IMAGES) break;
  }
  return out.length ? JSON.stringify(out) : '';
}

module.exports = { checkQuota, getUploadsUsage, noteWritten, extractLocalImages, deletePostImages, sanitizeImageList };
