# Legacy draft timestamp comparison

- **ID:** 9908
- **Status:** resolved
- **Test:** `local annotation drafts are kept per node > the un-namespaced copy moves to the command node once`
- **File:** `apps/web/src/lib/persistence-keys.test.ts:41`

## Observation (2026-11-09)

Base: `448e9fffb992c3b6306aa6562c88e23c59fb74d8`. Observing commit:
`d95269b49`. No existing case matched the owning file or test name in the group indexes;
this is a first observation, not a recurrence.

Command: `mise run test:logged -- --name review-default-tests -- mise run test`.
The aggregate granted six workspace worker slots, one root slot, two bridge slots
and one protocol slot. The web package reported 14163 passed, 2 skipped, 1 failed;
other groups passed. Overall duration: 257 seconds. The failing assertion took
0.50 ms. Expected legacy JSON timestamp `1794235736978`, received
`1794235736977`.

Isolated unchanged owner command:
`NODE_ENV=test mise run test:logged -- --name persistence-keys-isolated -- bun test --cwd apps/web ./src/lib/persistence-keys.test.ts --parallel=1 --only-failures`.
Passed (0.2 seconds).

Evidence: `/tmp/orkestrator-test-run.4WOjS6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `/tmp/orkestrator-test-run.nfczhf/summary.json`.

## Cause and scope

`legacyDraft("stale")` calls `Date.now()` each time. The test calls it to write the
stored value, then calls it again to construct the expected value. Crossing a
millisecond boundary changes the expected JSON even though the stored value is
unchanged. This is an assertion clock dependency, not evidence of a product race.
Neither the owner nor its persistence implementation is changed by the Actions
panel branch. No unrelated test or product code was modified to hide the failure.

At the time of this observation, the case recorded the failure only and the
default suite remained red.

## Resolution (2026-11-09)

Merging `origin/main` brought in the repair: the test captures the stale payload
once and reuses it for the write and comparison. The same failure was independently
recorded in [case 9907](9907-local-annotation-draft-legacy-clock-race.md), which
contains the reproduction and stress evidence for that fix. No new reproduction
or stress run is claimed here. This branch's original observation is retained
under a new number because main already owns claim 9906 for a different case.
