const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');

class DatabaseWrapper {
  constructor(sqlDb) { this.db = sqlDb; this.dirty = false; }
  exec(sql) { this.db.run(sql); }
  prepare(sql) {
    const db = this.db;
    return {
      get(...params) {
        const stmt = db.prepare(sql);
        try {
          if (params.length > 0) stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            return row;
          }
          return undefined;
        } finally { stmt.free(); }
      },
      all(...params) {
        const stmt = db.prepare(sql);
        const rows = [];
        try {
          if (params.length > 0) stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            rows.push(row);
          }
          return rows;
        } finally { stmt.free(); }
      },
      run(...params) {
        db.run(sql, params);
        const info = db.exec('SELECT last_insert_rowid() as id, changes() as changes');
        return { lastInsertRowid: info[0]?.values[0][0] || 0, changes: info[0]?.values[0][1] || 0 };
      }
    };
  }
  pragma(str) { this.db.run(`PRAGMA ${str}`); }

  // 标记「有未落盘的改动」。这是写请求路径上唯一该调的方法 —— 它是 O(1) 的。
  //
  // 背景：sql.js 没有增量写盘能力，落盘只能 export() 整个数据库再整体覆盖，
  // 代价随数据量线性增长（实测 12.5MB 的库约 25ms），而且是同步调用，
  // 这期间整个事件循环冻结。原先每个成功的写请求都直接落盘，等于让
  // 「点一次赞」这种最廉价的操作背上全库序列化的成本，写放大约 5 万倍：
  // 单个用户以 40 次/秒点赞就能让全站请求排队。
  // 改为置脏标记 + 由 startAutoSave 按固定间隔合并落盘后，写请求的边际成本归零，
  // 代价是崩溃时最多丢 FLUSH_INTERVAL 内的改动（见下方常量）。
  markDirty() { this.dirty = true; }

  // 强制立即落盘。仅用于初始化完成、进程退出这类必须确保持久化的时刻。
  saveNow() {
    if (!this.db) return;
    // 先写临时文件再 rename：rename 在同一文件系统上是原子的。
    // 原先直接覆盖 data.db，一旦在写入中途崩溃或磁盘写满，
    // 唯一的数据文件就会变成半截的损坏文件。
    const tmp = DB_PATH + '.tmp';
    try {
      // 明确指定 0600。临时文件是新建的，不指定就套用进程 umask（通常给出 644），
      // 而 rename 之后这个权限就成了 data.db 的权限 —— 于是每次落盘都会把
      // 事先 chmod 过的权限冲掉，库里的口令哈希对同机其它用户
      //（比如跑 nginx 的 www-data）重新变成可读。
      fs.writeFileSync(tmp, Buffer.from(this.db.export()), { mode: 0o600 });
      // writeFileSync 的 mode 只在新建文件时生效，上次崩溃残留的 .tmp 会沿用旧权限，补一次
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, DB_PATH);
      this.dirty = false;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  // 兼容旧调用点：语义已从「立刻落盘」改为「稍后落盘」
  save() { this.markDirty(); }
}

let wrapper = null;
let flushTimer = null;

// 合并落盘间隔。崩溃时的最大数据丢失窗口就是这个值。
// 2 秒是个折中：持续写入时落盘开销占比约 1%（12.5MB 的库 25ms / 2000ms），
// 同时丢失窗口短到用户几乎不可能察觉。
const FLUSH_INTERVAL = 2000;

function flushIfDirty() {
  if (!wrapper || !wrapper.dirty) return;
  try {
    wrapper.saveNow();
  } catch (e) {
    // 落盘失败（磁盘满、权限等）不能让进程挂掉，但必须可见 —— 内存里的数据仍是完整的
    console.error('[DB] 落盘失败:', e.message);
  }
}

