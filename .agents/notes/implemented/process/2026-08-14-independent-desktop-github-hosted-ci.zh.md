# Agent Note: 独立 Desktop 的 GitHub 托管 CI

Status: implemented

[English](2026-08-14-independent-desktop-github-hosted-ci.md) | 中文

## 问题

独立私有 Desktop 仓库需要一个易于理解的必需 CI 结论，同时不能依赖组织专属容量、自托管维护或另一套基准测试拓扑。

Desktop 打包专属于 macOS 和 Apple Silicon，但这种接近发布的工作不能让普通仓库检查依赖 macOS runner，也不能把主 CI 的结论变成 Desktop 发布判定。

## 决策

[CI](../../../../.github/workflows/ci.yml) 在标准 GitHub 托管 runner 上使用五条阻断性泳道：`linux`、`node-compat`、`python-sdk`、`python-runtime` 和原生 `windows`。始终运行的 `all-checks-passed` 聚合作业会在任一泳道未成功时失败，为分支保护提供一个稳定结论。

主 CI 工作流由拉取请求、推送到 `master` 和手动派发触发。它的工作流级并发组会为这三种事件中的每一种取消被取代的运行。其中不包含自托管选择器、自定义 runner 标签、故障切换变量或手动 runner 基准测试。

[Desktop macOS](../../../../.github/workflows/desktop-ci.yml) 保持为独立且受路径约束的工作流。其 `desktop-arm64` 作业运行在 Apple Silicon 的 `macos-15` 镜像上，验证封装后的 Desktop 构建，但不成为仓库聚合结论的依赖。Desktop 工作流的并发策略由其自身单独负责。

需要 pnpm 的主作业通过 `pnpm/action-setup@v6` 按仓库明确指定的 `11.7.0` 版本提供它；[pnpm 提供决策](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md)负责该设置策略。原生 Windows 是一项标准托管的必需结果；其阻断性构建范围直接体现在主工作流中。

## 曾考虑的替代方案

- **保留大规格、自定义或自托管 runner 池** — 否决：必需结论会依赖本仓库之外的基础设施，并需要独立的恢复流程。
- **保留串行参考作业或 runner 基准测试** — 否决：它们会增加第二套 CI 拓扑，却不改变分支保护结论。
- **把 Desktop 打包放入主聚合流程** — 否决：Desktop 是变更面更窄的发布形态 macOS 工作，而不是仓库范围的质量泳道。
- **仅取消拉取请求运行** — 否决：同一 ref 上较早的推送或手动运行同样已经被取代。

## 后果

贡献者可以在普通 GitHub 托管镜像和不可变安装上复现必需作业清单。排队时间和性能变化通过普通运行观察，而非通过保留的基准测试机群。

聚合流程有意仅限五条主泳道。Desktop 验收在其独立工作流中报告，真实提供方覆盖率则仍是单独的[手动真实 API e2e 决策](../testing/2026-08-14-manual-real-api-e2e-for-independent-desktop.md)所规定的显式操作。
