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
