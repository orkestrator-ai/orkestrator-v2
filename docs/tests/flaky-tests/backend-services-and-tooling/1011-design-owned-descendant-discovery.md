# surviving owned descendants fail shutdown verification and are terminated before profile removal

- **ID:** 1011
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `surviving owned descendants fail shutdown verification and are terminated before profile removal`
- **File:** `tests/unit/design-qualification-processes.test.ts:221`
- **Original command:** `mise run test`, root/support group with one worker, concurrent workspace and bridge groups.
- **Failure:** The descendant PID remained zero instead of being greater than zero (417.90 ms).
- **Suite counts:** 3,520 root/support passes, four failures, one error; 3,524 tests across 170 files.
- **Isolated rerun:** `mise run test:logged -- --name design-process-owner -- bun test ./tests/unit/design-qualification-processes.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file (7.6 s).
- **Evidence:** `orkestrator-test-run.pk3f2Z` below the host temporary directory.
- **Hypothesis:** Process discovery may race fixture startup under aggregate load; the unchanged full owner passes alone. Not confirmed; no assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** a partial-file read. The fixture wrapper creates `descendant` and then writes the pid; a read between the two sees `""`, `Number("")` is `0`, and the old loop `break`s on any successful read, so the test asserted `0 > 0` (the recorded 417.90 ms failure, well inside the loop's 2 s bound).
- **Fix:** `tests/unit/design-qualification-processes.test.ts` keeps reading until a non-zero pid arrives, ending early only when the wrapper exits (its `exit` event); no wall-clock bound. The fixture's default preview `timeoutMs` (only a readiness watchdog) is 60 s instead of 5 s.
- **Reproduced:** yes. Making the fixture write `""` first and the pid 300 ms later failed the unchanged test with `Expected: > 0, Received: 0` (105 ms); the changed test passes the same injection.
- **Stress:** passed under `bun scripts/test-under-contention.ts --burners 6` in `f4-testall-cont` (57.6 s). Base `a8b89f154`. Not part of this case: the same file's `a nonresponsive owned server…` and `another build identity…` cases (500 ms product deadlines) failed with ENOENT on the pid file in one single-core contention run; not investigated here.
