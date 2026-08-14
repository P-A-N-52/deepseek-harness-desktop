# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is a Tauri application that packages the existing Web GUI. It starts the sealed `dsh` Web sidecar on `127.0.0.1` with an OS-assigned port, reads its ready URL, and loads that exact origin in its WebView. It does not assemble another Cordis application or introduce another API protocol.

## Development

From the repository root:

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

The development command starts the Desktop host and its local sidecar. The build command creates a release-shaped macOS application at `apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app`. That raw Tauri application is a packaging input, not the distributable artifact.

## Unsigned developer-preview artifact

The supported distribution target is Apple Silicon macOS 13.5 or later. Desktop has no Intel or universal build, no automatic updater, and no compatibility promise beyond the Harness developer preview.

The sealed sidecar uses Node.js 24.19.0 and `@yao-pkg/pkg` 6.21.0. The application carries their provenance, the product and Node licenses, third-party notices, target-specific npm and Cargo CycloneDX SBOMs, and SHA-256 digests for the host, sidecar, ripgrep, and PTY helper. The release manifest rejects missing evidence, a mismatched deployment target, or an uncommitted source tree.

Create an annotated `desktop-unsigned-v<dsh-version>` tag on a clean build revision, build the application from that revision, and package it locally:

```sh
pnpm run desktop:package-dmg -- \
  --app "apps/desktop/src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app" \
  --output .artifacts/desktop-dmg \
  --minimum-macos 13.5 \
  --tag desktop-unsigned-v<dsh-version>

pnpm run desktop:verify-dmg -- \
  --input .artifacts/desktop-dmg \
  --minimum-macos 13.5 \
  --expected-tag desktop-unsigned-v<dsh-version>
```

The packager never changes the Tauri build. It copies the application into a private directory, gives every nested Mach-O and the outer application an ad-hoc hardened-runtime seal, creates an unsigned DMG with an `/Applications` link, mounts the image read-only, and repeats the bundle and runtime-evidence checks against the mounted copy. It atomically writes exactly three files: `DeepSeek-Harness-Desktop_<version>_aarch64_unsigned.dmg`, `SHA256SUMS`, and `release-manifest.json`.

This artifact has no Apple Developer ID and is not notarized. Apple has not authenticated its publisher or performed the notarization malware check, and Gatekeeper is expected to block its first launch. A SHA-256 digest confirms only that the bytes match a manifest obtained from a source you already trust; it does not authenticate that source.

Download all three files into one directory and verify them before opening the DMG:

```sh
shasum -a 256 -c SHA256SUMS
```

Drag the application to `/Applications` and try to open it once. After confirming the source, version, and digest, follow Apple's per-application exception path in **System Settings → Privacy & Security → Open Anyway**. Managed Macs may prohibit that exception. Do not remove quarantine attributes or disable Gatekeeper. See [Apple's guidance for opening apps safely](https://support.apple.com/en-gb/102445).

Credential-free CI builds and exercises the raw application but does not package or publish the DMG. `pnpm run desktop:publish-dmg` is a local publisher; the command below only verifies the artifact and shows the intended repository:

```sh
pnpm run desktop:publish-dmg -- \
  --input .artifacts/desktop-dmg \
  --repo P-A-N-52/deepseek-harness-desktop \
  --tag desktop-unsigned-v<dsh-version>
```

After the clean commit and annotated tag exist on `origin`, append `--publish` to that command only for an intentional GitHub Release write.

Publication still does not add Apple trust. The distribution decision is recorded in the [local unsigned macOS Desktop note](../../.agents/notes/implemented/process/2026-08-14-local-unsigned-macos-desktop-distribution.md).

## Runtime and data

The WebView uses the browser's same-origin HTTP and WebSocket carrier. The Desktop host provides no Tauri IPC, invoke handler, remote capability, shell, filesystem, or process capability to that page. Loopback relies on a local-machine trust assumption: it protects the browser API from cross-site callers, but other processes on the same machine can still connect to it.

The sidecar resolves the same `$DSH_HOME` as `dsh`. Profiles, settings, credential references, and sessions therefore remain shared between the CLI, browser GUI, and Desktop application.

Desktop pins the in-app directory browser for workspace selection. Directory listing and creation remain same-origin Host API operations, while the chooser stays inside the WebView and does not require a Tauri filesystem capability or a separately owned operating-system dialog. Ordinary `dsh web` deployments keep their adaptive native-or-browser picker.

## Lifecycle

The Desktop host owns the sidecar process tree. It waits for readiness before navigating, rejects every other destination, and returns to its bundled failure page if the sidecar exits. Window exit and host termination signals use the same shutdown path: the host sends `SIGTERM`, waits up to six seconds, then terminates and reaps only the owned tree. The sealed sidecar also watches its original parent. If the host disappears without running that path, the sidecar requests ordinary application teardown and then force-terminates its dedicated process group.

## Current capability

Desktop reuses the Web GUI's existing approval behavior. It does not submit approval responses until the shared API protocol implements `ApiProxy.respond`.

The rationale and the security limits are recorded in the [Tauri Desktop loopback note](../../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-loopback-shell.md).
