# OpenCode undo (0175) validation: five-second timeouts across two aggregate runs

- **ID:** 0978
- **Status:** open
- **Date observed:** 2026-10-26
- **Change under test:** `44668a907` on
  `todo-0175-opencode-undo-3179a52c7d02`: OpenCode revert-marker handling in
  `opencode-revert.ts`, `opencode-stream-state.ts`, `opencode-snapshots.ts`
  and `opencode-provider.ts`, plus two new OpenCode test files. None of the
  three failing owners or their implementations changed.
- **Original command:** `mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reservations
  4/1/2/1; backend used two Bun workers. Other worktrees occupied all 18 of
  the shared host's worker slots (the protocol group waited 95.7 s).
- **Aggregate result:** exit 1 after 688.3 s of test groups. Backend: 11,213
  passed, 95 skipped, three failed. Every other workspace package, bridges and
  protocol regeneration passed; root and agent-support failed only on the
  flake-register duplicate ID fixed in the same change (0977).
- **Failure evidence:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.A9Oe03/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

| Owning file under `apps/backend/src/core/` | Failing test | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- | --- |
| `coordinator-service.test.ts` | `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` | Five-second timeout at 5066.93 ms, inside `project-git-service.ts` `readStatus`. | 69 pass, 0 fail. |
| `design/cross-process.test.ts` | `design canvases across processes sharing one data directory > a lane waits for another process's canvas lease before committing` | Five-second timeout at 6167.21 ms. | 17 pass, 0 fail. |
| `looped-review-service.test.ts` | `LoopedReviewService lifecycle guards > marks a pull request that never completed as failed` | Five-second timeout at 5440.56 ms. | 59 pass, 0 fail. |

Each rerun selected exactly one complete owner with the Node preload, from
`apps/backend`:

```sh
bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts
bun test --preload ../../tests/setup-node.ts ./src/core/design/cross-process.test.ts
bun test --preload ../../tests/setup-node.ts ./src/core/looped-review-service.test.ts
```

The unchanged owners' isolated passes establish intermittent behavior. Shared
host contention is a hypothesis, not a confirmed root cause. No
implementation, assertion, timeout or skip in these owners changed.

## Third aggregate run — 2026-10-26

`mise run test` at `7f1a2e0ec` (the same code plus flake-register documents)
passed bridges and protocol regeneration and failed two different
five-second timeouts, again with the host's worker slots shared with other
worktrees (the protocol group ran 223.2 s; bridges 1183.5 s). Evidence:
`orkestrator-test-run.u88JLP` in the host temporary directory.

| Owning file | Failing test | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- | --- |
| `tests/unit/firewall-policy.test.ts` | `container firewall policy > a gateway workload records its egress once and verifies enforcement without running the firewall: the destination answered` | Five-second timeout at 5003.89 ms. | 34 pass, 0 fail (`bun test ./tests/unit/firewall-policy.test.ts`). |
| `apps/backend/src/core/review-validation-worker.test.ts` | `precise repository resource profiles admit lightweight checks with spare host capacity` | Five-second timeout at 5192.77 ms. | 50 pass, 0 fail (`bun test --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts` from `apps/backend`). |

The second run's backend failures above passed in this run, and this run's
failures passed in the earlier ones, consistent with load-dependent timing.
Nothing was changed in these owners.


## Review fixes validation — 2026-10-26

- **Change under test:** `2015359f9` on `todo-0175-opencode-undo-3179a52c7d02` fixes long revert-marker IDs and delayed action responses, and adds recovery and snapshot paging coverage. The failing owners and their implementations are unchanged.
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; backend and web each used two isolated Bun workers. Bridges waited 253.8 seconds for shared host capacity.
- **Aggregate result:** exit 1 after 585.9 seconds of test groups (587.9 seconds logged). Backend: 11,228 passed, 95 skipped, four failed and one between-test error across 657 files (488.13 seconds). Desktop: 1,320 passed, 14 skipped, one failed across 91 files (41.42 seconds). Web: 9,830 passed, 10 skipped, zero failed; the remaining workspace packages, root/support, bridges and protocol regeneration passed.
- **Evidence:** `orkestrator-test-run.1YwIKw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; enclosing log `orkestrator-test-run.5OhBot/repository-tests.log.gz`.

| Unchanged owning file | Aggregate failure | Complete owning-file rerun |
| --- | --- | --- |
| `apps/desktop/tests/preview-transport-manager.test.ts` | `PreviewTransportManager (desktop tunnel end to end) > hiding does not close the listener; the last release retires it and frees the attachment`: release invocation absent after the fixed wait (295.42 ms). | `mise run test:logged -- --name preview-owner-rerun -- bun test --cwd apps/desktop ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures` passed in 1.1 seconds. Confirmed recurrence of [0790](../previews-annotations-and-gateway/0790-preview-transport-attachment-release-timing.md). |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write`: zero changes after 2,006.05 ms. | `mise run test:logged -- --name worktree-watcher-owner-rerun -- bun test --cwd apps/backend ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed in 1.4 seconds. Reopened [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md). |
| `apps/backend/src/core/environment-move.test.ts` | `restart recovery re-links submodules of an adopted or abandoned copy`: 5,069.21 ms timeout and terminated Git child. | `mise run test:logged -- --name environment-move-owner-rerun -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` remained non-green: 35 passed, two failed and two errors across 37 tests (46.45 seconds). The original case timed out at 5,039.46 ms and `move_environment > moves a worktree with nested submodules (same disk)` timed out at 5,070.46 ms. Evidence: `orkestrator-test-run.ioWqle/`. See existing [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md); this run does not independently establish a flake. |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner > staging in a linked worktree (index outside the root) is detected` and `real Git through the shared owner > a shared ref moving the baseline outside the worktree is detected`: both timed out at 5,002.01 ms. | `mise run test:logged -- --name worktree-snapshots-owner-rerun -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` also failed both cases (5,002.02 / 5,002.01 ms): two passed, two failed in 11.21 seconds. Evidence: `orkestrator-test-run.LNBdEz/`. Unresolved; not classified as flakes. |

The focused OpenCode revert/provider/snapshot regressions, formatting, lint and typechecking passed. Shared host contention is a possible contributor to timing failures, but the persistent isolated failures above do not establish that cause. No unrelated implementation, assertion, timeout or skip was changed.
