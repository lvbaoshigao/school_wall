#!/bin/bash
# 恢复 cloudflared 隧道（测试期间被停用）。
#
#   bash deploy/restore-cloudflared.sh
#
# 背景：隧道的 ingress 曾配成 webhall.dpdns.org → http://localhost:3000，
# 也就是直连后端、绕过 nginx。这样一来 nginx 上做的限流、请求体上限、
# 慢连接超时对公网流量全都不生效 —— 而公网正是最需要它们的地方。
#
# 恢复之前，请先在 Cloudflare Zero Trust 面板把 ingress 的 service 改成：
#     http://localhost:11451
# （面板路径：Networks → Tunnels → 选中隧道 → Public Hostname → 编辑）
# 隧道配置是面板远程下发的，本机改不了。
set -euo pipefail

printf '\n\033[1;33m确认已在 Cloudflare 面板把 ingress 指向 http://localhost:11451 了吗？\033[0m\n'
read -rp '输入 yes 继续：' ans
[ "$ans" = "yes" ] || { echo "已取消"; exit 1; }

sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sleep 5
systemctl is-active cloudflared

echo ""
echo "隧道实际连到的目标（看日志里的 ingress 配置）："
sudo journalctl -u cloudflared --since "-2 min" --no-pager \
    | grep -oE '"service":"http://[^"]+"' | tail -3

echo ""
echo "若上面显示的仍是 :3000，说明面板配置没改成功，公网流量还是绕过 nginx 的。"
