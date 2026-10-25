# Agent interactions (0001) validation: known backend timing flakes

- **ID:** 0900
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0001 (agent interactions and permissions) on branch `todo-0001-agent-interactions-db4f03351da7`, based on `00a0cb82`: OpenCode auto-answer removal, read-only policy reporting, Claude question previews, Claude tmux and Grok pauses, CLI hold, Codex questions. None of the failing owners or their production code was changed.
- **Original command:** `mise run test:logged -- --name full-non-ios -- mise run test` (worktree on an external Lexar drive, other worktrees validating on the same host).
- **Aggregate result:** failed after 1574.9 s. Bridges and the codex protocol lockfile passed; in the workspace group every package but backend reported 0 fail. Backend ran 11519 tests: 11427 pass, 89 skip, 3 fail:
  - `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts`: `mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone` (5580.05 ms, elapsed over the deadline bound); see [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md) and [0518](../design-canvas-and-artifacts/0518-mermaid-watchdog-aggregate-deadline.md).
  - `apps/backend/src/core/environment-move.test.ts`: `move_environment > moves a worktree with nested submodules (copy)` (5062.59 ms) and `restart recovery re-links submodules of an adopted or abandoned copy` (5064.65 ms), five-second timeouts; see [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md) and [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md).
- **Root group:** 3430 pass, 1 fail in `tests/unit/test-diagnostic-bounds.test.ts`. That was a real convention violation in a new test of this change (`NativeAgentQuestionCard.test.tsx` passed a DOM query result to `toBeNull`), corrected in the same change; the owner then passed (16 pass). Not a flake.
- **Owner reruns:** each passed alone: `mise run test:logged -- --name rerun-mermaid -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1` (28.8 s) and `mise run test:logged -- --name rerun-move -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1` (37.8 s).
- **Evidence:** `orkestrator-test-run.aMkTVq/` under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host and external-drive contention is a possible contributor, not an established cause.
