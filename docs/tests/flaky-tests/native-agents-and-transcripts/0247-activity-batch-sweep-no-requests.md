# Activity sweep batch tests see no bridge requests

- **ID:** 0247
- **Status:** open
- **Date observed:** 2026-10-15
- **Tests:** `activity sweep over the batch route > 100 sessions cost 2 request(s) and touch nothing`
  and `activity sweep over the batch route > a restarted bridge re-detects the batch route`
- **Owning file:** `apps/backend/src/core/native-agent-service-activity-batch.test.ts:153` and `:269`
- **Original command:** `mise run test` on `todo-f-auth-required-readiness-827f9bbb991b`
  (sign-in readiness for bridges, backend providers and the native tab; no
  activity-sweep code changed). Other worktrees were also working on the host.
- **Failure:** the fake bridge recorded no requests: expected batch sizes
  `[64, 36]`, received `[]` (37.70 ms); expected `["POST"]`, received `[]`
  (10.40 ms). The log shows `Activity reconciliation for env-1 failed` with
  `ProviderUnavailableError` and `ProviderUnreachableError` around them.
- **Suite counts:** backend 8,026 passed, 39 skipped, 3 failed across 436 files
  (262.07 s); the third failure was case 0218. Web, protocol, desktop, CLI,
  toolchain, root, bridge and lockfile groups passed.
- **Isolated owning-file rerun:** `bun test src/core/native-agent-service-activity-batch.test.ts src/core/design/service.test.ts --preload ../../tests/setup-node.ts --only-failures`
  from `apps/backend` passed three times in a row (17 pass each, about 1.7 s).
- **Evidence:** `/tmp/orkestrator-test-run.8FscOl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the sweep could not reach the fake bridge's local port under
  host load, so reconciliation failed before sending; not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Recurrence on the MCP apply-path gaps branch

On 2026-10-16, `mise run test` failed two other cases of the same suite:
`activity sweep over the batch route > 10 sessions cost 1 request(s) and touch
nothing` (11.44 ms) and `> a failing batch route is bypassed for one sweep
only` (7.93 ms), with the same `ProviderUnavailableError` and
`ProviderUnreachableError` reconciliation logs. The change touched no
activity-sweep code. The unchanged owning file passed alone three times in a
row (7 pass each):

```bash
bun test src/core/native-agent-service-activity-batch.test.ts
```

Several other worktrees were running suites on the host at the same time.
Recorded evidence only; no test changed.


## Recurrence during mobile layout main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  with the testing guide's GNU-tool PATH while merging `origin/main` into
  `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers on the shared host.
- **Failure:** `activity sweep over the batch route > 10 sessions cost 1 request(s) and touch nothing`
  received `[]` instead of `[10]` at line 153 (11.81 ms), after reconciliation
  logged an error before the fake bridge recorded a request.
- **Suite counts:** backend 8,345 passed, 40 skipped and one failed across
  8,386 tests in 445 files (275.13 s). All other workspace packages, root,
  bridges and protocol verification passed. The aggregate exited 1 in 299.2 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-activity-batch-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 0.3 s).
- **Evidence:** `/tmp/orkestrator-test-run.6Xi3Fp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.C7Kwve/merge-tests.log.gz`.
- **Disposition:** recurrence matches the existing empty-request failure and
  passes alone. The local-port/host-load hypothesis remains unconfirmed; no
  product code, assertions, deadlines or skips changed.

## Recurrence during read-only Codex networking validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name wslock-full2 -- mise run test`
  on `fix/codex-read-only-turn-hosted-search` at `cd00cf51`, which changes no
  backend code. Other worktrees were validating on the same host.
- **Failure:** `activity sweep over the batch route > 1 sessions cost 1 request(s) and touch nothing`
  failed in the aggregate (16.88 ms), after reconciliation logged
  `ProviderUnavailableError` and `ProviderUnreachableError` for `env-1`.
- **Suite counts:** backend 8,618 passed, 41 skipped and one failed across
  8,660 tests in 461 files. Bridges and protocol verification passed; root
  also reported the existing flake-register metadata error for case 0265.
- **Isolated rerun:** `mise run test:logged -- --name wslock-activity-batch -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1`
  passed the unchanged owning file (exit 0, 0.5 s).
- **Evidence:** outer artifacts
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ToPPRg` and
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pYmQ2c`.
- **Disposition:** recurrence of the same aggregate-only failure; passes alone.
  No product code, assertions, deadlines or skips changed.

