# Restore plan at the real measurement cap times out under parallel load

- **ID:** 5360
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `snapshot measurements past the cap > restore plans at the real cap stay complete and cost no blob reads`
- **File:** `apps/backend/src/core/change-tracking/measurement-file-cap.test.ts`
- **Original command:** `mise run test:logged -- --name change-tracking -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/change-tracking --parallel=4 --only-failures'`, during the E4 object-store work (efficiency report 0430, part 0550) on branch `object-store-f917b2cace0c-r1` based on `69a3b4ca5`.
- **Worker configuration:** four isolated Bun workers over the 24 change-tracking test files; host load average about 34 (other worktrees' suites running).
- **Failure:** the test exceeded Bun's 5000 ms deadline (5926.09 ms reported). Cleanup then closed the database under the timed-out turn, so the next lines are `turn.finalize-failed ... Cannot use a closed database` and an unhandled `RangeError: Cannot use a closed database` from `latestMeasurement` (`measurement-file-cap.test.ts:475`).
- **Suite counts:** 286 pass, 1 fail, 1 error across 287 tests in 23 files (22.2 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/change-tracking/measurement-file-cap.test.ts` from `apps/backend` passed the complete unchanged owning file twice (20 pass, 0 fail each); the test alone took 3.1 s.
- **Hypothesis:** the fixture writes and captures the measurement cap plus 50 files in one turn, which costs about 3 s on an idle worker, so a loaded host pushes it past the default 5 s deadline. The change under test did not touch the capture, measurement or restore paths this test exercises (it changed only the store's sweep, its byte count and retention's manifest walk, none of which this test runs). Unconfirmed: whether the same run on `main` times out; it was not repeated there.
- **Later observation (2026-11-05):** during the E3 retention work on `54911a112`, on an external volume with a host load average about 50, it exceeded the deadline (5543.45 ms) under four workers and again when its owning file ran alone. Run alone with `--timeout=30000` and `-t "restore plans at the real cap"` it passed. That change touched no code on this test's capture path. So on a loaded host the 5 s deadline can fail even in isolation.
- **Recurrence 2026-11-05:** review preparation of `76136cdb7` on `move-pipe-captures-c7893f496669-r1`, based on `af2e566e5`, timed out at 5246.50 ms in `mise run test`. The owning file also timed out alone, three times out of three (5125 to 5371 ms; 19 pass, 1 fail, 1 error) at a host load average of 33 to 37 on 12 cores, with the same closed-database error after the timeout; the first of those ran beside three other owner reruns. With `--timeout=60000` on the command line, for diagnosis only, the test filtered by name passed in 10.3 s at a load average of 37 and the whole file passed alongside `object-store-write-path.test.ts` in 34.0 s, so it was slow rather than stalled. That branch moved `runCommandBuffer`, which this test's capture calls, into `command-capture.ts`; on a successful capture the only differences are the output limit passed as a value and a Windows-only `windowsHide` flag. No idle-host rerun was possible, so a small cost from the move is not excluded by measurement. No assertion, timeout or skip was changed.

## Egress repair validation — 2026-11-05

The default aggregate (`mise run test:logged -- --name review-default-tests -- mise run test`,
two backend workers) reproduced the restore-plan timeout at 5,586.09 ms, then the
closed-database cleanup error. Backend totals: 15,599 pass, 134 skip, four failures,
one error. This owner and its implementation are unchanged by the egress branch.
`mise run test:logged -- --name measurement-cap-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/measurement-file-cap.test.ts --parallel=1 --only-failures`
also failed: 19 pass, one failure and one error, 8.8 s for the file; the case timed
out at 5,526.42 ms. Artifact:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.WN1JLd/measurement-cap-owner.log.gz`.
This occurrence has no isolated pass, so it remains unresolved; it is not excused
as environmental based on the timeout alone.

## Recurrence 2026-11-06 — coordinator Work panel removal

`mise run test:logged -- --name address-default-suite -- mise run test`
failed on this unchanged backend test at 5090.23 ms (5,000 ms deadline)
with four backend workers. Backend totals: 16,356 pass, 126 skip, three failures and two errors;
web: 12,990 pass, zero failures. The same run also caught two new test type
errors, corrected in `5f5cb11b1`. Evidence:
`/tmp/orkestrator-test-run.srVdfm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The owning file passed unchanged with
`mise run test:logged -- --name address-measurement-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-file-cap.test.ts --parallel=1 --only-failures`
(exit 0, 6.3 s). No assertion, skip, or timeout was changed. The coordinator
renderer removal does not edit this backend path; initial timeout cause remains
unconfirmed. A fresh aggregate run follows the test type fix.

## Interaction-policy review repair validation — 2026-11-06

The exact default aggregate retry (`mise run test:logged -- --name
review-default-tests -- mise run test`, up to four backend workers) reproduced
the timeout at 5,977.15 ms. The backend group later hit its no-output watchdog,
so it has no complete test total. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LRGSlT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The unchanged owner failed alone again: 19 passes, one timeout (6,075.48 ms)
and one closed-database error, 11.2 s for twenty tests:

```sh
mise run test:logged -- --name backend-measurement-cap-alone -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-file-cap.test.ts --parallel=1 --only-failures
```

Artifact: `orkestrator-test-run.gk5LrU/backend-measurement-cap-alone.log.gz`
under the same temporary root. This branch changes no measurement/capture code
or tests. The failure remains unresolved; no timeout, assertion or skip changed,
and no environmental exemption is claimed from the timeout alone.

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

The exact restore-plan test timed out at 5532.95 ms against the 5000 ms
deadline in `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Unchanged complete owner rerun:

```sh
mise run test:logged -- --name measurement-cap-isolated -- bun --cwd=apps/backend test src/core/change-tracking/measurement-file-cap.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 4.0 s. Passing output was deleted by the logged
runner, so isolated totals are not inferred. The isolated pass establishes
intermittence, not a cause or a repair. No assertion, timeout or skip changed.

## Environment-deletion main merge — 2026-11-06

`mise run test:logged -- --name merge-default -- mise run test` repeated
the restore-plan deadline at 5,724.92 ms with four isolated backend workers.
Evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HtWRHT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The complete unchanged owner still failed alone:
`mise run test:logged -- --name merge-restore-plan-alone -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-file-cap.test.ts --parallel=1 --only-failures`.
It reported 19 pass, one fail and one between-test error in 11.81 s: the same
case timed out at 5,812.19 ms, then outstanding work used the closed database.
Isolated evidence: `orkestrator-test-run.ShXcQv/merge-restore-plan-alone.log.gz`
under the same temporary root. The nine-worker component browser suite was
also running. No isolated pass, new root cause or fix is claimed; no assertion,
deadline, skip or implementation changed.

### Resolution — 2026-11-06

- **Root cause:** the case is deliberately about the production cap
  (`measurementFileRowCap` 2,000), so it writes and captures 2,050 files in one
  turn and plans a 2,050-file restore. On this host that costs about 1 s for the
  turn and 0.2 s for `restore.prepare` when idle (3.6 s on the first,
  module-loading run). Its runtime therefore scales with host load, and Bun's
  5 s default is below it under the aggregate. The closed-database error is a
  consequence of that: on timeout, `afterEach` runs `harness.cleanup()` under the
  still-running turn. Earlier diagnostics already showed the case is slow, not
  stalled (10.3 s at load 37 with a long timeout).
- **Fix (test only):** `apps/backend/src/core/change-tracking/measurement-file-cap.test.ts`
  gives this one case a 30 s budget sized to its workload, with a comment saying
  why. There is no event to synchronise on, only throughput. Shrinking the cap
  would remove what the case exists to check, and every assertion is unchanged.
- **Reproduced:** yes. Pinned to one core beside 8 busy loops, the unchanged case
  failed 3/3 (5.40 to 5.61 s, `this test timed out after 5000ms`), each followed
  by `turn.finalize-failed ... Cannot use a closed database`.
- **Verification:** the same contention with the fix
  (`mise run test:logged -- --name coord-5360-fix-load -- taskset -c 11 bun --cwd=apps/backend test ./src/core/change-tracking/measurement-file-cap.test.ts -t "restore plans at the real cap" --rerun-each=3`):
  3/3 pass, about 8 s each. Complete owner alone: pass (`coord-ct-files`, with
  `retention-store-walks.test.ts`).
