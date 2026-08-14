# Agent Note: Manual real-API e2e for the independent Desktop repository

Status: implemented

English | [中文](2026-08-14-manual-real-api-e2e-for-independent-desktop.zh.md)

## Problem

Keyless tests prove assembled behavior but cannot prove a live provider request. The real-API suite self-skips when no key is available, so an automatic workflow without an explicit key check could report green without exercising the provider.

The independent private Desktop repository currently has no configured real-provider repository secret. A temporary local test key must not become a repository secret or be uploaded to make CI appear complete.

## Decision

[e2e.yml](../../../../.github/workflows/e2e.yml) is triggered only by `workflow_dispatch`. It remains separate from keyless [CI](../../../../.github/workflows/ci.yml), so ordinary pull requests, pushes, and scheduled automation never receive or depend on a real-provider credential.

The workflow maps the `DEEPSEEK_API_KEY_EXTERNAL` repository secret to `DEEPSEEK_API_KEY` only in its preflight and real-e2e test steps. Checkout, pnpm setup, dependency installation, and the build execute without that environment variable.

The preflight fails loudly when the secret is absent or empty. It names the configuration error before `pnpm run test:e2e` can self-skip, preventing a manual invocation from becoming a false-green result. This decision does not configure a repository secret and does not upload any local temporary key.

## Alternatives considered

- **Run real-provider e2e on pull requests, pushes, or a schedule** — rejected for now because it would make an external credential part of automatic CI and needs a separate trigger and threat-model decision.
- **Configure the temporary local key as a repository secret** — rejected because local testing authority does not authorize persistent repository credential storage.
- **Allow a missing secret to self-skip** — rejected because a skipped suite cannot demonstrate that the live-provider path ran.
- **Put the credential in the primary CI workflow** — rejected because the primary aggregate remains keyless and reproducible without secret access.

## Consequences

A maintainer who needs live-provider evidence deliberately starts the workflow and must ensure that the repository secret has been configured through the repository's secret-management controls. A missing secret is a useful failed configuration result, not a passing test result.

Any future automatic real-API gate requires an explicit follow-up decision covering its events, credential exposure, branch-protection role, and operational ownership. Until then, the automatic CI topology remains keyless.
