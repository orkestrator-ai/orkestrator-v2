# Dependency upgrades (0032) validation: backend timeouts and browser-suite failures

- **ID:** 0825
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** Electron 45, electron-builder 26.18, electron-updater 6.8.11, in-range `bun audit fix` (undici, body-parser, fast-uri, ip-address, happy-dom), `tsx` removed from two bridges, and the React Compiler lint burn-down across `apps/web` and `e2e/fixture` (todo 0032). No backend source changed.
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` (default reservations; worktree on an external Lexar drive, other worktrees validating on the same host).
- **Aggregate result:** failed after 1195.3 s. Root and agent-support, bridges and the codex protocol lockfile passed; in the workspace group web, desktop, web-public, cli, protocol and toolchain reported 0 fail. Backend ran 11094 tests: 11010 pass, 79 skip, 5 fail, all five-second timeouts:
  - `apps/backend/src/core/coordinator-service.test.ts`: `project coordinator > discards an unborn HEAD and a dirty remote-tracking switch` (5050.88 ms) and `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` (5967.63 ms); see [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md).
  - `apps/backend/src/core/environment-move.test.ts`: `move_environment > moves a worktree with nested submodules (copy)` (5054.02 ms), see [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md); `restart recovery re-links submodules of an adopted or abandoned copy` (5105.98 ms), see [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md) and [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).
  - `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts`: `streamed media in Chromium > (unnamed)` (5004.69 ms); also seen in [0694](0694-command-handover-validation.md).
- **Owner reruns:** each owner passed alone with `bun test <file> --preload ../../tests/setup-node.ts --parallel=1` from `apps/backend`: media-stream 1 passed, coordinator-service 56 passed, environment-move 37 passed.
- **Browser suite:** `mise run test:browser` (with `ORKESTRATOR_E2E_PORT` set to a free port, because another checkout's fixture server held the default) reported 673 passed, 102 skipped, 7 failed. The same five spec files were then run on this branch and on the base commit `ba7cc8d4` in a temporary worktree:
  - `e2e/AgentLaunchDialog.spec.ts` `selects a native branch suggestion with the keyboard and confirms` (both projects; `rel` instead of `release/2.0`): fails on base too; see [0382](../web-ui/0382-component-browser-parallel-load.md) and [0500](0500-agent-mail-main-merge-validation.md).
  - `e2e/MonacoRuntime.spec.ts` (desktop): fails on base too; see [0517](../web-ui/0517-monaco-runtime-browser-startup.md).
  - `e2e/ToolGroupFold.spec.ts` (mobile `a waiting group that fits its cap follows appended calls…`): passed on the branch rerun; base failed a different case in the same file; see [0747](../web-ui/0747-tool-group-overflow-follow.md) and [0721](../web-ui/0721-tool-fold-history-anchor.md).
  - `e2e/DesignCanvas.spec.ts` (both projects, 30 s timeouts): failed on both branch and base in the five-file run, then passed 2/2 on both when run alone.
  - `e2e/DesignCanvasAccessibility.spec.ts` (mobile) was a real regression from the change, not a flake: restoring the saved viewport during render skipped the first default-view commit that auto-expands live frames on small canvases. Fixed in the same change (restore stays in an effect); the spec passes on both projects.
- **Evidence:** `orkestrator-test-run.9LICZu/` (test) and `orkestrator-test-run.ewcPRe/` (browser) under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host and external-drive contention is a possible contributor, not an established cause.
