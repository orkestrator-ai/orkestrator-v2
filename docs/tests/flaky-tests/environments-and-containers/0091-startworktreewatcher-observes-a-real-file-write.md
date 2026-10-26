# `startWorktreeWatcher > observes a real file write` (`apps/backend/tests/worktree-watcher.test.ts:237`)

- **ID:** 0091
- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,686 passed, 1 skipped, 1 failed
- **Failure:** `expect(changes).toBeGreaterThan(0)` received `0` after one file write and a fixed 280 ms total wait; failed duration 281.50 ms
- **Isolated rerun:** `bun test apps/backend/tests/worktree-watcher.test.ts` -> 24 passed, 0 failed; the target passed in 284.11 ms
- **Root cause:** The test drives the real recursive `fs.watch` implementation. The first failure looked like aggregate scheduler contention, but a stress version that waited up to two seconds for one write still missed one event in 30 repetitions. A single OS watcher event is therefore not a reliable synchronization primitive for this test.
- **Fix:** The test now performs bounded, distinct file writes until the watcher reports a change or a two-second deadline expires. A broken watcher still fails at the deadline, while one dropped OS event no longer fails the suite.
- **Verification:** `bun test apps/backend/tests/worktree-watcher.test.ts --test-name-pattern "observes a real file write" --rerun-each 50` -> 50 passed, 0 failed. Targeted stress and the final aggregate suite both passed.


## OpenCode review-fix validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` at `2015359f9`; standard 4/1/2/1 group reservations and two isolated backend workers.
- **Failure:** the same test received zero changes after the bounded distinct-write loop (2,006.05 ms), so the prior fix does not eliminate the aggregate failure. Reopened this record.
- **Suite counts:** backend 11,228 passed, 95 skipped, four failed and one error across 657 files (488.13 seconds); full details and evidence are in [0978](../aggregate-validation-runs/0978-opencode-undo-validation-backend-timeouts.md).
- **Unchanged owner rerun:** `mise run test:logged -- --name worktree-watcher-owner-rerun -- bun test --cwd apps/backend ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed, exit 0 in 1.4 seconds.
- **Assessment:** aggregate-only recurrence; host contention or delayed OS watcher delivery remain hypotheses. No watcher code, assertion, deadline or skip changed.

## Mobile settings review-fix validation — 2026-10-26

The review-fix `mise run test` on branch
`todo-0035-mobile-layout-gaps-49509c5f9933` used workspace/root/bridges/protocol
allocations of 4/1/2/1, with two backend workers. Backend finished with 11762
passed, 97 skipped and four failed across 703 files (636.58 s); the aggregate
finished in 654.9 s. Web passed 9834 tests. Aggregate evidence is
`orkestrator-test-run.x766cu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. The change touches no backend implementation
or backend tests.

The bounded repeated-write case at line 290 again observed zero changes
(2007.85 ms), despite the earlier fix. The complete unchanged owning file
also failed alone:

`mise run test:logged -- --name backend-watcher-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures`

Result: 33 passed, one failed (2008.82 ms), 34 tests total, 2.7 s logged.
Evidence: `orkestrator-test-run.lweF1u`. Reopened for this host recurrence;
it remains non-green in isolation, so load alone is not an established cause.
No watcher implementation, assertion, deadline or skip changed.

## Live terminal cleanup validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name terminal-signal-repository -- mise run test`, Bun 1.4.4, standard worker leases. The change only edits `e2e/agent-testing/container-claude-terminal-signal.spec.ts`; the watcher and its tests are unchanged.
- **Failure:** `startWorktreeWatcher > observes a real file write` received zero changes after the current two-second bounded write loop (2004.32 ms, `apps/backend/tests/worktree-watcher.test.ts:290`). Reopened because the earlier retry-loop fix did not prevent this aggregate recurrence.
- **Complete unchanged owner:** `mise run test:logged -- --name worktree-watcher-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed, exit 0 in 1.0 seconds.
- **Evidence:** `orkestrator-test-run.zbtDAc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. The aggregate exited 1 with backend 11197 passed, 95 skipped, two failures and one between-test error across 655 files; the other failure is [0248](0248-move-restart-recovery-submodule-timeout.md). Root/support, bridges, protocol and every other workspace package passed.
- **Changes:** evidence only; no watcher code, assertions, deadlines or skips changed. The original aggregate remains failed.

## Mail delivery review validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name mail-repository -- mise run test`, Bun 1.4.4, standard workspace/root/bridges/protocol reservations of 4/1/2/1 and two backend workers. Mail fixes are committed as `e4365f43b`; the watcher and its tests are unchanged.
- **Failure:** `startWorktreeWatcher > observes a real file write` received zero changes after the bounded repeated-write loop (2010.06 ms, `apps/backend/tests/worktree-watcher.test.ts:294`).
- **Suite counts:** backend 11,918 passed and six failed across 712 files; desktop 1,369 passed and two failed. Root/support, bridges, protocol and all other workspace packages passed. The full command exited 1 after 817.0 seconds.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name mail-worktree-watcher-rerun -- sh -c 'cd apps/backend && bun test ./tests/worktree-watcher.test.ts --parallel=1 --only-failures'` passed, exit 0 in 1.4 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z9OzLB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer result in `orkestrator-test-run.nVyQ5W/mail-repository.log.gz` under the same temporary root.
- **Assessment:** an aggregate-only recurrence in this run. Delayed OS event delivery or host contention remain hypotheses. The other failing owners (profile cleanup, submodule moves and Git snapshots) remained non-green when rerun alone. No watcher code, assertions, deadlines or skips changed; the original aggregate remains failed.

## Coordinator launch coverage validation — 2026-10-26

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` at `64e7f8262` (only coordinator renderer tests changed). Standard workspace/root/bridges/protocol reservations were 4/1/2/1 slots, including two backend workers; other worktrees were validating concurrently.
- **Failure:** `startWorktreeWatcher > observes a real file write` received zero changes after the bounded write loop (2005.98 ms).
- **Aggregate:** backend 11,343 passed, 99 skipped, five failed and four between-test errors across 663 files (366.63 s); desktop had two assertion failures; web passed all 9,875 active tests. Root/support, bridges and the protocol lockfile passed. Aggregate exit 1 after 441.9 s.
- **Unchanged owner:** `mise run test:logged -- --name worktree-watcher-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed, exit 0 in 2.2 s.
- **Evidence:** `orkestrator-test-run.iPZEJ3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and enclosing `orkestrator-test-run.BxYW3V/repository-tests.log.gz` under the host temporary directory.
- **Assessment:** another intermittent recurrence. Watcher delivery or host contention remain hypotheses; no watcher implementation, assertion, deadline or skip changed. The aggregate remains failed.
