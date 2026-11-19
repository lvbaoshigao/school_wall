# 部署与运维

本目录是面向 Debian、服务用户 server、项目路径 /home/server/school_wall 的部署模板。这里描述的是脚本行为，不代表当前机器已经安装或启用了这些设置。安装器正常执行会修改系统服务、Nginx 配置和 UFW；审查与验证可先使用只读模式。

## 运行要求与架构

需要 Node.js >=22.12.0、npm、Nginx（含 http_realip 模块）、systemd、sudo、curl、ss 与 UFW。安全加固脚本还需要 OpenSSH 和 fail2ban。Node.js 路径可以来自 nvm；安装器会把检查通过的当前 Node 绝对路径写进服务 drop-in，升级或移动 Node 后要重新运行安装器。

~~~text
浏览器 -> nginx :11451 -> node 127.0.0.1:3000
            |-- /api/       代理：限流、体积上限、超时
            |-- /dashboard  代理：应用生成 nonce CSP 与看板会话票据
            |-- /uploads/   代理：应用校验证据图片访问票据并返回缓存策略
            |-- /assets/    直接读取前端产物，长缓存
            |-- /           SPA，index.html 要求重新验证缓存
~~~

上传文件不能由 Nginx alias 直接公开。公开图片与私密证据统一由应用处理；私密响应的 private, no-store 和 no-referrer 会原样保留。前端 CSP 允许 data: / blob: 图片预览；看板使用应用生成的 nonce CSP，代理不向它叠加前端 CSP。

## 首次安装与更新

先在受控环境完成首次初始化。可在目标机以前台方式运行 bash deploy.sh（默认只监听回环），通过 ssh -L 3000:127.0.0.1:3000 server@HOST 建立转发，在管理电脑打开 http://localhost:3000 完成向导，再用 Ctrl+C 停止前台进程并执行安装器。系统没有默认管理员账号；不要在初始化之前把站点公开。生产访问应使用 HTTPS，隧道的 HTTPS 边缘也必须回源到 Nginx 11451，不能绕过代理直连 3000。

~~~bash
# 在项目根目录检查本地依赖，不启动应用、不修改系统
bash deploy.sh --check
# 在部署机检查安装器前置条件（不会调用 sudo 或修改权限）
bash deploy/install-server.sh --check

# 真正安装/更新：仅在目标部署机执行
bash deploy/install-server.sh
# 非标准 SSH 端口要先显式指定，避免 UFW 未放行实际管理端口
SSH_PORT=2222 bash deploy/install-server.sh
~~~

安装器会停止 school-wall 服务，按两端锁文件执行 npm ci 并重建前端，实际验证 sharp 原生编码/解码，再安装四个 Nginx snippet（proxy、headers、csp、realip）、站点和 systemd 单元。已有 node_modules 和 dist 不会跳过更新。准备失败会退出并保留服务停止状态，修复依赖/构建错误后重新运行；它不冒报成功，也不终止通用的 node index.js 进程。端口 3000 被非受管进程占用时会直接退出，请自行核实进程归属。

