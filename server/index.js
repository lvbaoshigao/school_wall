const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { initDB, getWrapper, getSetting } = require('./db');
const { authRequired, SECRET } = require('./middleware/auth');
const { readPrefs } = require('./lib/prefs');
const visits = require('./lib/visits');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatars');
const IMAGE_DIR = path.join(UPLOADS_DIR, 'images');
const BUG_REPORT_IMAGE_DIR = path.join(UPLOADS_DIR, 'bug-reports');
[UPLOADS_DIR, AVATAR_DIR, IMAGE_DIR, BUG_REPORT_IMAGE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// 是否部署在我们自己掌控的反向代理（nginx / Cloudflare）之后。
// 只有为真时才允许从请求头取客户端 IP —— 否则任何人都能自己伪造
// CF-Connecting-IP，为每个请求换一个「IP」，限流形同虚设。
const BEHIND_PROXY = process.env.TRUST_PROXY === '1' || parseInt(process.env.TRUST_PROXY) > 0;

// 取真实客户端 IP。
// 直连时只认 socket 对端；在代理后按 CF-Connecting-IP → X-Forwarded-For 首项 → req.ip 的顺序。
// 这一步取错的后果不是「限流变松」而是「服务不可用」：若拿到的是代理自身的 IP，
// 全站所有用户会共用同一个计数桶，正常流量互相把对方挤成 429。
// Cloudflare 场景尤其隐蔽 —— 即使配了 trust proxy，req.ip 拿到的仍是
// Cloudflare 边缘节点 IP，几百个节点后面站着全部用户。
function clientIp(req) {
  if (BEHIND_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// 限流的计数 key。
//
// 只按 IP 计数在校园场景下会出事：整个校园网常常共用一个出口 IP（NAT），
// 全校学生会被算成同一个来源，额度瞬间被正常流量打满，互相把对方挤成 429。
// 因此带有效 token 的请求按用户 ID 计数，各自独立；匿名流量才退回按 IP。
// 伪造 token 拿不到独立额度 —— 验签不过就落回 IP 桶。
function rateKey(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), SECRET);
      if (payload?.id) return `u:${payload.id}`;
    } catch {}
  }
  return `ip:${clientIp(req)}`;
}

// 滑动窗口计数限流。
// 相比原先的「固定窗口 + 定时整体清零」：固定窗口在窗口边界可以打进两倍额度
// （窗口末尾打满 + 清零后立刻再打满），滑动窗口按时间加权继承上一窗口的计数，没有这个缺口。
// 每个 key 只存 3 个数字，内存 O(1)；并对 key 总数设上限，避免大量来源 IP 把 Map 撑大。
const RL_MAX_KEYS = 20000;

function createRateLimiter(windowMs, maxRequests, name = '') {
  const hits = new Map();

  // 定期清掉不活跃的 key，而不是把所有计数一起归零
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [k, v] of hits) if (v.last < cutoff) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return (req, res, next) => {
    const key = rateKey(req);
    const now = Date.now();
    const idx = Math.floor(now / windowMs);

    let e = hits.get(key);
    if (!e) {
      // Map 满了先强制清理一轮；仍然满则拒绝新 key 而不是无限增长
      if (hits.size >= RL_MAX_KEYS) {
        const cutoff = now - windowMs;
        for (const [k, v] of hits) if (v.last < cutoff) hits.delete(k);
        if (hits.size >= RL_MAX_KEYS) {
          res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
          return res.status(429).json({ error: '服务繁忙，请稍后再试' });
        }
      }
      e = { win: idx, cur: 0, prev: 0, last: now };
      hits.set(key, e);
    }

    if (idx === e.win + 1) { e.prev = e.cur; e.cur = 0; e.win = idx; }
    else if (idx !== e.win) { e.prev = 0; e.cur = 0; e.win = idx; }
    e.last = now;

    // 上一窗口的计数按剩余比例加权计入，得到平滑的速率估计
    const elapsed = (now % windowMs) / windowMs;
    const estimate = e.prev * (1 - elapsed) + e.cur;

    if (estimate >= maxRequests) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    e.cur++;
    next();
  };
}

