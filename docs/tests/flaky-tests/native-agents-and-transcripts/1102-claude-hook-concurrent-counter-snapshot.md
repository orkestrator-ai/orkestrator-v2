# 1102 — Claude hook concurrent counter snapshot

- **ID:** 1102
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `hook writers serialize counters and retain a completed turn without any config`
- **Owner:** `apps/backend/tests/claude-state-signal-integration.test.ts`

## Observation

During legacy prompt-queue claim validation on branch
`todo-0078-legacy-prompt-queue-claim-cf8aca50d0cb`, a broad backend run with three
isolated Bun workers failed at line 259: the snapshot was `working 6 0` instead
of `working 20 0` after all twenty writer processes exited successfully. The
case took 2493.64 ms. The host was also running other admitted suites.

The logged command was:

```sh
mise run test:logged -- --name legacy-focused -- bun --cwd apps/backend test --preload ../../tests/setup-node.ts ./src/core/storage-record-upgrades.test.ts ./src/core/storage-prompt-queues.test.ts ./src/core/native-agent-prompt-queue-dispatcher.test.ts --parallel=3 --only-failures
```

The `bun --cwd ... test` form invoked the backend package's test script, whose
`src tests` arguments selected the entire backend. The intended focused cases
were subsequently run with `sh -c 'cd apps/backend && bun test ...'`.
This branch does not change the hook script or the failing test.

## Isolated rerun

```sh
mise run test:logged -- --name hook-writers-isolated -- sh -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts ./tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures'
```

The unchanged owner passed (exit 0, 2.2 s). Original evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FvEZxm/legacy-focused.log.gz`.
The broad run finished with 12,106 passed, 120 skipped, 20 failed and 11
between-test errors across 728 files (850.12 s). It also observed a queue
assertion while that implementation was still being edited; the final nine
queue-related owners passed together after the edits. That in-progress failure
is not classified as a flake.

## Hypothesis

The snapshot may be published out of counter order when the shell writers run
concurrently under host load. The isolated pass establishes intermittent
behaviour, not its cause. No assertion, timeout or skip was changed.

## 2026-11-05 E8 review recurrence

Preparation at cd5b0142 again failed this owner under `mise run test` (1169.12 ms; diagnostic in review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt). The owner passed in a sequential one-worker rerun alongside three other recorded backend owners:
`mise run test:logged -- --name recorded-backend-failures -- bun --cwd=apps/backend test tests/shell.test.ts tests/claude-state-signal-integration.test.ts tests/commands-container-exec.test.ts src/core/preview-listener-ownership.test.ts --parallel=1 --only-failures`.
The command passed in 6.1 seconds; passing output was deleted by the logged runner. No assertion changed.

## X1 preparation recurrence, 2026-11-05

Preparation at `e6d400a5a` failed the exact owner test with `working 4 0`
instead of `working 20 0` (1386.84 ms), in `mise run test:logged -- --name
review-default-tests -- mise run test`. Evidence: review-validation-cb344dc9-16d4-4c41-980a-8b2fc2a2e3b5/validation-04.stderr.txt.
The aggregate selected concurrent workers through the tier runner; it has no
reliable closing total. `mise run test:logged -- --name recorded-state-signal --
bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts
--parallel=1 --only-failures` passed in 0.9 s (exit 0). Passing output was removed,
so no totals are inferred. No implementation, assertion or timeout changed;
the root cause and original aggregate remain unresolved.
## Egress name-check repair validation — 2026-11-05

`mise run test:logged -- --name review-default-tests -- mise run test` reproduced
`hook writers serialize counters and retain a completed turn without any config`
in the workspace group (two backend workers): expected `working 20 0`, received
`working 16 0`, 1,142.95 ms. The aggregate's final totals are recorded in the repair
result; the owner and hook implementation are unchanged by the egress branch.
`mise run test:logged -- --name claude-signal-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures`
passed with exit 0 in 2.1 s. The original failure remains in the logged workspace
artifact (`orkestrator-test-run.LAWw4i` under the host temporary directory).
No cause or fix is established by the isolated pass.

## Interaction-policy review repair validation — 2026-11-06

`mise run test:logged -- --name review-default-tests -- mise run test`
reproduced this counter failure in the backend group (the default aggregate
allocates up to four backend workers): expected `working 20 0`, received
`working 9 0`, 1,271.49 ms. The aggregate finished with failed workspace/root
groups and passing bridge/protocol groups; the backend did not produce a
complete total before its no-output watchdog fired. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LRGSlT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The unchanged owner still failed alone with `working 8 0` (1,337.17 ms),
six passes and one failure across seven tests, 3.1 s:

```sh
mise run test:logged -- --name backend-state-signal-alone -- bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures
```

Isolated evidence is `orkestrator-test-run.zuLdCA/backend-state-signal-alone.log.gz`
under the same temporary root. This branch changes interaction browser fixtures,
the Codex fake and qualification tests, and documentation; it changes neither
this owner nor the Claude hook script. No fix or new isolated pass is claimed.

## Flow viewport review validation recurrence — 2026-11-06

Observed on `d81fd21ed` in
`mise run test:logged -- --name review-default-tests -- mise run test`.
This branch changes the shared flow viewport and its renderer tests, plus
qualification documentation; it changes none of this owner's implementation.
The aggregate finished in 1615.7 s. Backend used four isolated workers
(16,358 pass, 134 skip, three failures); root used one worker
(3,674 pass, three failures). Web passed with 13,101 pass and ten skips.
Original evidence is under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fvkr6h/`;
the outer wrapper is `orkestrator-test-run.OXNmsh` under the same temporary root.

The exact hook-counter test received `working 19 0` instead of `working 20 0`
(1137.53 ms) in `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Unchanged complete owner rerun:

```sh
mise run test:logged -- --name hook-writers-isolated -- bun --cwd=apps/backend test tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 0.9 s. Passing output was deleted by the logged
runner, so isolated totals are not inferred. The isolated pass establishes
intermittence, not a cause or a repair. No assertion, timeout or skip changed.
