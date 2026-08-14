# Agent Note: Private documentation verification without Pages

Status: implemented

English | [中文](2026-08-14-private-documentation-verification-without-pages.zh.md)

## Problem

The private automation repository needs a production documentation build on each selected change, but GitHub Pages can expose generated content outside the repository. A repository variable that guards deployment still leaves a persistent publication capability and elevated Pages permissions in an automation workflow.

## Decision

The documentation workflow contains only the unconditional `verify` job. It uses a frozen dependency install, sets `DOCS_BASE=/`, and runs `pnpm run doc-sync` for selected `master` changes and manual dispatches. The workflow and its only job have repository read permission.

The workflow has no Pages configuration action, artifact upload, deployment action, Pages permission, OIDC permission, publication variable, or Pages-specific concurrency group. It cannot enable Pages, select visibility, or publish documentation. The website projection remains verified as described by [canonical documentation projection](2026-07-13-documentation-site-projection.md).

## Alternatives considered

**Keep a variable-gated Pages publication job.** A variable can prevent ordinary runs from entering the job, but the checked-in workflow still retains an external publishing capability and the permissions needed to use it.

**Enable Pages from the workflow.** Automatic enablement requires separately authorized elevated credentials and makes hosting state a CI side effect.

**Skip the production documentation build.** Removing the deployment path must not defer VitePress or link failures until an unrelated future publication decision. The verification job preserves the existing quality signal.

## Consequences

Selected documentation changes always receive a frozen production build and cannot change GitHub Pages state or expose the generated site. Repository administrators retain full control of any future publication decision outside this workflow.

A future Pages or other hosting integration requires explicit user authorization, a separate implementation decision, and focused verification of the destination and visibility policy. It cannot be reintroduced by setting a repository variable.