## Activity-sweep observation during agent readiness main merge — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reserved 4/1/2/1 slots on the shared host).
- **Failure:** `activity sweep over the batch route > missing unmaps only that session; unavailable leaves every mapping uncertain` retained `provider-1` at line 177 instead of removing it (20.58 ms). Reconciliation logged `ProviderUnreachableError`; this assertion did not inspect the request count, so the empty-request symptom of earlier observations is not independently established here.
- **Suite counts:** backend 8925 passed, 41 skipped and one failed across 8967 tests in 475 files (401.89 seconds). All other workspace packages, bridges and protocol verification passed. Root/support also reported the Pi runtime staging timeout tracked in 0178. The aggregate exited 1 after 1216.5 seconds, including host-capacity waits.
- **Isolated rerun:** `mise run test:logged -- --name merge-activity-file -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 0.4 seconds).
- **Evidence:** `orkestrator-test-run.f52EuE/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer artifact `orkestrator-test-run.uYmDZx/merge-tests.log.gz` under the host temporary directory.
- **Assessment:** the isolated pass establishes intermittence. The relationship to earlier local-port failures and host contention remains unconfirmed. No source, assertion, deadline or skip changed.

## Refused-cell validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`. No backend implementation or owning test changed.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host; backend used two isolated workers. The workspace group waited 686.3 seconds for capacity.
- **Failures:** the 10-session case received `[]` instead of `[10]` (22.53 ms); the 100-session case received `[]` instead of `[64, 36]` (58.55 ms), both at line 153 after activity reconciliation logged an error.
- **Suite counts:** backend 8818 passed, 41 skipped and three failed across 8862 tests in 473 files (366.20 seconds). The remaining backend failure is 0211; bridges separately hit 0214. Root/support and protocol passed. The aggregate exited 1 after 1101.3 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name activity-batch-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 0.3 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nN9Z1G/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- This matches the existing aggregate-only empty-request symptom. The host-load/port hypothesis remains unconfirmed; no implementation, assertion, timeout or skip changed.

## Design live-cycle review recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name review-full -- mise run test`.
- **Failure:** `a failing batch route is bypassed for one sweep only` failed at line 239 in the unchanged owning file. Backend reported 9017 passed, 41 skipped and one failed.
- **Owning-file rerun:** `mise run test:logged -- --name review-activity-batch-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed unchanged in 0.5 seconds.
- **Evidence:** `orkestrator-test-run.yzrbXX/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** the owning-file pass establishes intermittence; the cause remains unconfirmed. No source, assertion, deadline or skip changed.