function startAutoSave() {
  flushTimer = setInterval(flushIfDirty, FLUSH_INTERVAL);
  // 不因为这个定时器而阻止进程退出
  if (flushTimer.unref) flushTimer.unref();

  // 退出前把未落盘的改动写下去，否则最后 2 秒的数据会丢。
  //
  // 这里刻意不再注册 SIGINT/SIGTERM：本模块在 main() 一开始的 initDB() 里就完成注册，
  // 早于 index.js 的 gracefulShutdown。而旧实现是同步 process.exit(0)，
  // 于是 index.js 的 server.close() 永远等不到回调 —— 所谓优雅关闭从来没生效过，
  // 在途请求会被直接掐断。信号处理统一交给 index.js，它会先关监听再落盘。
  // beforeExit 保留：给 adduser.js 这类不经过 index.js 的脚本兜底。
  process.on('beforeExit', () => flushIfDirty());
}

function getSetting(db, key, defaultVal = '') {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? row.value : defaultVal;
  } catch { return defaultVal; }
}

function setSetting(db, key, value) {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").run(key, String(value));
  } catch (e) {}
}

// 是否清空重建。默认 false：保留旧数据，通过 migrateSchema 自动补齐新版本所需的表与列。
// 旧版本升级导入时无需手工删库，重启即自动适配；确需重建时设置 KEEP_DB=0。
const REBUILD = process.env.KEEP_DB === '0';

