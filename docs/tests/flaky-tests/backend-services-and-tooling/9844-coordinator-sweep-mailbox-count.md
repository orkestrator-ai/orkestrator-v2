# Coordinator sweep mailbox sync count varies in aggregate validation

- **ID:** 9844
- **Status:** open
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
