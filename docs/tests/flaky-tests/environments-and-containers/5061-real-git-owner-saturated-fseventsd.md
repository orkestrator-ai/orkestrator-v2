# `real Git through the shared owner` loses events on a saturated `fseventsd`

- **ID:** 5061
- **Status:** open
- **Date observed:** 2026-11-04
- **File:** `apps/backend/src/core/worktree-snapshots-git.test.ts`
- **Host:** arktech-mini, macOS arm64, external APFS volume, Bun 1.4.4. `fseventsd` was using 100–138% of a core with 8–11 GB resident after seven days of uptime, load average 6 to 10.
- **Original command:** `mise run test:logged -- --name snapshots-git-macos -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`: 2 passed, 5 failed, each at the 15 s `until` deadline. Evidence: `orkestrator-test-run.Atdf69` under the host temporary directory.
- **Control:** the same file at `e198fd4a7`, unchanged, with only its deadlines raised to 120 s (`bun test --cwd apps/backend` on a temporary copy): 1 passed, 4 failed, each at 120 s. That file injects `startWatch`, so it runs the old whole-root watch and shows the failure does not need the watch plan. The file as changed for the plan, same deadlines: 1 passed, 6 failed. An earlier run of it at 180 s: 4 passed, 3 failed (one of those an assertion since replaced).
- **Linux:** the file as changed passes, 7 of 7 in about 26 s (`oven/bun:1.4.4`, linux/arm64 on Docker Desktop).
- **Assessment:** a single write's event did not arrive within minutes, so raising the deadline does not help. On the same host and volume, `worktree-watcher-real.test.ts` passes because it keeps writing distinct files until one is reported, and a separate probe saw the first event take 3 to 35 s. Lost or very late delivery from a saturated `fseventsd` fits all of this, but what keeps it busy was not established, and no restart of it was tried. No watcher delivery fix was made, and no deadline, assertion or skip was loosened.
- **Root cause:** the host's `fseventsd` loses and delays events for every program, and the file waited on one write's event. See the section below.
- **Fix:** `6c454e5c5`. On macOS each detection repeats its change until a published scan shows it; Linux keeps one change, one event and the 15 s deadline.
- **Follow-up:** whether one write's event arrives promptly on a healthy macOS host; to-do 5060 (retired 2026-11-10), task 3, whose result is in [git-scan-caches.md](../../../architecture/git-scan-caches.md#measured) (one write reaches the watcher 10–35 ms after it is made on a healthy `fseventsd`).

## 2026-11-05 address-findings observation

The combined command
`mise run test:logged -- --name watcher-real-recovery -- bun test --cwd apps/backend ./tests/worktree-watcher-real.test.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`
reported 15 pass, 1 skip, 5 fail in 335.27 s. One failure was a new symlink
regression expecting a named path where exclusion invalidation deliberately emits
a whole-tree hint; that assertion was corrected, and its isolated rerun passed
in 15.0 s. The other four failures were service delivery deadlines: ignored
dependency write followed by source write, minimum-gap detection, staging, and
baseline ref movement. Artifact: `orkestrator-test-run.8Tn4fk/watcher-real-recovery.log.gz`
under the host temporary directory.

The owning service file was rerun alone:
`mise run test:logged -- --name snapshots-git-isolated -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`.
It reported 4 pass, 3 fail in 93.10 s. Minimum-gap detection passed alone;
ignored-write/source detection, staging, and ref movement still timed out at
15 s. Artifact: `orkestrator-test-run.VPfmCD/snapshots-git-isolated.log.gz`.
The strengthened ignored-write test passed its new zero-scan and zero-hint
assertions but timed out waiting for the subsequent source edit's revision.
These results do not establish healthy macOS service-level delivery. The
existing follow-up remains open; no deadline or assertion was weakened.

A corrected combined rerun reported 14 pass, 1 skip, 6 fail in 257.33 s
(`orkestrator-test-run.NQS7Sl/watcher-real-recovery.log.gz`): the symlink
case received hints but its exclusion proof did not refresh, and five service
detections timed out. The real-Git symlink regression now explicitly delivers
the replacement event after the filesystem mutation, retaining both hint and
updated-proof assertions, so it tests proof invalidation independently of native
delivery. Its focused rerun passed in 6.6 s. Existing native-delivery tests remain
unchanged. This does not close the healthy-host qualification gap.

Final combined run after explicit event delivery in the Git-proof regression:
15 pass, 1 skip, 5 fail in 163.13 s, with the Git-proof regression passing.
The remaining failures were service new-directory detection, ignored-write then
source detection, minimum-gap detection, staging, and ref movement.
Artifact: `orkestrator-test-run.ynvykA/watcher-real-recovery.log.gz`.
All remain delivery deadlines; healthy-host service qualification is still open.

