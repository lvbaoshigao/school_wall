#!/bin/bash
# 校园墙 —— 服务器端安装/更新脚本（在部署机上以 server 用户运行，需要 sudo）
#
#   bash deploy/install-server.sh
#
# 幂等：重复执行只会把配置刷成当前版本，不会重复追加。
set -euo pipefail

APP_ROOT="/home/server/school_wall"
DEPLOY_DIR="$APP_ROOT/deploy"
PROXY_PORT=11451

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -un)" = "server" ] || { echo "请以 server 用户运行"; exit 1; }

# ---------------------------------------------------------------
say "1/6 收紧文件权限"
# nginx 以 www-data 运行，要读 dist 和 uploads，就得能穿过 /home/server。
# 711 只给「穿过」不给「列目录」—— 别人知道确切路径才能读到，且读到的只有前端静态文件。
chmod 711 /home/server
chmod 755 "$APP_ROOT" "$APP_ROOT/client"
[ -d "$APP_ROOT/client/dist" ] && chmod -R a+rX "$APP_ROOT/client/dist"

# 后端目录只给穿过权限，不给列目录 —— 里面有数据库和依赖
chmod 751 "$APP_ROOT/server"
chmod -R a+rX "$APP_ROOT/server/uploads" 2>/dev/null || true
chmod 755 "$APP_ROOT/server/uploads"

# 数据库和密钥只有属主能读
chmod 600 "$APP_ROOT/server"/data.db* 2>/dev/null || true
[ -f "$APP_ROOT/server/.env" ] && chmod 600 "$APP_ROOT/server/.env"

# ---------------------------------------------------------------
say "2/6 安装 nginx 配置"
sudo install -m 644 -D "$DEPLOY_DIR/nginx/school-wall-proxy.conf" \
    /etc/nginx/snippets/school-wall-proxy.conf
sudo install -m 644 -D "$DEPLOY_DIR/nginx/school-wall-headers.conf" \
    /etc/nginx/snippets/school-wall-headers.conf
sudo install -m 644 -D "$DEPLOY_DIR/nginx/school-wall.conf" \
    /etc/nginx/sites-available/school-wall
sudo ln -sfn /etc/nginx/sites-available/school-wall /etc/nginx/sites-enabled/school-wall

# 默认站点监听 80 且能列目录，用不到，去掉减少暴露面
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t

# ---------------------------------------------------------------
say "3/6 安装 systemd 服务"
# 之前可能有在 SSH 里裸跑的实例占着 3000 端口
if pgrep -f 'node index\.js' >/dev/null 2>&1; then
    echo "  停掉裸跑的 node 实例…"
    pkill -f 'node index\.js' || true
    sleep 2
fi

sudo install -m 644 -D "$DEPLOY_DIR/systemd/school-wall.service" \
    /etc/systemd/system/school-wall.service
sudo systemctl daemon-reload
sudo systemctl enable school-wall
sudo systemctl restart school-wall

# ---------------------------------------------------------------
say "4/6 配置防火墙"
# 对外只留 SSH 和反代端口；后端 3000 绑在回环上，本来就进不来，
# 这里再显式拒一次，防止以后有人把 HOST 改回 0.0.0.0 时无声地暴露出去。
#
# 放行规则必须排在 enable 前面：ufw 默认拒绝入站，
# 先 enable 再 allow 的话，中间那一瞬间会把正在操作的 SSH 会话本身掐断。
sudo ufw allow 22/tcp            >/dev/null
sudo ufw allow "$PROXY_PORT"/tcp >/dev/null
sudo ufw deny  3000/tcp          >/dev/null
sudo ufw --force enable >/dev/null
sudo ufw reload >/dev/null

# ---------------------------------------------------------------
say "5/6 启动 nginx"
sudo systemctl enable nginx >/dev/null
sudo systemctl restart nginx

# ---------------------------------------------------------------
say "6/6 自检"
sleep 3
LOCAL_IP=$(hostname -I | awk '{print $1}')

fail=0
check() {
    local desc="$1" cmd="$2"
    if eval "$cmd" >/dev/null 2>&1; then
        printf '  \033[32m✓\033[0m %s\n' "$desc"
    else
        printf '  \033[31m✗\033[0m %s\n' "$desc"; fail=1
    fi
}

check "school-wall 服务 running"     "systemctl is-active --quiet school-wall"
check "nginx 服务 running"           "systemctl is-active --quiet nginx"
check "后端只监听回环 127.0.0.1:3000" "ss -ltn | grep -q '127.0.0.1:3000'"
check "后端未监听 0.0.0.0:3000"       "! ss -ltn | grep -q '0.0.0.0:3000'"
check "nginx 监听 $PROXY_PORT"        "ss -ltn | grep -q ':$PROXY_PORT'"
check "反代首页 200"                  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PROXY_PORT/)\" = 200 ]"
check "反代 API 可达"                 "curl -sf http://127.0.0.1:$PROXY_PORT/api/setup/status >/dev/null"
check "不存在的 API 返回 404 而非挂起" "[ \"\$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PROXY_PORT/api/nope)\" = 404 ]"

echo ""
if [ "$fail" = 0 ]; then
    printf '\033[32m全部通过\033[0m  →  http://%s:%s\n' "$LOCAL_IP" "$PROXY_PORT"
else
    printf '\033[31m有检查未通过\033[0m，看 journalctl -u school-wall -n 50\n'; exit 1
fi
