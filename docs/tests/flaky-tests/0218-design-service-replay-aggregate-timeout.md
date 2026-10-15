# Design service replay aggregate timeout

- **ID:** 0218
- **Status:** open
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
