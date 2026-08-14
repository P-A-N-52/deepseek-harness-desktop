# AGENTS.md — GitHub Actions

Run the `windows` CI job on `windows-latest` under native `pwsh`. The five blocking lanes in `.github/workflows/ci.yml` — `linux`, `node-compat`, `python-sdk`, `python-runtime`, and `windows` — must remain in `all-checks-passed`; use GitHub-hosted runners only, with no Wine, self-hosted, or failover topology.

Every `actions/checkout` step must set `persist-credentials: false`; `scripts/ci-workflow.spec.ts` scans every workflow for this policy.
