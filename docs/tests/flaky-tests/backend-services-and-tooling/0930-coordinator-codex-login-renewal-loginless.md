# Coordinator Codex login renewal reads loginless in the aggregate

- **ID:** 0930
- **Status:** resolved
- **Date observed:** 2026-10-25 (first seen inside aggregate case
  [9890](../aggregate-validation-runs/9890-reconnect-freshness-validation.md),
  which had no owner case)
- **Test:** `renews an expired owner login without ordinary sessions before the coordinator handoff`
- **File:** `apps/backend/src/core/agent-accounts-active.test.ts:571`
- **Change under test:** todo 0038 (design link resume identity on the native
  session record; teardown fallback), commit `f771a8b8c` on
  `todo-0038-design-conversation-links-852aa84d76e8`. No account, login or
  coordinator code changed.
- **Original command:** `mise run test` (default worker reservations; the
  workspace group took 4 slots and started without waiting). Host load
  average 37–52 from other workers' suites on the same machine.
- **Failure:** `expect(login.loginless).toBeUndefined()` received `true`
  (26.27 ms). The concurrent `prepareCoordinatorCodexHome` and
  `readCoordinatorCodexLogin` read the owner `auth.json` as loginless instead
  of waiting for the stubbed refresher's renewed login.
- **Aggregate counts:** backend 11,437 passed, 89 skipped, 3 failed across
  681 files (796.55 s). The other two failures were the known environment-move
  timeouts [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)
  and [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md).
  Root/support, bridges and the Codex protocol lockfile passed.
- **Unchanged owner rerun:** `mise exec -- bun test --preload ../../tests/setup-node.ts src/core/agent-accounts-active.test.ts`
  from `apps/backend` passed twice (25 pass, 0 fail each).
- **Evidence:** `orkestrator-test-run.ZkIWTS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory.
- **Hypothesis:** the two concurrent reads race the refresher's write of the
  renewed `auth.json` (or read a partially written file) under load. Not
  established; no implementation, assertion, timeout or skip was changed.

## Provider parity main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test` on `agent-provider-parity-b3e549e90812-r1`, merging main at `751b971623` (2026-10-31).
- **Worker configuration:** workspace/root/bridges/protocol reservations 6/1/2/1; backend 4x parallel, root 1x parallel; Bun 1.4.4. The run waited about 182 seconds for the host scheduler.
- **Aggregate result:** exit 1; backend 11,883 passed, 103 skipped and four failed across 11,990 tests in 812 files (266.84 s); root/support 3,320 passed, one failed and one error across 3,321 tests in 162 files (350.27 s). Web, desktop, public web, CLI, protocol, toolchain, bridges and protocol-lockfile checks passed. The aggregate took 710.6 s including the queue.
- **Failure:** `renews an expired owner login without ordinary sessions before the coordinator handoff` expected `login.loginless` to be undefined and received `true` (48.90 ms).
- **Unchanged owner rerun:** `mise run test:logged -- --name merge-account-login-owner -- bun test --cwd apps/backend ./src/core/agent-accounts-active.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0 (2.0 s).
- **Evidence:** `orkestrator-test-run.LzSOdM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and enclosing `orkestrator-test-run.WvH9mv/merge-default-tests.log.gz` under the host temporary directory.
- **Assessment:** unchanged owner passed in isolation; no implementation, assertion, deadline or skip changed. Timing or host contention remains a hypothesis. The aggregate remains non-green.


## Essential logging review repair — 2026-11-04

- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, captured against `a6fbce12d17d8fae2a029cb07f15dc4abd31d101`, Bun 1.4.4, default workspace worker pool. Backend: 14,186 pass, 102 skip, 1 fail across 964 files (240.69 s); the named case failed in 13.85 ms with `login.loginless` equal to `true`.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-ba68504e-9e73-4f80-ad0f-1fb00b892449/validation-04.stderr.txt`, lines 2048–2060 and 2452–2456. The unchanged owner rerun `mise run test:logged -- --name recorded-account-owner -- bun test --cwd apps/backend ./src/core/agent-accounts-active.test.ts --parallel=1 --only-failures` passed (1.0 s).
- **Defect:** `readCoordinatorCodexLogin` read before joining the per-home refresher. A concurrent reader could observe an empty file during renewal and skip the refresh join because the empty snapshot had no refresh token.
- **Repair:** Join the owning home's refresher before reading its login. The refresher still checks expiry and serializes spending the refresh token. A deterministic regression starts with an empty login and proves the reader joins renewal and receives the restored access token. No timeout, assertion, or skip was loosened.
- **Focused verification:** The complete account owner passed after repair (1.1 s), and `codex-host-login-refresh.test.ts` passed. The review-stage fix result records aggregate verification and the repair commit.

- **Fix reference:** `f45e4c350` (`fix(logging): isolate essential writes and close persistence gaps`).
- **Aggregate after repair:** The exact recorded command was rerun: backend 14,188 pass, 102 skip, 0 fail across 964 files (199.51 s); web 11,835 pass, 10 skip, 0 fail; root/support, bridges and protocol lockfile groups passed. The command still exited 1 solely on the web build's already-recorded `commands-environment.ts:1686` TS18047 and `LocalEnvironmentDeleteDialog.test.tsx:78` TS2769. Neither file is in this branch's diff against origin/main. Evidence: `orkestrator-test-run.AktCYA/review-default-tests.log.gz` (outer capture), `orkestrator-test-run.F6xf8P/` (group artifacts) under the host temporary directory, and `apps/web/.turbo/turbo-build.log`. No further login-renewal failure occurred.
