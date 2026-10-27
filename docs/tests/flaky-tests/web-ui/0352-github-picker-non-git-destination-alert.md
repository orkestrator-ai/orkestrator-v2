# GitHub picker non-git destination alert missing in the root suite

- **ID:** 0352
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `tests/unit/components/GitHubCloneIntegration.test.tsx`.
- **Test:** `GitHub picker to project registration > handles a non-git destination through the real add_project handler`.
- **Original command:** `mise run test` (root and agent-support tests, alongside the workspace and bridge suites).
- **Failure:** `findByRole("alert")` at line 188 gave up after 1706.75 ms with `Unable to find role="alert"`; the Clone from GitHub dialog was still open.
- **Suite result:** 3039 tests across 140 files in 283.75 seconds, one failure.
- **Owning-file rerun:** `bun test --preload ./tests/setup-node.ts tests/unit/components/GitHubCloneIntegration.test.tsx` passed unchanged (7 passed, 0 failed).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nSrOTz/root-and-agent-support-tests.log.gz`.
- **Assessment:** isolated pass confirms intermittence; root cause is unconfirmed. Observed during unrelated backend unread-bell changes. No implementation, assertion, timeout or skip changed.

## Main merge validation — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, aggregate reservations 4/1/2/1; one worker for the owning package/group.
- **Observation:** The empty-destination alert lookup failed at 2,135.84 ms; the success-toast assertion also observed an unexpected error callback at 633.83 ms. Owning file passed unchanged in 1.8 s.
- **Owning-file rerun:** `mise run test:logged -- --name merge-root-rerun-GitHubCloneIntegration -- bun test ./tests/unit/components/GitHubCloneIntegration.test.tsx --parallel=1 --only-failures` (exit 0).
- **Evidence:** `orkestrator-test-run.LitzDV/root-and-agent-support-tests.log.gz`; root group had 3051 passed, 1 skipped and 4 failed, including the separate README installer-link regression; Codex group had 2227 passed and 4 failed.
- **Assessment:** Confirmed recurrence; no implementation, assertion, skip or timeout changed.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The missing-destination and empty-destination alert cases failed after 2487.49 and 1893.61 ms; the error-toast-after-unmount case failed after 1511.16 ms. `mise run test:logged -- --name merge-owner-github -- bun test ./tests/unit/components/GitHubCloneIntegration.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (8.7 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## OpenCode abort-cleanup review validation — 2026-10-27

`mise run test:logged -- --name abort-repository-tests -- mise run test`
repeated the non-git-destination `findByRole("alert")` failure at 1,996.17 ms
in the root group (`--parallel=1`) on the shared host, at a load average of
227.27 during triage. The complete unchanged owner passed with
`mise run test:logged -- --name abort-rerun-github-clone -- bun test ./tests/unit/components/GitHubCloneIntegration.test.tsx --parallel=1`
(6.3 s). The failing evidence is
`orkestrator-test-run.EI9pye/root-and-agent-support-tests.log.gz`, below the
host temporary directory. Aggregate counts and the other failures from the
same run are tracked in
[1180](../aggregate-validation-runs/1180-interaction-test-matrix-0162-validation.md).
No implementation, assertion, timeout, or skip changed.