async function initDB() {
  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH) && !REBUILD) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    if (fs.existsSync(DB_PATH) && REBUILD) {
      try {
        const bak = DB_PATH + '.bak_' + Date.now();
        fs.copyFileSync(DB_PATH, bak);
        fs.chmodSync(bak, 0o600);
        console.log('[DB] 旧数据库已备份到 ' + path.basename(bak));
      } catch {}
      try { fs.unlinkSync(DB_PATH); } catch {}
    }
    sqlDb = new SQL.Database();
  }
  wrapper = new DatabaseWrapper(sqlDb);
  wrapper.pragma('foreign_keys = ON');

  wrapper.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      real_name TEXT DEFAULT '',
      show_real_name INTEGER DEFAULT 0,
      avatar TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      gender TEXT DEFAULT '',
      contact_qq TEXT DEFAULT '',
      contact_wechat TEXT DEFAULT '',
      contact_weibo TEXT DEFAULT '',
      contact_bilibili TEXT DEFAULT '',
      show_contact INTEGER DEFAULT 0,
      class_number INTEGER DEFAULT 0,
      is_graduate INTEGER DEFAULT 0,
      graduation_year INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      ban_until TEXT DEFAULT '',
      ban_reason TEXT DEFAULT '',
      ban_level TEXT DEFAULT 'login',
      -- 搜索与发现隐私开关（1=允许）
      allow_search_by_id INTEGER DEFAULT 1,
      allow_search_by_username INTEGER DEFAULT 1,
      allow_search_by_nickname INTEGER DEFAULT 1,
      allow_search_by_real_name INTEGER DEFAULT 0,
      allow_discover INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- ===== 校园墙（多租户核心） =====
    CREATE TABLE IF NOT EXISTS walls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER,
      status TEXT DEFAULT 'active',
      require_join_approval INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    -- 墙成员关系 + 墙内角色。wall_role: owner|admin|tree_hole|member  status: pending|active
    CREATE TABLE IF NOT EXISTS wall_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      wall_role TEXT DEFAULT 'member',
      -- 'pending' | 'active' | 'banned'
      status TEXT DEFAULT 'pending',
      wall_ban_until TEXT DEFAULT '',
      wall_ban_reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(wall_id, user_id)
    );
    -- 封禁审计日志（全局与墙内共用）
    CREATE TABLE IF NOT EXISTS ban_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,              -- 'global' | 'wall'
      wall_id INTEGER DEFAULT 0,        -- scope='wall' 时有效
      target_user_id INTEGER NOT NULL,
      operator_id INTEGER,              -- NULL 表示系统自动
      action TEXT NOT NULL,             -- 'ban' | 'unban'
      duration_minutes INTEGER DEFAULT 0, -- 0=永久
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    -- 建墙申请（发给超级管理员审批）
    CREATE TABLE IF NOT EXISTS wall_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER NOT NULL,
      wall_name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      reviewer_id INTEGER,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      reviewed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT '分享',
      is_anonymous INTEGER DEFAULT 0,
      author_id INTEGER,
      author_ip TEXT NOT NULL,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      is_markdown INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      author_ip TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER,
      receiver_id INTEGER NOT NULL,
      wall_id INTEGER DEFAULT 0,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      content TEXT NOT NULL,
      is_anonymous INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      conversation_id TEXT DEFAULT '',
      assignee_id INTEGER DEFAULT 0,
      reply_to_id INTEGER DEFAULT 0,
      reply_to_content TEXT DEFAULT '',
      is_revoked INTEGER DEFAULT 0,
      link TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      is_pinned INTEGER DEFAULT 0,
      is_markdown INTEGER DEFAULT 0,
      delete_at TEXT DEFAULT '',
      scope TEXT DEFAULT 'wall',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      author_id INTEGER,
      is_anonymous INTEGER DEFAULT 0,
      author_ip TEXT NOT NULL,
      end_at TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS vote_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      option_text TEXT NOT NULL,
      vote_count INTEGER DEFAULT 0,
      FOREIGN KEY (vote_id) REFERENCES votes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS vote_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(vote_id, user_id),
      FOREIGN KEY (vote_id) REFERENCES votes(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES vote_options(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
    -- 安全举报（校园霸凌/抽烟等）：按墙隔离
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      tracking_code TEXT UNIQUE NOT NULL,
      reporter_id INTEGER NOT NULL,
      report_types TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '',
      is_anonymous INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      status_note TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS post_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      reviewer_id INTEGER,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      reviewed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS user_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id INTEGER DEFAULT 0,
      reporter_id INTEGER NOT NULL,
      reported_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      evidence_messages TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      action_taken TEXT DEFAULT '',
      reviewer_id INTEGER,
      feedback TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      reviewed_at DATETIME
    );
    -- 帖子收藏/书签
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, post_id)
    );
    -- 用户偏好（键值对，当前用于导航栏选项卡开关等个性化设置）
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER NOT NULL,
      pref_key TEXT NOT NULL,
      pref_value TEXT DEFAULT '',
      updated_at DATETIME DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (user_id, pref_key)
    );
    -- 权限覆盖项。只存「与名号默认集不同」的部分：
    -- effect='grant' 是额外授予，effect='deny' 是从默认集里剔除。
    -- wall_id=0 表示全局作用域（墙级权限在此授予时对所有墙生效）。
    -- 默认集本身在 lib/permissions.js，不落库 —— 改默认集对所有持有者立即生效。
    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      wall_id INTEGER NOT NULL DEFAULT 0,
      perm TEXT NOT NULL,
      effect TEXT NOT NULL,
      operator_id INTEGER,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, wall_id, perm)
    );
    -- Bug 反馈
    CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      reply TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);

  // 索引
  ['CREATE INDEX IF NOT EXISTS idx_posts_wall ON posts(wall_id, created_at DESC)',
   'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id)',
   'CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(wall_id, category)',
   'CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)',
   'CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)',
   'CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id)',
   'CREATE INDEX IF NOT EXISTS idx_votes_wall ON votes(wall_id, created_at DESC)',
   'CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, is_read)',
   'CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(receiver_id, type)',
   'CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)',
   'CREATE INDEX IF NOT EXISTS idx_announcements_wall ON announcements(wall_id, is_pinned DESC, created_at DESC)',
   'CREATE INDEX IF NOT EXISTS idx_user_perms ON user_permissions(user_id, wall_id)',
   'CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id)',
   'CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id)',
   'CREATE INDEX IF NOT EXISTS idx_wall_members_wall ON wall_members(wall_id, status)',
   'CREATE INDEX IF NOT EXISTS idx_wall_members_user ON wall_members(user_id, status)',
   'CREATE INDEX IF NOT EXISTS idx_wall_apps_status ON wall_applications(status)',
   'CREATE INDEX IF NOT EXISTS idx_reports_tracking ON reports(tracking_code)',
   'CREATE INDEX IF NOT EXISTS idx_reports_wall ON reports(wall_id, status)',
   'CREATE INDEX IF NOT EXISTS idx_post_reports_wall ON post_reports(wall_id, status)',
   'CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id)',
   'CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status)',
   'CREATE INDEX IF NOT EXISTS idx_user_reports_reported ON user_reports(reported_user_id)',
   'CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id)',
   'CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id, user_id)',
   'CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status)',
   'CREATE INDEX IF NOT EXISTS idx_bug_reports_reporter ON bug_reports(reporter_id)',
  ].forEach(s => { try { wrapper.exec(s); } catch(e) {} });

  // ===== 旧库自动迁移：为旧版本数据库补齐新增的列，避免升级后查询报错 =====
  try {
    const tableCols = {};
    // sql.js 用 `PRAGMA table_info` 在 wrapper.prepare 下可用；此处统一封装
    const pragma = (t) => {
      try {
        const rows = wrapper.prepare(`PRAGMA table_info(${t})`).all();
        return new Set(rows.map(r => r.name));
      } catch { return new Set(); }
    };
    const tables = ['users', 'walls', 'posts', 'messages', 'announcements', 'votes', 'friends', 'reports', 'post_reports', 'user_reports'];
    for (const t of tables) tableCols[t] = pragma(t);

    const addCol = (t, col, type) => {
      if (!tableCols[t] || !tableCols[t].has(col)) {
        try { wrapper.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`); } catch {}
      }
    };

    // users
    addCol('users', 'bio', "TEXT DEFAULT ''");
    addCol('users', 'gender', "TEXT DEFAULT ''");
    addCol('users', 'contact_qq', "TEXT DEFAULT ''");
    addCol('users', 'contact_wechat', "TEXT DEFAULT ''");
    addCol('users', 'contact_weibo', "TEXT DEFAULT ''");
    addCol('users', 'contact_bilibili', "TEXT DEFAULT ''");
    addCol('users', 'show_contact', "INTEGER DEFAULT 0");
    addCol('users', 'class_number', "INTEGER DEFAULT 0");
    addCol('users', 'is_graduate', "INTEGER DEFAULT 0");
    addCol('users', 'graduation_year', "INTEGER DEFAULT 0");
    addCol('users', 'status', "TEXT DEFAULT 'active'");
    addCol('users', 'ban_until', "TEXT DEFAULT ''");
    addCol('users', 'ban_reason', "TEXT DEFAULT ''");
    addCol('users', 'ban_level', "TEXT DEFAULT 'login'");
    addCol('users', 'allow_search_by_id', "INTEGER DEFAULT 1");
    addCol('users', 'allow_search_by_username', "INTEGER DEFAULT 1");
    addCol('users', 'allow_search_by_nickname', "INTEGER DEFAULT 1");
    // 真实姓名属敏感信息，默认关闭，由用户在设置里主动开启
    addCol('users', 'allow_search_by_real_name', "INTEGER DEFAULT 0");
    addCol('users', 'allow_discover', "INTEGER DEFAULT 1");
    addCol('users', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // walls（多校园墙）
    addCol('walls', 'description', "TEXT DEFAULT ''");
    addCol('walls', 'owner_id', 'INTEGER');
    addCol('walls', 'status', "TEXT DEFAULT 'active'");
    addCol('walls', 'require_join_approval', "INTEGER DEFAULT 1");
    addCol('walls', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // wall_members（墙内封禁）
    addCol('wall_members', 'wall_ban_until', "TEXT DEFAULT ''");
    addCol('wall_members', 'wall_ban_reason', "TEXT DEFAULT ''");

    // posts
    addCol('posts', 'wall_id', "INTEGER DEFAULT 0");
    addCol('posts', 'category', "TEXT DEFAULT '分享'");
    addCol('posts', 'is_anonymous', "INTEGER DEFAULT 0");
    addCol('posts', 'author_ip', "TEXT DEFAULT ''");
    addCol('posts', 'like_count', "INTEGER DEFAULT 0");
    addCol('posts', 'comment_count', "INTEGER DEFAULT 0");
    addCol('posts', 'is_markdown', "INTEGER DEFAULT 0");
    addCol('posts', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // messages
    addCol('messages', 'wall_id', "INTEGER DEFAULT 0");
    addCol('messages', 'type', "TEXT DEFAULT 'chat'");
    addCol('messages', 'title', "TEXT DEFAULT ''");
    addCol('messages', 'is_anonymous', "INTEGER DEFAULT 0");
    addCol('messages', 'is_read', "INTEGER DEFAULT 0");
    addCol('messages', 'conversation_id', "TEXT DEFAULT ''");
    addCol('messages', 'reply_to_id', "INTEGER DEFAULT 0");
    addCol('messages', 'reply_to_content', "TEXT DEFAULT ''");
    addCol('messages', 'is_revoked', "INTEGER DEFAULT 0");
    addCol('messages', 'assignee_id', "INTEGER DEFAULT 0");
    // 站内信的跳转目标（前端路径，如 /post/12）。存量消息为空串，
    // 前端会按 type/conversation_id/追踪码做降级推导。
    addCol('messages', 'link', "TEXT DEFAULT ''");
    addCol('messages', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // announcements
    addCol('announcements', 'wall_id', "INTEGER DEFAULT 0");
    addCol('announcements', 'is_pinned', "INTEGER DEFAULT 0");
    addCol('announcements', 'is_markdown', "INTEGER DEFAULT 0");
    addCol('announcements', 'delete_at', "TEXT DEFAULT ''");
    // 作用域：'wall' 本墙公告（wall_id 为该墙）；'global' 全站公告（wall_id 存 0）
    addCol('announcements', 'scope', "TEXT DEFAULT 'wall'");
    addCol('announcements', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // votes
    addCol('votes', 'wall_id', "INTEGER DEFAULT 0");
    addCol('votes', 'description', "TEXT DEFAULT ''");
    addCol('votes', 'author_id', 'INTEGER');
    addCol('votes', 'is_anonymous', "INTEGER DEFAULT 0");
    addCol('votes', 'author_ip', "TEXT DEFAULT ''");
    addCol('votes', 'end_at', "TEXT DEFAULT ''");
    addCol('votes', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // friends
    addCol('friends', 'status', "TEXT DEFAULT 'pending'");
    addCol('friends', 'created_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // reports（安全举报）
    addCol('reports', 'wall_id', "INTEGER DEFAULT 0");
    addCol('reports', 'status', "TEXT DEFAULT 'pending'");
    addCol('reports', 'status_note', "TEXT DEFAULT ''");
    addCol('reports', 'images', "TEXT DEFAULT ''");
    addCol('reports', 'updated_at', "DATETIME DEFAULT (datetime('now','localtime'))");

    // post_reports
    addCol('post_reports', 'wall_id', "INTEGER DEFAULT 0");
    addCol('post_reports', 'status', "TEXT DEFAULT 'pending'");
    addCol('post_reports', 'reviewer_id', 'INTEGER');
    addCol('post_reports', 'reviewed_at', 'DATETIME');

    // user_reports
    addCol('user_reports', 'wall_id', "INTEGER DEFAULT 0");
    addCol('user_reports', 'status', "TEXT DEFAULT 'pending'");
    addCol('user_reports', 'action_taken', "TEXT DEFAULT ''");
    addCol('user_reports', 'reviewer_id', 'INTEGER');
    addCol('user_reports', 'feedback', "TEXT DEFAULT ''");
    addCol('user_reports', 'reviewed_at', 'DATETIME');

    console.log('[DB] 迁移完成：旧库列已补齐到最新版本');
  } catch (e) {
    console.warn('[DB] 迁移过程中出现少量跳过项（可忽略）: ' + e.message);
  }

  if (!getSetting(wrapper, 'require_approval')) {
    setSetting(wrapper, 'require_approval', '0');
  }

  // 不再自动创建种子账号或示例校园墙。
  // 首次启动时由前端 /api/setup 引导用户创建超级管理员 + 第一个校园墙。
  if (!getSetting(wrapper, 'initialized') || getSetting(wrapper, 'initialized') !== '1') {
    console.log('[DB] 数据库未初始化，请通过前端完成首次设置（创建超级管理员 + 第一个校园墙）');
  }

  // 迁移/建表的结果必须确保落盘，这里走同步写
  wrapper.saveNow();
  startAutoSave();
  console.log('[DB] 数据库初始化完成' + (REBUILD ? '（已重建）' : ''));
  return wrapper;
}

module.exports = { initDB, getSetting, setSetting, getWrapper: () => wrapper };
