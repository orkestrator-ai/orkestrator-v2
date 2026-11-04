# Coordinator mail loop-budget notice missing under aggregate load

- **ID:** 3611
- **Status:** open
- **Date observed:** 2026-11-03
- **Test:** `command node coordinator ↔ leaf coordinator > budgets stop two coordinators from waking each other endlessly`
- **Owning file:** `apps/backend/src/core/coordinator-node-coordinator-mail.test.ts:613`.
- **Original command:** `mise run test:logged -- --name fix-round-root -- mise run test`, during Coordinator Work panel review repair. Workspace grant six slots; backend four isolated workers and web two, alongside root/support (one) and bridges (two).
- **Failure:** `notice?.body` was not a string at the assertion looking for `Sending another request does not reset this budget` (269.98 ms). Backend: 13,838 passed, 103 skipped, one failed. Web: 11,610 passed, ten skipped, zero failed. Root/support, bridges and protocol passed. Aggregate exit 1 after 347.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.oLpm6Y/fix-round-root.log.gz`; group evidence `/tmp/orkestrator-test-run.bOl78I/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Complete unchanged owner:** `mise run test:logged -- --name mail-budget-owner -- bun --cwd=apps/backend test ./src/core/coordinator-node-coordinator-mail.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 1.8 s). Two root-directory attempts found no matching tests because of root discovery exclusions; they did not execute the owner.
- **Assessment:** credible aggregate-only flake; asynchronous notice publication is a hypothesis, not a confirmed cause. This branch changes renderer code and renderer tests, plus documentation; the backend owner and its backend/protocol imports are unchanged. The aggregate remains failed for verifier assessment. No assertion, timeout or implementation changed to conceal it.

## R6a review repair recurrence — 2026-11-04

Preparation at `720ef1bed740706a65bd311e9e74f8bf78e77b2b` ran
`mise run test:logged -- --name review-default-tests -- mise run test`.
The same notice-body assertion failed in 579.74 ms. The backend reported
14,068 passed, 102 skipped, one failed; root/support reported 3,529 passed
and one separate Chromium lifecycle-hook timeout. Other group counts are not
included in those totals. The scheduler selected the worker configuration.

Original evidence is preserved in
`.orkestrator/review-artifacts/review-validation-6f788315-ee40-4537-8a7a-e80b8b9652b4/validation-04.stderr.txt`
(failure at lines 238–248). The package classifies this failure `related`
because the import graph reaches `commands-registry-servers.ts`, which this
branch changes for Docker log retention. That classification is not evidence
that the logging change caused the missing notice.

The complete unchanged owner passed alone, exit 0 in 5.5 s:

```sh
mise run test:logged -- --name fix-budget-owner -- bun test --cwd apps/backend ./src/core/coordinator-node-coordinator-mail.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

This confirms another intermittent observation, not a root-cause repair.
No mail code, assertion or timeout was changed. The aggregate rerun result
is recorded separately in this round's fix result.
