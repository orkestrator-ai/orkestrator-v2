# Application logging shutdown deadline fails under load

- **ID:** 0712
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `application logging shutdown > quits anyway when the flush outlives its deadline`
- **File:** `apps/desktop/electron/application-logging.test.ts`
- **Original command:** the workspace group of `mise run test` (`bunx turbo run build test:workspace … --concurrency=3`, `ORKESTRATOR_TEST_WORKERS=3`), run directly while other worktrees held the machine at a load average of about 70.
- **Failure:** failed after 68 ms; `fixture tree digest > names every class of change a coordinator could make` (0258) also timed out in the same run.
- **Isolated rerun:** `bun test ./electron/application-logging.test.ts` from `apps/desktop`: 25 pass, 0 fail.
- **Assessment:** a deadline-based test sensitive to scheduler delay; unconfirmed.

## Preview pool review repair — 2026-11-03

At `1012906d3`, `mise run test:logged -- --name r1-status-full-suite -- mise run test`
failed the sibling `application logging shutdown > closes the log only after pending output settles`
at `apps/desktop/electron/application-logging.test.ts:760` after 23.49 ms:
`quitCount` was zero instead of one after the five-millisecond sleep.
Desktop used two workers; workspace/root/bridges/protocol reservations were
6/1/2/1. Desktop reported 1,622 passes, 16 skips and one failure. Root reported 3,481 passes and one unrelated failure; web reported
11,513 passes, ten skips and no failures. The aggregate exited 1 in 836.1 s,
including a 269 s resource wait. Its other failures were the existing case
3008 metadata, review fan-out assertion and ActionBar test type error.

The complete unchanged owner passed alone (exit 0, 0.3 s):

```sh
mise run test:logged -- --name r1-logging-owner -- bun test --cwd apps/desktop ./electron/application-logging.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2G7kmZ/r1-status-full-suite.log.gz`;
the inner workspace log is under `orkestrator-test-run.FCChXD` in the same
temporary parent. Neither logging code nor its tests changed on this branch.
This confirms intermittence in another shutdown sibling; scheduler delay
between closing the log and the deferred quit remains a hypothesis.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 1.4 s: `mise run test:logged -- --name design-links-owner-desktop-logging -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the cases use fixed sleeps: 60 ms for a 10 ms deadline at `application-logging.test.ts:450`, and 5 ms after resolving the stop at line 427. The sibling `holds the quit open until the flush completes, then quits once` failed in [0720](../aggregate-validation-runs/0720-mcp-environment-delivery-validation.md) (73.4 ms) and [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) (26.13 ms); this case covers both. The owner passed alone today (25/25, 5.2 s; Bun 1.4.4).
- **Next step:** poll (bounded) for `quitCount === 1` instead of the fixed sleeps.

## Container resource budget review — 2026-10-25

The workspace group of `mise run test:logged -- --name resource-tests -- mise run test` failed `application logging shutdown > holds the quit open until the flush completes, then quits once` after 36.02 ms: `app.quitCount` was still zero after resolving the pending flush and waiting five milliseconds (line 429). The complete unchanged owner passed with the aggregate's Node preload: `mise run test:logged -- --name application-logging-owner-node -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures` (exit 0, 0.2 seconds logged). Evidence: host temporary artifact `orkestrator-test-run.9oxrhT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`, compressed after aggregate finalization. This confirms an intermittent flush-completion timing failure in the same shutdown owner; shared-host contention remains a hypothesis. No desktop implementation, assertion, deadline or skip changed.


## Project checkout review validation — 2026-10-31

After installing the missing pinned Codex CLI into the ignored checkout-local
`binaries/` directory, the exact default command was rerun:

```sh
mise run test:logged -- --name review-default-rerun -- mise run test
```

It finished in 776.7 s, including about 528 s queued behind other worktrees.
Worker reservations were workspace/root/bridges/protocol 6/1/2/1. Root,
bridges and protocol passed. The workspace retained only
`application logging shutdown > holds the quit open until the flush completes, then quits once`
at `apps/desktop/electron/application-logging.test.ts:429`: after its fixed
five-millisecond sleep, `quitCount` was zero instead of one (16.16 ms test
duration). Desktop reported 1,382 passed, 16 skipped and one failed. Backend
passed 11,352 tests with 103 skipped; web passed 10,850 with ten skipped.

The complete unchanged desktop owner passed (exit 0, 0.8 s):

```sh
mise run test:logged -- --name desktop-logging-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.kmeKkl/` and enclosing
`orkestrator-test-run.6zMpc6/` in the host temporary directory. The checkout
fixes change no logging implementation, timing assertion, deadline or skip.
The isolated pass confirms intermittence, not a root cause or an aggregate
pass.


## CLI descriptor coverage review — 2026-11-03

`mise run test:logged -- --name review-default-tests -- mise run test`
ran after the descriptor-size coverage and scheduler-policy repair based on
`1d85a718a`. Worker reservations were workspace/root/bridges/protocol 6/1/2/1.
The desktop package failed
`application logging shutdown > closes the log only after pending output settles`
at line 760 (29.93 ms): `app.quitCount` was zero instead of one after a fixed
five-millisecond sleep. Desktop totals: 1,622 pass, 16 skip, one fail across
111 files (35.85 s).

The complete unchanged owner passed alone (exit 0, 0.7 s):
`mise run test:logged -- --name descriptor-review-logging-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`.
Passing case counts were not retained by the logged runner. Evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.GsDDP5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
This confirms intermittence in another flush-completion sibling; the fixed sleep
is an evidence-backed timing hypothesis, not a proven root cause. No desktop
code, timeout, assertion or skip changed. Status remains open.

## Integrate review — 2026-11-05

At `d96a45c1c`, the exact preparation rerun
`mise run test:logged -- --name review-default-tests -- mise run test`
(workspace/root/bridge/protocol reservations 6/1/2/1) failed
`application logging shutdown > quits anyway when the flush outlives its deadline`
at line 1144: quitCount was 0 instead of 1 after 72.59 ms. The complete unchanged
owner passed alone (exit 0, 1.1 s):
`mise run test:logged -- --name logging-isolated -- bun test --cwd=apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`.
Evidence: workspace log in `orkestrator-test-run.tjKud0` under the host temporary
directory; outer run `orkestrator-test-run.lBswTp`. Aggregate totals were not yet
available. No logging implementation or test was changed. See aggregate case 5105
for the companion Pi and diagnostics intermittence.
