// 一次性时区修正。
//
// 背景：服务器系统时区是 America/New_York，而使用者在 UTC+8。
// 库里所有 datetime('now','localtime') 写出来的时间都是纽约本地时间，
// 而前端拿到这种不带时区的裸串会按**浏览器本地时区**解析 ——
// 于是北京时间 19:20 注册的账号，界面上显示成 07:20，「刚刚」变成「12小时前」。
//
// 修法分两步，本脚本只做第二步：
//   1. 先把系统时区改对：sudo timedatectl set-timezone Asia/Shanghai，并重启服务
//   2. 跑本脚本，把存量时间整体 +12 小时
//
// 为什么是固定 +12：库里最早的数据是 2026-07-06，全部落在夏令时(EDT, -0400)期间，
// 与 +0800 相差正好 12 小时。若将来有 EST(-0500) 期间写入的数据需要按 13 小时单独处理。
//
// 刻意**不动**的列：
//   users.ban_until / wall_members.wall_ban_until —— 走 toISOString()，本来就是 UTC 绝对时间
//   votes.end_at / announcements.delete_at        —— 用户用 datetime-local 手填，已经是用户本地时区
//
// 脚本是幂等的：完成后在 settings 里写一个标记，重复执行会直接退出。

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.db');
const MARKER = 'tz_shift_v1';
const HOURS = 12;

// 表 → 需要平移的列
const TARGETS = {
  users:             ['created_at'],
  walls:             ['created_at'],
  wall_members:      ['created_at'],
  wall_applications: ['created_at', 'reviewed_at'],
  posts:             ['created_at'],
  comments:          ['created_at'],
  likes:             ['created_at'],
  messages:          ['created_at'],
  announcements:     ['created_at'],
  votes:             ['created_at'],
  vote_records:      ['created_at'],
  friends:           ['created_at'],
  reports:           ['created_at', 'updated_at'],
  post_reports:      ['created_at', 'reviewed_at'],
  user_reports:      ['created_at', 'reviewed_at'],
  ban_logs:          ['created_at'],
  bookmarks:         ['created_at'],
  user_prefs:        ['updated_at'],
  bug_reports:       ['created_at', 'updated_at'],
  user_permissions:  ['created_at'],
};

const DRY_RUN = !process.argv.includes('--apply');

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error('找不到数据库:', DB_PATH);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const one = (sql) => { try { const r = db.exec(sql); return r.length ? r[0].values[0][0] : null; } catch { return null; } };
  const has = (t) => !!one(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`);
  const cols = (t) => { try { return db.exec(`PRAGMA table_info(${t})`)[0].values.map(v => v[1]); } catch { return []; } };

  if (has('settings') && one(`SELECT value FROM settings WHERE key='${MARKER}'`)) {
    console.log(`已经执行过（settings.${MARKER} 存在），不再重复平移。`);
    process.exit(0);
  }

  console.log(DRY_RUN ? '=== 试运行（不写盘）===' : '=== 正式执行 ===');
  console.log(`平移量: +${HOURS} 小时\n`);

  let total = 0;
  for (const [table, columns] of Object.entries(TARGETS)) {
    if (!has(table)) { console.log(`  跳过 ${table}（表不存在）`); continue; }
    const existing = cols(table);
    for (const col of columns) {
      if (!existing.includes(col)) { console.log(`  跳过 ${table}.${col}（列不存在）`); continue; }
      const where = `${col} IS NOT NULL AND ${col} != ''`;
      const n = one(`SELECT COUNT(*) FROM ${table} WHERE ${where}`) || 0;
      if (!n) continue;
      const before = one(`SELECT MIN(${col}) FROM ${table} WHERE ${where}`);
      if (!DRY_RUN) {
        db.run(`UPDATE ${table} SET ${col} = datetime(${col}, '+${HOURS} hours') WHERE ${where}`);
      }
      const after = DRY_RUN
        ? one(`SELECT datetime(MIN(${col}), '+${HOURS} hours') FROM ${table} WHERE ${where}`)
        : one(`SELECT MIN(${col}) FROM ${table} WHERE ${where}`);
      console.log(`  ${(table + '.' + col).padEnd(34)} ${String(n).padStart(4)} 行   ${before} → ${after}`);
      total += n;
    }
  }

  console.log(`\n合计 ${total} 行`);

  if (DRY_RUN) {
    console.log('\n这是试运行。确认无误后加 --apply 正式执行：');
    console.log('  node scripts/fix-timezone.js --apply');
    process.exit(0);
  }

  db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${MARKER}', datetime('now','localtime'))`);

  // 先写临时文件再 rename，与 db.js 的落盘策略保持一致，避免中途崩溃留下半截文件
  const tmp = DB_PATH + '.tzfix';
  fs.writeFileSync(tmp, Buffer.from(db.export()), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, DB_PATH);
  console.log('已写入数据库。');
})();
