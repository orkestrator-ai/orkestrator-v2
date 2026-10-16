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

## MCP apply-path merge validation recurrence on 2026-10-16

Merging `origin/main` into `mcp-apply-path-gaps` and running
`mise run test:logged -- --name merge-suite -- mise run test` reproduced the
same five-second timeout at 5184.28 ms. The pending nested-repository assertion
then rejected with `disk I/O error` after fixture cleanup. The backend reported
8,319 passed, 40 skipped, one failed and one unhandled error. The other workspace
packages, root, bridges and protocol check passed. The workspace group took
447.0 seconds. Evidence:
`/tmp/orkestrator-test-run.U853xk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

After the aggregate finished, the unchanged owning file passed alone (exit 0,
18.5 seconds):

```bash
mise run test:logged -- --name merge-coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

No coordinator implementation, assertion, timeout or skip was changed.

## Merge validation recurrence on 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test` on
`overnight-opencode-skew-guard-854f012a1bb0` timed out in the same case at
5216.88 ms, with four workspace worker slots alongside the root, bridge and
protocol groups. The backend reported 8,279 passed, 40 skipped, one failed and
one teardown error across 8,320 tests; the workspace group finished in
456.6 seconds. Evidence:
`/tmp/orkestrator-test-run.3f2Lou/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

An owning-file rerun while the aggregate was still active also timed out at
5126.59 ms, followed by `SQLITE_IOERR_VNODE` during asynchronous persistence
after fixture cleanup (47 passed, one failed, one error; 27.9 seconds).
Evidence: `/tmp/orkestrator-test-run.vvWBFs/merge-coordinator-rerun.log.gz`.
After the aggregate finished, the unchanged owning file passed all 48 tests,
exit 0, in 19.7 seconds:

```bash
mise run test:logged -- --name merge-coordinator-final -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

This matches the existing load-related timeout and teardown pattern. No
coordinator implementation, assertion, timeout or skip was changed.

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

## Recurrence on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran the backend
with two isolated workers within a four-slot workspace group while other
worktree validations shared the host. `project coordinator > bound discard
confirmations refuse stale, sequencer, nested, and failed switches` exceeded
the five-second deadline at 5,165.84 ms.

`mise run test:logged -- --name merge-coordinator-isolated -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the
unchanged owning file in 18.6 seconds. Evidence and aggregate package counts
are retained in
`/tmp/orkestrator-test-run.Q27xqQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The existing load hypothesis remains unconfirmed; no assertion, timeout or
skip was changed.

Aggregate backend counts for this observation: 8,341 passed, 40 skipped,
5 failed and 3 between-tests errors across 8,386 tests in 445 files
(391.37 seconds). The other failures are recorded in 0162, 0165 and 0248.
