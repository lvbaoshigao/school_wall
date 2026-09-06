const initSqlJs = require("sql.js");
const fs = require("fs");
const bcrypt = require("bcryptjs");
initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync("data.db"));
  const hash = bcrypt.hashSync("User@12345", 10);
  db.run("INSERT OR IGNORE INTO users (username, password_hash, nickname, real_name, role, status, class_number) VALUES ('zhangsan', ?, '张三', '张三', 'user','active', 3)", hash);
  db.run("INSERT OR IGNORE INTO users (username, password_hash, nickname, real_name, role, status, class_number) VALUES ('wangwu', ?, '王五', '李四', 'user','active', 2)", hash);
  fs.writeFileSync("data.db", Buffer.from(db.export()));
  console.log("added test users");
});
