# Agent Note: Local unsigned macOS Desktop distribution

Status: implemented

English | [中文](2026-08-14-local-unsigned-macos-desktop-distribution.zh.md)

## Problem

The Desktop application needs one repeatable macOS delivery artifact without GitHub Actions, an Apple Developer ID, or notarization. Tauri's raw build can be launched locally, but its outer application seal is not a valid distributable ad-hoc seal after the sealed runtime and legal resources are assembled. Copying that application directly into a DMG would therefore present an invalid bundle as a finished artifact.

An unsigned artifact also has a different trust model from a Developer ID release. It cannot authenticate its publisher, obtain Apple's notarization malware check, or pass Gatekeeper's normal identified-developer assessment. The artifact metadata and installation instructions must make those limits explicit.

## Decision

The delivery artifact is an Apple Silicon developer-preview DMG for macOS 13.5 or later. Packaging starts from a clean `HEAD` named by an annotated `desktop-unsigned-v<dsh-version>` tag. It retains the sealed runtime evidence, licenses, third-party notices, npm and Cargo CycloneDX SBOMs, target metadata, and per-executable digests produced by the release-preparation stage.

The local packager verifies the immutable Tauri application, copies it into a private same-filesystem staging directory, and changes only that copy. It applies hardened-runtime ad-hoc signatures to every Mach-O file and nested code bundle before sealing the outer application. The Node sidecar receives exactly the four entitlements in `sidecar-entitlements.plist`. Verification requires a strict outer seal, an ad-hoc signature with no authority, Team ID, or timestamp on every launched code object, the fixed sidecar entitlements, and the original runtime evidence.

The packager creates an unsigned compressed DMG containing the application and an `/Applications` link. It mounts the image read-only, verifies its exact root inventory, and repeats application, Mach-O, entitlement, runtime-evidence, architecture, and deployment-target checks against the mounted copy. The output directory is created atomically and contains exactly the DMG, `SHA256SUMS`, and `release-manifest.json`. The manifest states that the application is ad-hoc signed, the disk image is unsigned, Developer ID and notarization are absent, Gatekeeper approval is required, and updates are manual. Packaging revalidates the original Tauri application after completion so repeated runs cannot depend on a mutated build input.

Credential-free CI continues to build and exercise the raw application, sealed sidecar, browser flow, and host lifecycle. It does not package or publish the DMG. Local publication is a separate command whose default mode only verifies the tag and artifact. The command writes a GitHub Release only with an explicit `--publish`; it requires the tag commit to equal the remote default branch, requires the remote annotated tag object to equal the local object, uploads only the three declared files to a draft, downloads and compares their bytes, and makes the draft public only after those checks pass.

Installation guidance identifies the DMG as unsigned and unnotarized. Users verify the source, version, and SHA-256 before opening it, attempt one launch, and use macOS System Settings to approve the blocked application only when they accept that source. The documentation does not recommend removing quarantine attributes or disabling Gatekeeper. Managed Macs may prohibit the exception.

## Alternatives considered

**Replace Tauri with Electron.** Electron would still require Developer ID and notarization for the Apple trust path, while adding another Chromium runtime and replacing a working loopback host. It does not solve the unsigned-distribution limitation.

**Distribute the raw Tauri application.** The assembled application does not have a valid strict outer seal. A private packaging copy is required before the bundle can be represented as internally consistent.

**Ad-hoc sign the build output in place.** Signing changes bundle bytes covered by the pre-sign evidence and makes a second packaging run depend on the first. Keeping the Tauri application immutable preserves repeatability and separates build verification from delivery sealing.

**Retain Developer ID signing and notarization.** That path provides Apple publisher identity, notarization review, and the normal Gatekeeper experience, but it requires Apple credentials and a separate credential-bearing release system. Those guarantees are deliberately outside this distribution.

**Tell users to remove quarantine or disable Gatekeeper.** Those commands weaken a system-wide security control and obscure the artifact's trust status. The supported exception is the per-application macOS approval flow after independent source and digest verification.

**Add Intel, universal binaries, or automatic updates.** The SEA carrier, ripgrep, PTY helper, and Rust host are target-native, while Desktop shares pre-release data with the CLI and has no downgrade promise. Those features require separate runtime, compatibility, and rollback decisions.

## Consequences

The DMG is reproducibly assembled and self-consistent, but it is not an Apple-trusted release. Gatekeeper is expected to block the first launch, Apple has not authenticated the publisher or performed notarization review, and SHA-256 proves only that downloaded bytes match a manifest obtained from an already trusted source. Some managed Macs cannot run the application.

The distribution remains arm64-only, requires macOS 13.5 or later, and updates manually. Users should back up the shared `$DSH_HOME` before changing versions. The local publisher can make the artifact available without release automation, but publication does not upgrade its trust guarantees.
