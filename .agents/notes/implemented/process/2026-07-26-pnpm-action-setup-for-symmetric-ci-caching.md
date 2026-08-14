# Agent Note: Provision CI pnpm via pnpm/action-setup

Status: implemented

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

CI needs one reproducible pnpm provisioner that is independent of the runner image's Corepack installation and does not place action-managed executables in a shared home-relative directory.

The independent Desktop repository now has primary CI, Desktop macOS validation, documentation verification, manual real-API e2e, and release or sandbox workflows. They must agree on the locked pnpm release while retaining workflow-specific cache choices.

## Decision

Every repository workflow that needs pnpm provisions it through `pnpm/action-setup@v6`; no workflow runs `corepack enable`. Each action step uses `dest: ${{ runner.temp }}/setup-pnpm` and `version: 11.7.0`, matching the root `packageManager` declaration.

The primary [GitHub-hosted CI topology](2026-08-14-independent-desktop-github-hosted-ci.md), [Desktop macOS workflow](../../../../.github/workflows/desktop-ci.yml), documentation verification, and manual real-API e2e all use that same explicit action release and pnpm version. `actions/setup-node` owns the pnpm store cache only in workflows that elect to cache it; pnpm provisioning and cache policy remain separate concerns.

The root `@yarnpkg/cli-dist` development dependency separately supplies the modern Yarn CLI exercised by generated-project tests, so that coverage does not inherit the runner image's Yarn Classic.

## Alternatives considered

- **Use `corepack enable` in each workflow** — rejected because Corepack availability is runner-image state rather than a repository-pinned toolchain.
- **Let each workflow infer pnpm from an unversioned action setup** — rejected because the released pnpm version must be visible in the workflow and stay synchronized with `package.json`.
- **Use one composite action for provisioning and caching** — rejected because cache policy remains different across lightweight verification, release-shaped, and platform-specific workflows; a wrapper would merely reproduce those inputs.
- **Rely on the runner image's Yarn** — rejected because generated-project coverage requires the repository-pinned modern Yarn CLI rather than Yarn Classic.

## Consequences

Every CI workflow starts from the same pnpm action major, explicit pnpm version, and runner-private destination. A version change updates the root package-manager declaration and workflow pins together, while cache tuning stays local to the workflow that owns its latency and storage trade-off.

The explicit destination keeps pnpm's action-managed executable directory separate from the package store, and the CI workflow specification enforces that invariant for every repository workflow pnpm setup.
