const express = require('express');
const jwt = require('jsonwebtoken');
const { hashPassword } = require('../lib/password');
const { getSetting, setSetting } = require('../db');
// SECRET 必须从认证模块取同一份：原来这里既没 require jwt 也没 require SECRET，
// 初始化成功路径走到 jwt.sign 必然抛 ReferenceError，首次部署永远 500。
const { SECRET } = require('../middleware/auth');

// 首次设置。挂载在 /api 全局限流之前 —— 它有自己更严的 setupLimiter，
// 且系统未初始化时这是唯一可用的入口，不该和普通 API 共用额度。
module.exports = (setupLimiter) => {
  const router = express.Router();

  // ===== 首次设置 API（无需登录） =====
  router.get('/status', (req, res) => {
    const initialized = req.db ? getSetting(req.db, 'initialized', '0') === '1' : false;
    const userCount = req.db ? req.db.prepare('SELECT COUNT(*) as c FROM users').get().c : 0;
    res.json({ initialized, userCount });
  });

  router.post('/', setupLimiter, (req, res) => { Promise.resolve().then(async () => {
    // 已初始化则拒绝
    if (getSetting(req.db, 'initialized', '0') === '1') {
      return res.status(400).json({ error: '系统已初始化，不能重复设置' });
    }

    const { username, password, nickname, wall_name, wall_description } = req.body;

    // 校验超级管理员字段
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: '用户名长度3-20个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

    // 校验第一个校园墙
    const wallName = (wall_name || '').trim();
    if (!wallName || wallName.length < 2 || wallName.length > 30) {
      return res.status(400).json({ error: '校园墙名称长度2-30个字符' });
    }

    // 原子化检查+创建：用事务防止并发竞态
    // 锁通过 sql.js 的 db.run('BEGIN') 实现，由于 js 是单线程，BEGIN/COMMIT
    // 之间不会有其它请求插入，但 Promise 的 await 会释放事件循环，所以 hashPassword
    // 必须在事务外完成
    try {
      // 先检查再插入
      if (req.db.prepare("SELECT COUNT(*) as c FROM users").get().c > 0) {
        return res.status(400).json({ error: '系统中已有用户，不能通过此接口设置' });
      }

      const hash = await hashPassword(password);
      // userId 必须提升到事务块之外：下方 jwt.sign 在事务 try 块外引用它，
      // 原先 const 声明在事务块内部，初始化必在最后一步抛 ReferenceError 回滚成 500。
      let userId = 0;
      let wallId = 0; // 同 userId：res.json 在事务块外引用它，必须提升作用域
      req.db.db.run('BEGIN');
      try {
        // 事务内再检查一次（理论不需要，但防御性编程）
        if (req.db.prepare("SELECT COUNT(*) as c FROM users").get().c > 0) {
          req.db.db.run('ROLLBACK');
          return res.status(400).json({ error: '系统中已有用户，不能通过此接口设置' });
        }

        // 创建超级管理员
        const userResult = req.db.prepare(`
          INSERT INTO users (username, password_hash, nickname, role, status)
          VALUES (?, ?, ?, 'super_admin', 'active')
        `).run(username, hash, nickname || username);
        userId = userResult.lastInsertRowid;

        // 创建第一个校园墙
        const wallResult = req.db.prepare(`
          INSERT INTO walls (name, description, owner_id, status, require_join_approval)
          VALUES (?, ?, ?, 'active', 1)
        `        ).run(wallName, (wall_description || '').trim(), userId);
        wallId = wallResult.lastInsertRowid;

        // 超级管理员同时成为该墙的墙主
        req.db.prepare(`
          INSERT INTO wall_members (wall_id, user_id, wall_role, status)
          VALUES (?, ?, 'owner', 'active')
        `).run(wallId, userId);

        req.db.db.run('COMMIT');
      } catch (e) {
        req.db.db.run('ROLLBACK');
        throw e;
      }

      // 标记已初始化。首次设置必须确保落盘，这里走同步写而不是脏标记
      setSetting(req.db, 'initialized', '1');
      req.db.saveNow();

      // 签发 token 自动登录
      const token = jwt.sign({ id: userId, username, role: 'super_admin' }, SECRET, { expiresIn: '7d' });

      res.json({
        message: '初始化完成！',
        token,
        user: { id: userId, username, nickname: nickname || username, role: 'super_admin' },
        wall: { id: wallId, name: wallName },
      });
    } catch (e) {
      // 只把异常写日志，不回显 e.message —— 它可能包含 SQL 片段与磁盘路径
      console.error('[Setup] 初始化失败:', e.message);
      res.status(500).json({ error: '初始化失败，请查看服务端日志' });
    }
  }).catch(e => {
    console.error('[Setup] 未捕获错误:', e.message);
    if (!res.headersSent) res.status(500).json({ error: '初始化失败' });
  }); });

  return router;
};
