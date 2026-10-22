# Renamed owning files

- **ID:** 0049
- **Status:** open
Every entry below records the file name, line number, command, and counts
**exactly as observed at the time of the run**. Those are evidence and are never
rewritten, because a rewritten stack location or a rewritten command no longer
identifies anything that was actually executed.

Several owning files were split into narrower ones on 2026-08-16
(`refactor(tests): split oversized test modules`). Historical entries still name
the pre-split file; use this table to find the file that owns those tests today.
The recorded line numbers refer to the pre-split file and can be resolved
against the commit named in the entry, or against `main` before that split.

| Historical file | Current owner |
| --- | --- |
| `apps/backend/src/core/build-pipeline-service.test.ts` | `apps/backend/src/core/build-pipeline-service-*.test.ts` |
| `apps/backend/src/core/native-agent-service.test.ts` | `apps/backend/src/core/native-agent-service-*.test.ts` |
| `apps/web/src/components/terminal/TerminalContainer.test.tsx` | `apps/web/src/components/terminal/TerminalContainer*.test.tsx` |
| `apps/web/src/lib/opencode-client.test.ts` | `apps/web/src/lib/opencode-*.test.ts` |
| `bridges/acp-bridge/src/index.test.ts` | `bridges/acp-bridge/src/acp-*.test.ts` |
| `bridges/claude-bridge/src/services/session-manager.test.ts` | `bridges/claude-bridge/src/services/session-manager-*.test.ts` |
| `bridges/codex-bridge/src/app-server-runtime.test.ts` | `bridges/codex-bridge/src/app-server-runtime-*.test.ts` |
| `tests/unit/components/ClaudeTmuxChatTab.test.tsx` | `tests/unit/components/ClaudeTmuxChatTab.test.tsx` and `ClaudeTmuxChatTab.parts.test.tsx` |
| `tests/unit/electron/commands.test.ts` | `tests/unit/electron/commands-*.test.ts` |
| `tests/unit/electron/gateway.test.ts` | `tests/unit/electron/gateway-*.test.ts` |
| `tests/unit/electron/tmux-backend.test.ts` | `tests/unit/electron/tmux-*.test.ts` |

To rerun one of these in isolation today, substitute the current owner into the
entry's recorded command — for example
`bun test ./bridges/acp-bridge/src/acp-*.test.ts` in place of
`bun test ./bridges/acp-bridge/src/index.test.ts`. A new observation should be
recorded against the file that actually ran, not against the historical name.
