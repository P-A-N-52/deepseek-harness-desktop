# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 是一个打包现有 Web GUI 的 Tauri 应用。它在 `127.0.0.1` 的操作系统分配端口上启动封闭的 `dsh` Web sidecar，读取其就绪 URL，并在 WebView 中加载该精确 origin。它不组装另一棵 Cordis 应用，也不引入另一套 API 协议。

## 开发

从仓库根目录运行：

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

开发命令启动 Desktop host 和它的本地 sidecar。构建命令在 `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app` 创建一个未签名但具备发行结构的 macOS 应用。

## 发行产物

支持的发行目标是 macOS 13.5 或更高版本的 Apple Silicon。Desktop 没有 Intel 或 universal 构建，没有自动更新器，也不提供超出 Harness 开发者预览范围的兼容性承诺。

封闭 sidecar 使用 Node.js 24.19.0 和 `@yao-pkg/pkg` 6.21.0。应用携带两者的来源记录、产品与 Node 许可证、第三方声明、特定目标的 npm 与 Cargo CycloneDX SBOM，以及 host、sidecar、ripgrep 和 PTY helper 的 SHA-256 摘要。发行清单会拒绝缺失的证据、不匹配的部署目标或有未提交改动的源码树。

`pnpm run desktop:package-release` 接受已构建应用、输出目录、Developer ID Application identity、`notarytool` keychain profile、annotated `desktop-v<dsh-version>` tag、Apple Team ID 和最低 macOS 版本。该命令要求 tag 指向干净的 `HEAD`，以 hardened runtime 签署嵌套代码和应用，对应用执行公证与 staple，创建带 `/Applications` 链接的 DMG 并签名，对 DMG 执行公证与 staple，以只读方式挂载 DMG 完成最终代码签名和 Gatekeeper 验证，并写出 `SHA256SUMS` 与 `release-manifest.json`。

无凭据 CI 会构建并运行未签名应用，但不会使用 Apple 凭据或发布发行资产。只有打包命令使用受保护凭据完整成功后，签名发行版才存在。发行理由记录在 [macOS Desktop 发行产物说明](../../.agents/notes/implemented/process/2026-08-14-macos-desktop-release-artifact.md)中。

## 运行时与数据

WebView 使用浏览器的同源 HTTP 和 WebSocket 载体。Desktop host 不向该页面提供 Tauri IPC、invoke handler、remote capability、shell、文件系统或进程能力。回环依赖本机信任假设：它保护浏览器 API 不受跨站调用，但同一台机器上的其他进程仍可连接。

sidecar 解析与 `dsh` 相同的 `$DSH_HOME`。因此 profile、设置、凭据引用和会话在 CLI、浏览器 GUI 与 Desktop 应用之间保持共享。

Desktop 固定使用应用内目录浏览器来选择工作区。目录列举和创建仍是同源 Host API 操作，而选择器留在 WebView 内，不需要 Tauri 文件系统能力或归属另一个进程的操作系统对话框。普通 `dsh web` 部署继续使用自适应的原生或浏览式选择器。

## 生命周期

Desktop host 拥有 sidecar 进程树。它在导航前等待就绪，拒绝所有其他目标，并在 sidecar 退出时回到随附的失败页面。窗口退出和 host 终止信号使用同一关闭路径：host 发送 `SIGTERM`，最多等待六秒，然后只终止并回收其拥有的树。封闭 sidecar 还会监测其原始父进程。如果 host 未运行该路径就消失，sidecar 会请求普通应用 teardown，然后强制终止其专属进程组。

## 当前能力

Desktop 复用 Web GUI 的既有审批行为。在共享 API 协议实现 `ApiProxy.respond` 之前，它不提交审批响应。

设计理由和安全限制记录在 [Tauri Desktop 回环说明](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md)中。
