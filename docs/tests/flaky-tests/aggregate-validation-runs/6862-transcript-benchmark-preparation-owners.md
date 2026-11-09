# To-do 6260 preparation: owners triaged `related` through a transitive import

- **ID:** 6862
- **Status:** open
- **Date observed:** 2026-11-05 (aggregate), 2026-11-06 (reruns)
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` in review preparation, macOS arm64, Bun 1.4.4, 18 CPUs. It ended after 1,247 s without the backend group's closing totals.
- **Commits:** failures recorded at `6e5ac57fe`; reruns at `653cf9192`, which changes nothing these owners run (benchmark script flags, its cleanup, and one new hashing test).
- **Evidence:** `.orkestrator/review-artifacts/review-validation-d87cceb4-6aec-4385-bde1-ebd00ab9a90e/validation-02.stderr.txt` (preserved, not committed).

## Failing tests

The triage marked these ten `related` with the reason `imports-changed-file` and the changed path `apps/backend/src/core/native-agent-projection-encoding.ts`. Each owner does reach that module, but only as one of 684 to 869 modules in its import closure (counted with `bun build --metafile`). The branch's only change there is what `digestWithMessages` feeds its hash; it has no import-time effect, and none of these tests calls it. To-do 6920 limited `related` by import to a changed file within two hops of the test's own code (2026-11-09); a replay of these ten owners against that change, with this branch's changed module, gives `undetermined` with `reaches-changed-file-indirectly` at 3 and 8 hops ([failure triage](../../../architecture/review-preparation.md#failure-triage)).

| Owner | Tests that failed in the aggregate | Original failure |
| --- | --- | --- |
| apps/backend/tests/portable-inputs-stamps.test.ts | in `a restart with unchanged inputs`: `a staged file rewritten with the same bytes is still unchanged`, `the relay's fresh copy of unchanged mounts is still unchanged`; in `a changed input is reflected at the next start`: `changing one file in a tree copies that tree alone`, `removing one input takes only that input out of the home`, `a file that never came from an input is never removed`, `a revocation's scrub empties the home of that provider's inputs` | 60 s timeout, then `entrypoint failed:` with empty stderr after `killed 1 dangling process` (the pattern of cases [5561](../environments-and-containers/5561-portable-input-stamps-spawn-latency-deadline.md) and [6600](6600-live-head-preparation-owners-vary-with-load.md)) |
| apps/backend/tests/portable-inputs-user-extensions.test.ts | in `user skills and commands in containers`: `withholds nested credentials before staging and import while preserving safe resources`, `the entrypoint imports them where Claude and Grok read user resources` | 5 s timeout, then the entrypoint child's status `null` instead of 0 |
| apps/backend/src/core/control-mcp-coordinator-goals.test.ts | `setting a goal > refuses a parked dispatch, which would hold the loop back unseen` | 5 s timeout, then `session.start failed: operation-failed` from the fixture |
| apps/backend/src/core/coordinator-notice-hierarchy.test.ts | `disabled receiver declines repository, switch and stop notices for leaf fallback` | 5 s timeout, then `SQLiteError: disk I/O error` (`SQLITE_IOERR_VNODE`) in the fixture's `addEnvironment` |

The "unhandled error between tests" the triage could not attribute is not a separate failure. Each of the eleven such blocks in the log is a late throw from a test that had already hit its deadline, and each is followed by that test's own `(fail)` line.

The same run had seven `undetermined` timeouts in other owners (`staged-input-relay`, `coordinator-delegation-wakes`, `coordinator-node-coordinator-mail`, the container-status and attachment tests, `goalWorkspaceFingerprint`, and the Codex review-security test) and the packaged-Electron path test, which expects a Linux layout on macOS. They are outside this case.

## Runs alone at `653cf9192`

Load is the one-minute average while the run was going.

| Owner | Command | Result |
| --- | --- | --- |
| control-mcp-coordinator-goals and coordinator-notice-hierarchy | `mise run test:logged -- --name rework-coord -- bun --cwd=apps/backend test <both files> --parallel=2` | pass, 66 s, load about 40 |
| portable-inputs-user-extensions | `bun --cwd=apps/backend test tests/portable-inputs-user-extensions.test.ts` | 5 pass, 1 skip, 0 fail, 11 s, load about 40 |
| portable-inputs-stamps, one failing test | `bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts -t "a staged file rewritten"` | 1 pass, 11 s, load about 40 |
| portable-inputs-stamps, whole file | `bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts` | 50 pass, 0 fail, 982 s, load 38 to 52 |

Two earlier attempts at the stamps file through `test:logged` (one with `--only-failures --parallel=2`, one without) were ended by the runner's 300 s no-output watchdog, not by a failure. The file's tests call `Bun.spawnSync`, which blocks the event loop, so Bun prints nothing while a slow boot runs.

## What this shows

- **Established:** every `related` owner passes alone on this branch with the change in place, so none of these failures follows from the change.
- **Established for one:** `SQLITE_IOERR_VNODE` is an I/O error from the host's file system, not a test assertion. This host's disk had reported problems on the same day.
- **Not established:** why the entrypoint children stalled. The host ran at a one-minute load average of 40 to 52 on 18 CPUs throughout, which matches case 6600's correlation with load, but load is not shown to be the cause.

## Fix

None here. No assertion, deadline or fixture changed: the tests belong to other areas, and a longer deadline on this branch would only hide the condition.
