# Agent Note: Tauri Desktop uses the loopback Web carrier

Status: implemented

[English](2026-08-13-tauri-desktop-loopback-shell.md) | 中文

## 问题

DeepSeek Harness 已有完整的浏览器 GUI、同源 API 载体和由 CLI 拥有的持久化 home。原生 Desktop 包必须让该 GUI 可分发，同时不能把它的 WebView 变成有特权的原生 client、创建平行的 RPC 载体，或把它的会话和设置与 `dsh` 分离。

## 决定

`apps/desktop` 是围绕封闭 Desktop `dsh` 入口的 Tauri shell。它在 `127.0.0.1` 的端口 `0` 上启动 Web profile，读取 sidecar 的就绪 URL，并在一个 WebView 中打开该精确的回环 origin。浏览器 HTTP 请求和两条 WebSocket downlink 仍是对现有载体的同源调用。这保持了 [GUI 分层](2026-07-19-gui-layering-and-rpc-protocol.md)、[API 信任](2026-07-28-api-browser-trust-boundary.md)和 [WebSocket 载体](2026-08-04-websocket-downlink-carrier.md)的既有决定。

该页面不获得 Tauri IPC、invoke handler、remote capability、shell、文件系统或进程能力。导航仅允许到已就绪的回环 origin。`$DSH_HOME` 仍是 sidecar 所解析的 Harness home，因此 profile、设置、凭据引用和会话与 `dsh` 共享。

封闭入口把自身的可执行文件闭包选作应用模块树。App boot 既从该树导入裸 Cordis 插件，也通过它提供 `ctx.appModuleResolver`；client 模块注册表经该服务解析每个 `dsh.client` 包 manifest，agent preset 子树则以其 `moduleBaseUrl` 导入裸包行。被包含配置的上下文仍以 profile 为基准，因此物理 `$DSH_HOME` profile 无法替换或隐藏从闭包选定的代码或元数据。随附 agent preset 通过枚举快照目录名称并检查其路径来发现，不依赖封闭文件系统提供带原型的 `Dirent`。

封闭入口固定使用浏览式目录选择器组合。目录列举和创建通过现有同源 Host API 传输，交互则留在 WebView 内。它既不向页面授予 Tauri 文件系统能力，也不把选择器窗口交给 `osascript` 子进程。普通 Web profile 保留自适应选择器，因为其宿主和浏览器可能有不同的部署需要。

Desktop shell 不增加审批响应路径。在既有 API 协议实现 `ApiProxy.respond` 之前，待审批项继续保持现有 GUI 的仅展示行为。

## 生命周期

Rust host 拥有一棵以专属进程组为根的 sidecar 进程树。它只会在成功就绪后导航。窗口退出、启动失败和 host 终止信号进入同一条幂等关闭路径：host 发送 `SIGTERM`，最多等待六秒，然后发送 `SIGKILL`，并且只回收其拥有的树。封闭 sidecar 会监测其原始父进程。如果 host 未运行该路径就消失，sidecar 会请求普通应用 teardown，并在 teardown 完成或达到时限后强制终止其专属进程组。sidecar 退出会使已接受的 URL 失效，并让应用回到随附的失败页面，而非跟随之后取得该端口的无关服务。

## 验证

Desktop 检查覆盖 sidecar 命令构造、就绪 URL 准入、启动失败和关闭。最终 SEA 通过 Chromium 运行，以证明插件激活、onboarding 和应用内工作区选择器。已打包应用的生命周期检查会启动原生 host，识别其直接 sidecar 与回环 listener，终止 host，证明进程树和端口已经消失，并针对同一 `$DSH_HOME` 重启。Chromium 和 API 检查不声称覆盖原生 WebView 交互。

## 考虑过的替代方案

**`file://` 或自定义 Tauri 协议加 IPC。** 未采用，因为它会创建第二个 API 载体、脱离浏览器同源路径，并在尚无必要时要求有特权的 WebView 集成。

**Tauri remote capability。** 未采用，因为回环页面不需要原生命令、文件系统访问、进程访问或 IPC；授予其中任何一项都会扩大本地代码执行面。

**独立的 Desktop home。** 未采用，因为它会无产品收益地分叉 CLI 的 profile、会话、设置和凭据引用。

## 后果

Desktop 应用复用 Web UI、API 信任栅栏和 WebSocket 载体，无需另一套 client 协议。回环依赖本机信任假设，而不是对其他本机进程的隔离。原生能力功能和审批响应不属于首日应用。
