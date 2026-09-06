#!/bin/bash
# 校园墙部署机 —— 安全加固（在部署机上以 server 用户运行，需要 sudo）
#
#   bash deploy/harden-server.sh
#
# 幂等。刻意不动 SSH 的 PasswordAuthentication —— 关掉密码登录是个
# 一旦密钥丢了就只能去物理控制台救的操作，单独放在 disable-ssh-password.sh 里，
# 由人确认后再执行。
set -euo pipefail

DEPLOY_DIR="/home/server/school_wall/deploy"
HARDEN_DIR="$DEPLOY_DIR/hardening"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -un)" = "server" ] || { echo "请以 server 用户运行"; exit 1; }

# 提前拿到 sudo 凭据，避免中途弹密码。
#
# 注意执行方式：在没有分配 tty 的 ssh 会话里（`ssh host 'bash 本脚本'`），
# sudo 的免密票据是按 ppid 记的，而 `$(sudo …)`、`sudo … | grep` 这些
# 命令替换和管道都会开子 shell，ppid 一变就命不中缓存，
# 表现是同样的 sudo 有的过有的不过、自检随机报红。
# 请用 `ssh -t host 'bash deploy/harden-server.sh'`，或者直接在机器上跑。
sudo -v

# ---------------------------------------------------------------
say "1/5 内核参数"
sudo install -m 644 -D "$HARDEN_DIR/99-school-wall-sysctl.conf" \
    /etc/sysctl.d/99-school-wall-hardening.conf
sudo sysctl --system >/dev/null
echo "  已应用"

# ---------------------------------------------------------------
say "2/5 sshd"
# 先确认自己有可用的公钥，否则改完配置万一出问题就没有后路
if [ ! -s ~/.ssh/authorized_keys ]; then
    echo "  ✗ ~/.ssh/authorized_keys 为空，先装公钥再来（本步骤已跳过）"
else
    sudo install -m 644 -D "$HARDEN_DIR/99-school-wall-sshd.conf" \
        /etc/ssh/sshd_config.d/99-school-wall-hardening.conf
    # 配置有语法错误时 reload 会让 sshd 直接退出，先验后加载
    if sudo sshd -t; then
        sudo systemctl reload ssh
        echo "  已应用（现有连接不受影响）"
    else
        sudo rm -f /etc/ssh/sshd_config.d/99-school-wall-hardening.conf
        echo "  ✗ 配置校验失败，已回滚"; exit 1
    fi
fi

# ---------------------------------------------------------------
say "3/5 fail2ban"
sudo install -m 644 -D "$HARDEN_DIR/school-wall-fail2ban.local" \
    /etc/fail2ban/jail.d/school-wall.local
sudo systemctl restart fail2ban
sleep 2
sudo fail2ban-client status sshd | sed 's/^/  /'

# ---------------------------------------------------------------
say "4/5 日志容量"
# 这台机器只有 15G 可用，journal 默认可以吃到磁盘的 10%，
# 再加上之前非正常关机留下的损坏 journal，先把上限压下来。
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=20M\nMaxRetentionSec=2week\n' \
    | sudo tee /etc/systemd/journald.conf.d/99-school-wall.conf >/dev/null
sudo systemctl restart systemd-journald
echo "  journal 上限 200M"

# ---------------------------------------------------------------
say "5/5 敏感文件权限"
# 数据库里是口令哈希。/home/server 放开到 711 是为了让 nginx 能读到前端静态文件，
# 同机的 www-data 因此能穿过目录 —— 这几个文件必须确保它读不到。
chmod 600 /home/server/school_wall/server/data.db* 2>/dev/null || true
chmod 600 /home/server/school_wall/server/.jwt_secret 2>/dev/null || true
[ -f /home/server/school_wall/server/.env ] && chmod 600 /home/server/school_wall/server/.env
chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys
ls -l /home/server/school_wall/server/data.db /home/server/school_wall/server/.jwt_secret 2>/dev/null | sed 's/^/  /'

# ---------------------------------------------------------------
say "自检"
# sysctl / sshd 都在 /usr/sbin 下，非交互式 ssh 会话的 PATH 里通常没有它 ——
# 用相对名字调用会全部「命令找不到」，自检就会在配置其实生效的情况下报一片红。
SYSCTL=/usr/sbin/sysctl
SSHD=/usr/sbin/sshd

# sshd -T 只取一次存进变量，而不是每条检查都 `sudo sshd -T | grep` 一遍。
# 无 tty 时 sudo 的免密票据是按 ppid 记的，管道里的 sudo 处在不同的子 shell，
# 会随机命不中缓存 —— 表现就是同样的检查有的过有的不过。
SSHD_CONF="$(sudo $SSHD -T 2>/dev/null || true)"

fail=0
chk() {
    if eval "$2" >/dev/null 2>&1; then printf '  \033[32m✓\033[0m %s\n' "$1"
    else printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; fi
}
sshd_is() { grep -qx "$1" <<<"$SSHD_CONF"; }

chk "tcp_syncookies 已开"        "[ \"\$($SYSCTL -n net.ipv4.tcp_syncookies)\" = 1 ]"
chk "不接受 ICMP 重定向"          "[ \"\$($SYSCTL -n net.ipv4.conf.all.accept_redirects)\" = 0 ]"
chk "不接受源路由"                "[ \"\$($SYSCTL -n net.ipv4.conf.all.accept_source_route)\" = 0 ]"
chk "dmesg 受限"                 "[ \"\$($SYSCTL -n kernel.dmesg_restrict)\" = 1 ]"
chk "符号链接保护已开"            "[ \"\$($SYSCTL -n fs.protected_symlinks)\" = 1 ]"
chk "root 禁止 SSH 登录"          "sshd_is 'permitrootlogin no'"
chk "MaxAuthTries=3"             "sshd_is 'maxauthtries 3'"
chk "LoginGraceTime=30"          "sshd_is 'logingracetime 30'"
chk "X11 转发已关"                "sshd_is 'x11forwarding no'"
chk "只允许 server 登录"          "sshd_is 'allowusers server'"
chk "fail2ban sshd jail 运行中"   "sudo fail2ban-client status sshd"
chk "data.db 权限 600"            "[ \"\$(stat -c %a /home/server/school_wall/server/data.db)\" = 600 ]"
chk ".jwt_secret 权限 600"        "[ \"\$(stat -c %a /home/server/school_wall/server/.jwt_secret)\" = 600 ]"
chk "服务仍在运行"                "systemctl is-active --quiet school-wall && systemctl is-active --quiet nginx"

# 密码登录是否已关只做提示，不计入失败 —— 它由 disable-ssh-password.sh 单独负责
if sshd_is 'passwordauthentication no'; then
    printf '  \033[32m✓\033[0m SSH 密码登录已关闭\n'
else
    printf '  \033[33m·\033[0m SSH 密码登录仍开启（如需关闭：bash deploy/disable-ssh-password.sh）\n'
fi

echo ""
[ "$fail" = 0 ] && printf '\033[32m加固完成\033[0m\n' || { printf '\033[31m有检查未通过\033[0m\n'; exit 1; }
