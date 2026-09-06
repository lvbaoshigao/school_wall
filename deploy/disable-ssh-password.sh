#!/bin/bash
# 关闭 SSH 密码登录，改为只认公钥。
#
#   bash deploy/disable-ssh-password.sh
#
# 单独成一个脚本、不并进 harden-server.sh，是因为这一步的失败代价不一样：
# 一旦私钥丢了或没同步到别的机器，就只能去 VirtualBox 控制台救，远程没有后路。
# 脚本会先确认「当前这条连接确实是用密钥进来的」，再动配置。
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
CONF=/etc/ssh/sshd_config.d/99-school-wall-hardening.conf

[ "$(id -un)" = "server" ] || { echo "请以 server 用户运行"; exit 1; }

say "1/4 检查公钥"
if [ ! -s ~/.ssh/authorized_keys ]; then
    echo "  ✗ ~/.ssh/authorized_keys 是空的。先把公钥装上，否则关掉密码就进不来了。"
    exit 1
fi
printf '  authorized_keys 里有 %s 个公钥：\n' "$(grep -c '^ssh-' ~/.ssh/authorized_keys || echo 0)"
awk '{print "    " $1 " ... " $NF}' ~/.ssh/authorized_keys

say "2/4 确认当前连接是密钥认证进来的"
# 光有 authorized_keys 不够 —— 文件权限不对、SELinux、密钥类型被禁用，
# 都会让公钥认证静默失败而回落到密码。必须确认它真的能用。
if sudo journalctl -u ssh --since "-10 min" 2>/dev/null | grep -q "Accepted publickey for server"; then
    echo "  ✓ 最近 10 分钟内有成功的公钥登录记录"
else
    echo "  ✗ 最近 10 分钟没有公钥登录记录。"
    echo "    请先在另一个终端执行下面这条确认能进来，再重跑本脚本："
    echo "      ssh -o PasswordAuthentication=no server@$(hostname -I | awk '{print $1}')"
    exit 1
fi

say "3/4 关闭密码登录"
sudo cp -a "$CONF" "$CONF.bak.$(date +%s)"
# 覆盖式写入，避免重复执行时把同一行追加多遍
sudo sed -i '/^PasswordAuthentication/d;/^KbdInteractiveAuthentication/d;/^PubkeyAuthentication/d' "$CONF"
sudo tee -a "$CONF" >/dev/null <<'EOF'

# ===== 只认公钥 =====
PasswordAuthentication no
# 不关这个的话，PAM 的键盘交互认证仍然是一条能试密码的路
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF

if ! sudo /usr/sbin/sshd -t; then
    echo "  ✗ 配置校验失败，回滚"
    sudo mv "$(ls -t $CONF.bak.* | head -1)" "$CONF"
    exit 1
fi
sudo systemctl reload ssh

say "4/4 验证"
sleep 1
sudo /usr/sbin/sshd -T | grep -iE '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication)' | sed 's/^/  /'
echo ""
printf '\033[33m注意：当前这条 SSH 连接不会被断开。\033[0m\n'
printf '在关掉它之前，请另开一个终端验证能连上：\n'
printf '  ssh server@%s\n' "$(hostname -I | awk '{print $1}')"
printf '连不上就立刻在当前会话里回滚：\n'
printf '  sudo rm %s && sudo systemctl reload ssh\n' "$CONF"
