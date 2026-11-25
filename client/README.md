# 校园墙前端

基于 Vue 3、Vite、Vue Router、Pinia 和 Axios。完整功能、后端配置及部署方式见 [项目说明](../README.md)。需要 Node.js >=22.12.0。

## 本地开发

在本目录执行：

```bash
npm ci
npm run dev
```

Vite 默认只监听 `127.0.0.1:5173`，将 API、上传图片、本地壁纸和运行看板请求代理到 `127.0.0.1:3000`。后端需另行启动；也可在项目根目录按项目说明使用启动脚本。

通过环境变量或本目录的 `.env.local` 设置 `VITE_PORT`、`VITE_BACKEND_PORT`；两者必须是不同的有效端口。后端不会自动读取此文件。

## 验证

```bash
# Node.js 内置测试运行器；测试使用隔离的 mock 存储/API
npm test
# 生产构建，输出到 dist
npm run build
```

在项目根目录运行 `node --test` 可一并执行后端和移动 SDK 的回归测试。
