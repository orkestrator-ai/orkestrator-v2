# Initial prompt attachment symlink rejection diagnostics (`apps/backend/src/core/commands-state-sync.test.ts`)

- **ID:** 0102
- **Status:** resolved
- **Date observed:** 2026-08-08; recurred 2026-08-10
- **Tests:** `initial prompt attachment command > does not prune through a staging-directory replacement race` and `initial prompt attachment command > rejects symlink ancestors without modifying their external target`
- **Original command:** `bun run test` (workspace backend group, `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Suite counts:** First observation: 1,519 backend tests, 1,518 passed and 1 failed. 2026-08-10 reproduction: 1,556 total, 1,555 passed and 1 failed with 5,858 assertions.
- **Failure:** Expected an error containing `symlink or non-directory ancestor`, but received `Confined file write failed (exit 73)`; the 2026-08-10 recurrence failed the static ancestor test in 29.26 ms.
- **Isolated rerun:** `bun test src/core/commands-state-sync.test.ts` from `apps/backend` -> 93 passed, 0 failed with 432 assertions in 8.52 s after the first observation. On 2026-08-10, `bun test --cwd apps/backend src/core/commands-state-sync.test.ts` -> 94 passed, 0 failed with 436 assertions in 7.10 s; the recurrent target passed in 27.19 ms.
- **Root cause:** `writeFromPinnedRoot` settled its child process on `exit`, which may fire before the final stderr `data` event. The confined helper correctly denied the symlink with exit code 73, but aggregate scheduling sometimes let the parent format the error before it had received the helper's `symlink or non-directory ancestor` diagnostic.
- **Fix:** Settle the confined writer on the child process `close` event, which occurs after its stdio streams close, preserving the fail-closed diagnostic without weakening the external-target assertions.
- **Verification:** `bun test --cwd apps/backend src/core/commands-state-sync.test.ts --test-name-pattern 'rejects symlink ancestors|does not prune through' --rerun-each 30` -> 90 passed, 0 failed; `bun test --cwd apps/backend src/core/path-safety.test.ts --test-name-pattern 'rejects a symlinked ancestor' --rerun-each 30` -> 30 passed, 0 failed. The final `bun run test` aggregate on 2026-08-10 passed every workspace, root, bridge, protocol-lockfile, and iOS group.