## 2026-11-05 root cause and fix

`fseventsd` was at about 100% of a core and 9 GB resident after seven days, as in the
runs above. Three controls with no Orkestrator code, on the same volume:

| Probe | Result |
| --- | --- |
| Bun 1.4.4 and Node 22.23.1 side by side, recursive `fs.watch` on one directory, 12 writes 3 s apart, 70 s to arrive | Each saw the same 6 of 12, 4.6 to 61.4 s late; the other 6 did not arrive |
| Bun alone, 15 writes 500 ms apart, 20 s to arrive | 3 of 15; 0 of 15 in two further runs, one non-recursive, one on the internal disk |
| Node alone, same | 15 of 15, up to 20.6 s late, after 55 s and 535 writes before the first event arrived |

Two runtimes receiving identical events at identical latencies puts the loss below
both of them. Neither Bun, the watch plan nor the service is needed to reproduce it. What
keeps `fseventsd` busy is still not established.

With the change in `6c454e5c5`, `fseventsd` still at about 100% of a core. The Linux runs and the first macOS runs were on the working copy just before its darwin-only progress line was finalised:

| Command | Result |
| --- | --- |
| `worktree-snapshots-git.test.ts` alone, macOS, three runs | Exit 0 in 259.7 s (counts removed with the passing output); 7 of 7 in 77.8 s; 7 of 7 in 51.0 s |
| With `worktree-watcher-real.test.ts`, macOS, three runs | Exit 0 in 124.7 s; 20 pass, 1 skip (Linux only), 0 fail in 100.8 s; at the committed code, exit 0 in 267.4 s |
| Mutation: `plan: null` in the service test, macOS | Fails at `expect(scansStarted).toBe(scansBefore)`, 6 expected, 7 received, so it detects the plan being off |
| `worktree-snapshots-git.test.ts`, `oven/bun:1.4.4` linux/arm64, three runs, one change per detection | 7 of 7 each, about 29 s |
| `worktree-watcher-real.test.ts`, split and plan tests, same container | 50 of 50 |

An earlier combined run was stopped by the runner's five-minute no-output watchdog,
because `--only-failures` prints nothing for a passing file. Both files now write a line
to stderr per detection on macOS. `console.log` would not do: the test preload suppresses it.

The cases [9892](9892-worktree-git-aggregate-timeouts.md) and
[0957](0957-worktree-index-and-shared-ref-aggregate-timeouts.md) are on the same file and
may share this cause on macOS. They stay open: no aggregate stress run was done here.

## 2026-11-05 full-suite recurrence and explicit-delivery repair

Review preparation at `3ef4e38e6` ran `mise run test:full` (exit 1,
1,562,750 ms). The ignored-write case failed after 180,756 ms with
`no quiet window with a delivered ignored write before the deadline`.
Its no-scan assertion was never reached. Complete suite totals were unavailable;
triage listed 16 distinct failures and unattributed errors. Original evidence:
`.orkestrator/review-artifacts/review-validation-575573b4-beca-47da-ba6f-ac452035415c/validation-04.stdout.txt`.
The earlier passing isolated runs did not establish aggregate reliability, so
this case is reopened rather than attributing this recurrence to a proved cause.

The ignored-write assertion now writes a real ignored file and explicitly delivers
its path through the real root watcher listener while temporarily withholding
native callbacks. It asserts zero hints and zero scans after the minimum scan
gap. A source-path event through that same listener must then trigger a real Git
scan and publish the source change. This removes both missing delivery and late
unrelated callbacks from the negative assertion without bypassing the watcher
filter or shared service. Other cases still test native delivery; healthy-host
macOS qualification remains in to-do 5060 task 3. This record stays open pending
aggregate reliability evidence for the remaining native-delivery cases.

Targeted repair validation on macOS (2026-11-05):

- `mise run test:logged -- --name ignored-write-fix -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`: exit 0, 157.7 s.
- `mise run test:logged -- --name ignored-write-repeat -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures --test-name-pattern 'a write under the ignored node_modules' --rerun-each 3`: exit 0, 41.0 s.
- `mise run test:logged -- --name flake-index-fix -- bun test ./tests/unit/flaky-tests-index.test.ts ./tests/unit/todo-index.test.ts --parallel=1 --only-failures`: exit 0, 2.0 s.

Passing logs are removed by the logged runner. These isolated passes repair the
filter assertion's evidence; they do not resolve the broader native delivery case.
