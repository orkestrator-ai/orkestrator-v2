# Real-watch tests that start their own `fs.watch` time out on a saturated `fseventsd`

- **ID:** 9820
- **Status:** open
- **Date observed:** 2026-11-15 to 2026-11-16
- **Test:** `worktree watcher on this platform's real watch > the per-directory plan leaves a large ignored tree unwatched and withdraws coverage`; `… > replacing an ignored directory with a symlink refreshes proof and reports it`; less often `… > an install into a new node_modules goes unreported`, `… > removing the ignore rule makes node_modules visible again`, `… > a file in a directory created after the watch began is noticed` and `… > a directory removed and created again is still noticed`
- **File:** `apps/backend/tests/worktree-watcher-real.test.ts`
- **Host:** arktech-mini, macOS arm64, external APFS volume, Bun 1.4.4. `fseventsd` at 99.6% of a core after 10 days 9 hours of uptime, load average about 2.3.
- **Observing head:** `796bcb9ad` (branch `macos-burst-rescans-34ffd546b9bc-r1`, to-do 8171 (retired)).
- **Observing branch base:** `b89ba0509`.

## Observation

Every run of the file on this host failed, at the branch head and with the
branch's only change in the file's import graph (`worktree-watcher.ts`) put
back to the base:

| Run | Watcher source | Result | Failed |
| --- | --- | --- | --- |
| `watcher-owners-slow` (4 files, one worker), 2026-11-15 22:44 | head `84f25b771` | 72 pass, 4 skip, 5 fail | large tree (hook timeout), symlink, ignore rule removed (hook timeout), directory recreated (87 ms), install (18 ms) |
| `watcher-owners-slow-rerun`, 23:16 | head `796bcb9ad` | 73 pass, 4 skip, 4 fail | large tree (hook timeout), symlink, new directory, install (hook timeout) |
| `watcher-real` (file alone), 23:21 | head `796bcb9ad` | 15 pass, 3 skip, 3 fail | large tree (hook timeout), symlink, install (hook timeout) |
| `watcher-real-mergebase` (file alone), 23:37 | base `b89ba0509` | passed | — |
| `ww-ab-head-1` (the three tests), 23:49 | head | 0 pass, 3 fail | large tree (hook timeout), symlink, install (hook timeout) |
| `ww-ab-base-1`, 23:55 | base | 1 pass, 2 fail | large tree (hook timeout), symlink |
| `ww-ab-head-2`, 00:02 | head | 1 pass, 2 fail | large tree (hook timeout), symlink |
| `ww-ab-base-2`, 00:08 | base | 1 pass, 2 fail | large tree (hook timeout), symlink |

The A/B runs alternated the watcher source in one worktree with
`--test-name-pattern 'per-directory plan leaves|replacing an ignored directory|an install into a new node_modules'`,
each through `mise run test:logged`. Evidence under the host temporary
directory: `orkestrator-test-run.Y7UgSH`, `.0arjw6`, `.QPiFZH`, `.roA747`,
`.fuEZyT`, `.qCFGlz` and `.fKuQeE`.

The failure is the same on both sources. The large-tree test passes its own
assertions, often after 100 to 560 repeated writes before a first notice, and
then its `afterEach` (closing the in-process watches and removing the 2,000
fixture directories) exceeds Bun's hook timeout. The next test, the symlink
case, then waits the full 90 s for `qualified` in `watchWorktree`
(`expect(opened.watcher.qualified).toBe(true)`, received `false`).

## Assessment

Environmental on this host, and not caused by the 8171 branch:

- The base watcher source fails the same two tests in the same way (2 of 2
  targeted runs); its one full-file pass was the exception.
- The branch's watcher changes act only after an owner calls
  `unannouncedChange`, which this file never does.
  `worktree-watcher-missed-change.test.ts` pins that: without a reported miss,
  late or absent events never withdraw coverage.
- Every failing test injects `startWatch` with an in-process `fs.watch`, so its
  watch starts and closes on the test's own thread. On a saturated `fseventsd`
  those calls block, which is why the backend runs its watches in a helper
  process ([git-scan-caches.md](../../../architecture/git-scan-caches.md#lost-events-on-macos)).
  The tests that use the helper passed in every run.

Related cases on the same host: [6613](6613-worktree-watcher-real-control-delivery-deadline.md)
(one test of this file past its delivery deadline) and
[5061](5061-real-git-owner-saturated-fseventsd.md). No assertion, deadline or
skip was changed.

## Next step

Rerun the file alone on a healthy `fseventsd` (after a reboot of arktech-mini,
step 4 of the "8171 (retired) task 1" item in the
[manual-test checklist](../../../todo/manual-test/7568-manual-test-checklist.md)). A pass
there confirms the host; a failure there means the large-tree cleanup should
close its watches and remove its fixture in a way that cannot outlast the hook,
so that it no longer starves the next test.
