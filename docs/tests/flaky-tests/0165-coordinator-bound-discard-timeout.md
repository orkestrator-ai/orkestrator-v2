# Coordinator bound discard confirmations timeout under aggregate load

- **ID:** 0165
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test` on branch
  `implement-improvements-ecf7c41c13cd-r1` (inconsistency remediation; the
  coordinator service and its close paths are not changed by this branch)
- **Worker configuration:** workspace group (2 worker slots) concurrent with
  the root, bridges and codex-protocol groups. The workspace group took 742.3 s,
  against 399.0 s for the same group earlier on this branch, so the host was
  unusually loaded.
- **Failure:** the test failed at 5111.35 ms (bun's five-second default
  timeout). No assertion message was reported. Root, bridges and
  codex-protocol groups passed in the same run.
- **Isolated rerun:**
  `mise run test:logged -- --name coordinator-rerun-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed three times in a row (14.8 s, 12.0 s, 10.6 s for the whole file).

## Current assessment

A timeout under aggregate load, the same shape as 0151 and 0155. The test runs
several sequential confirmation switches inside one five-second budget. Keep
open until a recurrence shows whether it needs a larger explicit timeout or a
cheaper fixture.

## Recurrence on 2026-10-15

GitHub setup recovery validation timed out in the same case at 5166.09 ms under
`mise run test`, with four workspace worker slots. Evidence is in
`/tmp/orkestrator-test-run.9M60yV/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The unchanged owning file passed alone (exit 0, 14.1 seconds):

```bash
mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

No coordinator implementation, assertion, timeout or skip was changed.

## Recurrence — 2026-10-15 (coordinator mail upgrade recovery)

`mise run test:logged -- --name mail-native-reconciliation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts ./src/core/coordinator-service.test.ts ./src/core/native-agent-service-reconciliation.test.ts --parallel=2 --only-failures`
timed out in the same case at 5114.84 ms while the full repository suite was
also running. Results: 184 passed, one failed and one teardown error across
three files (31.35 seconds). The teardown hit `SQLITE_IOERR_VNODE` after the
timed-out test's temporary store was removed. Evidence:
`/tmp/orkestrator-test-run.XqYrUe/mail-native-reconciliation.log.gz`.

An owning-file rerun during the aggregate also timed out at 5152.92 ms
(47 passed, one failed, one teardown error; 31.16 seconds). Evidence:
`/tmp/orkestrator-test-run.cxnHm5/coordinator-service-isolated.log.gz`.
After the aggregate finished,
`mise run test:logged -- --name coordinator-service-isolated-final -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
passed the whole owning file (48 tests, exit 0, 19.4 seconds).

The new canonical-key persistence test passed in every run. No branch-switch
implementation, assertion, timeout or skip was changed. Host contention remains
the hypothesis for this recurrence.

## Held-send validation recurrence on 2026-10-15

The unchanged case timed out at 5171.27 ms in
`mise run test:logged -- --name repository-tests -- mise run test`, with four
workspace worker slots and the component browser suite running concurrently.
The backend package reported 7,887 passed, 39 skipped, one failed and one
unhandled error; the workspace group took 386.6 seconds. After the timeout,
the same test's pending nested-repository assertion rejected with `disk I/O
error` instead of `nested repositories`. This is consistent with the timed-out
fixture being cleaned up while its asynchronous work was still finishing. The failure is retained in
`/tmp/orkestrator-test-run.LvVdAx/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The owning file passed unchanged, exit 0, in 12.2 seconds:

```bash
mise run test:logged -- --name coordinator-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

The matching timeout and isolated pass support the existing load hypothesis.
No coordinator implementation, assertion, timeout or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Aggregate:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots. The unchanged case timed out at 5262.85 ms; late fixture work also reported a disk I/O error.
- **Rerun during the aggregate:** `mise run test:logged -- --name coordinator-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` also timed out (5115.92 ms; 47 passed, one failed, one late SQLite error; 30.6 seconds). Evidence: `/tmp/orkestrator-test-run.lxE56B/coordinator-rerun.log.gz`.
- **After the aggregate:** the same owning-file command with `--name coordinator-final-rerun` passed unchanged in 16.8 seconds (exit 0).
- **Aggregate evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No coordinator implementation, assertion, timeout or skip changed. Host contention remains a hypothesis.
