# 启动与前后端分离

要求 Node.js >= 22.13.0 和 npm。在项目目录之外调用下列脚本也能正确定位文件。任何启动方式都不提供默认账号；首次设置应在本机完成。

## Linux 开发

```sh
bash start.sh
bash start.sh --port 3100 --client-port 5180
# 仅启动后端（无需 client 目录、依赖或构建）
bash start.sh --backend-only --port 3100
# 只检查端口、锁文件、模块和 sharp，不安装、不启动、不打开数据库
bash start.sh --check --backend-only --port 3100
```

默认同时启动 Express 与 Vite，仅监听 127.0.0.1；终端保留两端日志。启动器依次检查后端健康、前端页面及其 API 代理，全部就绪后才打印 ready。后端设置 SERVE_CLIENT=0、NODE_ENV=development、KEEP_DB=1，避免读取旧前端构建或意外重建数据。Vite 使用此次命令指定的后端端口。

首次运行按锁文件执行 npm ci；成功后在各自 node_modules 内保存依赖指纹。package.json、package-lock.json、平台、架构或 Node ABI 改变时重新安装。之后启动复用依赖，但仍检查直接依赖、node:sqlite 内存锁能力与 sharp 实际编解码。--install 强制重装；--skip-install 复用已有依赖并做检查，适合已手动执行 npm ci 的环境；两者不能同时使用。生产部署默认每次按锁文件安装。Linux 开发启动与部署在替换依赖前会拒绝仍运行于本仓库的后端/Vite 进程，要求先停止相关服务。

按 Ctrl+C 同时优雅关闭子进程，也可在另一个终端执行：

```sh
bash stop.sh                 # 后端默认端口 3000 对应的开发会话
bash stop.sh --port 3100     # 同时停止该会话启动的后端与 Vite
```

状态仅写入被忽略的 .cache/school-wall，权限限制为当前用户。stop.sh 校验本仓库入口、PID、Linux /proc 启动时间后才向启动器发送 SIGTERM；不按端口杀进程，也不执行 pkill。直接 npm start、deploy.sh 或 systemd 启动的后端，请使用原终端 Ctrl+C 或对应服务管理器停止。若上次启动器被 SIGKILL 造成状态无法验证，使用原终端检查与清理；脚本不会猜测进程归属。端口被占用时直接失败，不自动选择其他端口。

## Windows

```bat
start.bat --port 3100 --client-port 5180
start.bat --backend-only --port 3100
start.bat --skip-install
stop.bat --port 3100 --client-port 5180
deploy.bat --api-only --port 3100
```

保留原有双窗口开发与端口参数。--backend-only（别名 --api-only）不访问前端依赖；--skip-install 跳过 npm ci，仍验证依赖与原生 sharp。未指定该参数时继续使用锁文件重装。Windows 的停止命令只处理入口确认为本仓库的 Node 进程，但操作系统终止进程可能中断写入，维护前应备份数据。

## 独立后端与生产部署

```sh
# 仅安装和检查后端；不要求存在 client/package-lock.json 或 client/dist
bash deploy.sh --api-only --prepare-only
bash deploy.sh --api-only --check
bash deploy.sh --api-only --port 3100

# 原有同进程提供前端构建的方式保持可用
bash deploy.sh --prepare-only
bash deploy.sh 3000
```

--api-only 与 --backend-only 等价，后端设置 SERVE_CLIENT=0；API、上传访问校验和 /dashboard 仍由 Express 提供。普通 deploy.sh/deploy.bat 设置 SERVE_CLIENT=1，并安装、构建前端。Linux deploy.sh 保持前台运行，Ctrl+C 停止。脚本不会自动读取 server/.env，也不修改防火墙或系统服务。需要长期运行时使用现有 deploy/install-server.sh 提供的 systemd/nginx 方案：nginx 独立提供 client/dist，服务模板显式设置 SERVE_CLIENT=0，其系统加固保留。

直接运行也不依赖启动器：

```sh
cd server
npm ci --omit=dev --include=optional
# 先从 .env.example 创建并填写本机 .env，再显式加载
node --env-file=.env index.js
```

Node 不会自动加载 .env。server/.env.example 仅是示例；环境变量优先于 --env-file 中的同名值。DATA_DIR 建议使用绝对路径，生产数据与代码分开。一个数据目录只能由一个后端实例写入；不同端口不代表可共享同一目录，集成测试和并行开发必须各用独立 DATA_DIR。KEEP_DB=1 保留数据；日常启动不要使用 KEEP_DB=0。使用安装器的固定 systemd 模板时，应从 .env 移除 HOST、PORT、TRUST_PROXY、KEEP_DB、NODE_ENV 和 SERVE_CLIENT，让模板提供这些固定值；安装器会拒绝不一致配置。

## 前后端地址约定

开发中，Vite 通过 /api、/uploads、/rele、/dashboard 代理后端，保留原始 Host 和 Origin，使看板的同源 CSRF 校验有效。默认后端为 http://127.0.0.1:3000，可单独运行前后端：

```sh
# 终端 1
bash start.sh --backend-only --port 3100
# 终端 2
cd client
npm ci --include=dev --include=optional
BACKEND_ORIGIN=http://127.0.0.1:3100 npm run dev
```

client/.env 由 Vite 自动读取。BACKEND_ORIGIN 支持另一台主机/容器的 http(s) 源，优先于兼容变量 VITE_BACKEND_ORIGIN 和 VITE_BACKEND_PORT；不得含账号、密码、路径、查询或片段。VITE_PORT 控制开发端口，禁止把代理指向 Vite 自己。start.sh/start.bat 同时启动两端时显式使用命令行后端端口。不要将密钥放入 VITE_ 变量。

生产静态前端继续使用相对 /api 地址。Vite 开发代理不会进入构建产物：独立部署 client/dist 时，网关需将 /api、/uploads、/rele、/dashboard 转发到后端，并保留路径及同源语义；项目现有 nginx 模板已如此配置。若其他客户端确需跨源直连 API，显式配置 ALLOWED_ORIGINS 为可信的完整源列表，不能将其当作权限控制；看板仍应经同源网关访问。

## 启动脚本回归验证

```sh
bash -n start.sh stop.sh deploy.sh deploy/install-server.sh
node --test deploy/test/startup.test.cjs
node deploy/check-runtime.cjs --server --client --sharp
```

测试使用临时数据目录和动态空闲端口，覆盖参数拒绝、无副作用预检、无需前端的独立部署、进程归属校验、健康检查/关闭与代理头语义，不操作系统服务或生产数据库。Windows 运行验证需在 Windows/PowerShell 环境执行。
