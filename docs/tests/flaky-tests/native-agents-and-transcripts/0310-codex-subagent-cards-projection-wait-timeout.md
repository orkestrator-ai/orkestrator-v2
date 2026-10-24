# Codex sub-agent cards: projection wait timeout (`apps/backend/tests/codex-subagent-cards.test.ts`)

- **ID:** 0310
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `Codex sub-agent cards through the bridge and backend projection > each child keeps one card, its transcript and status across a fresh backend and a cold restart`
- **Owning file:** `apps/backend/tests/codex-subagent-cards.test.ts:125`
- **Original command:** `mise run test` on branch `fix-codex-phantom-denials-8bdb8d15d820`
  (base `9da80451`), whose diff touches no backend or bridge source. Other
  worktrees were running suites and live tests on the same host; workspace
  admission waited for slots.
- **Failure:** at 31,775.48 ms, `Failed waiting for three child cards and the
  rejected spawn: TimeoutError: The operation timed out.` from
  `waitForProjection` (`apps/backend/tests/wait-for-projection.ts:37`), called
  at `codex-subagent-cards.test.ts:132`. The log also carries repeated
  `mcpServerStatus/list failed (-32601): unknown method` lines from the fake
  app-server, which appear in passing runs too.
- **Suite counts:** backend 8,789 passed, 41 skipped, 2 failed (8,832 tests,
  471 files, 514.15 s); the other failure was 0226. Root had one failure
  (0178); web, bridges and the protocol lockfile passed.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts tests/codex-subagent-cards.test.ts`
  from `apps/backend`: 1 passed in 1.1 s.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.6fSEkJ`.
- **Hypothesis:** host contention delaying the fake app-server's child
  notifications past the wait deadline. Not confirmed.

## Egress qualification review recurrence — 2026-10-22

- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`, Bun 1.4.3 on macOS arm64; workspace/root/bridges/protocol reservations 4/1/2/1. Other worktrees also ran suites.
- **Failure:** the same owning test failed its card snapshot at line 140 (714.12 ms). Some pending children retained fallback names (`lint_check`, `type_check`) and empty actions instead of their hydrated names and tool actions. This differs from the original wait timeout but also observes a child projection before complete hydration.
- **Backend counts:** 9903 passed, 80 skipped and one failed across 9984 tests in 571 files (537.46 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name codex-subagent-cards-isolated -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.9 seconds logged).
- **Evidence:** `orkestrator-test-run.MSqERJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. The passing owner output was deleted by the logged runner.
- **Assessment:** confirms an intermittent projection snapshot mismatch in the existing owner. Asynchronous hydration under contention is a hypothesis; no backend/bridge implementation, test assertion, timeout or skip changed.

## Live image preview validation recurrence — 2026-10-24

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`, started on 2026-10-23 and completed on 2026-10-24 (Europe/London), while validating `0b41b3d9c`. The aggregate reserved workspace/root/bridges/protocol workers 4/1/2/1; the backend used two Bun workers. Other worktrees were also running suites.
- **Failure:** the same test failed at line 170 after 656.97 ms: the cold-restart projection's `turn.phase` was `recovering`, where the assertion expected `idle`.
- **Suite counts:** backend 10,569 passed, 77 skipped and 15 failed across 10,661 tests in 618 files (595.32 seconds). The other 14 failures expected OpenCode version `1.19.0` while the installed binary reported `1.19.4`. Root, bridges and protocol groups passed; the complete aggregate took 649.2 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name codex-cold-restart-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` passed unchanged (one test, exit 0, 1.8 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.SfITWq/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer aggregate log in `orkestrator-test-run.uF2Bqh/repository-tests.log.gz` under the same temporary root. Passing rerun output was deleted by the logged runner.
- **Assessment:** another observation of the cold projection before recovery settles. Host contention remains a hypothesis; the backend, bridge and owning test were unchanged by the image preview fix.


## Mixed-version compatibility main merge — 2026-10-24

- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=712274379cc0a83226b8d2ab4b04e9a329fbcb14 mise run test:logged -- --name merge-suite -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1 on the shared macOS host, Bun 1.4.3; backend used two workers.
- **Failure:** `each child keeps one card, its transcript and status across a fresh backend and a cold restart` failed its line-140 snapshot in 473.17 ms. Pending cards retained fallback names (`type_check`, `unit_check`) and empty actions instead of hydrated names and `tool:exec_command`, matching the earlier snapshot symptom.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-codex-subagent-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` passed (one test, 2.2 s logged).
- **Evidence:** `orkestrator-test-run.sWhHYC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate finalization; the aggregate summary is in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#mixed-version-compatibility-main-merge--2026-10-24).
- **Assessment:** confirmed intermittent recurrence. Hydration under contention remains a hypothesis; no owning implementation, assertion, timeout or skip changed during merge resolution.
