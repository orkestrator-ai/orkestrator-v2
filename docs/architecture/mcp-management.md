# MCP server management

Status: living. Implemented against the plan in
[`docs/improvements/mcp/plan/`](../improvements/mcp/plan/00-index.md); the
investigation is [`docs/improvements/mcp.md`](../improvements/mcp.md).

Users add, edit, rename, remove and (where the provider has a saved switch)
enable or disable the MCP servers each agent platform connects to, without
starting a conversation. The backend is authoritative: it reads and writes the
provider's **own** configuration files, never a parallel registry, and reports
saved state, runtime application and connection health separately.

This is not Control MCP. Control MCP ([control-mcp.md](control-mcp.md)) lets
another agent drive Orkestrator; this feature edits the servers Orkestrator's
agents use. The settings menu keeps them as separate sections ("MCP servers"
and "Control MCP").

## Components

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Contract | `packages/protocol/src/mcp-management.ts` | DTOs, bounds, error codes, capability model, validation and redaction helpers |
| Commands | `apps/backend/src/core/commands-registry-mcp.ts` | `list_mcp_management_targets`, `get_mcp_management_snapshot`, `get_mcp_definition`, `validate_mcp_mutation`, `mutate_mcp_definition`, `apply_mcp_configuration`, `get_mcp_operation`, `cancel_mcp_apply`; runtime probe; container reader |
| Service | `mcp-management/service.ts` | Targets, snapshots, preview, locked conflict-checked writes, idempotency, apply scheduling, crash recovery |
| Targets | `mcp-management/targets.ts` | Opaque target ids (`mcp1~<provider>~backend`, `mcp1~<provider>~env~<id>~<incarnation>`) |
| Sources | `mcp-management/providers.ts` | Per-provider source paths, precedence, trust, capabilities, apply strategy |
| Catalog | `mcp-management/catalog.ts` | Passive reads, effective/shadowed computation, public summaries |
| Codecs | `mcp-management/codecs.ts` | Native entry ⇄ canonical definition; unknown keys preserved |
| Documents | `mcp-management/document.ts`, `json-edit.ts`, `toml-edit.ts` | Minimal edits plus whole-document semantic verification |
| Files | `mcp-management/source-store.ts` | Bounded reads, keyed revisions, cross-process locks, atomic replace |
| Operations | `mcp-management/operations-store.ts` | Durable operation records and recovery intent |
| Apply | `mcp-management/apply.ts` | Per-runtime plan and the Codex reload queue |
| UI | `apps/web/src/components/settings/mcp-servers/` | Section, editor, preview, row actions, apply status |
| Bridges | `bridges/pi-bridge/src/mcp.ts`, `bridges/cursor-bridge/src/agent-session.ts` | Adopt saved file changes at the next turn boundary |

Nothing here is exposed as a Control MCP tool, and no command accepts a
filesystem path: sources and entries are addressed by opaque ids that the
backend resolves against current environment state.

## Sources, precedence and write support

Paths are resolved on the backend with the same rules the launchers use. "Host"
means a local worktree environment or the backend-user target; containers are
described below. Higher precedence wins for a same-name entry.

| Provider | Source | Path rule | Format / subtree | Prec. | Written? | Trust on host |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | Backend user | `homedir()/.claude.json` | JSON `mcpServers` | 10 | yes | — |
| Claude | Private local | same file, `projects[<worktree path>]` | JSON `…mcpServers` | 20 | yes | allowed |
| Claude | Project | `<worktree>/.mcp.json` | JSON `mcpServers` | 30 | yes | allowed (coordinators exclude) |
| Codex | Backend user | `$CODEX_HOME/config.toml` (default `~/.codex`) | TOML `[mcp_servers.*]` | 10 | yes | — |
| Codex | Project | `<worktree>/.codex/config.toml` | TOML | 20 | yes | only if trusted in Codex |
| OpenCode | Backend user | `$XDG_CONFIG_HOME/opencode/{config.json,opencode.json,opencode.jsonc}` | JSON/JSONC `mcp` | 10–12 | yes | — |
| OpenCode | Custom | `$OPENCODE_CONFIG` when set | JSON/JSONC `mcp` | 15 | yes | — |
| OpenCode | Project | `<worktree>/opencode.json(c)` | JSON/JSONC `mcp` | 20–21 | yes | allowed |
| Cursor | Backend user | `~/.cursor/mcp.json` | JSON `mcpServers` | 10 | yes | — |
| Cursor | Project | `<worktree>/.cursor/mcp.json` | JSON `mcpServers` | 20 | yes | **excluded** on host |
| Grok | Backend user | `~/.grok/config.toml` | TOML `[mcp_servers.*]` | 10 | yes | — |
| Grok | Project | `<worktree>/.grok/config.toml` | TOML | 20 | yes | only if trusted in Grok |
| Grok | Compatibility | `~/.claude.json`, `.mcp.json`, `.cursor/mcp.json` | JSON | 1–3 | never | honours `[compat.*] mcps = false` |
| Pi | Backend user | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `mcp.json` | JSON `mcpServers` or bare map | 10 | yes | — |
| Pi | Project | `<worktree>/.pi/mcp.json` | same | 20 | yes | **excluded** on host |
| all | Orkestrator | injected at launch | runtime | 1000 | never | — |

