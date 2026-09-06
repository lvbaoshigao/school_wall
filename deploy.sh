#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
CLIENT_DIR="$SCRIPT_DIR/client"
PORT="${1:-3000}"

echo "========================================"
echo "   🏫 校园墙 - 一键部署脚本"
echo "========================================"
echo ""

# 1. 检查 Node.js
echo "[1/4] 检查 Node.js..."
if ! command -v node &>/dev/null; then
    echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
    exit 1
fi
echo "✅ Node.js $(node --version)"

# 2. 安装后端依赖
echo ""
echo "[2/4] 安装后端依赖..."
cd "$SERVER_DIR"
if [ -d "node_modules" ]; then
    echo "✅ 后端依赖已存在，跳过"
else
    npm install --production
    echo "✅ 后端依赖安装完成"
fi

# 3. 安装前端依赖并构建
echo ""
echo "[3/4] 构建前端..."
cd "$CLIENT_DIR"
if [ ! -d "node_modules" ]; then
    npm install
fi
if [ -d "dist" ] && [ -f "dist/index.html" ]; then
    echo "✅ 前端已构建，跳过（如需重新构建请删除 client/dist 目录）"
else
    npm run build
    echo "✅ 前端构建完成"
fi

# 4. 启动服务
echo ""
echo "[4/4] 启动服务器..."
cd "$SERVER_DIR"

# 获取内网 IP
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
fi
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(hostname -I | awk '{print $1}')
fi

export PORT=$PORT

echo ""
echo "========================================"
echo "   ✅ 部署完成！"
echo "========================================"
echo ""
echo "  🌐 前端:     http://${LOCAL_IP}:${PORT}"
echo "  📡 API:      http://${LOCAL_IP}:${PORT}/api"
echo "  ⚙️  管理后台: http://${LOCAL_IP}:${PORT}/dashboard"
echo ""
echo "  🔑 管理员: admin / 123456"
echo ""
echo "  内网 IP: ${LOCAL_IP}"
echo "  端口:    ${PORT}"
echo ""
echo "  按 Ctrl+C 停止服务"
echo "========================================"
echo ""

node index.js
