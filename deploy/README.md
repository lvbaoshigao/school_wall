# 部署与运维

部署机：`192.168.31.43`（Debian 13，VirtualBox 虚拟机，1 核 / 2G / 20G）
访问地址：**http://192.168.31.43:11451**

## 架构

```
浏览器 ──▶ nginx :11451 ──▶ node :3000（仅 127.0.0.1）
             │
             ├── /api/         反代给 node（限流、体积上限、慢连接超时在这一层）
             ├── /dashboard    反代给 node
             ├── /uploads/     nginx 直发（不经过 node 事件循环）
             ├── /assets/      nginx 直发，长缓存
             └── /             SPA，回落 index.html
```

后端只监听回环，外部无法直连 —— 否则 nginx 上的防护全都能被绕开。

## 目录

```
~/school_wall/
├── server/          后端（data.db、.jwt_secret 都在这里，权限 600）
├── client/dist/     前端构建产物，由 nginx 直接读
└── deploy/
    ├── install-server.sh          安装/更新 nginx + systemd + 防火墙
    ├── harden-server.sh           安全加固（内核参数、sshd、fail2ban、日志上限）
    ├── disable-ssh-password.sh    关闭 SSH 密码登录（单独执行，见下）
    ├── restore-cloudflared.sh     恢复外网隧道（当前已停用）
    ├── nginx/                     nginx 配置与 snippet
    ├── systemd/school-wall.service
    └── hardening/                 sysctl / sshd / fail2ban 配置
```

## 常用操作

```bash
# 看服务状态与日志
systemctl status school-wall
journalctl -u school-wall -f

# 重启
sudo systemctl restart school-wall
sudo systemctl reload nginx     # 只改了 nginx 配置时用 reload，不断连接

# 改了配置后重新安装
bash ~/school_wall/deploy/install-server.sh
```

**注意**：这些脚本里有大量 `sudo`。用 `ssh host 'bash 脚本'` 这种没有 tty 的方式执行时，
sudo 的免密票据按 ppid 记，命令替换和管道会开子 shell 导致票据命不中，
表现为同样的命令有的过有的不过。请用 `ssh -t`，或直接在机器上跑。

## 更新代码

```bash
# 后端：改完直接传，然后重启
scp server/*.js server/routes/*.js server@192.168.31.43:school_wall/server/...
ssh server@192.168.31.43 'sudo systemctl restart school-wall'

# 前端：本地构建后打包传过去（机器上没装 rsync）
cd client && npm run build
tar czf /tmp/dist.tgz -C dist .
scp /tmp/dist.tgz server@192.168.31.43:/tmp/
ssh server@192.168.31.43 'cd ~/school_wall/client && rm -rf dist.new && mkdir dist.new \
  && tar xzf /tmp/dist.tgz -C dist.new && rm -rf dist && mv dist.new dist \
  && chmod -R a+rX dist && rm /tmp/dist.tgz'
```

数据库是 sql.js（整库读进内存，按脏标记合并落盘），**不要**在服务运行时用脚本直接写
`data.db` —— 服务下一次落盘会把你的改动整个覆盖掉。要改先停服务。

另外，任何 `require('./db.js')` 的脚本都会触发 `initDB()` 的迁移/重建逻辑。
只读探查请自己 `new SQL.Database(fs.readFileSync('./data.db'))`，别走 db.js。

## 安全现状

已生效：

- 后端只监听 `127.0.0.1:3000`，防火墙额外显式拒绝 3000
- ufw 仅放行 22 与 11451
- nginx 层：限流（读 30r/s、写 2r/s）、单 IP 并发 30、请求体上限 6MB、
  慢连接超时（header 10s / body 20s）
- nginx 无条件覆盖 `X-Forwarded-For`、清空 `CF-Connecting-IP`/`True-Client-IP`，
  伪造这些头拿不到独立限流额度（已实测验证）
- systemd 沙箱：`ProtectSystem=strict`、能力集清空、系统调用过滤、内存上限 768M
- sshd：禁 root 登录、只允许 server 用户、MaxAuthTries 3、LoginGraceTime 30
- fail2ban：SSH 3 次失败封 1 小时，重复触发逐次加倍
- 内核：syncookies、禁 ICMP 重定向与源路由、dmesg/kptr 受限、符号链接保护
- `data.db` / `.jwt_secret` 权限 600（落盘时显式指定 mode，不再被 umask 冲掉）

**未做**（需要人工决定）：

- SSH 密码登录仍开着。公钥已装好并验证可用，要关执行
  `bash ~/school_wall/deploy/disable-ssh-password.sh`（脚本会先确认最近有成功的
  公钥登录记录才动手，失败自动回滚）。
- HTTPS 未配。当前是纯 HTTP，登录口令和 token 在局域网内是明文传输的。
  要上 HTTPS 需要证书，测试期间不联网所以没做。

## cloudflared 隧道（已停用）

机器上原有一个 cloudflared 隧道，把 `webhall.dpdns.org` 指向 `http://localhost:3000` ——
**绕过了 nginx**，公网流量拿不到上面任何一层防护。测试期间已 stop + disable。

要恢复，先在 Cloudflare 面板把 ingress 的 service 改成 `http://localhost:11451`
（隧道配置是面板远程下发的，机器上改不了），再跑
`bash ~/school_wall/deploy/restore-cloudflared.sh`。
