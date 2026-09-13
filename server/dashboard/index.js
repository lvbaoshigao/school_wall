const express = require('express');
const jwt = require('jsonwebtoken');
const { authRequired, requirePerm, SECRET } = require('../middleware/auth');
const { userCan } = require('../lib/permissions');
const dbops = require('../routes/dbops');

// 运行看板。页面是服务端拼的 HTML（按钮用内联 onclick），
// 所以 nginx 那边刻意没给 /dashboard 挂 CSP —— 见 deploy/nginx/school-wall-csp.conf。
const router = express.Router();

// ===== Dashboard =====
// 票据走 HttpOnly Cookie，不再接受 ?token= ——
// nginx 的 access_log 会完整记录 query string（已确认日志里存在 `GET /api/posts/search?q=...`），
// 把管理员 JWT 放在 URL 里等于把它明文写进服务器日志和浏览器历史。
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

// 前端在打开 Dashboard 前先调这里，用 Authorization 头换一张短期票据种进 Cookie
router.post('/api/dashboard/session', authRequired, requirePerm('global.dashboard'), (req, res) => {
  const ticket = jwt.sign({ id: req.user.id, aud: 'dashboard' }, SECRET, { expiresIn: '1h' });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', [
    `sw_dash=${ticket}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/dashboard',
    'Max-Age=3600',
    ...(secure ? ['Secure'] : []),
  ].join('; '));
  res.json({ message: 'ok' });
});

function dashboardAuth(req, res, next) {
  const fail = (code, msg) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(code).send(msg);
  };
  // Cookie 优先；Authorization 头保留给 curl / 脚本这类非浏览器访问
  const token = parseCookies(req).sw_dash
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) {
    return fail(401, '<h1>请先登录</h1><p>请在校园墙前端登录后，从导航栏进入 Dashboard</p>');
  }
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'], audience: 'dashboard' });
    req.user = payload;
    const user = req.db.prepare('SELECT role FROM users WHERE id=?').get(payload.id);
    if (!user || !userCan(req.db, payload.id, 'global.dashboard')) {
      return fail(403, '<h1>权限不足</h1>');
    }
    req.user.role = user.role;
    next();
  } catch {
    return fail(401, '<h1>票据无效或已过期</h1><p>请回到校园墙前端重新进入 Dashboard</p>');
  }
}

// ===== Dashboard 内部 API =====
//
// 功能性修复：页面 JS 原先带着固定的空 Bearer（TOKEN=''）直接调 /api/admin/*，
// 全部被 authRequired 打回 401 —— 发公告 / 删帖 / 改角色 / 封禁这批按钮从
// 「票据改走 Cookie」的安全重构后就再没成功过。
// 这里补一条用 Cookie 换短期 token 的通道：token 只存在于页面 JS 内存，
// 不进 URL、不进 localStorage、不进服务器日志，10 分钟自动过期。
router.post('/dashboard/api/token', dashboardAuth, (req, res) => {
  const token = jwt.sign({ id: req.user.id }, SECRET, { expiresIn: '10m' });
  res.json({ token });
});

// 数据库管理（备份 / 删库 / 白名单）：同源 Cookie 鉴权，权限要求与 /api/admin/db 一致
router.use('/dashboard/api/db', dbops.dashboardRouter(dashboardAuth));

router.get('/dashboard', dashboardAuth, (req, res) => {
  const db = req.db;
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// 用于 JS 字符串上下文的转义：在 HTML 转义之外，再对反斜杠和换行做转义，防止用户通过
// 浏览器对 onclick 属性值的 HTML 解码后，注入 JS 代码执行任意函数。
const escJs = s => esc(s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/\r/g,'\\r');
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE status='active'").get().c;
  const bannedUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE status='banned'").get().c;
  const totalPosts = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  const totalComments = db.prepare('SELECT COUNT(*) as c FROM comments').get().c;
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const todayPosts = db.prepare("SELECT COUNT(*) as c FROM posts WHERE date(created_at)=date('now')").get().c;
  const todayUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at)=date('now')").get().c;

  const recentPosts = db.prepare(`
    SELECT p.id, p.content, p.category, p.is_anonymous, p.like_count, p.comment_count, p.created_at,
      CASE WHEN p.is_anonymous=1 THEN '匿名' ELSE u.nickname END as author
    FROM posts p LEFT JOIN users u ON p.author_id=u.id ORDER BY p.created_at DESC LIMIT 10
  `).all();

  const allUsers = db.prepare(`
    SELECT id, username, nickname, real_name, role, status, ban_until, created_at
    FROM users ORDER BY created_at DESC
  `).all();

  const announcements = db.prepare(`
    SELECT a.*, u.nickname as author_name FROM announcements a JOIN users u ON a.author_id=u.id
    ORDER BY a.is_pinned DESC, a.created_at DESC
  `).all();

  const roleLabel = r => ({ super_admin:'超级管理员', admin:'全局管理员', user:'普通用户' })[r] || r;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>管理后台 - 校园墙</title>
<style>
:root{
  --bg:#0b0d1a; --panel:rgba(255,255,255,0.045); --panel-border:rgba(255,255,255,0.09);
  --text:#e8eaf2; --muted:rgba(232,234,242,0.55); --faint:rgba(232,234,242,0.35);
  --primary:#7c8cf8; --primary-2:#9d6ef0; --danger:#ff6b6b; --danger-soft:rgba(255,107,107,0.14);
  --ok:#3ddc84; --warn:#ffd166; --radius:14px;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:radial-gradient(1200px 600px at 80% -10%, rgba(124,140,248,0.14), transparent 60%),
             radial-gradient(900px 500px at 0% 100%, rgba(157,110,240,0.10), transparent 55%),
             var(--bg);
  color:var(--text);min-height:100vh;line-height:1.55}
.header{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:14px 28px;background:rgba(11,13,26,0.82);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--panel-border)}
.header h1{font-size:18px;font-weight:700;display:flex;align-items:center;gap:10px;white-space:nowrap}
.header h1::before{content:'';width:26px;height:26px;border-radius:8px;flex:none;
  background:linear-gradient(135deg,var(--primary),var(--primary-2))}
.header .who{display:flex;align-items:center;gap:14px;font-size:13px;color:var(--muted);min-width:0}
.header .who b{color:var(--text);font-weight:600}
.header a.back{color:var(--primary);text-decoration:none;font-size:13px;white-space:nowrap;padding:6px 12px;
  border:1px solid rgba(124,140,248,0.35);border-radius:8px;transition:background .2s}
.header a.back:hover{background:rgba(124,140,248,0.12)}
.container{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:26px}
.stat-card{background:var(--panel);border:1px solid var(--panel-border);border-radius:var(--radius);padding:18px 16px;text-align:center;transition:transform .2s,border-color .2s}
.stat-card:hover{transform:translateY(-2px);border-color:rgba(124,140,248,0.4)}
.stat-value{font-size:30px;font-weight:800;letter-spacing:-.5px;
  background:linear-gradient(135deg,#fff,#a9b4ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.stat-label{font-size:12px;color:var(--muted);margin-top:4px}
.section{background:var(--panel);border:1px solid var(--panel-border);border-radius:var(--radius);padding:22px;margin-bottom:22px}
.section h2{font-size:16px;margin-bottom:16px;color:var(--text);display:flex;align-items:center;gap:8px}
.section h2::before{content:'';width:4px;height:16px;border-radius:2px;background:linear-gradient(180deg,var(--primary),var(--primary-2))}
.section .hint{font-size:12px;color:var(--faint);margin-bottom:12px}
.table-wrap{overflow-x:auto;border-radius:10px;border:1px solid rgba(255,255,255,0.06)}
table{width:100%;border-collapse:collapse;min-width:560px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tr:hover{background:rgba(255,255,255,0.03)}
.role-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600}
.role-super_admin{background:rgba(255,209,102,0.16);color:#ffd166}
.role-admin{background:rgba(124,140,248,0.16);color:#a9b4ff}
.role-user{background:rgba(61,220,132,0.14);color:#8df0b6}
.status-banned{color:var(--danger);font-weight:600}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:9px;font-size:13px;
  cursor:pointer;color:#fff;text-decoration:none;margin:2px;font-weight:600;transition:opacity .15s,transform .15s}
.btn:hover{opacity:.88}.btn:active{transform:scale(.97)}
.btn-danger{background:linear-gradient(135deg,#ff6b6b,#e05252)}
.btn-primary{background:linear-gradient(135deg,var(--primary),var(--primary-2))}
.btn-success{background:linear-gradient(135deg,#2fbf71,#23945a)}
.btn-ghost{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12)}
.btn-sm{padding:4px 11px;font-size:12px;border-radius:7px}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.truncate{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.form-inline{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
input,textarea,select{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);border-radius:9px;
  padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--primary)}
input::placeholder,textarea::placeholder{color:var(--faint)}
.form-inline textarea{resize:vertical;min-height:64px}
.form-inline input[type=datetime-local]{color-scheme:dark}
.danger-zone{border:1px solid rgba(255,107,107,0.35);background:var(--danger-soft)}
.danger-zone h2::before{background:var(--danger)}
.code-display{font-family:'SF Mono',Consolas,monospace;font-size:30px;letter-spacing:10px;font-weight:800;
  color:#ffd166;text-align:center;padding:14px 0 8px;user-select:all}
.steps{display:grid;gap:14px}
.step{display:flex;gap:12px;align-items:flex-start}
.step-num{flex:none;width:24px;height:24px;border-radius:50%;background:rgba(255,107,107,0.2);color:#ff9b9b;
  display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-top:2px}
.wl-tags{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.wl-tag{display:inline-flex;align-items:center;gap:6px;background:rgba(124,140,248,0.14);border:1px solid rgba(124,140,248,0.3);
  border-radius:999px;padding:4px 12px;font-size:12px;font-family:monospace}
.wl-tag button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;line-height:1}
.wl-tag button:hover{color:var(--danger)}
.db-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.db-meta .item{background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 12px}
.db-meta .item .v{font-size:18px;font-weight:700}
.db-meta .item .k{font-size:11px;color:var(--muted)}
#toasts{position:fixed;top:70px;right:20px;z-index:2000;display:flex;flex-direction:column;gap:8px}
.toast{background:rgba(20,24,44,0.95);border:1px solid var(--panel-border);border-left:3px solid var(--primary);
  border-radius:10px;padding:10px 16px;font-size:13px;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,0.4);
  animation:slideIn .25s ease}
.toast.err{border-left-color:var(--danger)}
.toast.ok{border-left-color:var(--ok)}
@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:1000;justify-content:center;align-items:center;backdrop-filter:blur(4px)}
.modal.active{display:flex}
.modal-content{background:#141830;border:1px solid var(--panel-border);border-radius:16px;padding:26px;max-width:460px;width:92%}
.modal-content h3{margin-bottom:18px;font-size:16px}
.modal-content label{display:block;margin-bottom:5px;font-size:12px;color:var(--muted)}
.modal-content input,.modal-content select{width:100%;margin-bottom:14px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
@media (max-width:640px){
  .header{padding:12px 16px}
  .header .who span{display:none}
  .container{padding:16px 12px 50px}
  .stat-value{font-size:24px}
  .section{padding:16px}
  .truncate{max-width:140px}
}
</style></head><body>
<div id="toasts"></div>
<div class="header">
<h1>校园墙 · 管理后台</h1>
<div class="who"><span><b>${esc(req.user.username)}</b> (${roleLabel(req.user.role)})</span><a class="back" href="/">← 返回首页</a></div>
</div>
<div class="container">
<div class="stats-grid">
  <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">总用户 (活跃${activeUsers} / 封禁${bannedUsers})</div></div>
  <div class="stat-card"><div class="stat-value">${totalPosts}</div><div class="stat-label">总帖子 (今日${todayPosts})</div></div>
  <div class="stat-card"><div class="stat-value">${totalComments}</div><div class="stat-label">总评论</div></div>
  <div class="stat-card"><div class="stat-value">${totalMessages}</div><div class="stat-label">总消息</div></div>
  <div class="stat-card"><div class="stat-value">${todayUsers}</div><div class="stat-label">今日新用户</div></div>
</div>

<div class="section">
  <h2>公告管理</h2>
  <div class="form-inline">
    <input id="ann-title" placeholder="公告标题" style="flex:1;min-width:180px">
    <select id="ann-pinned"><option value="0">普通</option><option value="1">置顶</option></select>
  </div>
  <div class="form-inline">
    <textarea id="ann-content" placeholder="公告内容..." style="flex:1"></textarea>
  </div>
  <div class="form-inline">
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">定时删除: <input id="ann-delete-at" type="datetime-local" style="width:auto"></label>
    <button class="btn btn-primary" onclick="publishAnn()">发布公告</button>
  </div>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>标题</th><th>置顶</th><th>定时删除</th><th>发布时间</th><th>操作</th></tr></thead>
  <tbody>${announcements.map(a=>`<tr>
    <td>${a.id}</td><td>${esc(a.title)}</td>
    <td>${a.is_pinned?'是':'否'}</td>
    <td>${esc(a.delete_at)||'-'}</td>
    <td>${new Date(a.created_at).toLocaleString('zh-CN')}</td>
    <td><button class="btn btn-danger btn-sm" onclick="deleteAnn(${a.id})">删除</button></td>
  </tr>`).join('') || '<tr><td colspan="6" style="color:var(--faint)">暂无公告</td></tr>'}
  </tbody></table></div>
</div>

<div class="section">
  <h2>用户管理</h2>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>真实姓名</th><th>角色</th><th>状态</th><th>封禁截止</th><th>操作</th></tr></thead>
  <tbody>${allUsers.map(u=>`<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.nickname)||'-'}</td><td>${esc(u.real_name)||'-'}</td>
    <td><span class="role-badge role-${u.role}">${roleLabel(u.role)}</span></td>
    <td>${u.status==='banned'?'<span class="status-banned">封禁</span>':'正常'}</td>
    <td>${esc(u.ban_until)||'-'}</td>
    <td>${u.role!=='super_admin'?`
      <button class="btn btn-primary btn-sm" onclick="showSettings(${u.id},'${escJs(u.username)}','${escJs(u.role)}','${escJs(u.status)}')">设置</button>
    `:'<span style="color:var(--faint)">超级管理员</span>'}</td></tr>`).join('') || '<tr><td colspan="8" style="color:var(--faint)">暂无用户</td></tr>'}
  </tbody></table></div>
</div>

<div class="section">
  <h2>最近帖子</h2>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>内容</th><th>分类</th><th>作者</th><th>赞</th><th>评</th><th>时间</th><th>操作</th></tr></thead>
  <tbody>${recentPosts.map(p=>`<tr><td>${p.id}</td><td class="truncate">${esc(p.content)}</td>
    <td>${esc(p.category)||'-'}</td>
    <td>${p.is_anonymous?'<span style="color:var(--faint)">匿名</span>':esc(p.author||'-')}</td>
    <td>${p.like_count}</td><td>${p.comment_count}</td>
    <td>${new Date(p.created_at).toLocaleString('zh-CN')}</td>
    <td><button class="btn btn-danger btn-sm" onclick="deletePost(${p.id})">删除</button></td></tr>`).join('') || '<tr><td colspan="8" style="color:var(--faint)">暂无帖子</td></tr>'}
  </tbody></table></div>
</div>

<div class="section">
  <h2>数据库管理</h2>
  <div class="hint">备份 / 白名单 / 删库。仅超级管理员可见可操作。</div>
  <div id="db-meta" class="db-meta"><div class="item"><div class="v">…</div><div class="k">加载中</div></div></div>
  <div class="form-inline">
    <button class="btn btn-primary" onclick="makeBackup()">立即备份</button>
    <button class="btn btn-ghost" onclick="loadBackups()">刷新备份列表</button>
  </div>
  <div class="table-wrap"><table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th>操作</th></tr></thead>
  <tbody id="backup-rows"><tr><td colspan="4" style="color:var(--faint)">加载中…</td></tr></tbody></table></div>
</div>

<div class="section">
  <h2>访问 IP 白名单</h2>
  <div class="hint">控制谁能访问管理后台，或整个 API。环境变量 ADMIN_IP_WHITELIST 配置的条目始终生效（数据库被清空后的引导保护）。</div>
  <div class="form-inline">
    <label style="font-size:13px;color:var(--muted)">保护范围</label>
    <select id="wl-mode" style="min-width:200px">
      <option value="off">关闭（不限制）</option>
      <option value="admin">仅管理后台 / Dashboard</option>
      <option value="all">整个 API（内网部署模式）</option>
    </select>
    <span style="font-size:12px;color:var(--faint)">你的 IP：<code id="wl-myip"></code></span>
  </div>
  <div class="wl-tags" id="wl-tags"></div>
  <div class="form-inline">
    <input id="wl-input" placeholder="如 10.8.0.5、192.168.*、::1" style="flex:1;min-width:200px;font-family:monospace" onkeydown="if(event.key==='Enter')addWlEntry()">
    <button class="btn btn-ghost" onclick="addWlEntry()">添加</button>
    <button class="btn btn-primary" onclick="saveWhitelist()">保存白名单</button>
  </div>
  <div id="wl-env" style="font-size:12px;color:var(--faint)"></div>
</div>

<div class="section danger-zone">
  <h2>危险区 · 一键删库</h2>
  <div class="hint">清空全部数据（保留表结构），settings 一并清除，重启前端将重新出现初始化向导。执行前会自动生成一份 pre-wipe 备份。</div>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div>
      <button class="btn btn-danger" id="wipe-prep-btn" onclick="wipePrepare()">生成 6 位删库验证码</button>
      <span style="font-size:12px;color:var(--faint)">验证码 5 分钟内有效</span>
    </div></div>
    <div class="step" id="wipe-step2" style="display:none"><div class="step-num">2</div><div style="flex:1">
      <div class="code-display" id="wipe-code"></div>
      <div class="form-inline" style="margin-top:6px">
        <input id="wipe-input" placeholder="输入上方 6 位验证码" maxlength="6" style="width:200px;font-family:monospace;letter-spacing:4px;text-transform:uppercase">
        <button class="btn btn-danger" id="wipe-exec-btn" onclick="wipeExecute()" disabled>请等待 10 秒…</button>
      </div>
    </div></div>
  </div>
</div>
</div>

<!-- 用户设置弹窗 -->
<div id="settingsModal" class="modal">
<div class="modal-content">
  <h3>用户设置 · <span id="modal-username"></span></h3>
  <input type="hidden" id="modal-user-id">
  <label>全局角色</label>
  <select id="modal-role">
    <option value="user">普通用户</option>
    <option value="admin">全局管理员</option>
  </select>
  <label>封禁时长 (分钟, 0=永久)</label>
  <input type="number" id="modal-ban-duration" value="0" min="0">
  <div class="modal-actions">
    <button class="btn btn-success" onclick="saveSettings()">保存设置</button>
    <button class="btn btn-danger" onclick="banFromModal()">封禁</button>
    <button class="btn btn-ghost" onclick="closeModal()">取消</button>
  </div>
</div>
</div>

<script>
// ===== 票据引导 =====
// 先用 HttpOnly Cookie（Path=/dashboard）换一枚 10 分钟的短期 API token，
// 存在页面内存里给下面的管理操作用 —— 修复了 TOKEN 固定为空导致所有按钮 401 的问题。
let TOKEN='';
let tokenReady=null;
function ensureToken(){
  if(!tokenReady){
    tokenReady=fetch('/dashboard/api/token',{method:'POST'})
      .then(r=>{if(!r.ok)throw new Error('token 获取失败');return r.json()})
      .then(d=>{TOKEN=d.token})
      .catch(e=>{tokenReady=null;throw e});
  }
  return tokenReady;
}
ensureToken().catch(()=>{});

async function api(url,method,body){
  await ensureToken();
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  return d;
}

// ===== 轻量 toast =====
function showToast(msg,type){
  const box=document.getElementById('toasts');
  const el=document.createElement('div');
  el.className='toast'+(type==='err'?' err':type==='ok'?' ok':'');
  el.textContent=msg;
  box.appendChild(el);
  setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300)},3600);
}

// ===== 公告 =====
async function publishAnn(){
  const title=document.getElementById('ann-title').value;
  const content=document.getElementById('ann-content').value;
  const is_pinned=document.getElementById('ann-pinned').value==='1';
  const delete_at=document.getElementById('ann-delete-at').value;
  if(!title||!content)return showToast('请填写标题和内容','err');
  try{await api('/api/admin/announcements','POST',{title,content,is_pinned,delete_at});showToast('公告已发布','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
async function deleteAnn(id){if(!confirm('确定删除该公告?'))return;try{await api('/api/admin/announcements/'+id,'DELETE');location.reload()}catch(e){showToast(e.message,'err')}}

// ===== 帖子 =====
async function deletePost(id){if(!confirm('确定删除该帖子?'))return;try{await api('/api/admin/posts/'+id,'DELETE');location.reload()}catch(e){showToast(e.message,'err')}}

// ===== 用户设置弹窗 =====
function showSettings(id,username,role,status){
  document.getElementById('modal-user-id').value=id;
  document.getElementById('modal-username').textContent=username;
  document.getElementById('modal-role').value=role;
  document.getElementById('modal-ban-duration').value=0;
  document.getElementById('settingsModal').classList.add('active');
}
function closeModal(){document.getElementById('settingsModal').classList.remove('active')}

async function saveSettings(){
  const id=document.getElementById('modal-user-id').value;
  const role=document.getElementById('modal-role').value;
  try{await api('/api/admin/users/'+id+'/role','PUT',{role});showToast('角色已更新','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
async function banFromModal(){
  const id=document.getElementById('modal-user-id').value;
  const duration=parseInt(document.getElementById('modal-ban-duration').value)||0;
  try{await api('/api/admin/users/'+id+'/ban','PUT',{banned:true,duration});showToast('已封禁','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()});

// ===== 数据库管理 =====
function fmtSize(n){
  if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';
  if(n>=1048576)return (n/1048576).toFixed(2)+' MB';
  if(n>=1024)return (n/1024).toFixed(1)+' KB';
  return n+' B';
}
async function dbApi(path,method,body){
  const r=await fetch('/dashboard/api/db'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  return d;
}
async function loadDbStatus(){
  try{
    const s=await dbApi('/status');
    document.getElementById('db-meta').innerHTML=
      '<div class="item"><div class="v">'+fmtSize(s.db_size)+'</div><div class="k">数据库大小</div></div>'+
      '<div class="item"><div class="v">'+s.total_rows+'</div><div class="k">总行数 / '+s.tables.length+' 张表</div></div>'+
      '<div class="item"><div class="v">'+s.backups+'</div><div class="k">备份份数</div></div>'+
      '<div class="item"><div class="v">'+fmtSize(s.upload_size||0)+'</div><div class="k">上传文件体积</div></div>';
  }catch(e){document.getElementById('db-meta').innerHTML='<div class="item"><div class="k">加载失败: '+e.message+'</div></div>'}
}
async function makeBackup(){
  try{const r=await dbApi('/backup','POST',{});showToast(r.message,'ok');loadBackups();loadDbStatus()}
  catch(e){showToast(e.message,'err')}
}
async function loadBackups(){
  const tb=document.getElementById('backup-rows');
  try{
    const r=await dbApi('/backups');
    if(!r.backups.length){tb.innerHTML='<tr><td colspan="4" style="color:var(--faint)">还没有备份</td></tr>';return}
    tb.innerHTML=r.backups.map(b=>
      '<tr><td style="font-family:monospace">'+b.name+'</td><td>'+fmtSize(b.size)+'</td>'+
      '<td>'+new Date(b.created_at).toLocaleString('zh-CN')+'</td>'+
      '<td><a class="btn btn-ghost btn-sm" href="/dashboard/api/db/backups/'+encodeURIComponent(b.name)+'/download">下载</a> '+
      '<button class="btn btn-danger btn-sm" onclick="delBackup(\\''+b.name+'\\')">删除</button></td></tr>').join('');
  }catch(e){tb.innerHTML='<tr><td colspan="4" style="color:var(--danger)">加载失败: '+e.message+'</td></tr>'}
}
async function delBackup(name){
  if(!confirm('确定删除备份 '+name+' ?'))return;
  try{await dbApi('/backups/'+encodeURIComponent(name),'DELETE');showToast('已删除','ok');loadBackups();loadDbStatus()}
  catch(e){showToast(e.message,'err')}
}

// ===== IP 白名单 =====
let wlEntries=[];
async function loadWhitelist(){
  try{
    const r=await dbApi('/whitelist');
    wlEntries=r.entries||[];
    document.getElementById('wl-mode').value=r.mode;
    document.getElementById('wl-myip').textContent=r.current_ip||'未知';
    document.getElementById('wl-env').textContent=r.env_entries&&r.env_entries.length?('环境变量条目: '+r.env_entries.join(', ')):'（环境变量 ADMIN_IP_WHITELIST 未配置）';
    renderWlTags();
  }catch(e){showToast('白名单加载失败: '+e.message,'err')}
}
function renderWlTags(){
  document.getElementById('wl-tags').innerHTML=wlEntries.map((e,i)=>
    '<span class="wl-tag">'+e+'<button title="移除" onclick="removeWlEntry('+i+')">×</button></span>').join('')||'';
}
function addWlEntry(){
  const inp=document.getElementById('wl-input');
  const v=inp.value.trim();
  if(!v)return;
  if(!/^[0-9a-fA-F.:*]{1,45}$/.test(v))return showToast('条目只能包含 IP 字符与 *','err');
  if(wlEntries.includes(v))return showToast('条目已存在','err');
  wlEntries.push(v);inp.value='';renderWlTags();
}
function removeWlEntry(i){wlEntries.splice(i,1);renderWlTags()}
async function saveWhitelist(){
  try{
    const mode=document.getElementById('wl-mode').value;
    const r=await dbApi('/whitelist','PUT',{mode,entries:wlEntries});
    showToast(r.message,'ok');
  }catch(e){showToast(e.message,'err')}
}

// ===== 一键删库 =====
let wipeCode='',wipeTimer=null;
async function wipePrepare(){
  try{
    const r=await dbApi('/wipe/prepare','POST',{});
    wipeCode=r.code;
    document.getElementById('wipe-step2').style.display='flex';
    document.getElementById('wipe-code').textContent=r.code;
    document.getElementById('wipe-input').value='';
    startWipeCountdown(r.wait_seconds);
    showToast('验证码已生成，10 秒冷却后可执行','ok');
  }catch(e){showToast(e.message,'err')}
}
function startWipeCountdown(wait){
  const btn=document.getElementById('wipe-exec-btn');
  let remain=wait;
  btn.disabled=true;
  clearInterval(wipeTimer);
  wipeTimer=setInterval(()=>{
    remain--;
    if(remain<=0){clearInterval(wipeTimer);btn.disabled=false;btn.textContent='确认删库';}
    else{btn.textContent='请等待 '+remain+' 秒…';}
  },1000);
}
async function wipeExecute(){
  const code=document.getElementById('wipe-input').value.trim().toUpperCase();
  if(code!==wipeCode)return showToast('验证码不正确','err');
  if(!confirm('最后确认：将清空全部数据并自动备份，继续吗?'))return;
  const btn=document.getElementById('wipe-exec-btn');
  btn.disabled=true;
  try{
    const r=await dbApi('/wipe/execute','POST',{code});
    document.body.innerHTML='<div style="font-family:sans-serif;background:#0b0d1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="text-align:center"><h1 style="color:#3ddc84">已清空</h1><p style="color:rgba(255,255,255,.6)">'+r.message+'</p><p style="color:rgba(255,255,255,.4);font-size:13px">自动备份: '+r.backup.file+' ('+fmtSize(r.backup.size)+')</p><a href="/" style="color:#7c8cf8">返回首页</a></div></div>';
  }catch(e){
    btn.disabled=false;
    showToast(e.message,'err');
    if(e.message.indexOf('秒')>=0)startWipeCountdown(3);
  }
}

loadDbStatus();loadBackups();loadWhitelist();
</script></body></html>`);
});

module.exports = router;
