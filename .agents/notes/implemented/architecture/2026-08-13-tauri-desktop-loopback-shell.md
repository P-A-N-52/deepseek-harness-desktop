# Agent Note: Tauri Desktop uses the loopback Web carrier

Status: implemented

English | [中文](2026-08-13-tauri-desktop-loopback-shell.zh.md)

## Problem

DeepSeek Harness already has a complete browser GUI, a same-origin API carrier, and a CLI-owned persistent home. A native desktop package must make that GUI distributable without making its WebView a privileged native client, creating a parallel RPC carrier, or separating its sessions and settings from `dsh`.

## Decision

`apps/desktop` is a Tauri shell around the sealed desktop `dsh` entry. It starts the Web profile on `127.0.0.1` with port `0`, reads the sidecar's readiness URL, and opens that exact loopback origin in one WebView. Browser HTTP requests and both WebSocket downlinks remain same-origin calls to the existing carrier. This preserves the [GUI layering](2026-07-19-gui-layering-and-rpc-protocol.md), [API trust](2026-07-28-api-browser-trust-boundary.md), and [WebSocket carrier](2026-08-04-websocket-downlink-carrier.md) decisions.

The page receives no Tauri IPC, invoke handler, remote capability, shell, filesystem, or process capability. Navigation is admitted only to the ready loopback origin. `$DSH_HOME` remains the sidecar's resolved Harness home, so profiles, settings, credential references, and sessions are shared with `dsh`.

The sealed entry selects its executable closure as the application module tree. App boot uses that tree both to import bare Cordis plugins and to provide `ctx.appModuleResolver`; the client module registry resolves every `dsh.client` package manifest through that service, and agent preset subtrees use its `moduleBaseUrl` for bare rows. The included configuration context remains profile-relative, so a physical `$DSH_HOME` profile cannot displace or hide code or metadata selected from the closure. Shipped agent presets enumerate snapshot directory names and inspect their paths without depending on `Dirent` prototypes from the sealed filesystem.

The sealed entry pins the browse directory-picker composition. Directory listing and creation travel through the existing same-origin Host API, while the interaction remains inside the WebView. It neither grants the page a Tauri filesystem capability nor delegates the chooser window to an `osascript` child. The ordinary Web profile keeps its adaptive picker because its host and browser may have different deployment needs.

The desktop shell does not add an approval-response path. A pending approval continues to have the existing GUI's display-only behavior until the established API protocol implements `ApiProxy.respond`.

## Lifecycle

The Rust host owns one sidecar process tree rooted in a dedicated process group. It does not navigate before successful readiness. Window exit, startup failure, and host termination signals enter one idempotent shutdown path: the host sends `SIGTERM`, waits up to six seconds, then sends `SIGKILL` and reaps only its owned tree. The sealed sidecar watches its original parent. If the host disappears without running that path, the sidecar requests ordinary application teardown and force-terminates its dedicated process group after teardown completes or reaches its bound. A sidecar exit invalidates the accepted URL and returns the application to its bundled failure page rather than following an unrelated service that later obtains the port.

## Verification

Desktop checks cover sidecar command construction, ready-URL admission, startup failure, and shutdown. The final SEA runs through Chromium to prove plugin activation, onboarding, and the in-app workspace picker. The packaged application lifecycle check launches the native host, identifies its direct sidecar and loopback listener, terminates the host, proves the process tree and port are gone, and restarts it against the same `$DSH_HOME`. Chromium and API checks do not claim native WebView interaction coverage.

## Alternatives considered

**`file://` or a custom Tauri protocol plus IPC.** Rejected because it would create a second API carrier, fall outside the browser same-origin path, and require a privileged WebView integration before one is needed.

**Tauri remote capabilities.** Rejected because the loopback page does not need native commands, filesystem access, process access, or IPC; granting any of them would enlarge the local code-execution surface.

**A separate Desktop home.** Rejected because it would fork the CLI's profiles, sessions, settings, and credential references for no product benefit.

## Consequences

The desktop application reuses the Web UI, API trust fence, and WebSocket carrier without another client protocol. Loopback relies on a local-machine trust assumption, not isolation from other local processes. Native capability features and an approval response are not part of the first-day application.
