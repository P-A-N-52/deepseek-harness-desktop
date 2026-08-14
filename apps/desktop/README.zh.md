# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 是一个打包现有 Web GUI 的 Tauri 应用。它在 `127.0.0.1` 的操作系统分配端口上启动封闭的 `dsh` Web sidecar，读取其就绪 URL，并在 WebView 中加载该精确 origin。它不组装另一棵 Cordis 应用，也不引入另一套 API 协议。

## 开发

从仓库根目录运行：

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

开发命令启动 Desktop host 和它的本地 sidecar。构建命令在 `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app` 创建一个具备发行结构的 macOS 应用。该原始 Tauri 应用只是打包输入，不是可分发产物。

在 Windows host 上，`pnpm run desktop:build:windows` 生成相同的密封 sidecar 和 MSI 安装包（`--bundles msi`）作为替代。它运行相同的发行证据生成器，目标为 `x86_64-pc-windows-msvc`。

## 未签名开发者预览产物

支持的发行目标是 macOS 13.5 或更高版本的 Apple Silicon。Desktop 没有 Intel 或 universal 构建，没有自动更新器，也不提供超出 Harness 开发者预览范围的兼容性承诺。

封闭 sidecar 使用 Node.js 24.19.0 和 `@yao-pkg/pkg` 6.21.0。应用携带两者的来源记录、产品与 Node 许可证、第三方声明、特定目标的 npm 与 Cargo CycloneDX SBOM，以及 host、sidecar、ripgrep 和 PTY helper 的 SHA-256 摘要。发行清单会拒绝缺失的证据、不匹配的部署目标或有未提交改动的源码树。

在干净构建 revision 上创建 annotated `desktop-unsigned-v<dsh-version>` tag，从该 revision 构建应用，然后在本地打包：

```sh
pnpm run desktop:package-dmg -- \
  --app "apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app" \
  --output .artifacts/desktop-dmg \
  --minimum-macos 13.5 \
  --tag desktop-unsigned-v<dsh-version>

pnpm run desktop:verify-dmg -- \
  --input .artifacts/desktop-dmg \
  --minimum-macos 13.5 \
  --expected-tag desktop-unsigned-v<dsh-version>
```

打包器不会修改 Tauri 构建。它把应用复制到私有目录，为每个嵌套 Mach-O 和外层应用添加 ad-hoc hardened-runtime seal，创建带 `/Applications` 链接的未签名 DMG，以只读方式挂载镜像，并针对挂载副本重复 bundle 与 runtime 证据检查。它以原子方式写出且只写出三个文件：`DeepSeek-Harness-Desktop_<version>_aarch64_unsigned.dmg`、`SHA256SUMS` 和 `release-manifest.json`。

该产物没有 Apple Developer ID，且未经公证。Apple 没有认证其发布者或执行公证恶意软件检查，Gatekeeper 预计会拦截首次启动。SHA-256 摘要只能确认字节与从已信任来源获得的 manifest 一致，不能认证该来源。

把三个文件下载到同一目录，并在打开 DMG 前验证它们：

```sh
shasum -a 256 -c SHA256SUMS
```

把应用拖入 `/Applications` 并尝试启动一次。确认来源、版本与摘要后，按照 Apple 针对单个应用的例外流程进入**系统设置 → 隐私与安全性 → 仍要打开**。受管理的 Mac 可能禁止该例外。不要移除 quarantine attribute 或关闭 Gatekeeper。参见 [Apple 的安全打开应用指引](https://support.apple.com/en-gb/102445)。

无凭据 CI 会构建并运行原始应用，但不打包或发布 DMG。`pnpm run desktop:publish-dmg` 是本地 publisher；以下命令只验证产物并显示目标仓库：

```sh
pnpm run desktop:publish-dmg -- \
  --input .artifacts/desktop-dmg \
  --repo P-A-N-52/deepseek-harness-desktop \
  --tag desktop-unsigned-v<dsh-version>
```

干净 commit 与 annotated tag 已存在于 `origin` 后，只有在确实要写入 GitHub Release 时才为该命令追加 `--publish`。

发布动作仍不会增加 Apple 信任。发行决定记录在[本地未签名 macOS Desktop 说明](../../.agents/notes/implemented/process/2026-08-14-local-unsigned-macos-desktop-distribution.md)中。

## 运行时与数据

WebView 使用浏览器的同源 HTTP 和 WebSocket 载体。Desktop host 不向该页面提供 Tauri IPC、invoke handler、remote capability、shell、文件系统或进程能力。回环依赖本机信任假设：它保护浏览器 API 不受跨站调用，但同一台机器上的其他进程仍可连接。

sidecar 解析与 `dsh` 相同的 `$DSH_HOME`。因此 profile、设置、凭据引用和会话在 CLI、浏览器 GUI 与 Desktop 应用之间保持共享。

Desktop 固定使用应用内目录浏览器来选择工作区。目录列举和创建仍是同源 Host API 操作，而选择器留在 WebView 内，不需要 Tauri 文件系统能力或归属另一个进程的操作系统对话框。普通 `dsh web` 部署继续使用自适应的原生或浏览式选择器。

## 生命周期

Desktop host 拥有 sidecar 进程树。它在导航前等待就绪，拒绝所有其他目标，并在 sidecar 退出时回到随附的失败页面。窗口退出和 host 终止信号使用同一关闭路径：host 发送 `SIGTERM`，最多等待六秒，然后只终止并回收其拥有的树。封闭 sidecar 还会监测其原始父进程。如果 host 未运行该路径就消失，sidecar 会请求普通应用 teardown，然后强制终止其专属进程组。

## 当前能力

Desktop 复用 Web GUI 的既有审批行为。在共享 API 协议实现 `ApiProxy.respond` 之前，它不提交审批响应。

设计理由和安全限制记录在 [Tauri Desktop 回环说明](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md)中。
