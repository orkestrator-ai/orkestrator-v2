# Coordinator mail loop-budget notice missing in aggregate

- **ID:** 4040
- **Status:** resolved
- **Date observed:** 2026-11-03
- **Test:** `command node coordinator ↔ leaf coordinator > budgets stop two coordinators from waking each other endlessly`
- **Owning file:** `apps/backend/src/core/coordinator-node-coordinator-mail.test.ts:613`

## Observation

During merge validation of branch `oversized-test-file-45a00165c5f3-r1`
(parent `5bac5fc9b`, merging `origin/main` at `38ac30844`),
`mise run test:logged -- --name merge-default -- mise run test` failed.
The line-613 `toContain` assertion received a non-string value for
`notice?.body` (130.34 ms). The test finds the loop-budget system notice in
the mailbox before reading its body. The owner is unchanged from the target.

The backend reported 13,818 pass, 103 skip, one fail across 939 files
(193.40 s); web reported 11,545 pass, ten skip, zero fail.
Root/agent-support, bridges and the Codex protocol-lockfile groups passed.
The aggregate took 998.5 s including scheduler waits. Reservations were
workspace six slots, root one, bridges two and protocol one; package worker
counts were selected by the aggregate runner.

Evidence:
`/tmp/orkestrator-test-run.p5i5HR/merge-default.log.gz`;
inner failure artifacts: `/tmp/orkestrator-test-run.KvJd3i`.

## Isolated rerun

`mise run test:logged -- --name merge-coordinator-mail-owner -- bun test --cwd apps/backend ./src/core/coordinator-node-coordinator-mail.test.ts --parallel=1 --only-failures`
passed the complete unchanged owning file (exit 0, 2.7 s).

## Interpretation

The aggregate failure followed by a passing isolated owner establishes a
credible flake. A missing notice at assertion time is consistent with
asynchronous mail delivery, but the cause has not been established.
No assertion, timeout or implementation was changed. The isolated pass does
not turn the failed aggregate into a passing run.

## Resolution — 2026-11-04

The R6a review repair demonstrated the same failure by forcing delivery
before the test captured its wake baseline. The test now captures the count
before sending and retains the forced ordering; its budget and notice
assertions are unchanged. The complete owner passed after the repair.
See [case 3611](3611-node-coordinator-mail-budget-notice.md#resolution--2026-11-04)
for the cause, controlled failure artifact, fix reference and verification.
