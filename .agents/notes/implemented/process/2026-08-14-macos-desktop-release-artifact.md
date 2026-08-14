# Agent Note: macOS Desktop release artifact

Status: implemented

English | [中文](2026-08-14-macos-desktop-release-artifact.zh.md)

## Problem

The loopback Desktop shell combines four independently built Mach-O programs: the Tauri host, a Node single executable application, ripgrep, and the PTY spawn helper. A runnable local application is not a distributable macOS release unless those programs agree on architecture and deployment target, their JavaScript and Rust dependency closures are disclosed, and Apple can verify every code object that the outer bundle launches.

The sealed Node runtime also introduces source material outside the pnpm lockfile. A release must identify the exact Node carrier and packer, preserve the applicable licenses, and bind the resulting bytes to the same source revision and version as the application.

## Decision

The Desktop distribution targets `aarch64-apple-darwin` and declares macOS 13.5 as its minimum version, the greatest deployment target among its four executables. The product is a community Apple Silicon distribution with manual updates; it does not claim Intel, universal-binary, or other operating-system support.

The root dsh semver is the release identity. Cargo carries that exact semver. Tauri uses the numeric core as `CFBundleShortVersionString` and maps numbered alpha, beta, preview, and release-candidate stages into ordered numeric `CFBundleVersion` ranges. The dsh release bump updates and verifies all three representations together.

The sealed runtime uses Node.js 24.19.0 and `@yao-pkg/pkg` 6.21.0. Its producer pins each allowed target to the SHA-256 published in Node's release checksum document, verifies the archive before packaging, and gives the patched packer a fresh build-owned SEA cache containing only those verified bytes. The retained archive is content-addressed and reverified before it supplies the Node license. The Desktop runtime producer copies target-native ripgrep and the PTY helper as resources and materializes the ignored legal resource directory before Cargo validates Tauri's resource configuration. After the final host exists, the single release-preparation stage writes the product licenses, third-party notices, and target-specific npm and Cargo CycloneDX SBOMs to that directory, then generates a release manifest containing source state, versions, per-executable sizes, SHA-256 digests, architectures, deployment targets, and the product minimum. The npm SBOM maps each deployed package instance to one pnpm importer or package-and-snapshot record and carries the registry SHA-512 integrity; the Cargo SBOM follows the locked target graph. Tauri assembles the application only after this evidence exists.

A signed release starts from a clean `HEAD` named by an annotated `desktop-v<dsh-version>` tag. The packager verifies the unsigned application evidence, signs nested Mach-O files and code bundles before the outer application, and grants the Node sidecar only the four hardened-runtime entitlements recorded in `sidecar-entitlements.plist`. It notarizes and staples the application, creates and signs a DMG containing the application and an `/Applications` link, notarizes and staples the DMG, mounts it read-only, and repeats code-signing, stapling, and Gatekeeper checks against the mounted application. The resulting directory contains the DMG, `SHA256SUMS`, and a release manifest bound to the tag commit and Apple Team ID.

Credential-free CI starts without generated legal resources, builds the application on an Apple Silicon runner, checks the generated evidence, starts the final SEA in Chromium, and verifies native host ownership and restart. It neither reads Apple signing credentials nor publishes assets. A release operator supplies the Developer ID identity and `notarytool` keychain profile to the packaging command through a protected environment.

## Alternatives considered

**Publish the local ad-hoc application.** Gatekeeper cannot establish a Developer ID, notarization ticket, or trusted disk image for that artifact, so a runnable preview is not represented as a release.

**Sign only the outer application.** The sidecar and resource executables are launched code. Signing every discovered Mach-O and nested code bundle makes the hardened-runtime identity explicit before the outer seal is applied.

**Generate one SBOM from the whole monorepo.** Platform-incompatible optional packages and development-only crates do not ship in the arm64 application. The release evidence follows the deployed npm closure and the target-filtered, non-development Cargo graph instead.

**Ship a universal binary from one arm64 build.** The SEA carrier, ripgrep, PTY helper, and Rust host are target-native products. A universal release requires independently verified x86_64 inputs and a separate composition decision rather than relabeling one architecture.

**Enable automatic updates with the first release.** Desktop shares `$DSH_HOME` with the CLI, while the pre-release session and settings formats have no downgrade promise. Manual updates avoid creating an update and rollback guarantee before those data policies exist.

## Consequences

Desktop builds are large, target-specific, and slower than the Tauri host alone because the application carries a complete sealed runtime and its legal evidence. Release preparation requires a clean source tree, an annotated version tag, Apple credentials, and successful online notarization. Missing provenance, inconsistent versions, undeclared executables, a lower bundle deployment target, unexpected entitlements, or a changed DMG fails the release instead of falling back to an unsigned artifact.

The same evidence makes a release auditable without depending on the build machine after publication. A public release still exists only when the signed and notarized artifact verifier has completed; an unsigned CI application remains a preview.
