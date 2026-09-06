const express = require('express');
const jwt = require('jsonwebtoken');
const { authRequired, requirePerm, SECRET } = require('../middleware/auth');
const { userCan } = require('../lib/permissions');

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
    const payload = jwt.verify(token, SECRET);
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
<title>管理后台 - 表白墙</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f23;color:#e0e0e0}
.header{background:linear-gradient(135deg,#1a1a3e,#2d1b69);padding:20px 32px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.1)}
.header h1{font-size:22px;color:#fff}
.header a{color:#a8b8ff;text-decoration:none;font-size:14px}
.container{max-width:1200px;margin:0 auto;padding:24px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.stat-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;text-align:center}
.stat-icon{font-size:28px;margin-bottom:8px}
.stat-value{font-size:32px;font-weight:700;color:#fff}
.stat-label{font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px}
.section{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px}
.section h2{font-size:18px;margin-bottom:16px;color:#fff}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px}
th{color:rgba(255,255,255,0.5);font-weight:600;font-size:12px;text-transform:uppercase}
tr:hover{background:rgba(255,255,255,0.03)}
.role-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px}
.role-super_admin{background:rgba(255,215,0,0.2);color:#ffd700}
.role-admin{background:rgba(102,126,234,0.2);color:#a8b8ff}
.role-member{background:rgba(46,213,115,0.2);color:#b8ffb8}
.status-banned{color:#ff6b6b}
.btn{display:inline-block;padding:6px 14px;border:none;border-radius:6px;font-size:12px;cursor:pointer;color:#fff;text-decoration:none;margin:2px}
.btn-danger{background:#ff6b6b}.btn-primary{background:#667eea}.btn-success{background:#2ed573}.btn-sm{padding:4px 10px;font-size:11px}
.btn:hover{opacity:0.85}
.truncate{max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.form-inline{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.form-inline input,.form-inline textarea,.form-inline select{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 12px;color:#fff;font-size:14px}
.form-inline textarea{resize:vertical;min-height:60px}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;justify-content:center;align-items:center}
.modal.active{display:flex}
.modal-content{background:#1a1a3e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px;max-width:500px;width:90%}
.modal-content h3{margin-bottom:16px}
.modal-content label{display:block;margin-bottom:4px;font-size:13px;color:rgba(255,255,255,0.7)}
.modal-content input,.modal-content textarea,.modal-content select{width:100%;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 12px;color:#fff;font-size:14px;margin-bottom:12px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
</style></head><body>
<div class="header">
<h1>表白墙管理后台</h1>
<div><span style="color:rgba(255,255,255,0.6);margin-right:16px">${req.user.username} (${roleLabel(req.user.role)})</span><a href="/">← 返回首页</a></div>
</div>
<div class="container">
<div class="stats-grid">
  <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">总用户 (活跃${activeUsers} / 封禁${bannedUsers})</div></div>
  <div class="stat-card"><div class="stat-value">${totalPosts}</div><div class="stat-label">总帖子 (今日${todayPosts})</div></div>
  <div class="stat-card"><div class="stat-value">${totalComments}</div><div class="stat-label">总评论</div></div>
  <div class="stat-card"><div class="stat-value">${totalMessages}</div><div class="stat-label">总消息</div></div>
  <div class="stat-card"><div class="stat-icon">🆕</div><div class="stat-value">${todayUsers}</div><div class="stat-label">今日新用户</div></div>
</div>

<div class="section">
  <h2>公告管理</h2>
  <div class="form-inline">
    <input id="ann-title" placeholder="公告标题" style="flex:1">
    <select id="ann-pinned"><option value="0">普通</option><option value="1">置顶</option></select>
  </div>
  <div class="form-inline">
    <textarea id="ann-content" placeholder="公告内容..." style="flex:1"></textarea>
  </div>
  <div class="form-inline">
    <label style="display:flex;align-items:center;gap:4px;font-size:13px;color:rgba(255,255,255,0.7)">定时删除: <input id="ann-delete-at" type="datetime-local" style="width:auto"></label>
    <button class="btn btn-primary" onclick="publishAnn()">发布公告</button>
  </div>
  <table><thead><tr><th>ID</th><th>标题</th><th>置顶</th><th>定时删除</th><th>发布时间</th><th>操作</th></tr></thead>
  <tbody>${announcements.map(a=>`<tr>
    <td>${a.id}</td><td>${esc(a.title)}</td>
    <td>${a.is_pinned?'是':'否'}</td>
    <td>${esc(a.delete_at)||'-'}</td>
    <td>${new Date(a.created_at).toLocaleString('zh-CN')}</td>
    <td><button class="btn btn-danger btn-sm" onclick="deleteAnn(${a.id})">删除</button></td>
  </tr>`).join('')}
  </tbody></table>
</div>

<div class="section">
  <h2>用户管理</h2>
  <table><thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>真实姓名</th><th>角色</th><th>状态</th><th>封禁截止</th><th>操作</th></tr></thead>
  <tbody>${allUsers.map(u=>`<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.nickname)||'-'}</td><td>${esc(u.real_name)||'-'}</td>
    <td><span class="role-badge role-${u.role}">${roleLabel(u.role)}</span></td>
    <td>${u.status==='banned'?'<span class="status-banned">封禁</span>':'正常'}</td>
    <td>${esc(u.ban_until)||'-'}</td>
    <td>${u.role!=='super_admin'?`
      <button class="btn btn-primary btn-sm" onclick="showSettings(${u.id},'${escJs(u.username)}','${escJs(u.role)}','${escJs(u.status)}')">设置</button>
    `:'<span style="color:rgba(255,255,255,0.4)">超级管理员</span>'}</td></tr>`).join('')}
  </tbody></table>
</div>

<div class="section">
  <h2>话题分类管理</h2>
  <div id="categories-list" style="color:rgba(255,255,255,0.5)">话题分类现按各校园墙独立管理，请在对应校园墙的管理后台操作。</div>
</div>

<div class="section">
  <h2>最近帖子</h2>
  <table><thead><tr><th>ID</th><th>内容</th><th>分类</th><th>作者</th><th>点赞</th><th>评论</th><th>时间</th><th>操作</th></tr></thead>
  <tbody>${recentPosts.map(p=>`<tr><td>${p.id}</td><td class="truncate">${esc(p.content)}</td>
    <td>${esc(p.category)||'-'}</td>
    <td>${p.is_anonymous?'<span style="color:#636e72">匿名</span>':esc(p.author||'-')}</td>
    <td>${p.like_count}</td><td>${p.comment_count}</td>
    <td>${new Date(p.created_at).toLocaleString('zh-CN')}</td>
    <td><button class="btn btn-danger btn-sm" onclick="deletePost(${p.id})">删除</button></td></tr>`).join('')}
  </tbody></table>
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
    <button class="btn" style="background:rgba(255,255,255,0.1)" onclick="closeModal()">取消</button>
  </div>
</div>
</div>

<script>
const TOKEN='${req.query.token||''}';
const auth={headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN}};

async function api(url,method,body){
const opts={method,headers:auth.headers};
if(body)opts.body=JSON.stringify(body);
const r=await fetch(url,opts);return r.json();
}

// 公告
async function publishAnn(){
const title=document.getElementById('ann-title').value;
const content=document.getElementById('ann-content').value;
const is_pinned=document.getElementById('ann-pinned').value==='1';
const delete_at=document.getElementById('ann-delete-at').value;
if(!title||!content)return alert('请填写标题和内容');
await api('/api/admin/announcements','POST',{title,content,is_pinned,delete_at});
alert('公告已发布');location.reload();
}
async function deleteAnn(id){if(!confirm('确定删除?'))return;await api('/api/admin/announcements/'+id,'DELETE');location.reload()}

// 帖子
async function deletePost(id){if(!confirm('确定删除帖子?'))return;await api('/api/admin/posts/'+id,'DELETE');location.reload()}

// 用户设置弹窗
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
await api('/api/admin/users/'+id+'/role','PUT',{role});
alert('角色已更新');location.reload();
}
async function banFromModal(){
const id=document.getElementById('modal-user-id').value;
const duration=parseInt(document.getElementById('modal-ban-duration').value)||0;
await api('/api/admin/users/'+id+'/ban','PUT',{banned:true,duration});
alert('已封禁');location.reload();
}
// 点击弹窗外部关闭
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()});
</script></body></html>`);
});

module.exports = router;
