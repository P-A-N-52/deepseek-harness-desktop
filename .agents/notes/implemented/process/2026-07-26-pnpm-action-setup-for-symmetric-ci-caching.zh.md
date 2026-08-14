# Agent Note: 经由 pnpm/action-setup 提供 CI 的 pnpm

Status: implemented

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

CI 需要一种可复现的统一 pnpm 提供方式：它不能依赖 runner 镜像中是否安装 Corepack，也不能把由 action 管理的可执行文件放在共享的相对主目录中。

独立 Desktop 仓库现有主 CI、Desktop macOS 验证、文档验证、手动真实 API e2e，以及发布或 sandbox 工作流。它们必须就锁定的 pnpm 版本保持一致，同时保留各工作流独立的缓存选择。

## 决策

每个需要 pnpm 的仓库工作流都通过 `pnpm/action-setup@v6` 提供它；没有工作流运行 `corepack enable`。每个 action 步骤都使用 `dest: ${{ runner.temp }}/setup-pnpm` 与 `version: 11.7.0`，并与根目录的 `packageManager` 声明保持一致。

主[GitHub 托管 CI 拓扑](2026-08-14-independent-desktop-github-hosted-ci.md)、[Desktop macOS 工作流](../../../../.github/workflows/desktop-ci.yml)、文档验证和手动真实 API e2e 都使用同一 action 版本与明确的 pnpm 版本。仅在自行选择缓存的工作流中，`actions/setup-node` 才负责 pnpm store 缓存；pnpm 提供与缓存策略是彼此独立的关注点。

根目录的 `@yarnpkg/cli-dist` 开发依赖另行提供 generated-project 测试所使用的现代 Yarn CLI，因此该覆盖率不会沿用 runner 镜像中的 Yarn Classic。

## 曾考虑的替代方案

- **在每个工作流中使用 `corepack enable`** — 否决：Corepack 是否可用属于 runner 镜像状态，而不是仓库锁定的工具链。
- **让每个工作流从未固定版本的 action 设置中推断 pnpm** — 否决：发布的 pnpm 版本必须在工作流中可见，并与 `package.json` 同步。
- **用一个组合 action 包装提供与缓存** — 否决：轻量验证、发布形态和平台专属工作流仍有不同的缓存策略；包装层只会重复这些输入。
- **依赖 runner 镜像中的 Yarn** — 否决：generated-project 覆盖率需要仓库锁定的现代 Yarn CLI，而不是 Yarn Classic。

## 后果

每个 CI 工作流都从相同的 pnpm action 主版本、明确的 pnpm 版本和 runner 专属目标目录开始。变更版本时，根 package-manager 声明和工作流 pin 一同更新，而缓存调优仍归拥有其延迟与存储取舍的工作流管理。

明确的目标目录把 pnpm 由 action 管理的可执行文件目录与包 store 分开，CI 工作流规范会对每个仓库工作流的 pnpm 设置步骤强制执行这一不变量。
