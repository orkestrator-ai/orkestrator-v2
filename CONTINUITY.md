> **Stale session ledger.** This file is leftover from an old
> `orkestrator-ai` / Tauri worktree (`src-tauri`, flat `src/lib/*`). It is not
> current architecture and must not guide work. Current agent instructions are
> in [`AGENTS.md`](AGENTS.md).

Goal (incl. success criteria):
- Ensure todo writes in all native environments (`claude`, `opencode`, `codex`) surface a fresh todo list as the newest timeline item, always reflecting the latest todo state.
- Success: refreshed/resumed timelines append a latest todo snapshot instead of leaving the todo list buried at its original tool position or stale after later updates.

Constraints/Assumptions:
- Follow `AGENTS.md`: refresh this ledger at turn start and when task state materially changes.
- Use Bun for frontend tests and `apply_patch` for manual edits.
- Do not revert unrelated user changes.

Key decisions:
- Fix the issue in shared message normalization/fetch paths instead of only in render components, so refresh/reconnect/resume all behave consistently.
- Derive one synthetic latest-todo timeline message from the most recent `TodoWrite` tool state in the server message list.
- Based on current web docs, Claude interactive sessions also use `TaskCreate` and `TaskUpdate` to mutate tasks; `TodoWrite` alone is insufficient for Claude native interactive flows.

State:
- Done: Implemented shared latest-todo snapshot normalization, wired it into Claude/OpenCode/Codex message fetch flows (plus Codex resume), consolidated the styled todo renderer into a shared component used by Claude/OpenCode/Codex, and added focused tests.
- Now: Ready to report the shared renderer change and the remaining Claude `Task*` follow-up.
- Next: If requested, extend Claude native handling to `TaskCreate`/`TaskUpdate` (and possibly `TaskList`/`TaskGet` for read/list sync).

Done:
- Read `CONTINUITY.md`.
- Searched todo/timeline handling across `src/` and `src-tauri/`.
- Inspected `src/lib/opencode-client.ts`, `src/lib/codex-client.ts`, `src/lib/claude-client.ts`.
- Inspected `src/components/*ChatTab.tsx` and relevant stores.
- Confirmed the current bug is caused by todo state remaining embedded in older assistant messages.
- Added `appendLatestTodoSnapshot` in `src/lib/todo-tool.ts`.
- Appended synthetic tail todo messages in `src/lib/opencode-client.ts`, `src/lib/codex-client.ts`, and `src/lib/claude-client.ts`.
- Normalized Claude todo rendering via shared todo parsing, including cancelled todos.
- Added shared styled todo renderer in `src/components/todo/TodoToolPart.tsx` and switched Claude/OpenCode to use it, which also standardizes Codex via `OpenCodeMessage`.
- Added tests in `src/lib/todo-tool.test.ts`, `src/lib/opencode-client.test.ts`, `src/lib/codex-client.test.ts`, and `src/lib/claude-client.test.ts`.
- Ran `bun install`, `bun test src/lib/todo-tool.test.ts src/lib/opencode-client.test.ts src/lib/codex-client.test.ts src/lib/claude-client.test.ts`, and `bunx tsc --noEmit`.
- Searched current official docs for Claude/OpenCode/Codex todo-related tools.

Now:
- Summarize implementation and verification for the user.

Next:
- Wait for user validation in the app.

Open questions (UNCONFIRMED if needed):
- Claude: confirmed from docs that interactive sessions use `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`, with `TodoWrite` only in non-interactive mode / Agent SDK.
- OpenCode: no additional built-in todo mutator found beyond `todowrite`; `todoread` is read-only.
- Codex: UNCONFIRMED official public tool name for todo mutation; docs only say Codex "tracks progress with a to-do list".

Working set (files/ids/commands):
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/CONTINUITY.md`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/todo-tool.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/opencode-client.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/codex-client.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/claude-client.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/components/claude/ClaudeMessage.tsx`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/components/opencode/OpenCodeMessage.tsx`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/components/todo/TodoToolPart.tsx`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/todo-tool.test.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/opencode-client.test.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/codex-client.test.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-se48ae/src/lib/claude-client.test.ts`
- Commands used: `bun install`, `bun test src/lib/todo-tool.test.ts src/lib/opencode-client.test.ts src/lib/codex-client.test.ts src/lib/claude-client.test.ts`, `bunx tsc --noEmit`
- Web sources reviewed: Anthropic Claude Code settings/tool list, OpenCode tools/permissions docs, OpenAI Codex upgrades announcement