Injected names (`orkestrator`, `orkestrator-design`,
`orkestrator_workflow_result`) are shown as protected rows and cannot be claimed
by a new definition in any provider. A file entry that already uses one is shown
as overridden and can only be removed.

Saving to an excluded or untrusted project file is allowed and labelled: saving
is not permission to execute. The editor never changes an execution policy.

### Recorded discrepancies (not changed by this feature)

- **Claude precedence.** The Claude bridge merges `.mcp.json` over the private
  local entry over the user entry and passes the result inline, so that is the
  order shown. The Claude CLI in a terminal prefers the private local entry
  over `.mcp.json`. The editor previews the native-session order.
- **`CLAUDE_CONFIG_DIR`.** The bridge reads `homedir()/.claude.json` even when
  `CLAUDE_CONFIG_DIR` is set, so that file is the one edited. A terminal CLI
  started with `CLAUDE_CONFIG_DIR` reads `$CLAUDE_CONFIG_DIR/.claude.json`.
- **OpenCode merge.** OpenCode deep-merges same-name entries; a higher entry
  that omits a field inherits it. Rows say so rather than claiming replacement.
- **Pi disabled entries.** The Pi bridge skips a `disabled: true` entry, so a
  lower-priority entry with the same normalized name becomes effective; the
  catalog and preview show that.

## Capabilities by provider

| Provider | stdio | HTTP | SSE | Saved enable | `cwd` | Advanced fields | In-app sign-in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude | ✓ | ✓ | ✗ bridge drops SSE | ✗ | ✗ | — | existing reconnect/elicitation |
| Codex | ✓ | ✓ | ✗ | `enabled` | ✓ | timeouts, bearer variable, tool allow/deny, required | existing OAuth action |
| OpenCode | ✓ (`local`) | ✓ (`remote`) | ✗ | `enabled` | ✓ | timeout, disable auto-OAuth | existing `mcp.auth.start` |
| Cursor | ✓ | ✓ | ✓ | ✗ | ✓ | — | ✗ (sign in via Cursor) |
| Grok | ✓ | ✓ | ✗ unverified | ✗ unverified | ✗ | timeouts | ✗ |
| Pi | ✓ | ✓ | ✗ (treated as HTTP) | `disabled` | ✗ | — (limits: 32 args, 32 env, 16 headers) | ✗ |

Unsupported transports are refused on add and update; existing entries that use
one stay visible and removable. Every disabled control carries a reason in the
target capabilities, and the UI shows it.

## Writes

1. The target is resolved from current environment state; a stale incarnation
   or deleted environment is `unknown-target`.
2. A lock keyed by the file's real path is taken in-process and in
   `$TMPDIR/orkestrator-mcp-locks-<uid>/`, shared by every backend of the same
   OS user (dev/test profiles included). A stale lock is taken over only when
   its pid is dead or, on Linux, its process start time differs.
3. The file is re-read (bounded: 8 MiB general, 1 MiB Cursor/Pi), and the
   request's expected revision must match. Revisions are keyed HMACs of the
   whole file (`<dataDir>/mcp-management/revision.key`), so they reveal nothing
   about low-entropy secrets and cover every byte a write could overwrite.
4. The operation record is persisted (`<dataDir>/mcp-management/operations.json`,
   mode 0600) before the file is touched.
5. The edit is minimal: JSON/JSONC splices one property (comments and layout
   outside the entry are kept; JSONC comments are kept); TOML edits only the
   entry's tables and only changed keys. The result is re-parsed and compared
   with the old document plus the intended change; any other difference aborts.
6. A same-directory private temporary file is written, synced, re-checked
   against the expected revision and renamed over the target.

**Residual race.** A non-cooperating editor that writes between the final
re-check and the rename can be overwritten. Rename is not compare-and-swap and
nothing here claims otherwise.

**Symlinks.** Project files (and created parent directories) must resolve inside
the worktree; otherwise they are read-only. A user file symlinked elsewhere (a
dotfiles repository) is written at its real target. Files owned by another user
are read-only.

**Layouts not edited.** A TOML server defined inline (`[mcp_servers] a = {…}`)
or with dotted keys, a JSON key defined twice, or a non-object entry is shown
with a reason and left alone.

## Secrets

The renderer never receives a saved value. Env and header values are reported
as `literal` (present) or `reference` (`${VAR}`, `$VAR`, `{env:VAR}`, shown
verbatim). Arguments and URLs that look credential-bearing are shown redacted and
retained by position. Edits are `keep` / `set` / `clear`; a `keep` that names a
key or argument the saved revision no longer has is refused. Project files
refuse new literal env/header values and credential-bearing URLs; existing ones
are kept through unrelated edits. References to Orkestrator's own credentials
(`ORKESTRATOR_*_TOKEN`, `*_BRIDGE_TOKEN`) are refused. Operation records,
events, errors and logs carry names and ids only.

## Runtime application

