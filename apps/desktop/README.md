# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is a Tauri application that packages the existing Web GUI. It starts the sealed `dsh` Web sidecar on `127.0.0.1` with an OS-assigned port, reads its ready URL, and loads that exact origin in its WebView. It does not assemble another Cordis application or introduce another API protocol.

## Development

From the repository root:

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

The development command starts the Desktop host and its local sidecar. The build command creates the macOS application with its closed sidecar runtime.

## Runtime and data

The WebView uses the browser's same-origin HTTP and WebSocket carrier. The Desktop host provides no Tauri IPC, invoke handler, remote capability, shell, filesystem, or process capability to that page. Loopback relies on a local-machine trust assumption: it protects the browser API from cross-site callers, but other processes on the same machine can still connect to it.

The sidecar resolves the same `$DSH_HOME` as `dsh`. Profiles, settings, credential references, and sessions therefore remain shared between the CLI, browser GUI, and Desktop application.

## Lifecycle

The Desktop host owns the sidecar process tree. It waits for readiness before navigating, rejects every other destination, and returns to its bundled failure page if the sidecar exits. Window exit and host termination signals use the same shutdown path: the host sends `SIGTERM`, waits up to six seconds, then terminates and reaps only the owned tree. The sealed sidecar also watches its original parent. If the host disappears without running that path, the sidecar requests ordinary application teardown and then force-terminates its dedicated process group.

## Current capability

Desktop reuses the Web GUI's existing approval behavior. It does not submit approval responses until the shared API protocol implements `ApiProxy.respond`.

The rationale and the security limits are recorded in the [Tauri Desktop loopback note](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md).
