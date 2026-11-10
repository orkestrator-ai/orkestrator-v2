# `a write under an ignored node_modules goes unreported` reports the write when Git's proof is late on macOS

- **ID:** 9919
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `worktree watcher on this platform's real watch > a write under an ignored node_modules goes unreported while a source write is noticed`
- **File:** `apps/backend/tests/worktree-watcher-real.test.ts`
- **Host:** arktech-mini, macOS 27.2 arm64, Bun 1.4.4 (`38afee6c8`), `fseventsd` healthy (5–8% of a core, about 20 MB), load average 24 to 59 from other work. Fixtures on the checkout's external HFS+ volume. Base commit `04639b12b`.
- **Original command:** `bun test ./tests/worktree-watcher-real.test.ts` from `apps/backend`, one process, while measuring to-do [5060](../../../todo/cross-cutting/5060-worktree-watch-leftovers.md) task 3. The same file had passed under `mise run test:logged -- --name watcher-real-macos -- bun test --cwd apps/backend ./tests/worktree-watcher-real.test.ts --parallel=1` minutes before.
- **Failure:** `expect(received).toEqual(expected)` at line 253: the hints named `node_modules/pkg-1/lib/installed.js` and `packages/app/node_modules/pkg-1/lib/installed.js`. The test took 1,767–2,509 ms.
- **Suite counts:** 14 passed, 1 failed, 15 tests.
- **Isolated rerun:** the test alone (`-t "ignored node_modules goes unreported"`) failed 1 of 3 runs, and 2 of 12 in a later loop on the unchanged file.
- **Root cause:** a test defect. On macOS the watcher keeps one recursive root, so it reports `qualified` without waiting for Git's proof of which `node_modules` to leave out; until that proof is read nothing is left out, by design (`worktree-watcher.ts`: no answer proves nothing). The test wrote under `node_modules` once a source write was noticed, about 165 ms after start. A probe on this host saw the proof land 30–174 ms after start, so a slow pair of Git processes put it after the writes. Linux is not affected: there `qualified` waits for the plan.
- **Fix:** the test records the proof through the plan's `listExcluded` and waits for it before writing under `node_modules`, as `watchProof` already does for the other cases. The product keeps reporting early writes, which is a cost (one scan), never a missed change.
- **Verification:** after the fix the test alone passed 12 of 12 runs on the same host, against 10 of 12 for the original file in the same session; the whole file passed through `test:logged`.
