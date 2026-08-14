# Agent Note: Web 浏览器预期输出的必需 CI 门禁

Status: implemented

[English](2026-07-30-web-browser-snapshot-ci-gate.md) | 中文

## 问题

[无密钥 Web 浏览器 e2e 车道](2026-07-24-web-gui-browser-e2e-lane.md)会在本地比较已提交的浏览器预期输出，但拉取请求需要在合并前进行同样的回放断言。否则，行为变更可能留下陈旧的预期输出，直到无关的后续分支才会发现。

## 决策

[ci.yml](../../../../.github/workflows/ci.yml) 中的 `linux` 泳道会在每个主 CI 事件中运行完整 Web 浏览器 replay/compare 套件。`scripts/run-gates.ts` 将 `test:web:built` 纳入 `ci-linux-primary`，并明确提供 `DSH_SNAPSHOT=replay`；CI 从不使用 `record` 或 `refresh`，因此 golden 不匹配会失败，而不会在 runner 上改写预期输出。

Linux 泳道负责仓库构建，然后针对当前 `apps/web/dist` 和包 `lib/` 输出运行浏览器套件。它会在门禁前安装锁文件选定的 Chromium 及其托管系统依赖。浏览器检查仍面向 POSIX；原生 Windows 泳道不重复 Chromium 设置。

本地 `pnpm run test:web` 仍会在执行套件前构建，`test:web:built` 仍是已有构建产物的入口。开发者只会针对有意的用户可见变更运行 `DSH_SNAPSHOT=refresh pnpm run test:web`，评审随之产生的预期输出 diff，再以无写入的 replay 复验。

必需聚合流程依赖 Linux 泳道，因此浏览器不匹配会与其余主清单一样阻断稳定的 `all checks passed` 结果。[GitHub 托管 CI Note](../process/2026-08-14-independent-desktop-github-hosted-ci.md)记录当前的 runner 和聚合拓扑。

## 曾考虑的替代方案

**继续只要求本地运行。** 已否决：开发者记忆无法确保引入行为变更的拉取请求同时携带预期输出更新。

**让 CI 以 `refresh` 模式运行后检查工作树。** 已否决：先写后断言可能把回归变成生成出的更新；replay 直接比较已提交的 golden。

**新建独立 browser job。** 已否决：它会重复主 Linux 作业的不可变安装和构建，而该套件本已属于这条必需泳道。

**用 jsdom 快照代替 Chromium。** 已否决：jsdom 不覆盖组装后的浏览器、HTTP/SSE 承载或真实客户端插件组合。

## 后果

每次主 CI 运行都会证明组装后的 Web 应用与其已提交的浏览器预期输出一致。Linux 泳道承担 Chromium 设置和浏览器套件的成本，其余作业清单保持无浏览器。

该门禁不声称跨平台浏览器等价。Playwright 或 Chromium 升级若改变 ARIA 格式，就需要明确 refresh 并评审预期输出 churn。
