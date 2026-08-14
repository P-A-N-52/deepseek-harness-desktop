# Agent Note: 本地未签名 macOS Desktop 发行

Status: implemented

[English](2026-08-14-local-unsigned-macos-desktop-distribution.md) | 中文

## 问题

Desktop 应用需要一份无需 GitHub Actions、Apple Developer ID 或公证即可重复生成的 macOS 交付产物。Tauri 的原始构建可以在本地启动，但封闭 runtime 与法律资源组装完成后，外层应用 seal 并不是有效的可分发 ad-hoc seal。直接把该应用复制进 DMG 会把无效 bundle 表述为完成的产物。

未签名产物的信任模型也不同于 Developer ID 发行。它不能认证发布者，无法获得 Apple 的公证恶意软件检查，也不能通过 Gatekeeper 的常规已识别开发者评估。产物元数据与安装说明必须明确这些限制。

## 决定

交付产物是面向 macOS 13.5 或更高版本的 Apple Silicon 开发者预览 DMG。打包从 annotated `desktop-unsigned-v<dsh-version>` tag 命名的干净 `HEAD` 开始。它保留发行准备阶段生成的封闭 runtime 证据、许可证、第三方声明、npm 与 Cargo CycloneDX SBOM、目标元数据和各可执行文件摘要。

本地打包器先验证不可变的 Tauri 应用，把它复制到同一文件系统上的私有 staging 目录，并且只修改该副本。它先为每个 Mach-O 文件与嵌套 code bundle 应用 hardened-runtime ad-hoc 签名，再 seal 外层应用。Node sidecar 只获得 `sidecar-entitlements.plist` 中的四项 entitlement。验证要求有效的 strict 外层 seal、每个会被启动的代码对象都带有无 authority、Team ID 与 timestamp 的 ad-hoc 签名、固定的 sidecar entitlement，以及原始 runtime 证据。

打包器创建包含应用与 `/Applications` 链接的未签名压缩 DMG。它以只读方式挂载镜像，验证精确的根目录清单，并针对挂载副本重复应用、Mach-O、entitlement、runtime 证据、架构和部署目标检查。输出目录以原子方式创建，并且只包含 DMG、`SHA256SUMS` 和 `release-manifest.json`。manifest 明确说明应用使用 ad-hoc 签名、磁盘镜像未签名、不存在 Developer ID 与公证、需要 Gatekeeper 批准且更新必须手动完成。打包完成后会再次验证原始 Tauri 应用，因此重复运行不会依赖已被前一次打包修改的构建输入。

无凭据 CI 继续构建并运行原始应用、封闭 sidecar、浏览器流程和 host 生命周期。它不打包或发布 DMG。本地发布是独立命令，默认模式只验证 tag 与产物。该命令只有在显式传入 `--publish` 时才写入 GitHub Release；它要求 tag commit 等于远端默认分支，要求远端 annotated tag object 等于本地 object，只把三个声明文件上传到 draft，下载并逐字节比较这些文件，并且只在检查通过后公开 draft。

安装指引会把 DMG 标识为未签名且未经公证。用户需要先验证来源、版本和 SHA-256，尝试启动一次，并且只在接受该来源时通过 macOS 系统设置批准被拦截的应用。文档不会建议移除 quarantine attribute 或关闭 Gatekeeper。受管理的 Mac 可能禁止该例外。

## 考虑过的替代方案

**把 Tauri 替换为 Electron。** Electron 仍然需要 Developer ID 与公证才能进入 Apple 信任路径，同时会增加另一份 Chromium runtime 并替换已工作的回环 host。它不能解决未签名发行限制。

**分发原始 Tauri 应用。** 组装后的应用没有有效的 strict 外层 seal。只有在私有打包副本上重新 seal，才能把 bundle 表述为内部一致。

**在原构建产物上就地执行 ad-hoc 签名。** 签名会修改 pre-sign 证据覆盖的 bundle 字节，并让第二次打包依赖第一次。保持 Tauri 应用不可变可以维持可重复性，并分离构建验证与交付 seal。

**保留 Developer ID 签名与公证。** 该路径提供 Apple 发布者身份、公证检查和常规 Gatekeeper 体验，但它需要 Apple 凭据与独立的凭据型发行系统。这些保证被明确排除在本发行方式之外。

**要求用户移除 quarantine 或关闭 Gatekeeper。** 这些命令会削弱系统级安全控制并掩盖产物的信任状态。支持的例外是在独立验证来源与摘要后，通过 macOS 针对单个应用执行批准流程。

**加入 Intel、universal binary 或自动更新。** SEA carrier、ripgrep、PTY helper 与 Rust host 都是目标原生产物，而 Desktop 与 CLI 共享预发行数据且没有降级承诺。这些功能需要独立的 runtime、兼容性和回滚决策。

## 后果

DMG 可以重复组装且内部一致，但它不是 Apple 信任的发行版。Gatekeeper 预计会拦截首次启动，Apple 没有认证发布者或执行公证检查，SHA-256 只能证明下载字节与从已信任来源获得的 manifest 一致。部分受管理的 Mac 无法运行该应用。

本发行方式仍然只支持 arm64，需要 macOS 13.5 或更高版本，并采用手动更新。用户在切换版本前应备份共享的 `$DSH_HOME`。本地 publisher 可以在没有发行自动化的情况下提供产物，但发布动作不会提升其信任保证。
