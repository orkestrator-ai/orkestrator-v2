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
