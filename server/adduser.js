const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { hashPassword, isPasswordInput } = require('./lib/password');
const { DB_PATH } = require('./lib/paths');

// 离线副本工具：不再种下公开的固定口令，也不覆盖正在运行的 data.db。
// ADDUSER_PASSWORD='...' node adduser.js --database backup.db --output with-user.db --username newuser
async function main(args = process.argv.slice(2), env = process.env) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--database', '--output', '--username', '--nickname'].includes(args[i]) ||
        !args[i + 1] || Object.prototype.hasOwnProperty.call(options, args[i])) {
      throw new Error('用法：ADDUSER_PASSWORD=口令 node adduser.js --database 离线副本.db --output 新副本.db --username 用户名 [--nickname 昵称]');
    }
    options[args[i]] = args[i + 1];
  }
  const username = options['--username'];
  const password = env.ADDUSER_PASSWORD;
  if (!options['--database'] || !options['--output'] || typeof username !== 'string' ||
      username.length < 3 || username.length > 20 || username.trim() !== username ||
      /[\u0000-\u001f\u007f]/.test(username) || !isPasswordInput(password) || password.length < 6) {
    throw new Error('必须提供离线输入/新输出文件、3-20字符用户名及6字符以上且不超过1024字节的 ADDUSER_PASSWORD');
  }
  const nickname = options['--nickname'] || username;
  if (nickname.length > 30) throw new Error('昵称最多30个字符');
  const input = path.resolve(options['--database']);
  const output = path.resolve(options['--output']);
  const liveDatabase = path.resolve(DB_PATH);
  if (input === output || input === liveDatabase || fs.realpathSync(input) === liveDatabase || output === liveDatabase) {
    throw new Error('仅可读取离线副本并写入另一个新文件，不能操作服务端 data.db');
  }
  if (fs.existsSync(output)) throw new Error('输出文件已存在，拒绝覆盖');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(input));
  try {
    const statement = db.prepare("SELECT value FROM settings WHERE key = 'initialized'");
    let initialized = false;
    try { initialized = statement.step() && statement.get()[0] === '1'; }
    finally { statement.free(); }
    if (!initialized) throw new Error('离线副本尚未完成初始化，请先完成首次设置');
    const hash = await hashPassword(password);
    db.run("INSERT INTO users (username, password_hash, nickname, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [username, hash, nickname]);
    fs.writeFileSync(output, Buffer.from(db.export()), { flag: 'wx', mode: 0o600 });
    return { username, output };
  } finally { db.close(); }
}

if (require.main === module) {
  main().then(() => console.log('普通账号已添加到新的离线副本；原文件未修改。')).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
