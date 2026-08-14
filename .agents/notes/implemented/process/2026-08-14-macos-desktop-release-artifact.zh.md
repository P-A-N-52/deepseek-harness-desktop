# Agent Note: macOS Desktop release artifact

Status: implemented

[English](2026-08-14-macos-desktop-release-artifact.md) | 中文

## 问题

回环 Desktop shell 组合了四个独立构建的 Mach-O 程序：Tauri host、Node single executable application、ripgrep 和 PTY spawn helper。除非这些程序的架构与部署目标一致、JavaScript 与 Rust 依赖闭包得到披露，并且 Apple 能验证外层 bundle 启动的每个代码对象，否则可在本地运行的应用并不是可分发的 macOS 发行版。

封闭 Node runtime 还引入了 pnpm lockfile 之外的源码材料。发行版必须标识精确的 Node carrier 与 packer，保留适用的许可证，并把生成字节绑定到与应用相同的源码 revision 和版本。

## 决定

Desktop 发行版面向 `aarch64-apple-darwin`，并把四个可执行文件中最高的部署目标 macOS 13.5 声明为最低版本。该产品是手动更新的社区 Apple Silicon 发行版，不声称支持 Intel、universal binary 或其他操作系统。

根 dsh semver 是发行标识。Cargo 携带完全相同的 semver。Tauri 把数字核心用作 `CFBundleShortVersionString`，并把带编号的 alpha、beta、preview 和 release candidate 阶段映射到有序的数字 `CFBundleVersion` 范围。dsh 发行版本提升会一起更新并验证这三种表示。

封闭 runtime 使用 Node.js 24.19.0 和 `@yao-pkg/pkg` 6.21.0。其 producer 把每个允许的目标固定到 Node 发行校验文件公布的 SHA-256，在打包前验证 archive，并向打过 patch 的 packer 提供只含这些已验证字节的全新构建专用 SEA cache。保留的 archive 按内容寻址，并在提供 Node 许可证前再次验证。Desktop 构建把目标原生的 ripgrep 与 PTY helper 复制为资源，再生成包含源码状态、版本、各可执行文件大小、SHA-256 摘要、架构、部署目标和产品最低版本的发行清单。特定目标的 npm CycloneDX SBOM 会把每个已部署 package 实例映射到唯一的 pnpm importer 或 package-and-snapshot 记录，并携带 registry SHA-512 integrity；Cargo SBOM 跟随已锁定的目标图。产品许可证和第三方声明会与这些文档一起在 Tauri 组装应用前生成。

签名发行从 annotated `desktop-v<dsh-version>` tag 所命名的干净 `HEAD` 开始。打包器会验证未签名应用的证据，在外层应用之前签署嵌套 Mach-O 文件与 code bundle，并且只向 Node sidecar 授予 `sidecar-entitlements.plist` 中记录的四项 hardened runtime entitlement。它对应用执行公证与 staple，创建并签署包含应用和 `/Applications` 链接的 DMG，对 DMG 执行公证与 staple，以只读方式挂载它，并针对已挂载应用重复代码签名、staple 和 Gatekeeper 检查。生成目录包含 DMG、`SHA256SUMS`，以及绑定 tag commit 和 Apple Team ID 的发行清单。

无凭据 CI 在 Apple Silicon runner 上构建应用、检查生成证据、在 Chromium 中启动最终 SEA，并验证原生 host 的进程所有权与重启。它既不读取 Apple 签名凭据，也不发布资产。发行操作者通过受保护环境向打包命令提供 Developer ID identity 和 `notarytool` keychain profile。

## 考虑过的替代方案

**发布本地 ad-hoc 应用。** Gatekeeper 无法为该产物建立 Developer ID、公证票据或受信任磁盘镜像，因此可运行 preview 不会被表述为发行版。

**只签署外层应用。** sidecar 和资源可执行文件都是会被启动的代码。在应用外层 seal 之前签署每个已发现的 Mach-O 与嵌套 code bundle，可以明确 hardened runtime identity。

**从整个 monorepo 生成一份 SBOM。** 与平台不兼容的 optional package 和仅开发使用的 crate 不会进入 arm64 应用。发行证据改为跟随已部署 npm 闭包和经过目标筛选的非开发 Cargo 图。

**从一次 arm64 构建交付 universal binary。** SEA carrier、ripgrep、PTY helper 和 Rust host 都是目标原生产品。universal 发行需要独立验证的 x86_64 输入和另一项组合决定，而不是给一种架构重新贴标签。

**在首个发行版中启用自动更新。** Desktop 与 CLI 共享 `$DSH_HOME`，而预发行会话和设置格式没有降级承诺。手动更新避免在这些数据策略存在前建立更新与回滚保证。

## 后果

Desktop 构建体积大、依赖目标且比单独构建 Tauri host 更慢，因为应用携带完整的封闭 runtime 和法律证据。发行准备需要干净的源码树、annotated 版本 tag、Apple 凭据和成功的在线公证。缺失来源记录、版本不一致、未声明的可执行文件、过低的 bundle 部署目标、意外 entitlement 或被改变的 DMG 都会使发行失败，而不会回退到未签名产物。

同一组证据让发行版在发布后无需依赖构建机器即可审计。只有签名与公证产物的 verifier 完成后，公开发行版才存在；未签名的 CI 应用仍是 preview。