async function main() {
  const db = await initDB();
  const app = express();
  // 默认会在每个响应上发 `X-Powered-By: Express`，白送框架指纹给扫描器。
  app.disable('x-powered-by');
  const PORT = process.env.PORT || 3000;
  // 监听地址。本机开发保持 0.0.0.0（局域网内其它设备可直接连）；
  // 部署在反向代理之后必须设成 127.0.0.1 —— 否则外部可以绕开代理直连本端口，
  // 代理层做的连接数限制、请求体上限、超时收紧就全都形同虚设。
  const HOST = process.env.HOST || '0.0.0.0';

  // 前端构建产物是否就位。这个判断必须在注册 `/` 之前做：
  // 服务状态页和 SPA 首页抢的是同一条路径，先注册的永远赢，
  // 而 express.static 在文件末尾才挂 —— 结果部署后打开站点根路径
  // 看到的是「后端服务运行中」占位页，页面上的「打开校园墙」又指回 `/`，原地打转。
  const distPath = path.join(__dirname, '../client/dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));

  // CORS。原先是无参数的 cors()，等于 Access-Control-Allow-Origin: *，
  // 任意站点都能让访客的浏览器代为调用本站 API —— 配合免登录端点可以借校内
  // 访客的浏览器把数据捞出去。前端与后端同源（都经 nginx 出去），正常使用
  // 根本不需要 CORS，所以默认一条都不放行，只在显式配置或开发模式下开口子。
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== 'production') {
    // vite dev server 与本机联调
    allowedOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }
  app.use(cors({
    origin(origin, cb) {
      // 同源请求不带 Origin 头；这类请求直接放行，且不会回 CORS 头
      if (!origin) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }));
  app.use(compression({ threshold: 1024 }));
  // 只有上传接口需要大 body（2MB 图片经 base64 后约 2.7MB）。
  // 先给这两条路径挂大额度的解析器，body-parser 解析过后会置 req._body，
  // 后面的全局解析器会自动跳过，于是其余接口的上限收到 128KB ——
  // 否则任意一个端点都能收 5MB 并触发一次同步 JSON.parse。
  app.use(['/api/upload/image', '/api/avatar/upload', '/api/auth/avatar', '/api/upload/bug-image'], express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '128kb' }));
  // body-parser 的 PayloadTooLargeError（EntityTooLarge）默认走 express 兜底返回 HTML，
  // 而不是 JSON。上传类接口单独挂 5mb 解析器，其余接口的 128KB 上限本来就该
  // 返回 413 而非 500 —— 这里把该错误统一转成 JSON 响应，同时不影响真实服务错误。
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({ error: '请求体过大' });
      return;
    }
    next(err);
  });
  // 安全修复：默认不信任代理头，防止伪造 X-Forwarded-For 绕过限流/伪造 IP。
  // 若部署在反向代理后，设置环境变量 TRUST_PROXY=1（或具体跳数）。
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : (parseInt(process.env.TRUST_PROXY) || false));

  // 读请求便宜，额度给宽松些：单页加载会并发若干请求，未读轮询还在后台跑，
  // 卡太紧会误伤正常浏览。真正的成本集中在写操作上，由 writeLimiter 单独收紧。
  const apiLimiter = createRateLimiter(60000, 300, 'api');
  const authLimiter = createRateLimiter(60000, 20, 'auth');
  const uploadLimiter = createRateLimiter(60000, 10, 'upload');
  const setupLimiter = createRateLimiter(300000, 5, 'setup'); // 建墙设置接口限流：5分钟内最多5次
  // 写操作单独一档更严的限流：读请求便宜，写请求会触发落盘与索引更新，
  // 正常用户发帖/点赞远达不到 40 次/分钟，攻击者靠它拖慢服务却绰绰有余。
  const writeLimiter = createRateLimiter(60000, 40, 'write');

  app.use((req, res, next) => {
    req.db = db;
    const origEnd = res.end;
    res.end = function(...args) {
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode < 400) {
        // 只置脏标记（O(1)），真正落盘由 db.js 里的定时器合并执行。
        // 这里原先是直接全库 export + 同步写盘，把每个写请求都变成了
        // 一次与数据量成正比的阻塞操作。
        try { getWrapper()?.markDirty(); } catch {}
      }
      origEnd.apply(this, args);
    };
    next();
  });

  // 根路由 - 显示服务状态（仅在没有前端构建产物时；有 dist 时这条路径归 SPA）
  if (!hasDist) app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>校园墙服务</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0f0f23;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px;text-align:center;max-width:500px}
