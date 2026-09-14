# `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts:650`)

- **ID:** 0040
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** root group only, four Bun workers.
- **Failure:** `this test timed out after 5000ms` (duration: 5,021.67 ms). The paired unhandled error reported between tests was an expected-to-resolve promise rejecting: `commands.get("merge_pr_local")?.({ environmentId, method: "squash", deleteBranch: false })` was expected to resolve to `{ outcome: "merged" }`. The file also logged `killed 1 dangling process`.
- **Suite counts:** as above — the two failures and two errors in that run are these entries.
- **Isolated rerun:** `bun run test:logged -- --name rerun-pr -- bun test tests/unit/electron/commands-registry-pr.test.ts` → passed in 32.5 s.
- **Recurrence:** `bun run test:logged -- --name fix-review-full-suite-final -- bun run test` timed out at the same assertion after 5,016.38 ms while the concurrent workspace, bridges, and protocol-lockfile groups passed (root/agent-support: 3,772 passed, 1 skipped, 1 failed, 1 error across 181 files). The owning-file rerun, `bun run test:logged -- --name isolate-commands-registry-pr -- bun test tests/unit/electron/commands-registry-pr.test.ts --only-failures`, passed in 13.6 s. The reviewed change only affects the web scroll-state hook and its tests, so this recurrence remains unrelated and contention-shaped.
- **Hypothesis:** Same shape as the terminal entry — a real fake-`gh`/Git fixture racing the generic 5-second budget under contention, with the paired `merge_pr_local` rejection being the fixture failing rather than the draft-parsing behavior under test. Both entries were observed while reviewing `model-platform-detection`, whose diff touches only `apps/web`, an ACP bridge tsconfig, and Claude bridge test fixtures — nothing either file imports. Because these are timeouts rather than assertion mismatches, an isolated rerun alone does not fully exclude a genuine slowdown; a recurrence should time the fixture's process startup before adjusting budgets.
