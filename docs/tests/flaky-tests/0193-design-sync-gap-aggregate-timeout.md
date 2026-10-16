# Design sync gap test times out in the aggregate

- **ID:** 0193
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Test:** `design incremental sync > gaps reset: expired range, future cursor and a new generation`
- **File:** `apps/backend/src/core/design/sync.test.ts`
- **Original command:** `mise run test:logged -- --name final-messaging-full-suite -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- **Worker configuration:** Backend package one Bun worker; workspace and bridges at most two package tasks; root group three workers; protocol one slot. Another aggregate run was completing on the same host under the shared capacity scheduler.
- **Failure:** Five-second test timeout at 5013.03 ms, followed by `DesignError: Design service is stopping` during fixture teardown.
- **Backend counts:** 5787 passed, 15 skipped, two failures across 323 files in 260.21 seconds. The other failure was the mail ambiguity regression corrected in this change.
- **Isolated rerun:** `mise run test:logged -- --name design-sync-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/sync.test.ts --parallel=1 --only-failures` passed in 1.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.VmCKDu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Host contention is a plausible explanation for the aggregate timeout; the isolated
pass does not establish the cause. The teardown error follows the timeout and
fixture shutdown. No test was skipped, loosened, or changed to conceal the failure.

## Recurrence during version-reminder validation (2026-10-15)

- **Original command:** the macOS GNU-tool PATH from the testing guide with
  `mise run test:logged -- --name full-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were also
  validating on the host, and browser checks ran concurrently.
- **Failure:** the same gap-reset case exceeded its five-second deadline
  (5729.97 ms), followed by `DesignError: Design service is stopping` during
  teardown. The backend reported 7692 passed, 39 skipped, 5 failed and one
  additional error across 423 files in 340.15 seconds. The other failures
  belonged to environment deletion and shutdown tests.
- **Isolated rerun:** `mise run test:logged -- --name design-sync-rerun -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-sync.test.ts
  --parallel=1 --only-failures` passed unchanged in 5.5 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.ZPe1mY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer summary `/tmp/orkestrator-test-run.e91mPJ/summary.json`.
- **Hypothesis:** contention may contribute to the aggregate deadline, as in
  prior observations; the isolated pass does not establish the cause. No
  assertion, timeout or skip was changed.

## Recurrence during host-independent suite merge (2026-10-15)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. The component browser suite ran
  concurrently and passed.
- **Failure:** the same case exceeded its five-second deadline (5062.58 ms),
  followed by `DesignError: Design service is stopping` during timeout teardown.
- **Suite counts:** backend 7,840 passed, 39 skipped, two failed and two
  between-tests errors across 430 files (273.73 seconds). Root, bridge and
  protocol groups passed; the complete run finished in 340.8 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-sync -- bun
  --cwd=apps/backend test --preload ../../tests/setup-node.ts
  ./src/core/design/sync.test.ts --parallel=1 --only-failures` passed unchanged
  in 1.0 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.vFlcN6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer failure artifact `/tmp/orkestrator-test-run.OnVHEa/merge-tests.log.gz`.
- **Hypothesis:** shared-host contention may contribute, as in earlier
  observations; the isolated pass does not establish the cause. No test or
  timeout was changed.

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** the same gap-reset case timed out at 5055.49 ms, followed by
  `DesignError: Design service is stopping` during teardown.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-sync -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/design/sync.test.ts --parallel=1 --only-failures`
  also failed: five passed, one failed and one between-tests error across six
  tests (7.8 seconds); the case timed out at 5083.19 ms with the same teardown
  error. Artifact: `/tmp/orkestrator-test-run.2p6S3z`.
- **Disposition:** this observation does not establish an aggregate-only flake:
  the timeout reproduced alone while other host workloads remained active.
  Its cause is unresolved. No test, timeout or skip was changed.


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers alongside other host validations.
- **Suite counts:** backend 8,380 passed, 40 skipped and ten failed across
  8,430 tests in 449 files (556.88 seconds). Root had three failures; other
  workspace packages, bridges and protocol verification passed. Aggregate
  exited 1 after 671.2 seconds.
- **Failure:** `design incremental sync > gaps reset: expired range, future cursor and a new generation` timed out at 5018.73 ms against its 5000 ms limit, followed by a stopping-service teardown error.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-sync-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/sync.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the unchanged owning file (exit 0,
  1.3 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains an unconfirmed hypothesis; no implementation, assertion,
  timeout or skip changed.

## Resolution (2026-10-16)

Not an ordering bug. The case is a sequential loop with no concurrency:
`DESIGN_LIMITS.changeDescriptors + 2` = 258 legacy `mutate` calls, then pure
reads. Each mutate is a prepare and an execute, and each of those takes a
cross-process SQLite lease and makes several fsynced atomic writes (pending
file, history checkpoint, record and parent directory). The case took about
0.9 s alone. With other suites fsyncing on the same disk, it ran 5.0–5.7 s and
hit Bun's generic 5 s deadline. The `Design service is stopping` error that
followed was the abandoned loop's next `prepare` after teardown closed the
service, which is the correct refusal.

**Fix (test only).** The case lowers `changeDescriptors` to 8 with the new
`withDesignLimit` helper in `core/design/test-support.ts` (the idiom
`history.test.ts` already used for byte budgets). The log then rolls over
after 10 real commits instead of 258, and the case also checks that the
oldest cursor the log still covers gets a delta. A new in-memory case ("the
shipped change log covers exactly the newest changeDescriptors revisions")
keeps the shipped 256 bound covered with `pushChange` and `buildSync`, without
one fsync per revision. The deadline was not raised.
