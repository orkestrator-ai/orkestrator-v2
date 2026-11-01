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

## Remote host upgrades (0033) recurrence — 2026-10-26

- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` (base `93018933`), Bun 1.4.4 on Arch Linux x64, host load average 15–17 with other worktrees running suites. The diff touches no backend agent, bridge or projection code.
- **Failure:** line 170 after 1,317.22 ms: the cold-restart projection's `turn.phase` was `recovering`, expected `idle` (the 2026-10-24 symptom).
- **Suite counts:** backend 11,709 passed, 142 skipped, 4 failed across 11,855 tests in 703 files (731.65 s); the others were 0785, 1006 and the CLI package's 1007.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=2 tests/codex-subagent-cards.test.ts` from `apps/backend`: 1 passed.
- **Evidence:** `/tmp/orkestrator-test-run.s0jA9M/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` on omarchy-hp.

## Hidden-resume review recurrence — 2026-10-26

- **Failure:** Cold projection returned `recovering` instead of `idle` at line 170 (1544.23 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name codex-cards-owner -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (0.8 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.

## Keyboard-shortcut Windows/Linux recurrence — 2026-10-28

- **Original command:** `mise run test:logged -- --name full-test -- mise run test` on branch `todo-0325-keyboard-shortcuts-desktop-7ea8707afcbb` (base `6a6009a09`), Bun 1.4.4 on Arch Linux x64. Host load average was about 46, with other worktrees holding the exclusive test lease. The diff touches the desktop menu, the shortcut catalog and tests only; no backend, bridge or projection code.
- **Failure:** line 170 after 2,833.81 ms. The cold-restart projection's `turn.phase` was `recovering`, expected `idle`.
- **Owning-file rerun:** `mise run test:logged -- --name rerun-backend -- bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts ./tests/codex-subagent-cards.test.ts --parallel=2` passed this owner. The storage-writer guard in the same command failed, as it does on `origin/main`; see [1295](../aggregate-validation-runs/1295-keyboard-shortcuts-windows-linux-validation.md).
- **Evidence:** `/tmp/orkestrator-test-run.HKpv4c/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` on omarchy-hp. The aggregate was terminated at its deadline before finalization, so the log is uncompressed.
- **Assessment:** intermittent recurrence. No owning source, assertion, deadline or skip changed.

## Storage test splits (0930) recurrence — 2026-10-30

- **Original command:** `mise run test` on `todo-0930-storage-test-files-8ccf873101e6` at `dda88f007` (rebased as `b64a2b224`), Bun 1.4.4 on the shared Linux host, load average about 19–24.
- **Failure:** expected `idle`, received `recovering` at line 170 after the cold restart (988.01 ms), the same mismatch as case 1313.
- **Isolated rerun:** `mise run test:logged -- --name codex-subagent-alone -- bun --cwd=apps/backend test tests/codex-subagent-cards.test.ts` passed (4.0 s).
- **Assessment:** intermittent recurrence; the branch changes only storage tests and the writer guard. Recorded in aggregate case [1324](../aggregate-validation-runs/1324-storage-test-split-0930-validation.md).


## PR auto-merge review preparation recurrence — 2026-10-31

Preparation's `mise run test` failed the child-card projection equality at
line 140 after 1128.08 ms: child IDs and a `lint_check` card differed from the
expected snapshot. Evidence is
`.orkestrator/review-artifacts/review-validation-038a8906-ba10-4822-a245-7c81a58b7a2c/validation-04.stdout.txt`
(the backend used two parallel workers). The unchanged complete card owner
passed in the isolated command below; its sibling title-runner owner failed
because this checkout lacked the pinned Codex binary (9 passed, one failed,
2.7 s total):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts ./src/core/session-title-runners.test.ts --parallel=1 --only-failures
```

No projection implementation, assertion, or timeout changed.

After `mise run download:codex` installed the pinned 0.166.0 binary in the
ignored checkout-local `binaries/` directory, the exact isolated command above
passed both complete owners (10 tests, 5.1 s, exit 0).

## Capacity retry review (1010) recurrence — 2026-10-31

- **Original command:** `mise run test` on
  `todo-1010-capacity-retry-follow-ups-6057edc0cb1d` at `e81b746e9`, Bun 1.4.4
  on the shared macOS host. Workspace/root/bridges/protocol reserved 6/1/2/1
  worker slots; backend used two Bun workers. Admission waited about 411 s
  behind other worktrees' exclusive leases.
- **Failure:** the line-140 running-card assertion failed after 838.54 ms.
  The snapshot still contained a fallback `lint_check` card with empty actions,
  and another child's name/identity had not finished hydrating. The wait checks
  for three child IDs and the rejected spawn before checking the full snapshot;
  it does not require names or actions to have finished hydrating. This matches
  the earlier partial-hydration symptom; scheduling is a hypothesis, not an
  established root cause.
- **Suite counts:** backend 11,719 passed, 103 skipped, 1 failed across 11,823
  tests in 804 files. Twelve of thirteen workspace tasks passed. Root, bridge
  and Codex protocol groups all passed; the aggregate remained failed.
- **Complete unchanged owner:** `mise run test:logged -- --name
  codex-subagent-cards -- bun test --cwd apps/backend
  ./tests/codex-subagent-cards.test.ts --parallel=1` passed (one test, 2.9 s
  logged).
- **Evidence:**
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.QtSGjZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** confirmed intermittent recurrence. This review changes the
  OpenCode retry and ACP persistence/prompt paths; it does not change the Codex
  subagent fixture, implementation, assertion, timeout or skip.


## Held-history reconciliation review — 2026-11-01

The exact `mise run test` rerun observed `recovering` rather than `idle` at
`apps/backend/tests/codex-subagent-cards.test.ts:170` after 2229.63 ms, with two
backend workers. The backend group reported 12,521 passed, 107 skipped and
three failed. The complete unchanged owner passed alone with
`mise run test:logged -- --name current-codex-cards -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures`
(exit zero, 4.9 s). Evidence: `/tmp/orkestrator-test-run.NettPR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed after completion). No owner implementation, assertion, deadline or
skip changed; the isolated pass does not make the aggregate green.
