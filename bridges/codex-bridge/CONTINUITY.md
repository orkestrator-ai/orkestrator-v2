> **Stale session ledger.** This file is leftover `/help` notes. The bridge
> lives in `bridges/codex-bridge/` and speaks JSON-RPC to
> `codex app-server --stdio`. Current invariants are in
> [`AGENTS.md`](../../AGENTS.md) and
> [`docs/architecture/agent-engines.md`](../../docs/architecture/agent-engines.md).

Goal (incl. success criteria):
- Answer the current `/help` request with a concise, accurate summary of what this `codex-bridge` workspace does and how to use it.
- Success criteria: help text reflects the current codebase and commands in this workspace.

Constraints/Assumptions:
- Canonical continuity file for this workspace is `CONTINUITY.md`.
- Use Bun for package commands.
- Network access is restricted in this Codex session; repo inspection only.
- User asked for `/help`, not for code changes beyond required ledger maintenance.

Key decisions:
- Derive help content from `package.json` and `src/index.ts` instead of guessing.
- Create `CONTINUITY.md` because it was missing.

State:
- Repo inspected at root.
- `codex-bridge` is a TypeScript/Hono bridge server for Codex SDK integration.

Done:
- Confirmed workspace root and absence of `CONTINUITY.md`.
- Read `package.json`.
- Read `src/index.ts` to identify runtime behavior, commands, and HTTP endpoints.
- Created `CONTINUITY.md`.

Now:
- Respond to the `/help` request with a concise usage summary.

Next:
- Wait for the user’s next task.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED whether the user wants app usage, repo development help, or CLI-style help output. Defaulting to repo/runtime usage summary.

Working set (files/ids/commands):
- `/Users/arkaydeus/.codex/worktrees/e6cd/orkestrator-ai/docker/codex-bridge/CONTINUITY.md`
- `/Users/arkaydeus/.codex/worktrees/e6cd/orkestrator-ai/docker/codex-bridge/package.json`
- `/Users/arkaydeus/.codex/worktrees/e6cd/orkestrator-ai/docker/codex-bridge/src/index.ts`
- Commands: `ls -la`, `sed -n`, `rg --files`, `rg -n`