Save and "save and apply" are separate choices. Save never starts anything;
future provider loads read the new file. Apply only acts on runtimes the backend
already knows (persisted native sessions) and never creates a session.

| Provider | Strategy | What the backend reports |
| --- | --- | --- |
| Claude | per-query reload (bridge re-reads files every query) | `pending-next-turn` |
| Codex | `config/mcpServer/reload` on the environment's app-server | `queued` until **every** Codex session in the environment is idle (unknown activity and pending dispatches count as busy), then one reload; `pending-next-turn` after it succeeds, `failed` on error or after 30 minutes busy |
| OpenCode | server restart | `restart-required`; nothing is restarted |
| Cursor | bridge reattaches at the next message | `pending-next-turn` (see below) |
| Grok | process restart | `restart-required` |
| Pi | bridge rebuilds its MCP generation at the next message | `pending-next-turn` (see below) |

Coordinator sessions are `blocked-policy` (they use a private configuration
home). Project-scope changes are `blocked-policy` for sessions whose policy
excludes project resources. Container sessions are `restart-required` for
backend-user changes (their home is a copy). Terminal sessions are never
touched; the operation carries restart guidance instead.

**Pi and Cursor bridges** fingerprint the MCP files each live generation was
built from. At the next turn start (never mid-turn; running, compacting or
another claimed dispatch defer it) a changed fingerprint detaches and re-attaches
the session on the same conversation. Excluded project files are not part of the
fingerprint, so editing them does not rebuild a session. Cursor refuses to
substitute a new conversation when that resume fails; the prompt fails with a
clear message and the conversation is kept.

The scheduler runs on a timer, never on a request or event path; every
detached promise handles its rejection. Operation state survives backend
restart; an in-flight Codex reload is re-queued (reload is idempotent). A newer
apply for the same target cancels older queued work ("superseded").
`cancel_mcp_apply` cancels queued work and never touches the saved file.

## Crash recovery and idempotency

A request id is bound to a keyed fingerprint of the mutation: a retry after a
lost response replays the stored result; the same id with a different mutation
is `request-conflict`. On startup, an operation left `pending` is reconciled
from the file: unchanged revision → "not saved"; intended outcome present →
recovered as saved; anything else → `conflict`. A mutation is never repeated.

## Containers

A container's provider homes are copies made at creation, not a durable store
of intent, so **container targets are read-only**. When the container is
running, the catalog reads the container's own files (`/home/node/...`,
`/workspace/...`) with `docker exec --user node` (bounded, path passed as an
argument, never shell text); a stopped container is `offline`. Environment-
private editing needs the durable overlay from plan step 13, which is not
implemented; the UI says so and points to backend-user configuration for what
new containers receive.

`docker/entrypoint.sh` now copies Pi's `agent/mcp.json` into new containers
(size and symlink rules of `copy_agent_file`, mode 0600), closing the delivery
gap the investigation found. Cursor still has no user-MCP copy into containers.

## Events and rehydration

`mcp-management-changed` carries `{ revision, targetIds, operationIds }` only.
The settings section re-reads its snapshot on mount, on that event and on event
stream reconnect, and drops responses for a target the user has switched away
from. Drafts live only in the open dialog and are never persisted.

## Verification status

Automated evidence at the implementing commit (all with temporary homes and
worktrees; nothing reads or writes the operator's configuration):

| Area | Evidence |
| --- | --- |
| Protocol | `packages/protocol/src/mcp-management.test.ts` — bounds, unions, keep/set/clear, redaction, error round-trip |
| Editors | `json-edit.test.ts`, `toml-edit.test.ts` — comments, CRLF, multi-line strings, inline/dotted refusal |
| Files | `source-store.test.ts` — conflicts, modes, symlinks, locks, stale-lock takeover |
| Service | `service.test.ts`, `service-providers.test.ts`, `service-apply.test.ts` — CRUD for all six providers, shadowing and fallback, secret absence, idempotency, recovery, Codex queue, supersession, container catalog |
| Commands | `commands-registry-mcp.test.ts` |
| Bridges | Pi `mcp.test.ts`, `agent-session.test.ts`; Cursor `agent-session.test.ts` |
| UI | `mcp-draft.test.ts`, `ProviderMcpSettings.test.tsx`, `FullscreenSettingsLayout.test.tsx` |
| Container reader | Manual smoke against a throwaway container: ok, absent, oversized, offline, shell-metacharacter path |

Not yet verified (plan steps 01 and 14): live probes against the pinned vendor
binaries — that Codex's reload changes an existing thread's tools at its next
turn, OpenCode/Grok pick changes up on restart, Cursor's SDK re-reads
`~/.cursor/mcp.json` on resume, and that removed servers' tools are gone after
apply — plus real-browser, inactive-environment and container QA. Until those
are recorded, treat apply states as the backend's plan, not observed adoption.

## Rollback

Unregistering the commands (or reverting the UI section) disables management;
saved native files keep working with every provider. The two private files under
`<dataDir>/mcp-management/` can be deleted; operation history is then lost and
revisions change, which only forces a reload in open editors.
