# Per-machine accounts branch validation

- **ID:** 0801
- **Status:** open
- **Date observed:** 2026-10-25, macOS arm64 (18 cores), Bun 1.4.2.
- **Branch:** `todo-0722-per-machine-accounts-43dab4042230` on `ba7cc8d4`. It
  changes the accounts overview, the account store and its protocol types, a
  Cursor bridge test and a Codex probe script; no OpenCode, transcript
  artifact or Codex bridge code.

## Commands and outcomes

| Check | Result |
| --- | --- |
| `mise run format:check` | Passed. |
| `mise run lint` | Passed. |
| `mise run test:logged -- --name typecheck -- mise run typecheck` | Passed. |
| `mise run test:logged -- --name test -- mise run test` | Failed after 1107.8 s; all four groups completed. Host load average was about 59 on 18 cores during and after the run, with other worktrees active. |

| Package/group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| root | 3405 | 1 | 0 |
| @orkestrator/protocol | 1849 | 0 | 0 |
| @orkestrator/desktop | 1234 | 0 | 14 |
| @orkestrator/web-public | 41 | 0 | 0 |
| @orkestrator/toolchain | 91 | 0 | 0 |
| orkestrator (CLI) | 242 | 0 | 0 |
| @orkestrator/web | 9558 | 0 | 10 |
| @orkestrator/backend | 10790 | 5 | 79 |
| cursor-bridge | 792 | 0 | 0 |
| codex-bridge | 2356 | 1 | 40 |
| pi-bridge | 606 | 0 | 1 |
| claude-bridge | 1619 | 0 | 5 |
| acp-bridge | 669 | 0 | 3 |

## Failures and owner reruns

| Owner | Aggregate failure (duration) | Owner alone |
| --- | --- | --- |
| `tests/unit/test-diagnostic-bounds.test.ts` | never passes a DOM-producing query result directly to toBeNull | **A real failure from this branch**: its new tests used `queryBy…().toBeNull()`. Fixed with `expectDomAbsent`; the owner then passed (16 of 16). Not a flake. |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` | registers a research server and allows exactly its tools (40002.06 ms) | Passed. Already tracked as 0785 in coordinator-and-multi-review. |
| `apps/backend/src/core/opencode-host-start.test.ts` | a start that loses the database is retried and comes up (291.53 ms) | Passed. |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | executable document policy in chromium (5001.89 ms) | Passed (39 of 39, 201.1 s). |
| `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts` | streamed media in Chromium (5007.24 ms) | Passed. |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | the external watchdog ends a blocked render within the deadline and the browser is gone (5879.98 ms) | Passed. |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | two pre-plugin answers stay stale until late plugins are observed and confirmed | Intermittent alone as well; see 0791 and [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md). |

The four backend owners other than the OpenCode research one were rerun
together with `--parallel=1` (24 of 24 passed, 51.1 s), and the content-server
engines owner on its own. Every timeout sat at a five-second (or 40-second)
budget under host load; contention is the hypothesis, not a proven cause.
