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
