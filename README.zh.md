# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的实验性 macOS Tauri 发行版。原生 host 会监管封闭的 `dsh web` sidecar，让它在临时 IPv4 回环端口提供服务，并直接加载现有 Harness Web UI；本项目不分叉 UI，也不引入另一套 API 协议。

本仓库暂时保留完整 Harness monorepo，因为封闭运行时仍依赖内部启动、客户端模块、CLI 生命周期和文件系统搜索改动。上游 Git 历史保持完整，官方仓库被配置为只读 `upstream` remote。

## Desktop 状态

Desktop 发行目标是 macOS 13.5 或更高版本的 Apple Silicon。本地构建产出未签名但具备发行结构的 `.app`；发行打包器会校验干净的 annotated tag，应用 Developer ID 签名和 hardened runtime entitlement，对应用与 DMG 进行公证和 staple，挂载 DMG 完成最终验证，并生成校验和与发行清单。在这些签名检查通过前，任何产物都不是公开发行版。当前不支持自动更新、Intel 构建和其他操作系统。

```sh
pnpm install
pnpm run desktop:build
```

应用产物位于 `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app`。运行时、数据、安全性、生命周期和发行行为见 Desktop 指南（[English](apps/desktop/README.md) | [中文](apps/desktop/README.zh.md)）。

## 上游项目

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