## OpenCode result-key correction validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers on macOS arm64 with Bun 1.4.3.
- **Failure:** `activity sweep over the batch route > an older bridge is read individually and not re-probed every sweep` expected one POST but received zero at line 208 (7.43 ms). Reconciliation logged provider-unavailable/unreachable errors.
- **Suite counts:** backend 9499 passed, 67 skipped and 55 failed across 9621 tests in 532 files (450.39 seconds). Other workspace packages, root, bridges and protocol passed. Aggregate exit 1 after 483.9 seconds. Other failures included reproducible command-fixture database schema mismatches and two broker assertions subsequently updated for the changed contract.
- **Owning-file rerun:** `mise run test:logged -- --name activity-batch-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.3 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.I5wqmJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `orkestrator-test-run.mhBVPo/full-suite.log.gz` in the same temporary directory.
- **Assessment:** matches the existing aggregate-only empty-request symptom. Host contention or local-port failures remain hypotheses. No activity-sweep source, assertion, timeout or skip changed.


## Idle-observation review validation — 2026-10-21

- **Original command:** `mise run test:logged -- --name full-suite-warm -- mise run test`
  on `qualify-idle-observation-per-provider-faa8f79fb369`, using the aggregate's
  two isolated Bun backend workers. The preceding full suite passed (444.2 s).
- **Failure:** `activity sweep over the batch route > missing unmaps only that session; unavailable leaves every mapping uncertain`
  retained `provider-1` at line 177 (8.57 ms), with an activity reconciliation
  error. This assertion does not establish whether a request reached the fake
  bridge.
- **Suite counts:** backend 9,744 passed, 67 skipped, one failed across 9,812
  tests in 551 files (361.75 s). Every other workspace package, root/support,
  bridges and protocol verification passed. The aggregate exited 1 in 382.3 s.
- **Isolated rerun:** `mise run test:logged -- --name activity-batch-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (seven tests, exit 0, 0.3 s).
- **Evidence:** `orkestrator-test-run.8ydoTB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and outer `orkestrator-test-run.3APBbj/full-suite-warm.log.gz`, under the host
  temporary directory.
- **Assessment:** the isolated pass establishes intermittence and matches the
  previously recorded retained-mapping symptom. The local-port/host-load
  hypothesis remains unconfirmed. No activity-sweep source, assertion, timeout
  or skip changed.

## Claude revision-token review fixes — 2026-10-21

- **Original command:** `mise run test:logged -- --name full-tests-cold -- mise run test` on macOS arm64 with Bun 1.4.3 and concurrent host validation.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers.
- **Failure:** `activity sweep over the batch route > missing unmaps only that session; unavailable leaves every mapping uncertain` retained `provider-1` at line 177 (11.86 ms), after reconciliation logged an error. This assertion did not independently establish the empty-request symptom.
- **Suite counts:** backend 9740 passed, 67 skipped and one failed across 9808 tests in 551 files (416.37 seconds). The aggregate exited 1 after 439.7 seconds; root/support also hit the Pi staging timeout tracked in 0178. Other workspace packages, bridges and protocol passed.
- **Owning-file rerun:** `mise run test:logged -- --name activity-batch-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.4 seconds logged).
- **Evidence:** `orkestrator-test-run.e4Hc1C/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.l7ZsFV/full-tests-cold.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Host contention or local-port failures remain unconfirmed explanations; no activity-sweep source, assertion, timeout or skip changed.

The subsequent `mise run test:logged -- --name full-tests-warm -- mise run test`
passed all four groups (exit 0, 442.9 seconds logged); root/support passed in
190.9 seconds. Both owning implementations and tests remained unchanged.

## Native agent collaborator extraction — 2026-10-23

- **Original command:** `bun scripts/run-logged.ts --name na-s4b -- bun test --cwd apps/backend <the 49 native-agent-*.test.ts files> --parallel=8 --only-failures` on macOS arm64 with Bun 1.4.2, while extracting `NativeAgentPromptQueueDispatcher` on `todo-0010-native-agent-collaborators-3fc4749e0985`.
- **Failure:** `activity sweep over the batch route > 1 sessions cost 1 request(s) and touch nothing` expected batch sizes `[1]`, received `[]` (152.22 ms), after `Activity reconciliation for env-1 failed: Error`.
- **Owning-file change:** the test's `observed()` helper now reads `observedSessionActivity` through the new `NativeAgentLaunchActivityReconciler` test accessor instead of a cast on the service; the sweep, the fake bridge and the assertions are unchanged.
- **Owning-file rerun:** `bun test ./src/core/native-agent-service-activity-batch.test.ts` from `apps/backend` passed three times in a row; the same 49-file parallel command then passed twice.
- **Assessment:** same empty-request symptom under parallel load; no activity-sweep assertion, timeout or skip changed.

## Coordinator consistency gaps (todo 0028) — 2026-10-25

- **Change:** branch `todo-0028-coordinator-consistency-b1b98c1981f1` (coordinator status wakes, mail drain batching, coordinator panel); nothing in the native activity sweep or this test.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on macOS arm64, Bun 1.4.4.
- **Failure:** `activity sweep over the batch route > a restarted bridge re-detects the batch route` timed out after 5000.05 ms, after `Activity reconciliation for env-1 failed: ProviderUnreachableError`.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts src/core/native-agent-service-activity-batch.test.ts` from `apps/backend` passed, 7 of 7.
- **Aggregate counts:** backend 11,077 passed, 84 skipped, 2 failed across 658 files (698.8 s); web 9,665 passed; root/support 3,418 passed; bridges and protocol passed. The other failure was 0507.
- **Assessment:** recurrence of the same parallel-load symptom; no implementation, assertion, timeout or skip changed.

## Voice qualification review fixes — 2026-10-25

- **Change:** `9b1b42be8`; no activity-sweep implementation or test changed.
- **Original command:** `mise run test:logged -- --name voice-suite -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1, with other worktrees active.
- **Failure:** the 100-session case expected `[64, 36]` but recorded `[]` (82.69 ms); reconciliation logged `SyntaxError`.
- **Complete unchanged owner:** `mise run test:logged -- --name activity-batch-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed, exit 0 in 2.8 seconds logged.
- **Evidence:** `orkestrator-test-run.OeJQLs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend totals: 11,431 passed and four failed; web had one failure. Root/support, bridges and protocol passed. The aggregate exited 1 in 1099.1 seconds logged.
- **Assessment:** recurrence of the empty-request symptom; cause unproven. No assertion, deadline or skip changed.

## Codex resume-context review validation — 2026-10-26

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridges/protocol reservations 4/1/2/1, backend two Bun workers.
- **Failure:** `activity sweep over the batch route > 10 sessions cost 1 request(s) and touch nothing` expected batch sizes `[10]`, received `[]` at line 157 (33.93 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name activity-batch-owner -- bun test --cwd apps/backend ./src/core/native-agent-service-activity-batch.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0 in 1.7 seconds.
- **Aggregate counts:** backend 11,196 passed, 95 skipped, three failed and one error across 655 files (501.24 s). The aggregate exited 1 after its groups finished in 1010.2 s.
- **Evidence:** host temporary directory `orkestrator-test-run.unZQTH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; enclosing `orkestrator-test-run.2JILAH/repository-tests.log.gz`.
- **Assessment:** recurrence of this existing empty-request symptom. No activity implementation, test, assertion, timeout or skip changed; the aggregate remains failed.

