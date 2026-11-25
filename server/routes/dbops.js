// ===== 数据库管理（备份 / 一键删库 / 访问 IP 白名单） =====
//
// 双挂载点：
//   /api/admin/db/*      —— Vue 管理后台用，鉴权 = authRequired + global.db.manage 权限
//   /dashboard/api/db/*  —— 服务端渲染看板用，鉴权 = dashboardAuth(Cookie) + 同权限
//
// 删库流程（防止手滑/误触的三道闸）：
//   1. POST /wipe/prepare 生成 6 位随机码（去掉易混淆字符的字符集），仅返回给当前管理员
//   2. 执行端要求 body 带上该验证码，且距 prepare 至少 10 秒（服务端强制，改前端没用）
//   3. 执行前自动做一次 pre-wipe 备份 —— 即使删错了也能整库恢复
// 验证码 5 分钟过期，每个管理员同时只保留一份待确认状态。
//
// 删库语义：清空所有业务表的行（保留表结构与索引），settings 一并清空 →
// 重启后前端会重新出现首次设置向导，等同于「恢复出厂」。

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getWrapper, setSetting } = require('../db');
const { DATA_DIR, DB_PATH, UPLOADS_DIR } = require('../lib/paths');
const ipguard = require('../lib/ipguard');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

const WIPE_WAIT_MS = 10 * 1000;        // prepare 与 execute 之间的最短等待
const WIPE_EXPIRE_MS = 5 * 60 * 1000;  // 验证码有效期
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I/O/0/1 等易混淆字符

const pendingWipes = new Map(); // userId -> { code, armedAt }

function genCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 备份文件名白名单：只允许本模块生成的格式，下载/删除接口据此拒绝路径穿越
const SAFE_NAME = /^(backup|pre-wipe)-\d{8}-\d{6}(?:-[a-f0-9]{12})?\.db$/;
const quoteIdentifier = name => '"' + name.replace(/"/g, '""') + '"';
const wipeBinding = req => crypto.createHash('sha256').update(req.user.csrf || req.headers.authorization || '').digest('hex');

function dbStats(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);
  const rows = {};
  let total = 0;
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(t)}`).get().c;
      rows[t] = c; total += c;
    } catch { rows[t] = null; }
  }
  return { tables, rows, total };
}

function backupFilePath(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return null;
  const file = path.join(BACKUP_DIR, name);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch { return null; }
  return file;
}

function createBackup(prefix = 'backup') {
  const w = getWrapper();
  if (!w) throw new Error('数据库未就绪');
  w.saveNow(); // 先把内存中未落盘的改动写下去，保证备份是完整最新状态
  const buf = w.exportBytes();
  if (!['backup', 'pre-wipe'].includes(prefix)) throw new Error('无效的备份类型');
  const name = `${prefix}-${stamp()}-${crypto.randomBytes(6).toString('hex')}.db`;
  // 排他创建，避免同秒请求覆盖备份或跟随预置符号链接写入。
  fs.writeFileSync(path.join(BACKUP_DIR, name), buf, { mode: 0o600, flag: 'wx' });
  return { file: name, size: buf.length };
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => backupFilePath(f))
      .map(f => {
        const st = fs.lstatSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, created_at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

function wipeNow(db) {
  const before = dbStats(db);
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.pragma('foreign_keys = OFF');
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    for (const t of before.tables) db.prepare(`DELETE FROM ${quoteIdentifier(t)}`).run();
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence' AND type='table'").get()) {
      // 用户 ID 是登录 JWT、Dashboard 票据和私密上传授权的身份边界。
      // 密钥和 token_version 不随清库重置，复用旧 ID 会让旧凭据登录成新账号。
      db.prepare("DELETE FROM sqlite_sequence WHERE name <> 'users'").run();
    }
    db.exec('COMMIT');
  } catch (error) {
    if (started) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
  // settings 一并清空 → 前端重新出现首次设置向导（删库重置语义）
  getWrapper()?.saveNow();
  return before;
}

// ---- 白名单 ----

const IP_ENTRY_RE = /^[0-9a-fA-F.:*]{1,45}$/;

function validateEntries(entries) {
  if (!Array.isArray(entries)) return null;
  const cleaned = entries.map(e => String(e).trim()).filter(Boolean);
  if (cleaned.length > 100) return null;
  for (const e of cleaned) {
    if (!IP_ENTRY_RE.test(e)) return null;
  }
  return [...new Set(cleaned)];
}

// ---- 路由构建：authenticate 由两种挂载点各自提供 ----

function buildRouter(authenticate) {
  const r = express.Router();
  r.use(authenticate);
  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // 概览：库大小、行数统计、备份个数、白名单现状
  r.get('/status', (req, res) => {
    const db = req.db;
    let dbSize = 0;
    try { dbSize = fs.statSync(DB_PATH).size; } catch {}
    const stats = dbStats(db);
    res.json({
      db_size: dbSize,
      tables: stats.tables,
      rows: stats.rows,
      total_rows: stats.total,
      backups: listBackups().length,
      upload_size: dirSize(UPLOADS_DIR),
    });
  });

  r.post('/backup', (req, res) => {
    try {
      const out = createBackup('backup');
      res.json({ message: `备份完成：${out.file}`, ...out });
    } catch (e) {
      res.status(500).json({ error: '备份失败: ' + e.message });
    }
  });

  r.get('/backups', (req, res) => {
    res.json({ backups: listBackups() });
  });

  r.get('/backups/:name/download', (req, res) => {
    const fp = backupFilePath(req.params.name);
    if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: '备份不存在' });
    res.type('application/octet-stream').download(fp, req.params.name);
  });

  r.delete('/backups/:name', (req, res) => {
    const fp = backupFilePath(req.params.name);
    if (!fp) return res.status(400).json({ error: '非法文件名' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '备份不存在' });
    fs.unlinkSync(fp);
    res.json({ message: '备份已删除' });
  });

  r.get('/whitelist', (req, res) => {
    const { envList, cfgList, mode } = ipguard.getWhitelistConfig(req.db);
    res.json({
      mode,
      entries: cfgList,
      env_entries: envList,
      current_ip: ipguard.clientIpOf(req),
    });
  });

  r.put('/whitelist', (req, res) => {
    const { mode, entries } = req.body || {};
    if (!['off', 'admin', 'all'].includes(mode)) return res.status(400).json({ error: '无效的保护范围' });
    const cleaned = validateEntries(entries);
    if (cleaned === null) return res.status(400).json({ error: 'IP 条目格式无效（仅允许 IPv4/IPv6 与 * 通配）' });

    // 启用保护必须有实际名单，且合并环境配置后仍包含当前请求者，避免假保护或自锁。
    if (mode !== 'off') {
      const merged = [...ipguard.parseList(process.env.ADMIN_IP_WHITELIST || ''), ...cleaned];
      if (!merged.length) return res.status(400).json({ error: '启用访问保护前请至少配置一条包含当前 IP 的白名单' });
      const myIp = ipguard.clientIpOf(req);
      if (!ipguard.ipMatches(myIp, merged)) {
        return res.status(400).json({ error: `保存被拒绝：新名单不包含当前 IP（${myIp}），保存后将无法访问` });
      }
    }

    req.db.exec('BEGIN');
    try {
      setSetting(req.db, 'ip_whitelist_mode', mode);
      setSetting(req.db, 'admin_ip_whitelist', JSON.stringify(cleaned));
      req.db.exec('COMMIT');
    } catch (error) {
      req.db.exec('ROLLBACK');
      throw error;
    }
    res.json({ message: '白名单已更新', mode, entries: cleaned });
  });

  // 删库第 1 步：领取验证码
  r.post('/wipe/prepare', (req, res) => {
    const code = genCode();
    for (const [id, pending] of pendingWipes) {
      if (Date.now() - pending.armedAt > WIPE_EXPIRE_MS) pendingWipes.delete(id);
    }
    pendingWipes.set(req.user.id, { code, armedAt: Date.now(), binding: wipeBinding(req), attempts: 0 });
    res.json({
      code,
      wait_seconds: WIPE_WAIT_MS / 1000,
      expires_in: WIPE_EXPIRE_MS / 1000,
      message: '验证码已生成，请等待 10 秒后输入验证码执行',
    });
  });

  // 删库第 2 步：验证码 + 10 秒等待 + 自动 pre-wipe 备份 → 清空
  r.post('/wipe/execute', (req, res) => {
    const pending = pendingWipes.get(req.user.id);
    if (!pending) return res.status(400).json({ error: '请先生成删库验证码' });

    const elapsed = Date.now() - pending.armedAt;
    if (pending.binding !== wipeBinding(req)) return res.status(403).json({ error: '请在生成验证码的同一会话执行' });
    if (elapsed < 0 || elapsed > WIPE_EXPIRE_MS) {
      pendingWipes.delete(req.user.id);
      return res.status(400).json({ error: '验证码已过期，请重新生成' });
    }
    if (elapsed < WIPE_WAIT_MS) {
      const remain = Math.ceil((WIPE_WAIT_MS - elapsed) / 1000);
      return res.status(425).json({ error: `请等待 ${remain} 秒后再执行（防止误触的强制冷却）` });
    }
    const { code } = req.body || {};
    const supplied = typeof code === 'string' ? code.toUpperCase() : '';
    if (!/^[A-Z2-9]{6}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(pending.code))) {
      pending.attempts++;
      if (pending.attempts >= 5) pendingWipes.delete(req.user.id);
      return res.status(400).json({ error: pending.attempts >= 5 ? '验证码错误次数过多，请重新生成' : '验证码不正确' });
    }

    pendingWipes.delete(req.user.id);
    try {
      // 删库前自动备份 —— 这一步失败则中止删库
      const backup = createBackup('pre-wipe');
      const deleted = wipeNow(req.db);
      console.warn(`[DBOPS] 用户 ${req.user.id} 执行了一键删库。已自动备份到 ${backup.file}。`);
      res.json({
        message: '数据库已清空，页面数据将失效，请重新完成首次设置',
        backup,
        deleted_tables: deleted.tables.length,
        deleted_rows: deleted.total,
      });
    } catch (e) {
      res.status(500).json({ error: '删库失败（已中止）: ' + e.message });
    }
  });

  return r;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      try { const st = fs.lstatSync(path.join(dir, f)); if (st.isFile()) total += st.size; } catch {}
    }
  } catch {}
  return total;
}

module.exports = {
  apiRouter: buildRouter([(req, res, next) => {
    // 延迟 require 避免与 middleware/auth 的潜在加载环
    const { authRequired, requirePerm } = require('../middleware/auth');
    authRequired(req, res, (err) => {
      if (err) return next(err);
      requirePerm('global.db.manage')(req, res, next);
    });
  }]),
  dashboardRouter(dashboardAuth) {
    const { userCan } = require('../lib/permissions');
    return buildRouter([
      dashboardAuth,
      (req, res, next) => {
        if (userCan(req.db, req.user.id, 'global.db.manage')) return next();
        return res.status(403).json({ error: '权限不足' });
      },
    ]);
  },
  createBackup, wipeNow,
};
