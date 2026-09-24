# 07 — Implement Codex configuration management

Status: done using the safe TOML file writer (not `config/batchWrite`) plus an environment-level reload
route that never starts app-server; system and managed layers are shown read-only and project trust is read
from Codex's config. Thread-level adoption is unverified, so Codex runtimes stay `pending-next-turn` after a
reload (no `applied` evidence). Depends on: 01–05. [Plan index](00-index.md).

## Existing owners

- `bridges/codex-bridge/src/engine/app-server-engine.ts` and engine contract.
- `app-server-runtime-sessions.ts`: no-touch inventory and session actions.
- `codex-config.ts`: trusted launch overrides and MCP injection.
- `index.ts`: private authenticated HTTP composition.
- `app-server/generated/typescript/v2/Config*`, `MergeStrategy.ts`,
  `ListMcpServerStatus*`: pinned configuration and inventory contracts.
- `app-server/process-supervisor.ts`: generation and shared-process ownership.

Never hand-edit generated protocol files. A required protocol upgrade is a
separate pinned upgrade following the repository runbook.

## Source management

1. Build a Codex configuration adapter around native TOML sources. Use
   `config/read` and layer/origin metadata where a live app-server can provide
   it; preserve read-only origin information for managed policy, plugins and
   launch overrides. A merged effective map alone is not a writable source.
2. Expose an engine API narrowly scoped to MCP configuration. Do not expose
   arbitrary `config/batchWrite` key paths or `filePath` to renderer callers.
   Derive the authorized file path from the selected source and restrict writes
   to the selected `mcp_servers` entry.
3. Use `expectedVersion` for live RPC writes and return the resulting provider
   version as part of the opaque source revision. Map version conflict to the
   shared conflict response, without retrying against a newer version silently.
4. Prove remove semantics. Prefer a supported single-entry operation; if absent,
   use an atomic replacement of the exact **source** MCP table derived from a
   complete current read, or the safe TOML writer. Never replace a source table
   from paginated runtime inventory or an effective merged config.
5. Make rename one atomic config transaction. Quote/escape native names safely;
   names with dots must not become unrelated TOML key paths. Test table deletion,
   empty parent maps and unknown nested options.
6. Support stopped targets without starting an app-server solely to open settings.
   Use the shared safe-file writer when step 01 proves semantic parity. Serialize
   file and RPC writers by backing source identity to avoid competing owners.

Retain Codex-specific options such as timeout, tool selection and environment
references even if the first form does not edit them. Persistent enabled state is
an adapter capability; runtime reconnect remains a different action.

## Reload and thread application

After save-and-apply, use the existing `config/mcpServer/reload` path where valid.
This is an environment process operation, not a single-server RPC. If an alternate
write option already performs the required reload, avoid issuing two reloads;
select one proven path and test its outcome.

Record every affected loaded thread's saved/effective revision and generation.
Treat a scheduled reload as pending. At the next eligible turn/attach boundary,
prove that the thread uses the new effective configuration, then mark applied.
Detached/unmaterialized threads must remain detached; next attach receives the
latest configuration without inventing a resumable thread id.

Do not kill/restart the shared child to force application during a turn. Preserve
dispatch-journal semantics: MCP editing never sends a prompt, retries an ambiguous
turn or changes `cancelling`/`recovering` to idle. Handle generation death by
reconciliation and withdraw stale interactions according to existing rules.

Merge fresh per-session injected configuration with saved native definitions.
Verify that thread/launch overrides do not silently pin an old definition after
disk reload. Those overrides must not leak into config writes, backups or public
catalogs. A failure to apply one thread remains a per-thread outcome.

## Inventory and OAuth

Follow `nextCursor` for status reads when completeness matters, under explicit
byte/page/time budgets. If the budget is reached, report incomplete inventory;
never use partial results as deletion authority. Keep status reads no-touch and
thread-scoped only when that thread is loaded in the current generation.

Retain `mcpServer/oauth/login` through the existing interaction flow. Removing a
definition does not revoke account tokens automatically. Authentication URLs and
state are sensitive operation data, not general catalog fields; reject stale
generation completions and do not equate opening a URL with completed sign-in.

## Test matrix and acceptance

- [ ] CAS conflict and multiple atomic edits preserve unrelated TOML/comments.
- [ ] Delete/rename handles dot-containing names, nested fields, last table entry
  and inherited fallbacks without generating invalid TOML.
- [ ] Live RPC and stopped-file paths agree on resulting semantics.
- [ ] Reload affects the documented process scope and reports pending threads.
- [ ] Two threads, active turn, detached thread, unmaterialized thread and restart
  all retain conversation/dispatch identity and eventually use the intended config.
- [ ] Injected per-tab/per-attempt entries cannot be overwritten or persisted.
- [ ] Paginated inventory and source provenance prevent destructive partial writes.
- [ ] Stdout processing never waits on config rendering, SSE or frontend work.

Next adapter: [08 — OpenCode](08-opencode.md).
