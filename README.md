# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is an experimental macOS Tauri distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The native host supervises a sealed `dsh web` sidecar on an ephemeral IPv4 loopback port and loads the existing Harness Web UI directly; it does not fork the UI or introduce another API protocol.

This repository temporarily carries the complete Harness monorepo because the sealed runtime still depends on internal boot, client-module, CLI lifecycle, and filesystem-search changes. The upstream Git history is preserved, and the official repository is configured as the read-only `upstream` remote.

## Desktop status

The Desktop target is Apple Silicon macOS 13.5 or later. Local builds produce a release-shaped `.app`; the local packager verifies a clean annotated tag, ad-hoc seals a private copy with hardened runtime, mounts and verifies an unsigned DMG, and emits checksums plus an explicit trust manifest. The DMG has no Apple Developer ID and is not notarized, so Gatekeeper approval is expected and the artifact does not authenticate its publisher. Automatic updates, Intel builds, and other operating systems are not supported.

```sh
pnpm install
pnpm run desktop:build
```

The application is produced at `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app`. See the Desktop guide ([English](apps/desktop/README.md) | [中文](apps/desktop/README.zh.md)) for its runtime, data, security, lifecycle, and release behavior.

## Upstream project

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
