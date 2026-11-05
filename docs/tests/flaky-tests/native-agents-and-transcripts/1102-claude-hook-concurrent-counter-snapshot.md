# 1102 — Claude hook concurrent counter snapshot

- **ID:** 1102
- **Status:** resolved
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

## 2026-11-05 environment-deletion review recurrence

Preparation at `2350d1e8da1f721a4e8b11886ccc84df1304c77c` ran
`mise run test:logged -- --name review-default-tests -- mise run test` and
observed `working 11 0` instead of `working 20 0` (1178.65 ms). The immutable
diagnostic is `.orkestrator/review-artifacts/review-validation-99e6b0c3-c310-4ab4-a4da-4957c80f5523/validation-04.stderr.txt:1203`.
The package's triage marks it related through an indirect import of
`diff-stats-tracking.ts`; it also identifies this open flake. The package
reports no reliable complete aggregate count (including two between-test
errors), so no additional suite total is inferred here.

The owning file passed alone, unchanged, in 0.7 s:
`mise run test:logged -- --name address-recorded-hook -- bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures`.
This confirms recurrence of intermittent behavior, not a repair. The hook
script's one-second lock deadline can skip a write on contention while exiting
successfully, but that path was not instrumented in the captured run; no cause
is established. No assertion, timeout, skip or hook implementation was changed.

## Root cause and fix (2026-11-05, environment-deletion rework)

**Root cause.** `docker/orkestrator-state-signal.sh` takes its lock with
`flock -w 1` and, by design, skips its write and still exits 0 when the lock
is not free within one second, so a hook never holds up Claude. The test
starts twenty writers at once and expects all twenty increments. Unloaded,
the twenty serialized critical sections finish in about 80 ms; under an
aggregate suite's load each one spawns slowly enough that the later writers
pass the one-second deadline and drop their increments. The recorded cases
fit that: 6 and 11 of 20 increments, in cases that took 2,493.64 ms and
1,178.65 ms. A direct probe confirmed the mechanism: with the lock held for
two seconds, a writer returned 0 after one second and left the snapshot
unchanged. Sixteen concurrent bursts of twenty writers on this host, three
rounds, all reached 20 at both a one-second and a sixty-second wait, so the
load needed to cross the deadline was not reproduced here; the held-lock case
is the evidence.

**Fix.** The script reads an optional `ORKESTRATOR_STATE_LOCK_WAIT` (whole
seconds; anything else falls back to the one-second default, and nothing in
the image sets it). The serialization test sets it to 60, so it tests
serialization rather than host speed. A new deterministic case,
`a hook writer that cannot take the lock in time skips its write and still succeeds`,
holds the lock in a child process and checks that a writer with a zero or
malformed wait exits 0 without touching the snapshot, and that the next
writer after release counts on from the persisted value. No assertion was
loosened. Verified with
`mise run test:logged -- --name hook-lock -- bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts ./tests/tmux-poll-failed-turn.test.ts ./src/core/claude-state-signal.test.ts --parallel=2 --only-failures`
(passed, 1.8 s).
