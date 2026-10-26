# Legacy migration root-symlink (0058) branch validation

- **ID:** 1003
- **Status:** open
- **Date observed:** 2026-10-26, omarchy-hp (Arch Linux x64, 12 cores), Bun 1.4.4, other worktrees active (load average 11–22).
- **Branch:** `todo-0058-legacy-migration-symlink-977645ad36e4`. It changes
  `docker/orkestrator-migrate.sh`, `tests/unit/migrate-copy.test.ts`, the
  opt-in live Docker test `apps/backend/tests/container-live-replacement.test.ts`
  and docs; no backend, web, CLI or storage source.

## Commands and outcomes

| Check | Result |
| --- | --- |
| `mise run format:check` | Passed. |
| `mise run lint` | Passed. |
| `mise run typecheck` | Passed. |
| Run 1: `mise run test:logged -- --name full-test -- mise run test` on base `93018933` | Failed after 913.2 s: workspace and root groups. Bridges and the Codex protocol lockfile passed. |
| Run 2: the same command after rebasing onto `a51045a4` | Failed after 847.9 s: workspace group only (backend 1 failure, CLI 1 failure). Root, bridges, Codex protocol lockfile and web (9,837 passed) passed. |

## Failures and owner reruns

| Owner | Aggregate failure (duration) | Owner alone |
| --- | --- | --- |
| `tests/unit/flaky-tests-index.test.ts` (run 1) | environments-and-containers case 0887 lacked its `- **ID:**` line | **Not a flake.** A defect on the old base, fixed on `main`; passed after the rebase. |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` (runs 1 and 2) | 40 s timeout | Timed out alone too, and on clean `origin/main`; recorded in [0785](../coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md). |
| `apps/backend/src/core/storage-writer-guards.test.ts` (run 1) | `raw StorageDatabase writers outside StorageService > name the store they write` (6,324 ms) | Passed, 33 of 33. |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` (run 1) | `mermaid rendering > strips script, foreignObject and external references; directives cannot relax policy` (3,624 ms) | Passed, 14 of 14. |
| `apps/web/src/components/layout/ActionBar.test.tsx` (run 1) | `ActionBar workflow tabs > maps every configured native review provider and closes without launch on Cancel` (5,585 ms) | Passed, 291 of 291. |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` (run 1) | `typing after the sigil filters a maximal list without fetching, refreshing or scanning` (2,585 ms), already tracked in native-agents-and-transcripts | Passed, 20 of 20. |
| `packages/cli/tests/cli-client.test.ts` (run 1) | `packaged client against a real backend > scenario: setup-failure` (5,290 ms) | Passed (`-t "setup-failure"`). |
| `tests/unit/components/GlobalSettings.test.tsx` (run 1) | `GlobalSettings > copies the gateway token` (238 ms) | Passed with the flaky index test, 132 of 132. |
| `packages/cli/tests/launcher.test.ts` (run 2) | `kills live unready children after a bounded grace period and restores the previous release` (2,355 ms): expected 2 entries, received 1 | Passed alone three times, 4 of 4 each. |

## Assessment

Every failure except the OpenCode timeout passed in its unchanged owner, and
none differs between runs in a way the branch could cause: the branch touches
no code these suites import. The launcher case is a timing-sensitive child
lifecycle assertion under load. No implementation, assertion, timeout or skip
changed. Raw artifacts were in `/tmp/orkestrator-test-run.is9bfG` (run 1) and
`/tmp/orkestrator-test-run.2orfi8` (run 2).


## Timeout coverage review validation — 2026-10-26

- Commit `006b1000` adds only the migration helper's completion-timeout tests.
  `mise run test:logged -- --name repository-tests -- mise run test` failed
  after 610.0 s on the same Linux host, using workspace/root/bridge/protocol
  reservations of 4/1/2/1 and two backend Bun workers.
- Backend: 11,793 passed, 143 skipped, eight failed across 11,944 tests in
  707 files (547.71 s). All other workspace packages and the root, bridge and
  protocol groups passed. The migration owner passed all 12 tests; formatting,
  lint and typechecking passed.
- Evidence: `/tmp/orkestrator-test-run.1QvzPF/summary.json` and
  `/tmp/orkestrator-test-run.1QvzPF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

| Owner | Aggregate failures | Complete unchanged owner rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` timed out at 6,450.34 ms | `mise run test:logged -- --name storage-writers-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures` passed, exit 0, 2.2 s. |
| `apps/backend/tests/tmux-commands-teardown.test.ts` | Four cases: environment teardown kills live sessions (62.78 ms), orphan reconciliation leaves hooks (95.34 ms), start queued behind teardown (85.49 ms), and interactive terminal polling cleanup (70.08 ms) | `mise run test:logged -- --name tmux-teardown-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures` passed, exit 0, 1.2 s. Recurrences of [0236](../backend-services-and-tooling/0236-tmux-teardown-cleanup-rejection.md), [0245](../backend-services-and-tooling/0245-tmux-orphan-hook-restore.md) and [0786](../backend-services-and-tooling/0786-tmux-interactive-polling-teardown-rejection.md). |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` | Research-server registration exceeded 40 s | `mise run test:logged -- --name opencode-research-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` failed, 0 passed, 1 failed, 41.4 s; artifact `/tmp/orkestrator-test-run.dNgugO`. Still reproducible alone as previously documented in 0785. |
| `apps/backend/tests/tmux-commands-mcp.test.ts` | First-prompt naming cleanup rejected (63.61 ms) | `mise run test:logged -- --name tmux-mcp-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-mcp.test.ts --parallel=1 --only-failures` failed, 16 passed, 1 failed, 10.0 s; artifact `/tmp/orkestrator-test-run.433RzC`. Reproduces alone; not newly classified as flaky. |
| `apps/backend/tests/container-readiness.test.ts` | Exited fail-closed boot returned `container-exited` rather than `firewall-missing` (13.02 ms) | `mise run test:logged -- --name container-readiness-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-readiness.test.ts --parallel=1 --only-failures` failed, 10 passed, 1 failed, 0.9 s; artifact `/tmp/orkestrator-test-run.P9PIb7`. Reproduces alone; not newly classified as flaky. |

The storage deadline and four teardown failures passed in unchanged owners,
confirming intermittency without establishing a cause. The other three failures
remain reproducible. No backend implementation, assertion, deadline or skip
changed; the aggregate result remains failed.
