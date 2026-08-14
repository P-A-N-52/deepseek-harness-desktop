# Agent Note: Required CI gate for web browser expected outputs

Status: implemented

English | [中文](2026-07-30-web-browser-snapshot-ci-gate.zh.md)

## Problem

The [keyless web browser e2e lane](2026-07-24-web-gui-browser-e2e-lane.md) compares committed browser expected outputs locally, but a pull request needs the same replay assertion before it can merge. Otherwise a behavior change can leave stale expected outputs for an unrelated later branch to discover.

## Decision

The `linux` lane in [ci.yml](../../../../.github/workflows/ci.yml) runs the full web browser replay/compare suite on every primary CI event. It first runs the general `check:ci` aggregate, then installs Chromium and invokes `test:web:built` in a separate step with `DSH_SNAPSHOT=replay`; CI never uses `record` or `refresh`, so a golden mismatch fails rather than rewriting an expected output on the runner. The general snapshot config excludes `apps/web`, making the dedicated browser config the only process that owns those files.

The Linux lane owns the repository build and then runs the browser suite against the current `apps/web/dist` and package `lib/` outputs. Chromium provisioning occurs only after the general gates succeed, and each phase has its own workflow timeout so a stalled browser run is attributed to the browser step. The browser checks remain POSIX-oriented; the native Windows lane does not duplicate Chromium provisioning.

Local `pnpm run test:web` continues to build before executing the suite, and `test:web:built` remains the entry point for existing build artifacts. The comprehensive `check:all` aggregate schedules both the general and Web owners after its shared build, so splitting their inventories does not reduce local coverage. Developers run `DSH_SNAPSHOT=refresh pnpm run test:web` only for an intentional user-visible change, review the resulting expected-output diff, and then replay it without writes.

The required aggregate depends on the Linux lane, so a browser mismatch blocks the same stable `all checks passed` result as the rest of the primary inventory. The [GitHub-hosted CI note](../process/2026-08-14-independent-desktop-github-hosted-ci.md) records the current runner and aggregate topology.

## Alternatives considered

**Continue requiring only local runs.** Rejected because developer memory cannot ensure that the pull request introducing a behavior change also carries its expected-output update.

**Run CI in `refresh` mode and check the working tree afterward.** Rejected because writing before asserting can turn a regression into a generated update; replay compares the committed golden directly.

**Create a standalone browser job.** Rejected because it would duplicate the primary Linux job's immutable install and build for a suite that already belongs to that required lane.

**Replace Chromium with jsdom snapshots.** Rejected because jsdom does not exercise the assembled browser, HTTP/SSE carriage, or real client-plugin composition.

## Consequences

Every primary CI run proves that the assembled web application matches its committed browser expected outputs. The Linux lane pays for Chromium provisioning and the browser suite, while the rest of the job inventory remains browser-free.

The gate does not claim cross-platform browser equivalence. A Playwright or Chromium upgrade that changes the ARIA format requires an explicit refresh and review of the expected-output churn.
