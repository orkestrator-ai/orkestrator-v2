# Worktree Git observation deadlines in the aggregate

- **ID:** 9892
- **Status:** resolved
- **Date observed:** 2026-10-26
- **File:** `apps/backend/src/core/worktrees/snapshots-git.test.ts`
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test` on annotation review commit `e145c645d`, macOS arm64, Bun 1.4.4. The workspace group reserved four worker slots after waiting 657.6 seconds for host capacity.
- **Failures:** `real Git through the shared owner > a tracked edit that never touches the index is detected` timed out after 5002.01 ms; `staging in a linked worktree (index outside the root) is detected` timed out after 5000.23 ms. A later error between tests showed the tracked-edit assertion reading the next test's `b.txt` and `c.txt` changes along with `a.txt`.
- **Isolated rerun:** `mise run test:logged -- --name review-worktree-git-isolated -- bun test --cwd apps/backend ./src/core/worktrees/snapshots-git.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (four tests) in 1.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IciJEN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; enclosing run: `orkestrator-test-run.Yok1pE/review-tests.log.gz` under the same temporary directory. Passing isolated output was removed by the logged runner.
- **Scope:** annotation changes do not touch the worktree owner, Git scanning, or these tests. These deadline failures differ from the zero-cache-hit assertion resolved in [0180](0180-worktree-tracked-edit-cache-hit.md); they do not establish a recurrence of that product bug. Host contention or delayed watcher delivery is unconfirmed. No assertion, timeout or skip was changed.

## Recurrence — 0247 sweeps, 2026-10-26

- Both direct backend sweeps (`TMPDIR=<private dir> mise exec -- bun run --cwd apps/backend test:workspace`, macOS arm64, at `5eb3f9037` and `8268be981` on `test-temp-directory-4cd0548cf2b5-r1`, which does not touch this owner) timed out `real Git through the shared owner` cases at 5,000 ms: the tracked-edit, linked-worktree staging and shared-ref cases in the first, the tracked-edit case in the second. The owner rerun alone at load average 37 (`mise run test:logged -- --name rerun-worktree-snapshots-git -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktrees/snapshots-git.test.ts`) also failed the staging and shared-ref cases (2 pass, 2 fail; artifact `orkestrator-test-run.62Ge9Y`); no quieter rerun was taken. No change.

## Resolution (2026-11-15)

- **Root cause:** On a loaded macOS host the watcher detections exceeded Bun's 5 s default; the late assertion then read the next test's writes.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. In `apps/backend/src/core/worktrees/snapshots-git.test.ts` the Linux budget is `DEFAULT_TEST_TIMEOUT_MS` (60 s) instead of 30 s (macOS keeps its 360 s), and the Linux detection and settle deadlines, which wait for published scan revisions and never repeat a change, are 45 s hang watchdogs below the test budget instead of 15 s. macOS event loss itself stays in [5061](5061-real-git-owner-saturated-fseventsd.md).
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
