# Input-stamp tests pass their 60 s deadline when process spawning slows down

- **ID:** 5561
- **Status:** environmental
- **Date observed:** 2026-11-05
- **Test/file:** any test in apps/backend/tests/portable-inputs-stamps.test.ts that boots; which ones fail changes from run to run. In review preparation of the attention follow polling branch (`f9ca092b9`): `what the home holds decides as much as what the stamp says > an edited or deleted import comes back, as a full copy would bring it`, `> a stamp forged to match new inputs cannot keep the old input`, `> a damaged stamp falls back to the copy`, `> without the hashing tools every tree is copied`, `logins > Claude: a rotation and then a sign-out reach the home` and `logins > Claude: a sign-out leaves a login made or pushed since the import`.
- **Original command:** `mise run test` during review preparation, macOS arm64, Bun 1.4.4, 10 CPUs. The workspace group hit its 1,800,000 ms deadline with this file still running after 816 s. The same log has 12 timeouts at the 5 s default in other files, and the bridges group ended after 1,800,474 ms with no output.
- **Failure:** `^ this test timed out after 60000ms`, then `entrypoint failed:` with empty stderr, because the runner killed the boot it was waiting on (`killed 1 dangling process`).
- **Isolated rerun:** passed at the same commit (`b363473e5`), exit 0 in 181.5 s, once spawning was fast; see the table.
- **Root cause:** the deadline against the host's process spawn time, not the code under test. A boot runs many short-lived tools, so its duration follows spawn time. Spawning `/usr/bin/true` took 279–379 ms during the failures, with a load average of 32–42, and 4–12 ms just before and during the pass, with a load average of 22–42, so load average alone does not predict this failure. What slowed spawning was not identified. The tree of the worker that measured it ran at nice 10.
- **Not a hang:** four boots sampled after they had lived 20 s were all still making progress, with short-lived children (`gmkdir`, `bash`) started one to three seconds earlier and in run, uninterruptible or exiting states. A slow spell that outlasts several tests would explain failures in a row, which look like a wedged process.
- **Unrelated to the branch it was seen on:** the only code that branch changes is one test in `apps/backend/src/core/public-api/public-api-attention.test.ts`, which nothing imports and which this file does not load. The passing rerun includes that change.
- **Fix:** none here. The assertions, deadlines and entrypoint are unchanged, because a longer deadline on this branch would only hide the condition.
- **Not measured:** spawn time during the original preparation run and the 04:07–04:18 rerun (42 pass, 8 fail), so those runs are matched by their symptoms alone. The number of processes one boot spawns.

## Runs at `b363473e5`

All ran the owning file alone through `mise run test:logged`, with `bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts --only-failures`. The worker counts are in the table, and `-t` selected the named tests where noted.

| Time (GMT) | Scope | Load average (1 min) | Spawn time | Result |
| --- | --- | --- | --- | --- |
| 03:42–03:51 | Whole file, `--parallel=2` | 628 at the end | Not sampled | 2 timeouts, then the runner's 300 s no-output watchdog ended it at 546.2 s |
| 03:52–03:53 | `changing one single-file input`, `--parallel=1` | 526 to 363 | Not sampled | Passed, 43.1 s |
| 03:55–04:01 | The six named tests plus the eight others the pattern matched, `--parallel=1` | About 440 | Not sampled | 13 pass including all six, 1 fail (`logins > Codex: a rotation and then a sign-out reach the home`), 355.9 s |
| 04:07–04:18 | Whole file, `--parallel=2` | 38 to 76 | Not sampled | 42 pass, 8 fail (the last eight tests in the file), 658.1 s |
| 04:19–04:43 | Whole file, `--parallel=2` | 32 to 42 | 279–379 ms from 04:20 to 04:34, 5 ms at 04:42 | 31 pass, 19 fail, 1,428.7 s. The log last changed at 04:38. |
| 04:43–04:46 | Whole file, `--parallel=2`, started once spawning was under 40 ms | 22 to 38 | 4–10 ms, sampled every 30 s | Passed, exit 0, 181.5 s |

## When this recurs

