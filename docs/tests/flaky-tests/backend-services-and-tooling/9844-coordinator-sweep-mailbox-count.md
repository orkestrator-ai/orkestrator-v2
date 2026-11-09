# Coordinator sweep mailbox sync count varies in aggregate validation

- **ID:** 9844
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `the sweep's global work > runs the mailbox sync and the delegation scans once for several coordinators`
- **File:** `apps/backend/src/core/coordinator-sweep.test.ts:226`
- **Revision:** `451fccdf1` (bridge authority review repairs).

`mise run test:logged -- --name repair-default -- mise run test` reported
expected one sync call but received two (705.39 ms). The workspace group ran
with six granted slots. The outer command later hit its 30-minute deadline,
after an approximately 23-minute host-lease wait; final totals are unknown.
Neither this test nor `coordinator-sweep.ts` is changed by the branch.

The complete unchanged owning file passed alone (exit 0, 14.2 s):

```sh
mise run test:logged -- --name isolate-coordinator-sweep -- bun test --cwd apps/backend ./src/core/coordinator-sweep.test.ts --parallel=1 --only-failures
```

Evidence: host temporary files
`orkestrator-test-run.HNKlxf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
and `orkestrator-test-run.Iu6GYp/repair-default.log.gz`. The isolated pass
confirms intermittence. Timer scheduling under aggregate load is a hypothesis,
not an established cause. No implementation, assertion, timeout or skip changed.


## Cold realm boot review recurrence — 2026-11-06

Recorded preparation at `54ab6d570` ran
`mise run test:logged -- --name review-default-tests -- mise run test`.
Recovered workspace diagnostics show the mailbox sync count was two instead of one (928.69 ms).
The aggregate uses the repository scheduler (workspace group six slots;
bridge group two package slots with one Bun worker per bridge).

The complete unchanged owning file passed alone (exit 0, 3.3 s):

```sh
mise run test:logged -- --name address-coordinator-recorded-owner -- bun test --cwd apps/backend ./src/core/coordinator-sweep.test.ts --parallel=1 --only-failures
```

Original evidence remains in
`.orkestrator/review-artifacts/review-validation-f3469fba-5332-4a76-a6d8-5a4f873cf90f/validation-04.stderr.txt`
and `orkestrator-test-run.gIhwSP` compressed group logs below the host temporary
directory. The isolated pass establishes intermittence, not a cause or a fix.
The case remains open; no implementation, assertion, deadline or skip changed.

## CI recurrence and resolution — 2026-11-08 / 2026-11-09

**Recurrence.** CI pull-request run 42534159294 (#1990, `gpt-model-not`),
job "Tests (backend)" 128894642698, failed only this case: expected one sync
call, received two (475.06 ms); 20,582 passed, 1 failed. `mise run
flaky:recurrence -- 9844 --base a49fd2815` answered "open". Observed from
branch `fix-ci-failures-46b27b2ba576-r1`, base `a49fd2815`.

**Root cause (test).** `AgentMailService` debounces a mailbox sync 250 ms
after any `pane-layout`, `environment`, `project`, `session` or `coordinator`
change (`agent-mail-service.ts`, the `syncTimers` scopes). `addWorker` writes
an environment and a pane layout just before the test installs its
`synchronizeAgentMailboxes` spy. When the sweep took longer than the rest of
that 250 ms (a loaded runner), the mail service's own debounced sync landed
inside the measured window and was counted as the sweep's. The sibling case
in the same `describe` already stops the mail service before counting for
this reason; this one did not.

**Fix.** `coordinator-sweep.test.ts` calls `world.mail.shutdown()` (which
clears the debounce timers) before installing the spies, as its sibling does.
No assertion, deadline or production code changed.

**Verification.**

- Reproduced before the fix: a temporary `await Bun.sleep(300)` after the
  spies were installed failed the case with the CI message (expected 1,
  received 2; 367.68 ms) via `bun test --cwd apps/backend
  ./src/core/coordinator-sweep.test.ts -t "runs the mailbox sync"`.
- With the fix and the same delay: passed. Delay removed afterwards.
- Stress: eight concurrent runs of the case pinned to two cores with two
  busy-loop processes: 8 of 8 passed. The complete owning file passed through
  `mise run test:logged -- --name coordinator-sweep -- bun test --cwd
  apps/backend ./src/core/coordinator-sweep.test.ts --parallel=1
  --only-failures` (1.1 s).
