# Design sync gap test times out in the aggregate

- **ID:** 0193
- **Status:** open
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
