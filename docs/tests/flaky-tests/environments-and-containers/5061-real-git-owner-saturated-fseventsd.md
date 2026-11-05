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
- **Follow-up:** re-run on a macOS host with a healthy `fseventsd`; [5060](../../../todo/cross-cutting/5060-worktree-watch-leftovers.md), task 3.

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