h1{font-size:28px;margin-bottom:16px}
p{color:rgba(255,255,255,0.7);margin:8px 0}
a{color:#a8b8ff;text-decoration:none}
a:hover{text-decoration:underline}
.btn{display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:12px 24px;border-radius:10px;margin:16px 8px 0;text-decoration:none;font-weight:600}
.btn:hover{opacity:0.9;text-decoration:none}
</style></head><body>
<div class="card">
  <h1>校园墙</h1>
  <p>后端服务运行中</p>
  <p>API地址: <code>http://localhost:${PORT}/api</code></p>
  <a class="btn" href="/">打开校园墙</a>
  <a class="btn" href="/dashboard">管理后台</a>
</div>
</body></html>`);
  });

  // 首次设置：挂在 /api 全局限流之前，它有自己的 setupLimiter
  app.use('/api/setup', require('./routes/setup')(setupLimiter));

  // ===== API路由 =====
  app.use('/api', apiLimiter, (req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 访问统计。复用限流那套 key（登录后按用户 ID，未登录才按 IP），
    // 校园网整栋楼共用出口 IP，只按 IP 会把一群人算成一个。
    // 统计接口自身不计入，否则前端每分钟轮询一次会把自己刷进去。
    if (req.path !== '/stats/visits') {
      try { visits.track(rateKey(req)); } catch {}
    }
    next();
  });
  // 写操作再过一道更严的限流
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return writeLimiter(req, res, next);
    next();
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth', require('./routes/auth'));
  // 超管段（建墙申请审批 / 所有墙管理）单独一个文件。
  // 必须挂在 walls 之前：它的路径都是 /admin/... 两段以上，
  // 与 walls.js 的 /:id 不冲突，但顺序写在前面语义更清楚。
  app.use('/api/walls', require('./routes/wallAdmin'));
  app.use('/api/walls', require('./routes/walls'));
  app.use('/api/posts', require('./routes/posts'));
  app.use('/api/messages', require('./routes/messages'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/votes', require('./routes/votes'));
  app.use('/api/friends', require('./routes/friends'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/bug-reports', require('./routes/bugReports'));
  app.use('/api/permissions', require('./routes/permissions'));

  // ===== 头像文件存储 =====
  app.use('/uploads', express.static(UPLOADS_DIR, {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    immutable: true,
  }));

  app.use('/api', require('./routes/uploads')(uploadLimiter, { AVATAR_DIR, IMAGE_DIR, BUG_REPORT_IMAGE_DIR }));

  // ===== 轻量未读计数 =====
  app.get('/api/messages/unread-count', authRequired, (req, res) => {
    // 顶栏红点计入哪些类型由用户偏好决定；私信与树洞始终计入（它们是点对点对话）
    const prefs = readPrefs(req.db, req.user.id);
    const badgeTypes = [];
    if (prefs.badge_interaction) badgeTypes.push('interaction');
    if (prefs.badge_announcement) badgeTypes.push('announcement');
    if (prefs.badge_system) badgeTypes.push('system', 'role_application');
    if (prefs.badge_report) badgeTypes.push('report_notification');

    const chatRow = req.db.prepare(
      "SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND is_read = 0 AND type = 'private'"
    ).get(req.user.id);
    const treeHoleRow = req.db.prepare(
      "SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND is_read = 0 AND type = 'tree_hole'"
    ).get(req.user.id);

    let sys = 0;
    if (badgeTypes.length) {
      const holes = badgeTypes.map(() => '?').join(',');
      const sysRow = req.db.prepare(
        `SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND is_read = 0 AND type IN (${holes})`
      ).get(req.user.id, ...badgeTypes);
      sys = sysRow?.c || 0;
    }

    res.json({
      count: sys + (chatRow?.c || 0) + (treeHoleRow?.c || 0),
      chat: chatRow?.c || 0,
      treeHole: treeHoleRow?.c || 0,
      system: sys,
      announcement: (req.db.prepare(
        "SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND is_read = 0 AND type = 'announcement'"
      ).get(req.user.id)?.c || 0),
    });
  });

  // 壁纸
  const relePath = path.join(__dirname, '../rele');
  if (fs.existsSync(relePath)) {
    app.use('/rele', express.static(relePath, {
      maxAge: '30d',
      etag: true,
      lastModified: true,
      immutable: true,
    }));
  }

  app.get('/api/wallpaper', (req, res) => {
    try {
      if (!fs.existsSync(relePath)) return res.json({ file: null, url: null, total: 0 });
      const files = fs.readdirSync(relePath).filter(f => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f));
      if (!files.length) return res.json({ file: null, url: null, total: 0 });
      const f = files[Math.floor(Math.random() * files.length)];
      res.json({ file: f, url: `/rele/${f}`, total: files.length });
    } catch { res.json({ file: null, url: null, total: 0 }); }
  });

  // 近一小时访问量（内存统计，重启清零）
  app.get('/api/stats/visits', authRequired, (req, res) => {
    res.json(visits.stats());
  });

  app.use('/api/announcements', require('./routes/announcements'));

  app.use('/api/users', require('./routes/users'));

  // 运行看板（/api/dashboard/session 换票据 + /dashboard 页面）
  app.use('/', require('./dashboard'));

  // 前端静态文件
  if (hasDist) {
    app.use(express.static(distPath, {
      maxAge: '7d',
      etag: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/dashboard') && !req.path.startsWith('/uploads')) {
        return res.sendFile(path.join(distPath, 'index.html'));
      }
      // 走到这里说明是没有任何路由匹配的 /api、/dashboard、/uploads 路径。
      // 原先这里既不响应也不 next()，连接就一直挂着直到客户端自己超时 ——
      // 请求方看到的是「卡住」而不是 404，而且任何人都能靠批量打不存在的
      // /api/xxx 把连接数占满。必须显式收尾。
      res.status(404).json({ error: '接口不存在' });
    });
  }

  // 全局错误处理
  app.use((err, req, res, next) => {
    console.error('[Error]', err.message || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  const server = app.listen(PORT, HOST, () => {
    const initialized = getSetting(db, 'initialized', '0') === '1';
    console.log('');
    console.log('========================================');
    console.log('   School Wall Server Started');
    console.log('========================================');
    console.log('  Listen:     ' + HOST + ':' + PORT + (HOST === '127.0.0.1' ? '（仅回环，经反向代理对外）' : ''));
    console.log('  Backend:    http://localhost:' + PORT);
    console.log('  Dashboard:  http://localhost:' + PORT + '/dashboard');
    console.log('  Status:     ' + (initialized ? '已初始化' : '未初始化（请通过前端完成首次设置）'));
    console.log('========================================');
    console.log('');
  });

  // 慢速连接防护。Node 的默认值对 slowloris 很宽容：headersTimeout 60 秒，
  // 攻击者每 59 秒发一个字节就能长期占住一条连接，几百条就能耗尽事件循环的处理能力。
  // 真正的第一道防线在 nginx（client_header_timeout / client_body_timeout），
  // 这里是纵深防御 —— 万一直连到本端口，也不至于被拖住。
  //
  // keepAliveTimeout 必须大于上游 nginx 的 keepalive 空闲时间（那边设 60s），
  // 否则会撞上经典竞态：node 刚关掉空闲连接，nginx 正好复用它发请求，用户看到 502。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;   // 需 > keepAliveTimeout
  server.requestTimeout = 120000;  // 单个请求收完的上限（含大图上传）

  // 优雅关闭
  // 退出路径一律用 saveNow()：wrapper.save() 的语义是 markDirty()（延后 2 秒由定时器落盘），
  // 在马上要 process.exit 的地方调它等于什么都没做，改动会随进程一起消失。
  function gracefulShutdown(signal) {
    console.log(`\n[${signal}] 正在关闭服务...`);
    server.close(() => {
      try { getWrapper()?.saveNow(); console.log('[DB] 数据库已保存'); } catch (e) { console.error('[DB] 退出落盘失败:', e.message); }
      console.log('[Server] 已关闭');
      process.exit(0);
    });
    // 在途请求迟迟不结束时的兜底，同样要真的落盘再退
    setTimeout(() => {
      try { getWrapper()?.saveNow(); } catch {}
      process.exit(1);
    }, 5000);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    // 抢救一次落盘后必须退出。Node 官方对此有明确要求：未捕获异常之后
    // 进程状态已不可信，继续对外提供服务可能把坏数据写进库里。
    // systemd 配的是 Restart=on-failure，退出后 3 秒会被拉起。
    try { getWrapper()?.saveNow(); } catch {}
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
