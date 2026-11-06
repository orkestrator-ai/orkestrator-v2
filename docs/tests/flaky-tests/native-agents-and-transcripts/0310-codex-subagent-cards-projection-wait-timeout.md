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

## Frontend-to-backend branch main merge — 2026-11-01

- **Original command:** `mise run test:logged -- --name merge-tests-final -- mise run test`, Bun 1.4.4 on the shared Linux host. Workspace/root/bridge/protocol groups reserved 6/1/2/1 worker slots; backend used four parallel workers.
- **Failure:** `Codex sub-agent cards through the bridge and backend projection > each child keeps one card, its transcript and status across a fresh backend and a cold restart` received `recovering` instead of `idle` at line 170 after 920.68 ms.
- **Counts:** backend 12,912 passed, 112 skipped, one failed across 867 files (179.32 s). Web, root, bridges and protocol groups passed; the aggregate failed after 325.8 s.
- **Complete unchanged owning-file rerun:** `mise run test:logged -- --name merge-codex-subagent-isolated -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` passed (one test, 1.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.egszoc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.DtSUk4/merge-tests-final.log.gz`.
- **Assessment:** recurrence of the existing cold-restart observation mismatch. The first default aggregate's workspace group passed. No owning-test assertion, timeout or skip was changed; the isolated pass does not make the final aggregate green.

## Live logging review repair validation — 2026-11-01/02

`mise run test:logged -- --name review-repair-default -- mise run test` used
workspace/root/bridges/protocol reservations 5/1/2/1 on a shared macOS host.
The cold-restart card case expected `idle`, received `recovering` at line 170
(1,745.45 ms). The complete unchanged owner passed alone, exit 0 in 3.7 s:
`mise run test:logged -- --name codex-subagent-cards-owner -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures`.

The outer command reached its 1,800-second guard after a 925-second capacity
wait, so final workspace totals were unavailable. Evidence remains in the raw
`orkestrator-test-run.BSqVX9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
and the outer compressed `orkestrator-test-run.JX4kAV/review-repair-default.log.gz`
below the host temporary directory. No implementation, assertion, deadline or
skip changed. This repeats the known intermittent cold-restart projection state;
its cause remains unconfirmed.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.

## Safe error formatting second review — 2026-11-02

Preparation ran `mise run test` at `de952cc0accc820c6d57425323428cc993794a54`.
The backend used three isolated workers and reported 13,006 passed, 97 skipped,
and five failed across 870 files (440.83 s). Original evidence is preserved at
`.orkestrator/review-artifacts/review-validation-b03e0cc0-820a-4723-8d36-20d1666dfe82/validation-04.stdout.txt`.

This case observed cold.turn.phase was recovering rather than idle at line 170 (1242.23 ms).

The complete unchanged owner passed on the fix branch as part of
`mise run test:logged -- --name r5-round2-recorded-owners -- bun test --cwd apps/backend ./tests/container-readiness.test.ts ./src/core/commands-agent-tools.test.ts ./tests/codex-subagent-cards.test.ts ./src/core/nodes/node-files.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures`
(exit zero, 14.2 s; passing per-file counts were not retained by the runner).

A detached `origin/main` worktree at `9dbd7f1cc9981789ab352056bea84a1007c99959`
used its own `mise exec -- bun install --frozen-lockfile` dependencies.
Its complete owner check was `mise run test:logged -- --name r5-round2-main-child-cards -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` (3.7 s).
The targeted repeat command was `mise run test:logged -- --name r5-round2-main-cards-repeat -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --test-name-pattern 'each child keeps one card' --rerun-each=20 --parallel=1 --only-failures`.
Result: 18 passed, 2 failed (25.6 s); one repeated the exact recovering-versus-idle assertion at line 170, and one had a partial child snapshot at line 140. Failure evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.awzwf2/`.

The same failure on main establishes independence from this branch. The owner
and implementation are unchanged relative to main. No assertion, delay, skip,
or unrelated implementation was changed; the existing flake remains open.

### Exact aggregate rerun outcome

`mise run test:logged -- --name r5-round2-default-suite -- mise run test`
finished with exit 1 (919.0 s, including about 663 s of admission wait).
Workspace, root and protocol groups passed. All five original backend assertion
failures passed in this run. The sole failing group was bridges: the Codex
catalogue disposal assertion recorded in case 0791. No root-cause fix to these
existing timing cases is claimed. Final status evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kkqsTX/summary.json`;
compressed group logs are in that same directory. The enclosing log is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.TLjndR/r5-round2-default-suite.log.gz`.

## Opaque session review — 2026-11-03

Recorded `mise run test:all` at 27f6d5eba reported `recovering` instead of
`idle` at apps/backend/tests/codex-subagent-cards.test.ts:170 after cold restart
(1017 ms). The unchanged owner passed alone on the repair branch in 0.9 s:

`mise run test:logged -- --name codex-subagent-isolated -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures`

It also passed in a four-owner focused baseline run on origin/main 63e202c27
(248 pass, three unrelated failures). No assertion or timing changed.
Original evidence: `.orkestrator/review-artifacts/review-validation-2c183b1f-33d1-45e1-b1fe-0f5647dd9025/validation-01.stdout.txt`.

## Main merge validation — 2026-11-03

Merge parents: `75a0942990e169213c57b193efb5dfe87589abc2` and
`b58d401e12b948de0f9c4d966c706bfe00d04225`. The owner was not conflicted.
`mise run test:logged -- --name merge-tests -- mise run test` failed in the
workspace group (323.4 s overall); backend used four workers and reported
13,478 pass, 100 skip, 3 fail across 908 files. The test
`each child keeps one card, its transcript and status across a fresh backend and a cold restart`
received `recovering` instead of `idle` at line 170 (947.19 ms).

The unchanged complete owner passed alone:
`mise run test:logged -- --name merge-codex-cards-rerun -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures`
(exit 0, 1.0 s; passing counts not retained). This repeats the open cold-restart
projection race; no root cause is established. Original group evidence:
`/tmp/orkestrator-test-run.svBnLQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## CLI descriptor review — 2026-11-03

- **Test:** `Codex sub-agent cards through the bridge and backend projection > each child keeps one card, its transcript and status across a fresh backend and a cold restart`
- **Original command:** `mise run test` at `2e81b373d006fa917fec5ed04a254e10c76a6703`.
- **Worker configuration:** workspace reserved six slots, root one, bridges two; backend used four workers.
- **Failure:** Cold restart reported recovering instead of idle at line 170 (1154.15 ms).
- **Suite counts:** backend 13,567 pass, 100 skip, four fail across 916 files; root 3,480 pass, two fail, one error across 173 files.
- **Original evidence:** `.orkestrator/review-artifacts/review-validation-bca4dff9-573c-45e5-bc25-4af3941061cd/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name descriptor-triage-subagents -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` → passed, exit 0, 2.8 s.
- **Disposition:** The unchanged complete owner passed alone. This confirms intermittent behavior, not a root-cause fix. No assertion, timeout, skip or implementation in this area was changed.

## `recovering` variant fixed — 2026-11-03 (CLI descriptor repair)

- **Root cause of the `recovering` versus `idle` variant:** after `restart()`
  the test read one projection straight away. A fresh codex-bridge reports
  raw phase `starting` until its new app-server child is up, and
  `HttpBridgeProvider` maps that to `recovering`
  (`apps/backend/src/core/http-bridge/provider.ts`). Under load the first read
  came before the child was up.
- **Fix:** the cold-restart read now uses `stack.waitForProjection` until the
  phase is no longer `recovering`, then asserts `idle` and the same cards and
  rows as before. A turn that stays `recovering` still fails at the existing
  30 s projection deadline. No implementation, assertion or skip changed.
- **Verification:** `mise run test:logged -- --name l12-codex-cards -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --rerun-each=5 --only-failures`
  passed with exit 0 in 5.5 s.
- **Status:** still open. The original 31.8 s wait timeout and the
  fallback-name, empty-action snapshot at line 140 are different variants, and
  this change does not address them.

## E6 store-write review repair — 2026-11-05

- Recorded `mise run test` at `7bfd46df0` failed the line-140 snapshot in 697.56 ms: children still had fallback names and empty actions. Backend: 15,035 pass, 115 skip, 3 fail, 1 error across 1,012 files. Original output remains in `.orkestrator/review-artifacts/review-validation-d1e558f9-f9c1-4288-bf06-576ef34bd9ad/validation-04.stdout.txt`.
- The initial wait checked only identified children and the rejected spawn's name. That condition can hold before child activity hydration finishes.
- Repair: wait for the three expected names and tool actions and the rejected spawn's failure action before taking the snapshot. All existing snapshot assertions remain.
- Owning check: `mise run test:logged -- --name codex-cards -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures` passed (one test, 0.7 seconds). This addresses the partial-hydration symptom; the earlier cold-restart recovering/idle symptom remains open.

## Egress name-check repair validation — 2026-11-05

The first `mise run test:logged -- --name review-default-tests -- mise run test`
rerun failed `each child keeps one card, its transcript and status across a fresh
backend and a cold restart` after 15,201.59 ms. The aggregate was interrupted by
the pipeline pause before complete totals; its workspace used six reserved worker
slots, with two workers per package. No card implementation or owner test changed.
`mise run test:logged -- --name codex-cards-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures`
then passed with exit 0 in 1.4 s. The interrupted aggregate's original raw evidence
is `orkestrator-test-run.20KKVR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
under the host temporary directory. Contention is a hypothesis; no host load was
measured. This observation does not establish a fix.

## Storage/mail review recurrence — 2026-11-06

The exact recorded command, `mise run test:logged -- --name review-default-tests -- mise run test`,
recurred on the storage/mail branch (`023c7a2ce`, followed by the unchanged-test
classification rename `ee92c4741`). The workspace reserved six slots; backend
used four isolated workers alongside two web workers and the root group.
The completed backend totals were 16,613 pass, 138 skip, 4 fail and 2 errors
across 16,755 tests in 1,109 files (670.51 s execution). The full command
finished with exit 1 in 1,499.6 s; workspace and root failed, while bridges
and the protocol lockfile passed.

Evidence: `workspace-web-backend-desktop-web-public-cli-protocol-toolchain` in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KcOGqn`;
outer wrapper `orkestrator-test-run.uRCFAT` under the same temporary root.

`Codex sub-agent cards through the bridge and backend projection > each child
keeps one card, its transcript and status across a fresh backend and a cold
restart` failed after 32,543.54 ms in the projection wait at line 132. The last
projection still had pending child cards; fixture bridge stderr also reported
`mcpServerStatus/list` as an unknown method. This does not establish that the
method error caused the failed wait.

The unchanged complete owner passed alone, exit 0 in 1.7 s:

```sh
mise run test:logged -- --name findings-codex-cards -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures
```

Passing logs were removed; isolated case counts are not inferred. No bridge,
projection code, assertion, deadline or skip changed. The timeout variant
remains open; no cause or fix is established by this observation.

## Wait-timeout variant fixed — 2026-11-06 (to-do 4960 task 2 review repair)

- **Recorded failure:** review preparation's `mise run test:logged -- --name review-default-tests -- mise run test` at `32c1e126c` failed this test at line 132 after 31,241.89 ms: `Failed waiting for three child cards and the rejected spawn: TimeoutError`. Backend: 16,614 pass, 138 skip, 1 fail across 1,110 files (314.18 s). In the last projection the `lint_check` child had no name and no actions while Grace and Linus were hydrated. Evidence: `.orkestrator/review-artifacts/review-validation-58dd6eff-5cc0-4544-bf61-603faa8eef78/validation-04.stderr.txt`. The branch changed only backend change-tracking restore code, which this test does not reach.
- **Reproduced on the branch:** `mise run test:logged -- --name codex-cards-repeat -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --rerun-each=20 --parallel=1 --only-failures` at load average 43: 19 passed, 1 failed (run 9, 30,478 ms). That time the `unit_check` child stayed unhydrated, so any child can.
- **Root cause (codex bridge):** a sub-agent card gets its name and actions only from a transcript probe of the child's rollout. The probe ran only inside a publish, and a publish followed only a parent-stream event, at most once per `SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS` (2 s). The fake, like real Codex, sends the spawns as one burst and then nothing until `finish`. When the last probe of the burst could not yet resolve a child's rollout (for example a throttled probe, or a lookup that cached a miss), no later event triggered another probe. The card stayed without its name until the turn ended, well past the 30 s wait. The same gap affected real turns: a running child's progress did not appear while the parent was quiet (a `wait`).
- **Fix:** `scheduleSubagentProbe` (`bridges/codex-bridge/src/app-server-runtime-rows.ts`), called after every publish in `publishAssistantMessage`. While any card of a running turn is unsettled, it arms one follow-up publish a probe interval later, and cancels it once the cards settle, the turn ends or the thread is released. The test's wait, assertions and timeout are unchanged.
- **Regression test:** `sub-agent probes while the parent is quiet` in `bridges/codex-bridge/src/app-server-runtime-rows.test.ts`. With the follow-up disabled, the card never hydrates and the test fails at its 5 s wait. With the fix it passes.
- **Stress verification:** `mise run test:logged -- --name codex-cards-repeat-fixed -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --rerun-each=60 --parallel=1 --only-failures` at load average 39 to 43: 60 passed, 0 failed (77.8 s). The whole codex-bridge suite (`test:bridge`, two workers) passed.
- **Status:** still open. All three named variants now have a fix: the wait timeout here, partial hydration (2026-11-05) and `recovering` (2026-11-03). The 15.2 s aggregate failure of 2026-11-05 has no recorded assertion, so this case stays open until a soak passes or that failure is explained.

### Investigation — 2026-11-06

- `mise run test:logged -- --name n0310-baseline -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/codex-subagent-cards.test.ts --rerun-each=8 --only-failures` passed all 8 runs (11.8 s) at a load average above 20. The 2026-11-05 15.2 s failure printed no assertion that was retained, and no evidence for it survives under `/tmp`. The earlier `recovering` and partial-hydration variants are already fixed (see above), so the remaining variant cannot be identified. One single-read step is still left: `reopenBackend()` followed by one `projection()`. Its result is compared against the running cards. It is a candidate if a recurrence fails at that line. Status stays open.