Before investigating a timeout in this file, time a few spawns of `/usr/bin/true` while it runs, and compare with the table.

The file spends its time on real processes, which is what `scripts/test-tiers.ts` says belongs in the slow tier, yet it runs in the default tier. Moving it there would stop this failure reaching review preparation, at the cost of less frequent coverage. That is a separate decision about the tier list and has not been made here.

## Recurrence on the environment deletion branch (2026-11-06)

- **Failure:** `what the home holds decides as much as what the stamp says > a damaged stamp falls back to the copy`, `^ this test timed out after 60000ms`, in `mise run test` during review preparation of the environment deletion branch at `a27d3d51d`, macOS arm64, Bun 1.4.4, 18 CPUs. That host's 15-minute load average was 48–68 through the period.
- **Why triage linked it to the branch:** the file imports `tempDir` from `tests/container-lifecycle-fixtures.ts`, which imports `backend-runtime.ts` and with it 1,029 backend modules, among them the changed `diff-stats-tracking.ts`, `diff-stats-service.ts`, `worktree-watcher.ts`, `worktree-removal-reads.ts` and `watch-host.ts`. Nothing in the file calls them. None of them does work when imported: `watch-host.ts` builds its shared `WatchHost` at load, but the helper process starts only on the first watch.
- **Isolated reruns:** the case alone took 49.1 s while the host was loaded, under its 60 s deadline. At `9478f8808`, at a 1-minute load average of 8 with `/usr/bin/true` spawning in 2–3 ms, it passed alone in 3.0 s (`-t "a damaged stamp falls back"`). The whole file passed in 111.2 s, exit 0. Both ran through `mise run test:logged` with `bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts`.
- **Conclusion:** the same spawn-latency deadline as above. The test is unchanged.

## Recurrence on the completion Notes branch (2026-11-10)

- **Branch and base:** `open-notes-tab-0bdba344d18c-r1`, base `c6de4733c`, macOS arm64, Bun 1.4.4, 18 CPUs. `mise run flaky:recurrence -- 5561 --base c6de4733c` answered `environmental`.
- **Failure:** review preparation's default suite failed `logins > Grok: a rotation and then a sign-out reach the home`. Then a rerun of the whole owner on the same host hit eight consecutive 60 s timeouts: all of `a restart with unchanged inputs` and five tests in `a changed input is reflected at the next start`. It was stopped at 501.6 s. The same rerun session showed the recorded Grok case passing alone in 59.2 s, just under its deadline. Spawn time was not sampled during those runs.
- **Why triage linked it to the branch:** the branch changes `apps/backend/src/core/storage.ts` only by adding a one-line facade forwarder, `ensureBuildPipelineNotesTab`. This file reaches `storage.ts` only through the `backend-runtime.ts` import chain of `tests/container-lifecycle-fixtures.ts`, as on the environment deletion branch above, and never calls the new method. The fixtures use their own in-memory storage.
- **Isolated rerun:** at `3e87668f4` (branch head, test and entrypoint unchanged), `mise run test:logged -- --name stamps-owner -- bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts --parallel=2 --only-failures` passed (exit 0) in 157.4 s between 02:07:40 and 02:10:18 GMT. Spawning `/usr/bin/true`, sampled every 30 s, took 2.1–3.5 ms. The 1-minute load average fell from 24.7 to 15.1, and the 15-minute average from 43.8 to 39.3.
- **Conclusion:** the same deadline against host spawn time. No code or test change.


## Owner moved to the slow tier and consolidated (2026-11-10)

`apps/backend/tests/portable-inputs-stamps.test.ts` now runs only in the slow tier (`scripts/test-tiers.ts`; `mise run test:slow`, and CI's `test:full` on every pull request), so the default `mise run test` no longer runs it. The file was also consolidated: one fixture build per file restored per test, the per-provider `logins` tests merged into two scenarios covering all five providers, and the `import ownership failures` matrix reduced from 15 tests to 5. Entrypoint boots went from 129 to 59 and the file alone from about 115 s to about 55 s. Some test names cited above no longer exist; search the file for the scenario rather than the old name.
