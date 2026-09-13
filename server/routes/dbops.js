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
const { getWrapper, setSetting, getSetting } = require('../db');
const ipguard = require('../lib/ipguard');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
const SAFE_NAME = /^(backup|pre-wipe)-\d{8}-\d{6}\.db$/;

function dbStats(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);
  const rows = {};
  let total = 0;
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
      rows[t] = c; total += c;
    } catch { rows[t] = null; }
  }
  return { tables, rows, total };
}

function backupFilePath(name) {
  if (!SAFE_NAME.test(name)) return null;
  return path.join(BACKUP_DIR, name);
}

function createBackup(prefix = 'backup') {
  const w = getWrapper();
  if (!w) throw new Error('数据库未就绪');
  w.saveNow(); // 先把内存中未落盘的改动写下去，保证备份是完整最新状态
  const buf = w.exportBytes();
  const name = `${prefix}-${stamp()}.db`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), buf, { mode: 0o600 });
  return { file: name, size: buf.length };
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => SAFE_NAME.test(f))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, created_at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

function wipeNow(db) {
  const before = dbStats(db);
  db.pragma('foreign_keys = OFF');
  try {
    for (const t of before.tables) {
      try { db.prepare(`DELETE FROM "${t}"`).run(); } catch {}
    }
    // 重置自增计数器（sqlite_sequence 在 sqlite_master 里类型是 table 但被上面的过滤排除，单独清）
    try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch {}
  } finally {
    db.pragma('foreign_keys = ON');
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

  // 概览：库大小、行数统计、备份个数、白名单现状
  r.get('/status', (req, res) => {
    const db = req.db;
    let dbSize = 0;
    try { dbSize = fs.statSync(path.join(__dirname, '..', 'data.db')).size; } catch {}
    const stats = dbStats(db);
    res.json({
      db_size: dbSize,
      tables: stats.tables,
      rows: stats.rows,
      total_rows: stats.total,
      backups: listBackups().length,
      upload_size: dirSize(path.join(__dirname, '..', 'uploads')),
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
    res.download(fp, req.params.name);
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

    // 防自锁：新模式生效且名单非空时，当前 IP 必须仍在名单内（或 env 已兜底）
    if (mode !== 'off' && cleaned.length) {
      const merged = [...ipguard.parseList(process.env.ADMIN_IP_WHITELIST || ''), ...cleaned];
      const myIp = ipguard.clientIpOf(req);
      if (!ipguard.ipMatches(myIp, merged)) {
        return res.status(400).json({ error: `保存被拒绝：新名单不包含当前 IP（${myIp}），保存后将无法访问` });
      }
    }

    setSetting(req.db, 'ip_whitelist_mode', mode);
    setSetting(req.db, 'admin_ip_whitelist', JSON.stringify(cleaned));
    res.json({ message: '白名单已更新', mode, entries: cleaned });
  });

  // 删库第 1 步：领取验证码
  r.post('/wipe/prepare', (req, res) => {
    const code = genCode();
    pendingWipes.set(req.user.id, { code, armedAt: Date.now() });
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
    if (elapsed > WIPE_EXPIRE_MS) {
      pendingWipes.delete(req.user.id);
      return res.status(400).json({ error: '验证码已过期，请重新生成' });
    }
    if (elapsed < WIPE_WAIT_MS) {
      const remain = Math.ceil((WIPE_WAIT_MS - elapsed) / 1000);
      return res.status(425).json({ error: `请等待 ${remain} 秒后再执行（防止误触的强制冷却）` });
    }
    const { code } = req.body || {};
    if (String(code || '').toUpperCase() !== pending.code) {
      return res.status(400).json({ error: '验证码不正确' });
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
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
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
