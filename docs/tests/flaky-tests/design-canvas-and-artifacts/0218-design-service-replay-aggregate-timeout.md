# Design service replay aggregate timeout

- **ID:** 0218
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `design service (legacy adapters over prepare/execute) > missed events,
  expired replay and generation changes reset through changes()`
  (`apps/backend/src/core/design-service.test.ts:81`).
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** backend package `2x PARALLEL` in the workspace group,
  under the shared host-capacity scheduler, with other worktree validations active.
- **Failure:** Bun's `this test timed out after 5000ms`, reported at 6,167.72 ms.
  Teardown closed the design service while the interrupted mutation loop was
  still running, producing a between-tests `DesignError: Design service is
  stopping` at `design-service.ts:673`, reached from the loop at test line 91.
- **Failure evidence:** `/tmp/orkestrator-test-run.Kl63Ti/` (workspace group).
- **Suite counts:** backend 7,712 passed, 39 skipped, 1 failed, 1 between-tests
  error across 7,752 tests in 425 files (314.03 seconds). The workspace group
  failed on that backend case; root/agent-support, bridge, and protocol groups
  passed. The complete run finished in 504.6 seconds.
- **Isolated rerun:** `mise run test:logged -- --name design-service-isolated --
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/design-service.test.ts --parallel=1 --only-failures` passed unchanged
  in 4.0 seconds.
- **Hypothesis:** this replay-expiry case performs 260 real persisted mutations
  before restarting its service. Shared-host filesystem and CPU contention can
  exhaust its generic five-second outer budget. The stopping-service error
  follows timeout teardown; it is distinct from the reproducible backend
  shutdown/deletion race fixed during the same validation.
- **Disposition:** recorded without skipping, loosening, or changing the test.

- **Merge reconciliation (2026-10-15):** Renumbered from 0212 to 0214 to
  retain the independent agent-skills case added on main. The owning test now
  lives at `apps/backend/src/core/design/service.test.ts` after the design-domain
  move; the paths above preserve the original observation and rerun commands.

- **Second merge reconciliation (2026-10-15):** Renumbered from 0214 to
  0218 because main independently added the Codex escalation case as 0214.

## Recurrence during host-independent suite merge (2026-10-15)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. The component browser suite ran
  concurrently and passed.
- **Failure:** the same case exceeded its five-second deadline (5012.51 ms),
  followed by `DesignError: Design service is stopping` during timeout teardown.
- **Suite counts:** backend 7,840 passed, 39 skipped, two failed and two
  between-tests errors across 430 files (273.73 seconds). Root, bridge and
  protocol groups passed; the complete run finished in 340.8 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-service -- bun
  --cwd=apps/backend test --preload ../../tests/setup-node.ts
  ./src/core/design/service.test.ts --parallel=1 --only-failures` passed unchanged
  in 1.7 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.vFlcN6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer failure artifact `/tmp/orkestrator-test-run.OnVHEa/merge-tests.log.gz`.
- **Hypothesis:** shared-host contention may contribute, as in earlier
  observations; the isolated pass does not establish the cause. No test or
  timeout was changed.

Recurred on 2026-10-15 at 5012.03 ms in `mise run test` for the sign-in
readiness change (no design code touched), alongside case 0247. The unchanged
owning file passed alone three times in a row. Evidence:
`/tmp/orkestrator-test-run.8FscOl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Recurred on 2026-10-16 at 5553.87 ms in `mise run test` for the coordinator
launch-defaults change (no design code touched), with the same
`Design service is stopping` teardown error. The unchanged owning file passed
alone (10 pass, 0 fail). Evidence:
`/tmp/orkestrator-test-run.26CkBR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Observation during live coordinator suite main merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers on a shared 18-slot host.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and two
  between-tests errors across 441 files (452.96 seconds). The aggregate exited
  1 after 600.8 seconds. All other workspace packages and the bridge/protocol
  groups passed; root had the Pi staged-runtime timeout tracked as 0178.
- **Evidence:** `/tmp/orkestrator-test-run.3yIsw1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.i4Amls/merge-tests.log.gz`.

- **Failure:** the replay-reset case in `apps/backend/src/core/design/service.test.ts`
  timed out at 5011.94 ms, followed by `DesignError: Design service is stopping`.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-service-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/service.test.ts --parallel=1 --only-failures`
  also failed: nine passed, one failed and one between-tests error across ten
  tests (12.0 seconds). The same case timed out at 5025.95 ms. Artifact:
  `/tmp/orkestrator-test-run.9GCebK/merge-design-service-isolated.log.gz`.
- **Disposition:** this observation does not establish aggregate-only
  intermittence; the timeout reproduced alone while other host workloads
  remained active. Its cause remains unresolved. The merge conflict changes
  only documentation; no test, timeout, assertion or skip was changed.

## Resolution (2026-10-16)

Not an ordering bug. The cause is the same as
[0193](0193-design-sync-gap-aggregate-timeout.md): 260 sequential, fsynced
legacy mutations against a generic 5 s deadline. The case took about 0.9 s
alone and 5.0–8.0 s under aggregate load. The stopping-service error is the
abandoned loop meeting teardown. `changes()` reads one immutable record, and
nothing in the case runs concurrently.

**Fix (test only).** The case lowers `changeDescriptors` to 8 with
`withDesignLimit` (12 real commits instead of 260) and keeps every assertion:
reset for an expired cursor, a two-event replay, a future cursor, and a new
generation after restart. The shipped 256 bound is covered in memory by the
new case in `sync.test.ts`. The deadline was not raised.
