# Agent Note: Independent Desktop CI on GitHub-hosted runners

Status: implemented

English | [中文](2026-08-14-independent-desktop-github-hosted-ci.zh.md)

## Problem

The independent private Desktop repository needs one understandable required CI result without relying on organization-specific capacity, self-hosted maintenance, or a separate benchmark topology.

Desktop packaging is macOS and Apple-Silicon specific, but that release-shaped work must not make ordinary repository checks depend on a macOS runner or turn the primary CI result into a Desktop release verdict.

## Decision

[CI](../../../../.github/workflows/ci.yml) uses five blocking lanes on standard GitHub-hosted runners: `linux`, `node-compat`, `python-sdk`, `python-runtime`, and native `windows`. The always-running `all-checks-passed` aggregate fails unless every lane succeeds, giving branch protection one stable conclusion.

The `linux` lane reuses one immutable install and build but sequences its two owners: the general repository aggregate must succeed before Chromium provisioning and the dedicated Web browser replay begin. Separate 50-minute and 30-minute step deadlines attribute a stalled general or browser phase without duplicating checkout and dependency setup; the 110-minute job ceiling leaves the remaining 30 minutes for installation and provisioning.

The general gate scheduler stops launching work after a required gate fails and uses the awaited forced-cancellation lifecycle defined by the [parallel gate decision](2026-07-06-parallel-pre-push-gates.md). Primary CI deliberately applies that lifecycle only to sibling gates being discarded after CI already has a blocking failure; normal command completion and application shutdown retain their own graceful lifecycles.

The primary CI workflow triggers on pull requests, pushes to `master`, and manual dispatch. Its workflow-level concurrency group cancels a superseded run for every one of those events. It contains no self-hosted selector, custom runner label, failover variable, or manual runner benchmark.

[Desktop macOS](../../../../.github/workflows/desktop-ci.yml) remains a separate, path-scoped workflow. Its `desktop-arm64` job runs on the Apple-Silicon `macos-15` image and proves the sealed Desktop build without becoming a dependency of the repository aggregate. Desktop workflow concurrency is owned independently by that workflow.

Primary jobs that need pnpm provision it through `pnpm/action-setup@v6` at the explicit repository version `11.7.0`; the [pnpm provisioning note](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) owns that setup policy. Native Windows is a required standard-hosted result whose blocking build scope is visible directly in the primary workflow.

## Alternatives considered

- **Retain larger, custom, or self-hosted runner pools** — rejected because a required result would depend on infrastructure outside this repository and require a separate recovery procedure.
- **Keep serial reference jobs or runner benchmarks** — rejected because they add a second CI topology without changing the branch-protection verdict.
- **Put Desktop packaging in the primary aggregate** — rejected because Desktop is release-shaped macOS work with a narrower change surface than the repository-wide quality lanes.
- **Cancel only pull-request runs** — rejected for the primary CI because an older push or manual run for the same ref is equally superseded.
- **Gracefully terminate failed-run siblings before forcing them** — rejected because a termination handler can create a detached descendant after the scheduler captures the process tree, preventing bounded cleanup of work whose result can no longer affect CI.

## Consequences

Contributors can reproduce the required job inventory from ordinary GitHub-hosted images and immutable installs. Queue time and performance changes are observed through the ordinary runs rather than a retained benchmark fleet.

A required failure keeps its first result while sibling cancellation is awaited. Cleanup failure is reported alongside that result instead of being mistaken for successful cancellation.

The aggregate is intentionally limited to its five primary lanes. Desktop acceptance reports in its own workflow, and real-provider coverage remains an explicitly dispatched operation under the separate [manual real-API e2e decision](../testing/2026-08-14-manual-real-api-e2e-for-independent-desktop.md).