需要把完整后端源码、两端 package.json 与 package-lock.json、前端源码和 deploy 目录一起更新到目标机。不要只复制 server/*.js 而漏掉 lib/、routes/ 或锁文件，也不要把其他操作系统/CPU 的 node_modules 搬过去。sharp 的平台原生包属于 optional 依赖，安装命令显式包含它们；安装后会真实生成 PNG 并解码验证。不要用 --omit=optional 或全局禁用安装脚本来绕过错误。

安装器仅添加项目的 UFW 规则（放行 SSH_PORT 与 11451、拒绝 3000），不清空既有规则或删除其他 Nginx 站点，因此不能据此认定机器只开放了两个端口。执行前应确认管理端口配置；执行后查看 sudo ufw status verbose 与 ss -ltn。后端绑定回环是防止绕过代理的主要约束。

## 数据与配置

兼容现有安装，DATA_DIR 默认仍为 server 目录。数据根包含 data.db、.jwt_secret、uploads 与 backups；server/.env 始终是 systemd 的配置文件，应用本身不自动读取它。

~~~ini
# /home/server/school_wall/server/.env：简单 KEY=value；不使用 shell 命令或变量替换
DATA_DIR=/home/server/school-wall-data
# JWT_SECRET 可选。不设置时由应用生成持久化密钥；如设置需至少 16 字符。
# JWT_SECRET=替换为独立生成且妥善保存的强随机值
~~~

自定义数据目录需位于源码树外，使用不含空格/变量替换/系统说明符的绝对路径，且现有目录必须属于 server 用户并且不能经过符号链接。安装器校验这些约束，并把实际数据根写入 systemd ReadWritePaths；不能只修改 .env 后重启而不更新这个可写路径。HOST=127.0.0.1、PORT=3000、TRUST_PROXY=1、KEEP_DB=1、NODE_ENV=production 是这套模板的固定约束，.env 不应覆盖它们。

改变 DATA_DIR 不会自动迁移旧数据。停服务后把数据库、JWT 密钥、uploads 与 backups 作为一组迁移，确认路径与权限，再更新配置和重跑安装器；密钥丢失会使旧登录票据失效。不要在服务运行时用独立脚本写 data.db，sql.js 下一次落盘可能覆盖修改。备份与恢复请通过受权限保护的数据库管理接口或停服务维护。

后端目录与数据根权限 700，数据库、JWT 密钥和 .env 为 600，uploads/backups 递归去除组和其他用户权限，systemd UMask=0077。只有 client/dist 及其必要父目录开放给 Nginx 读取，www-data 无需读取上传文件。外部 DATA_DIR 还能让 ProtectSystem=strict 下的应用代码保持只读。

## 检查与日常维护

~~~bash
systemctl status school-wall nginx
journalctl -u school-wall -n 50 --no-pager
sudo nginx -t
sudo systemctl show school-wall -p ExecStart -p Environment -p ReadWritePaths

# 探活必须查询真实后端数据库，静态首页 200 不代表后端可用
curl --fail --connect-timeout 2 --max-time 5 http://127.0.0.1:11451/api/health
curl --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:11451/api/nope
# 第二条应返回 404
ss -ltn 'sport = :3000'
# 应只有 127.0.0.1:3000，不能出现 0.0.0.0 或 [::]

# 常规服务维护
sudo systemctl restart school-wall
sudo nginx -t && sudo systemctl reload nginx

# 无需部署的隔离回归：使用临时目录和替代命令，不加载应用数据库
node --test deploy/test/*.test.cjs
(cd server && npm test && npm run audit:security)
(cd client && npm test && npm run audit:security)
~~~

安装器的健康检查有连接/总超时，并对实际 /api/health 重试，随后核对回环监听、首页和未知 API 状态。若失败请检查服务与 Nginx 日志。反向代理以校验后的客户端地址覆盖 X-Forwarded-For；仅信任本机 cloudflared 的 CF-Connecting-IP 与协议声明，局域网客户端伪造这些头不能切换代理身份。

## 可选安全加固与隧道

~~~bash
# 会真实修改内核参数、sshd、fail2ban、日志容量和数据权限
bash deploy/harden-server.sh
# 会真实关闭 SSH 密码/键盘交互认证；先用第二个终端验证公钥可用
bash deploy/disable-ssh-password.sh
~~~

密码关闭脚本只证明最近十分钟有 server 用户公钥登录记录，不会证明当前连接本身的认证方式。它写入独立的早期 sshd include，先验语法和有效配置再 reload，失败恢复原文件。执行后保留当前会话，再新建连接验证。加固脚本不会自行关闭密码登录，fail2ban 默认只豁免回环，没有历史开发机的固定 IP 例外。SSH 保活参数探测失联客户端，不代表用户无操作会被踢下线。

如使用 Cloudflare Tunnel，先在面板把 ingress service 设为 http://localhost:11451，然后再按需要执行 bash deploy/restore-cloudflared.sh。脚本会操作 cloudflared 服务；本次代码审查不会启停隧道。跨主机代理或直接接 Cloudflare 边缘时需同步调整 realip 信任列表，不能继续把非本机来源当作回环隧道。
