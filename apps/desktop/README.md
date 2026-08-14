# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is a Tauri application that packages the existing Web GUI. It starts the sealed `dsh` Web sidecar on `127.0.0.1` with an OS-assigned port, reads its ready URL, and loads that exact origin in its WebView. It does not assemble another Cordis application or introduce another API protocol.

## Development

From the repository root:

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

The development command starts the Desktop host and its local sidecar. The build command creates an unsigned release-shaped macOS application at `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app`.

## Release artifact

The supported distribution target is Apple Silicon macOS 13.5 or later. Desktop has no Intel or universal build, no automatic updater, and no compatibility promise beyond the Harness developer preview.

The sealed sidecar uses Node.js 24.19.0 and `@yao-pkg/pkg` 6.21.0. The application carries their provenance, the product and Node licenses, third-party notices, target-specific npm and Cargo CycloneDX SBOMs, and SHA-256 digests for the host, sidecar, ripgrep, and PTY helper. The release manifest rejects missing evidence, a mismatched deployment target, or an uncommitted source tree.

`pnpm run desktop:package-release` accepts an already built application, output directory, Developer ID Application identity, `notarytool` keychain profile, annotated `desktop-v<dsh-version>` tag, Apple Team ID, and minimum macOS version. It requires that tag to name the clean `HEAD`, signs nested code and the application with hardened runtime, notarizes and staples the application, creates and signs a DMG with an `/Applications` link, notarizes and staples the DMG, mounts it read-only for final code-signing and Gatekeeper verification, and writes `SHA256SUMS` plus `release-manifest.json`.

Credential-free CI builds and exercises the unsigned application but neither consumes Apple credentials nor publishes release assets. A signed release exists only after the packaging command completes with protected credentials. The release rationale is recorded in the [macOS Desktop release artifact note](../../.agents/notes/implemented/process/2026-08-14-macos-desktop-release-artifact.md).

## Runtime and data

The WebView uses the browser's same-origin HTTP and WebSocket carrier. The Desktop host provides no Tauri IPC, invoke handler, remote capability, shell, filesystem, or process capability to that page. Loopback relies on a local-machine trust assumption: it protects the browser API from cross-site callers, but other processes on the same machine can still connect to it.

The sidecar resolves the same `$DSH_HOME` as `dsh`. Profiles, settings, credential references, and sessions therefore remain shared between the CLI, browser GUI, and Desktop application.

Desktop pins the in-app directory browser for workspace selection. Directory listing and creation remain same-origin Host API operations, while the chooser stays inside the WebView and does not require a Tauri filesystem capability or a separately owned operating-system dialog. Ordinary `dsh web` deployments keep their adaptive native-or-browser picker.

## Lifecycle

The Desktop host owns the sidecar process tree. It waits for readiness before navigating, rejects every other destination, and returns to its bundled failure page if the sidecar exits. Window exit and host termination signals use the same shutdown path: the host sends `SIGTERM`, waits up to six seconds, then terminates and reaps only the owned tree. The sealed sidecar also watches its original parent. If the host disappears without running that path, the sidecar requests ordinary application teardown and then force-terminates its dedicated process group.

## Current capability

Desktop reuses the Web GUI's existing approval behavior. It does not submit approval responses until the shared API protocol implements `ApiProxy.respond`.

The rationale and the security limits are recorded in the [Tauri Desktop loopback note](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md).
