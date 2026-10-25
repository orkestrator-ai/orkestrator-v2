# Service preview rollout (0042) validation

- **ID:** 0942
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0042 on branch
  `todo-0042-service-preview-rollout-f64ae24ade8a` (head `59157d460` for the
  second run): desktop preview partition retention for nodes, tunnel
  liveness client pings, legacy URL tab navigation basis, "Open as service",
  the browser toolbar, Electron and private-origin specs, `disk:report`.
- **Original command:** `mise run test:logged -- --name full-tests-0042-2 -- mise run test`,
  host load average 38 to 48 on 18 cores, shared with other worktrees' runs.
- **Aggregate result:** failed after 1653.8 s with only the workspace group
  failing (root, bridges and the Codex protocol lockfile passed). Five
  backend failures, all in files the change does not touch:
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery
    re-links submodules of an adopted or abandoned copy` (5115.78 ms; see
    [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)).
  - `apps/backend/src/core/multi-review-service.test.ts`: `native follow-up
    invalidates interactive PR authorization at restart` (6951.05 ms).
  - `apps/backend/src/core/diff-baseline.test.ts`: `a rebase excludes
    imported history and retains the rebased worker commits` (5749.65 ms).
  - `apps/backend/src/core/path-safety.test.ts`: `writeConfinedFile > rejects
    a symlinked ancestor and a regular file standing in for one` (5036.30 ms).
  - `apps/backend/tests/standalone-ready.test.ts`: `escalates SIGTERM to
    SIGKILL after the grace period` (SIGKILL arrived inside the 30 ms grace;
    see [0491](../backend-services-and-tooling/0491-standalone-ready-sigkill-escalation-aggregate.md)).
- **Owning-file reruns** (`bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./<file> --parallel=1` through `test:logged`):
  multi-review-service, diff-baseline, path-safety and standalone-ready
  passed at once. environment-move failed its first rerun at load 48
  (`moves a worktree with nested submodules (copy)` 5115.59 ms, see
  [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), and the restart
  recovery case again, 5045.19 ms) and passed the second (50.2 s).
- **First full run** (`full-tests-0042`, 1768.1 s, before the final commit)
  failed only on two real defects in the change, both fixed before the second
  run: a DOM query passed to `toBeNull` in `ServiceBrowserTab.test.tsx`
  (`tests/unit/test-diagnostic-bounds.test.ts`) and the moved toolbar classes
  (`tests/unit/mobile-responsive-contracts.test.ts`).
- **Evidence:** `orkestrator-test-run.rWSvnE/` and `orkestrator-test-run.TejCY1/`
  below the host temporary directory.
- **Assessment:** five-second budgets and a 30 ms kill grace missed on a
  saturated host. No assertion, timeout or skip changed.

## After rebasing onto `26b51f144` — 2026-10-25

`mise run test:logged -- --name full-tests-0042-3 -- mise run test` on head
`7780c6934` (load about 46): root, bridges and the Codex protocol lockfile passed;
the workspace group failed on two backend timeouts in untouched files:
`apps/backend/src/core/terminal-history.test.ts` `terminal history >
normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
(5001.13 ms, see
[0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md))
and the environment-move restart recovery case again (5043.62 ms, 0248).
Both unchanged owners passed alone (7.7 s and 29.1 s). Evidence:
`orkestrator-test-run.UFTXLR/` below the host temporary directory.
