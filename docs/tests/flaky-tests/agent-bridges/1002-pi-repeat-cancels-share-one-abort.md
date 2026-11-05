# Pi: repeat cancels of an accepted run

- **ID:** 1002
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `concurrent cancels for one claim > repeat cancels of an accepted run share one abort`
- **File:** `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts`
- **Original command:** `mise run test` on branch `todo-0109-rootless-linux-runtime-d03790b22a6c` (omarchy-hp, shared host), bridges group with two workers.
- **Failure:** `expect(await responses[0]!.json()).toEqual({ cancelled: true })` received a different body (one-line diff) after 37.32 ms.
- **Suite counts:** pi-bridge 632 pass, 1 fail; every other bridge passed.
- **Isolated rerun:** `mise run test:logged -- --name a-pi -- bun test --cwd bridges/pi-bridge --preload ./src/testing/test-isolation.ts src/prompt-cancel-preflight.test.ts --parallel=1` passed.
- **Hypothesis:** the first cancel answered before the run was accepted (`pending`) under load; the branch did not change the Pi bridge.

## Recurrence: 2026-11-03 coordinator-panel main merge

The unchanged owner failed in `mise run test:logged -- --name merge-tests -- mise run test`,
bridges group (two worker slots, one Bun worker per bridge): Pi reported 563 pass, 1 skip,
1 fail across 38 files (54.25 s). At line 336, the second response contained
`cancelled: false` instead of `true` (32.66 ms). The complete owner passed alone:
`mise run test:logged -- --name merge-pi-rerun -- bun test --cwd bridges/pi-bridge --preload ./src/testing/test-isolation.ts ./src/prompt-cancel-preflight.test.ts --parallel=1 --only-failures`
(exit 0, 1.3 s; passing counts were suppressed). Evidence:
`/tmp/orkestrator-test-run.hhJatu/bridges.log.gz`.
The timing hypothesis above remains unconfirmed. Merge parents:
`97f493ce559fb436f182ec083118d393e5f6c3e2` and
`7b48c23fb1a48d77f4f93968b289292e78dbb0ad`.

## Recurrence: 2026-11-05 installer address-findings validation

`mise run test:logged -- --name address-default-tests -- mise run test` on
installer repair commit `91fd199b6` (the run started on its parent while the
repair was being committed) failed in the bridges group with two worker slots.
Pi reported 615 pass, 1 skip, 1 fail across 41 files (26.89 s). The second
cancel body at line 337 was `{ cancelled: false }` instead of `{ cancelled: true }`
(16.70 ms). Neither the test nor bridge implementation is in the installer diff.

The complete owner passed alone (exit 0, 1.2 s; counts suppressed):
`mise run test:logged -- --name address-pi-cancel -- bun test --cwd bridges/pi-bridge ./src/prompt-cancel-preflight.test.ts --preload ../../tests/setup-node.ts --preload ./src/testing/test-isolation.ts --parallel=1 --only-failures`.
Aggregate evidence: `/tmp/orkestrator-test-run.ooy5qK/bridges.log.gz`.
The timing hypothesis remains unconfirmed.
