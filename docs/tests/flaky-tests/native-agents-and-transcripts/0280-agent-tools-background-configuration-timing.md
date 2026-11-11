# OpenCode agent-tool background configuration timing

- **ID:** 0280
- **Status:** resolved
## Observation — 2026-10-17 (device-login main merge)

- **Test:** `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation`, in `apps/backend/src/core/commands-agent-tools.test.ts:174` (removed with OpenCode 1.x on 2026-11-11; `git show 5f4e27b1c:apps/backend/src/core/commands-agent-tools.test.ts`).
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host. Backend used two isolated Bun workers.
- **Failure:** after the fixed 150 ms wait, `openCodeAgentToolsConfigurationCount()` was 1 instead of 0. The case took 166.45 ms.
- **Suite counts:** backend reported 8,840 passed, 41 skipped and one failed across 8,882 tests in 471 files (518.76 seconds). The workspace group finished with 12 successful tasks out of 13; root/support passed separately.
- **Owning-file rerun:** `mise run test:logged -- --name merge-agent-tools-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`, with the same PATH preference, passed unchanged (exit 0) in 2.2 seconds while the bridge group was running.
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YjH5CD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z4nMqJ/merge-tests.log.gz`.
- **Assessment:** the unchanged isolated pass establishes intermittence. The fixture delays its HTTP response by 75 ms and the assertion uses a fixed 150 ms wait; shared-host scheduling or HTTP latency is a plausible but unconfirmed cause. The merge conflicts were confined to flake documentation. No product code, assertion, timeout or skip was changed.

## Capacity retry review — 2026-10-30

Preparation's `mise run test` failed when the 150 ms background-configuration assertion retained one configuration (176.96 ms).
The backend reported 2 failures in the default aggregate with its normal
concurrent groups. Evidence is `validation-05.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-197e8c94-de90-4cb9-9a1d-f52dd1d193c4/`.

Both unchanged owners passed together with one isolated worker (exit 0, 3.3 s):

```sh
mise run test:logged -- --name preparation-backend-failures -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts ./tests/standalone-ready.test.ts --parallel=1 --only-failures
```

Consistent with the previously recorded real-timer scheduling sensitivity;
no product code, assertions, timeouts, or skips in these owners changed.

The exact default-suite command subsequently passed (exit 0, 160.5 s):
`mise run test:logged -- --name capacity-review-default-tests -- mise run test`.

### Resolution — 2026-11-06

- **Root cause:** the test slept a fixed 150 ms and then expected the background reconcile, whose fixture response is delayed 75 ms, to have finished. On a loaded host the response, the reconcile or the timer ran late. `schedule()` registers the cleanup that drops the in-flight entry (`task.finally`) before it chains the returned outcome (`task.then`), so the outcome promise settles only after the entry is gone. That promise is the completion signal the test should await.
- **Reproduced:** yes. With the fixture response delayed to 400 ms, the unchanged test failed with configuration count 1, not 0, as in the aggregate.
- **Fix:** `commands-agent-tools.test.ts` now awaits the outcome, then asserts zero configurations, one outcome and one request. The memoized second `schedule()` also awaits its returned promise instead of a 25 ms sleep, and it now also asserts that no reconcile was started. No assertion was removed and no product code changed.
- **Verification:** with the 400 ms delay (temporary), the fixed test passed. `mise run test:logged -- --name n0320-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --rerun-each=20` passed 420 tests with 0 failures.
- Same test and cause as [0320](0320-opencode-agent-tools-background-reconcile.md).

## Test removed (2026-11-11)

Test removed with OpenCode 1.x (2026-11-11). No surviving test runs this case;
the resolution above stays as history.