## Dispatch-recovery rebase — 2026-10-26

- **Change:** todo 0112 branch `todo-0112-review-fanout-recovery-0aecfac78013` rebased onto `a51045a4a` (review fan-out dispatch recovery, bridge `/dispatch` and status fields); no activity-sweep implementation or test changed.
- **Original command:** `mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1, load average about 8 to 9 with other worktrees active.
- **Failure:** `activity sweep over the batch route > missing unmaps only that session; unavailable leaves every mapping uncertain` (14.89 ms): after one reconciliation the stored mappings still held the session the fake bridge answered `missing` (`provider-1`), so the batch answer was not applied.
- **Suite counts:** backend 11,768 passed, 135 skipped and 1 failed across 703 files (480.29 s); web, root/support, bridges and the Codex protocol lockfile passed.
- **Complete unchanged owner:** `bun test ./src/core/native-agent-service-activity-batch.test.ts` from `apps/backend` passed three times in a row (7 pass each).
- **Evidence:** `orkestrator-test-run.oiIBIc` below the host temporary directory.
- **Assessment:** a fourth case of the same owner failing only in the aggregate; consistent with the batch reply never reaching reconciliation. Cause unproven. No assertion, deadline or skip changed.

## Main and remote feature-branch merge validation — 2026-10-26

- **Original command:** `mise run test:logged -- --name merge-repository -- mise run test` on the todo 0112 branch, Bun 1.4.4 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. The workspace group waited 263.2 seconds for its shared resource.
- **Failure:** `activity sweep over the batch route > 100 sessions cost 2 request(s) and touch nothing` expected `[64, 36]`, received `[]` at line 157 (51.14 ms), after reconciliation logged `ProviderUnavailableError`.
- **Suite counts:** backend 11,688 passed, 135 skipped, three failed and two errors across 703 files (396.45 seconds). Every other workspace package, root/support, bridges and protocol verification passed; the aggregate exited 1 after 712.6 seconds.
- **Concurrent-checkout limitation:** another process rebased this same checkout during the run. Two backend files failed to load because `agent-provider-contract.ts` temporarily contained conflict markers. These parse errors are separate from the activity-batch assertion and are not classified as flakes. The other process restored the merge at `3fdd41421`; its tracked code matches the intended resolved tree.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-activity-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures` passed (exit 0, 0.4 seconds logged).
- **Parse-error owner reruns:** `mise run test:logged -- --name merge-signal-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts --parallel=1 --only-failures` passed (74.0 seconds); `mise run test:logged -- --name merge-registry-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed (27.9 seconds). These reruns validate the restored files; the aggregate remains a failed, concurrently modified run.
- **Evidence:** `orkestrator-test-run.z45fz8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.HK0Z9L/merge-repository.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the known empty-request symptom, with the concurrent-checkout limitation above. No activity-sweep code, test, assertion, deadline or skip changed; the cause remains unproven.

## Coordinator upstream-send review — 2026-10-28

`mise run test:logged -- --name default-tests-rerun -- mise run test` retained
one backend failure: `a restarted bridge re-detects the batch route` exceeded
its 5,000 ms deadline (5,002.17 ms), following a `ProviderUnreachableError`.
Backend totals were 10,145 passed, 87 skipped and one failed. Web passed all
10,282 cases; root/support, bridges and protocol lockfile groups passed. The
aggregate exited 1 after 398.3 seconds logged.

The complete unchanged owner passed alone in 0.3 seconds (exit 0):

```sh
mise run test:logged -- --name activity-batch-isolated -- bun test --cwd apps/backend ./src/core/native-agent-service-activity-batch.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Evidence is `orkestrator-test-run.dVAVdc/default-tests-rerun.log.gz` and the
workspace group in `orkestrator-test-run.9oowaB/` below the host temporary
directory. No activity-sweep implementation, test, deadline or skip changed.
This confirms aggregate-only intermittence; its cause remains unproven.

## Pipeline validation-history review, 2026-10-30

`mise run test:logged -- --name repaired-unit-suite -- mise run test` repeated
this unchanged owner failure. The 100-session sweep recorded no requests instead of batches of 64 and 36 (205.03 ms); backend totals were 11,271 passed, 87 skipped and two failed.
The complete unchanged owner then passed alone with exit 0 in 1.0 s:

```sh
mise run test:logged -- --name recorded-activity-batch -- bun test --cwd apps/backend ./src/core/native-agent-service-activity-batch.test.ts --parallel=1 --only-failures
```

Aggregate evidence is `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. Passing output was removed by the runner.
No owner implementation, assertion, timeout or skip changed; the cause remains
unconfirmed.
