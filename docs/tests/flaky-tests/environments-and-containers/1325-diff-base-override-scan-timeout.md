# Diff-base override integration scan timeout

- **ID:** 1325
- **Status:** open
- **Observed:** 2026-10-31
- **Test:** `saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base`
- **File:** `apps/backend/src/core/diff-base-override.integration.test.ts`

During coordinator recovery validation,
`mise run test:logged -- --name repaired-full-suite -- mise run test:full`
timed out this unchanged integration case at 30,011.70 ms against its 30,000 ms
budget. The all-tier workspace reserved four slots with two isolated workers
per package, root reserved one slot, and bridges two. Browser and Electron
validation also ran on the shared Linux host.

The complete owning file passed alone:
`mise run test:logged -- --name isolated-diff-base-existing -- bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1 --only-failures`
(exit zero, 14.5 s). The logged runner removed passing raw output. Aggregate
evidence is in
`/tmp/orkestrator-test-run.eeYqDS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed after completion). Final aggregate counts are retained with that
run's artifacts.

This is an intermittent deadline miss in a real Git and scan scenario.
Shared-host contention is a hypothesis, not an established root cause. No
assertion, timeout, skip, scan implementation or owning test changed.
