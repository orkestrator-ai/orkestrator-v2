# Evidence body rename has not happened at the aggregate assertion

- **ID:** 9836
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `EvidenceBodyStore.put > syncs the file before the rename, then the directories, before resolving`
- **File:** `apps/backend/src/core/change-tracking/evidence-body-store.test.ts`
- **Original command:** `mise run test:logged -- --name review-default-suite -- mise run test`, on `f88e595d2` with the floating-notice repairs in progress.
- **Worker configuration:** backend `--parallel=4`; aggregate workspace allocation six workers, root one, bridges two, protocol one.
- **Failure:** line 111 expected `existsSync(target)` to be true, received false; 35.83 ms.
- **Suite counts:** backend 16367 pass, 134 skip, 3 fail; web 13119 pass, 10 skip, 24 fail (notice announcement compatibility failures subsequently repaired); root 3676 pass, 1 fail.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.synJsP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer runner `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.RRKHmW/review-default-suite.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name evidence-store-isolated -- bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts --parallel=1 --only-failures` passed, exit 0, 1.0 s. Passing output was deleted by the logged runner; no isolated test counts are inferred.
- **Hypothesis:** the aggregate assertion ran before the asynchronous rename completed. The different observation under isolation establishes intermittency, not a root cause. This owner and its implementation were unchanged; no deadline or assertion was weakened.

This is a different assertion from case 6550 (ingestion has not called put).

### Resolution — 2026-11-06

- **Root cause:** the test gave `put` a fixed 20 ms (`settled`) to reach its gated directory sync. `put` first runs `mkdir`, `writeFile`, the file sync and `rename` on the thread pool; on a loaded host those took longer than 20 ms, so the assertion ran before the rename. Nothing in the store was wrong.
- **Fix (test only):** `recordingSync` now exposes `directoryEntered`, released when the first directory sync starts (necessarily after the rename), and the ingestion test's `put` spy releases `putEntered` when called. Each test awaits that event (raced against the operation settling, so an early failure still reports) before the existing `settled` check. The assertions are unchanged. The ingestion test's `finally` now releases the gate and awaits the pull before restoring the spy, so a failed assertion no longer leaves a pull running into harness cleanup (the source of the follow-on `Cannot use a closed database`). The same latent race in `adopting a body whose directory sync is under way waits for it` was fixed the same way: if `first` had not yet renamed, `reuse` found no body and resolved early.
- **Reproduced:** yes. Temporarily adding a 40 ms delay to the recording file sync and to the `put` spy entry (simulating slow thread-pool I/O on a loaded host) failed all three tests: line 112 `existsSync(target)` false, line 260 `adopted` settled, line 341 `putIds.length` 0. With the fix and the same delays: `bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts --rerun-each=3` passed.
- **Verification:** delays removed; `mise run test:logged -- --name evb-stress -- bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts src/core/change-tracking/object-store-write-path.test.ts --rerun-each=20 --parallel=2` PASS (74.0 s, exit 0).
