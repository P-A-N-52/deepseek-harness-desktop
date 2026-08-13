# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 是一个打包现有 Web GUI 的 Tauri 应用。它在 `127.0.0.1` 的操作系统分配端口上启动封闭的 `dsh` Web sidecar，读取其就绪 URL，并在 WebView 中加载该精确 origin。它不组装另一棵 Cordis 应用，也不引入另一套 API 协议。

## 开发

从仓库根目录运行：

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

开发命令启动 Desktop host 和它的本地 sidecar。构建命令创建带有封闭 sidecar runtime 的 macOS 应用。

## 运行时与数据

WebView 使用浏览器的同源 HTTP 和 WebSocket 载体。Desktop host 不向该页面提供 Tauri IPC、invoke handler、remote capability、shell、文件系统或进程能力。回环依赖本机信任假设：它保护浏览器 API 不受跨站调用，但同一台机器上的其他进程仍可连接。

sidecar 解析与 `dsh` 相同的 `$DSH_HOME`。因此 profile、设置、凭据引用和会话在 CLI、浏览器 GUI 与 Desktop 应用之间保持共享。

## 生命周期

Desktop host 拥有 sidecar 进程树。它在导航前等待就绪，拒绝所有其他目标，并在 sidecar 退出时回到随附的失败页面。窗口退出和 host 终止信号使用同一关闭路径：host 发送 `SIGTERM`，最多等待六秒，然后只终止并回收其拥有的树。封闭 sidecar 还会监测其原始父进程。如果 host 未运行该路径就消失，sidecar 会请求普通应用 teardown，然后强制终止其专属进程组。

## 当前能力

Desktop 复用 Web GUI 的既有审批行为。在共享 API 协议实现 `ApiProxy.respond` 之前，它不提交审批响应。

设计理由和安全限制记录在 [Tauri Desktop 回环说明](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md)中。
