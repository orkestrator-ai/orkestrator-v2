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
| Commands | `apps/backend/src/core/commands-registry-mcp.ts` | `list_mcp_management_targets`, `get_mcp_management_snapshot`, `get_mcp_definition`, `validate_mcp_mutation`, `mutate_mcp_definition`, `apply_mcp_configuration`, `get_mcp_operation`, `cancel_mcp_apply`, `get_mcp_management_rollout`, `set_mcp_management_rollout`; runtime probe; container reader; correlation ids |
| Service | `mcp-management/service.ts` | Targets, snapshots, preview, locked conflict-checked writes, idempotency, apply scheduling, crash recovery |
| Targets | `mcp-management/targets.ts` | Opaque target ids (`mcp1~<provider>~backend~<backend hash>`, `mcp1~<provider>~env~<id>~<incarnation>`) |
| Sources | `mcp-management/providers.ts`, `native-policy.ts` | Per-provider source paths, precedence, trust (Codex/Grok trust files, Grok compatibility switches), capabilities, apply strategy |
| Catalog | `mcp-management/catalog.ts`, `references.ts` | Passive reads, effective/shadowed computation (including the Pi bridge's acceptance and last-wins rules), public summaries, rename reference warnings |
| Rollout | `mcp-management/rollout.ts` | Kill switch and per-provider write/apply gate from `global.mcpManagement` |
| Evidence | `mcp-management/evidence.ts`, `apps/backend/src/core/http-bridge-mcp-evidence.ts` | Proof that a runtime loaded the saved bytes |
| Codecs | `mcp-management/codecs.ts` | Native entry ⇄ canonical definition; unknown keys preserved |
| Documents | `mcp-management/document.ts`, `json-edit.ts`, `toml-edit.ts` | Minimal edits plus whole-document semantic verification |
| Files | `mcp-management/source-store.ts` | Bounded reads, keyed revisions, cross-process locks, atomic replace |
| Operations | `mcp-management/operations-store.ts` | Durable operation records and recovery intent |
| Apply | `mcp-management/apply.ts` | Per-runtime plan and the Codex reload queue |
| UI | `apps/web/src/components/settings/mcp-servers/` | Section, editor, preview, row actions, apply status |
| Bridges | `bridges/pi-bridge/src/mcp.ts`, `bridges/cursor-bridge/src/agent-session.ts`, `bridges/claude-bridge/src/services/mcp-config.ts`, `bridges/acp-bridge/src/acp-mcp-inventory.ts`, `bridges/codex-bridge/src/mcp-reload-route.ts` | Adopt saved file changes at the next turn boundary; report which MCP files a runtime was built from; Codex reload that never cold-starts |

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
| Codex | System | `/etc/codex/config.toml` (when present) | TOML `[mcp_servers.*]` | 5 | never | — |
| Codex | Backend user | `$CODEX_HOME/config.toml` (default `~/.codex`) | TOML `[mcp_servers.*]` | 10 | yes | — |
| Codex | Project | `<worktree>/.codex/config.toml` | TOML | 20 | yes | from `[projects."<path>"] trust_level` in the user config (worktree, then main checkout); `unknown` when absent |
| Codex | Managed | `/etc/codex/managed_config.toml` (when present) | TOML | 30 | never | — |
| OpenCode | Backend user | `$XDG_CONFIG_HOME/opencode/{config.json,opencode.json,opencode.jsonc}` | JSON/JSONC `mcp` | 10–12 | yes | — |
| OpenCode | Custom | `$OPENCODE_CONFIG` when set | JSON/JSONC `mcp` | 15 | yes | — |
| OpenCode | Project | `<worktree>/opencode.json(c)` | JSON/JSONC `mcp` | 20+ | yes | allowed; excluded when `OPENCODE_DISABLE_PROJECT_CONFIG` is set |
| OpenCode | Project `.opencode/` | `<worktree>/.opencode/opencode.json(c)` | JSON/JSONC `mcp` | 30+ | yes | as project |
| OpenCode | Config directories | `~/.opencode/`, then `$OPENCODE_CONFIG_DIR` | JSON/JSONC `mcp` | 32+, 34+ | yes | — |
| OpenCode | Inline | `OPENCODE_CONFIG_CONTENT` | JSONC `mcp` | 40 | never | — |
| OpenCode | Managed | `/etc/opencode/` (when present) | JSON/JSONC `mcp` | 50+ | never | — |
| Cursor | Backend user | `~/.cursor/mcp.json` | JSON `mcpServers` | 10 | yes | — |
| Cursor | Project | `<worktree>/.cursor/mcp.json` | JSON `mcpServers` | 20 | yes | **excluded** on host |
| Grok | Managed | `/etc/grok/managed_config.toml`, `$GROK_HOME/managed_config.toml` | TOML `[mcp_servers.*]` | 6–7 | never | — |
| Grok | Backend user | `$GROK_HOME/config.toml` (default `~/.grok`) | TOML `[mcp_servers.*]` | 10 | yes | — |
| Grok | Project | `<worktree>/.grok/config.toml` | TOML | 20 | yes | from `$GROK_HOME/trusted_folders.toml` (a trusted parent covers the worktree; `GROK_FOLDER_TRUST=0` or `[folder_trust] enabled = false` turns the gate off); `unknown` when undecided |
| Grok | Compatibility | Claude `~/.claude.json` (user and private local) > Cursor `~/.cursor/mcp.json` and project `.cursor/mcp.json` > project `.mcp.json` | JSON | 1–5 | never | Claude/Cursor imports honour `GROK_*_MCPS_ENABLED`, then `requirements.toml`, user `config.toml`, `managed_config.toml` `[compat.*] mcps`; the project config is never read for it |
| Pi | Backend user | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `mcp.json` | JSON `mcpServers` or bare map | 10 | yes | — |
| Pi | Project | `<worktree>/.pi/mcp.json` | same | 20 | yes | **excluded** on host |
| all | Orkestrator | injected at launch | runtime | 1000 | never | — |

Injected names (`orkestrator`, `orkestrator-design`,
`orkestrator_workflow_result`) are shown as protected rows and cannot be claimed
by a new definition in any provider. A file entry that already uses one is shown
as overridden and can only be removed.

Saving to an excluded or untrusted project file is allowed and labelled: saving
is not permission to execute. The editor never changes an execution policy.

### Recorded discrepancies and provider rules

- **Claude precedence.** The Claude bridge merges `.mcp.json` over the private
  local entry over the user entry and passes the result inline, so that is the
  order shown. The Claude CLI in a terminal prefers the private local entry
  over `.mcp.json`. The editor previews the native-session order.
- **The Claude CLI also loads MCP files itself.** Probed against the pinned SDK
  0.3.280 / CLI 2.1.280 with marker-writing stdio servers: the bridge passes its
  merged set inline, but because the query's `settingSources` include `user`
  (and `project` / `local` when project resources are on), the CLI child also
  loads `~/.claude.json` `mcpServers`, `.mcp.json` and `projects[cwd]` itself.
  A same-name inline server wins and only one copy starts. Consequences: SSE
  entries the bridge drops from its inline set probably still run (inferred, not
  probed with an SSE server), and with `CLAUDE_CONFIG_DIR` set the CLI reads
  `$CLAUDE_CONFIG_DIR/.claude.json` while the bridge (and this editor) read
  `homedir()/.claude.json`. `strictMcpConfig` would remove the CLI's own load
  but also stops plugin MCP servers (confirmed), so it is deliberately not set.
  Coordinators use `settingSources: []`, under which the CLI loads no MCP file,
  and the bridge passes them only the injected servers.
- **OpenCode and Codex merge.** OpenCode deep-merges same-name entries and
  Codex merges them field by field; a higher entry that omits a field inherits
  it. Rows say so rather than claiming replacement.
- **Pi disabled and skipped entries.** The Pi bridge skips a `disabled: true`
  entry and any entry it cannot load (bad name, non-object, unknown transport,
  missing or non-http(s) URL, no command, beyond 64 per file), so a
  lower-priority entry with the same normalized name becomes effective. The
  catalog applies the same rules: such rows are `disabled` or `invalid` with a
  reason and the fallback is shown as effective; the preview names it.
- **Pi normalized-name collisions.** Two entries in one file that Pi normalizes
  to the same name are all shown `invalid` naming the one Pi uses (the last, as
  the bridge's map does). Edit, rename and enable are refused; remove is allowed.
- **Grok saved enable.** `enabled = false` and the top-level
  `disabled_mcp_servers` list are shown as disabled. The editor does not offer
  the switch (unverified) and never writes `enabled`.
- **Plugin, team and remote layers are not modelled.** Claude plugins, Cursor
  plugins and team settings, OpenCode remote/org configuration and Codex
  profiles are not file sources this editor can read (or Orkestrator never
  selects them, as with Codex `--profile`). A server they add is visible only
  in the live panel, and the effective row shown here can differ from what such
  a layer overrides.

## Capabilities by provider

| Provider | stdio | HTTP | SSE | Saved enable | `cwd` | Advanced fields | In-app sign-in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude | ✓ | ✓ | ✗ bridge drops SSE | ✗ | ✗ | — | existing reconnect/elicitation |
| Codex | ✓ | ✓ | ✗ | `enabled` | ✓ | timeouts, bearer variable, tool allow/deny, required | existing OAuth action |
| OpenCode | ✓ (`local`) | ✓ (`remote`) | ✗ | `enabled` | ✓ | timeout, disable auto-OAuth | existing `mcp.auth.start` |
| Cursor | ✓ | ✓ | ✓ | ✗ | ✓ | — | ✗ (sign in via Cursor) |
| Grok | ✓ | ✓ | ✗ unverified | shown, not editable (unverified) | ✗ | timeouts | ✗ |
| Pi | ✓ | ✓ | ✗ (treated as HTTP) | `disabled` | ✗ | — (limits: 32 args, 32 env, 16 headers) | ✗ |

Unsupported transports are refused on add and update; existing entries that use
one stay visible and removable. Fields the chosen transport cannot carry (a URL
on stdio; command, arguments or working directory on a remote server; env on a
remote server for every provider except Claude) are refused instead of being
silently dropped. Every disabled control carries a reason in the
target capabilities, and the UI shows it.

## Writes

1. The target is resolved from current environment state; a stale incarnation
   or deleted environment is `unknown-target`.
2. A lock keyed by the file's real path is taken in-process and in
   `$TMPDIR/orkestrator-mcp-locks-<uid>/`, shared by every backend of the same
   OS user (dev/test profiles included). A stale lock is taken over only when
   its pid is dead, on Linux when its process start time differs, or when the
   lock body is unreadable and older than 10 minutes. A live holder whose start
   time cannot be checked is never taken over; the writer gets `busy`.
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

**Limits.** At most 64 servers per file on add, 1 MiB for the whole server map
after an edit (a file already over it stays editable if the edit does not grow
it), snapshots under 256 KiB (rows trimmed, `truncated` counted, freshness
`incomplete`), and the gateway rejects mutation bodies over 260 KiB before
decoding them.

**Rename references.** A rename preview warns about other settings that name
the server (Claude `enabledMcpjsonServers` / `disabledMcpjsonServers` and
per-project `disabledMcpServers` in `~/.claude.json`; OpenCode `tools` and
`agent.*.tools` keys starting with `<name>_`). They are not rewritten.

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
(`ORKESTRATOR_*_TOKEN`, `*_BRIDGE_TOKEN`) are refused wherever a new value is
entered: env and header values, the command, arguments, the URL and advanced
fields (Codex's `bearer_token_env_var` names a variable, so the bare name is
refused too). Operation records,
events, errors and logs carry names and ids only. Every structured failure
carries a correlation id (`mcpe-…`, sent as a ` [ref:<id>]` suffix and shown in
the UI as "Reference"); the backend logs one line with the command, the error
code and that id, never a value.

## Runtime application

Save and "save and apply" are separate choices. Save never starts anything;
future provider loads read the new file. Apply only acts on runtimes the backend
already knows (persisted native sessions) and never creates a session.

| Provider | Strategy | What the backend reports |
| --- | --- | --- |
| Claude | per-query reload (bridge re-reads files every query) | `pending-next-turn`, then `applied` on evidence (below) |
| Codex | `config/mcpServer/reload` on the environment's app-server | `queued` until **every** Codex session in the environment is idle (unknown activity and pending dispatches count as busy), then one reload; `pending-next-turn` after it succeeds, `failed` on error or after 30 minutes busy |
| OpenCode | server restart | `restart-required`; nothing is restarted |
| Cursor | bridge reattaches at the next message | `pending-next-turn` (see below), then `applied` on evidence |
| Grok | process restart | `restart-required`, then `applied` on evidence after the bridge restarts |
| Pi | bridge rebuilds its MCP generation at the next message | `pending-next-turn` (see below), then `applied` on evidence |

Coordinator sessions (by policy, or by their coordinator runtime id, which
matches no environment) are `blocked-policy`: they load no user MCP servers.
Project-scope changes are `blocked-policy` for sessions whose policy excludes
project resources. Container sessions are `restart-required` for backend-user
changes the entrypoint copies (their home is a copy made at creation); Cursor
container sessions are `blocked-policy`, because nothing copies Cursor's
`mcp.json` into containers. Queued work for a deleted environment is
`cancelled`. Terminal sessions are never touched; the operation carries restart
guidance instead.

**Codex reload** is one environment-level call, `POST /global/mcp/reload` on the
Codex bridge, which reloads only if an app-server child is already running
(`requestIfReady`) and never spawns one: `reloaded` or `not-running` →
`pending-next-turn`; a 404 from an older bridge → `restart-required`. When a
plan exceeds 64 runtimes, each environment keeps its first runtime before any
environment's second, so one reload per environment survives truncation (a plan
with more than 64 Codex environments still omits the rest).

**Older Pi and Cursor bridges** cannot be detected (the backend records no
bridge version for them), so `pending-next-turn` is reported whatever their
version; evidence-based `applied` simply never arrives from an old bridge.

**Pi and Cursor bridges** fingerprint the MCP files each live generation was
built from. At the next turn start (never mid-turn; running, compacting or
another claimed dispatch defer it) a changed fingerprint detaches and re-attaches
the session on the same conversation. Excluded project files are not part of the
fingerprint, so editing them does not rebuild a session. Cursor refuses to
substitute a new conversation when that resume fails; the prompt fails with a
clear message and the conversation is kept.

### Evidence of adoption

`applied` is reported only when the runtime's own bridge proves it. Each
bridge reports, on its no-touch `GET /session/:id/runtime-health`, an
`mcpConfig` naming the MCP files its live runtime was built from as
`sha256:<base64url>` digests of the exact bytes (`absent` / `excluded`
otherwise), plus when they were read: Claude the most recent query
(`queryStartedAt`, with its source `scope`), Cursor and Pi the attached
generation (`builtAt`, taken before the read), Grok the last child's MCP
listing (`loaded.observedAt`, process-level). At save time the backend records
privately, in the operation's recovery half, the digest of the bytes it wrote,
the moment the write began, and which reported file the source is (`user`,
`project`, or Claude's `local` — the `projects[<worktree>]` map in
`~/.claude.json`, proven by the user digest only when the query's scope was
`all`).

A runtime becomes `applied` when all of these hold:

1. the bridge reports a digest for that file, read at or after the write began;
2. that digest equals the saved bytes' digest, **or** equals the file as it is
   now and the saved change (by keyed entry digest, or absence for a removal,
   or new-name-present/old-name-absent for a rename) is still in it — needed
   because Claude rewrites `~/.claude.json` for unrelated bookkeeping;
3. Grok only: the bridge process id differs from the one recorded when apply
   was planned. Grok's evidence is whichever child reported last, so only a
   replaced bridge guarantees no session still holds a pre-save child.

An older bridge without the field, a failed or timed-out read, `absent` /
`excluded`, or a read that predates the save all leave the planned state
untouched and are not errors. Only local runtimes are polled (containers and
coordinators never read the saved host file), and never Codex or OpenCode.
Reads go through `NativeAgentService.mcpConfigEvidenceIfRunning`: persisted
mapping → provider resolved like the activity sweep (never starts a bridge) →
the runtime-health route, which touches no liveness and re-attaches nothing.
Polling is bounded: at most 8 reads per tick, each runtime at most every 10 s,
each read capped at 10 s, and none 24 h after apply was planned — the runtime
keeps its planned state and the scheduler goes idle once no queued or
evidence work remains.

The digests are unkeyed hashes of files that can hold low-entropy secrets, so
they stay backend-only: `bridgeRuntimeSummary` (the renderer-facing runtime
health) never copies `mcpConfig`, and the saved digest lives only in
`operations.json`'s recovery half, never in an operation snapshot or event.

The scheduler runs on a timer, never on a request or event path; every
detached promise handles its rejection. Operation state survives backend
restart; an in-flight Codex reload is re-queued (reload is idempotent). A newer
apply for the same target cancels older queued work ("superseded").
`cancel_mcp_apply` cancels queued work and never touches the saved file.

## Rollout switch

`global.mcpManagement` in the backend config is
`{ enabled, writeProviders, applyProviders }`; absent means everything enabled.
`set_mcp_management_rollout` replaces it atomically and a settings save that
omits the key keeps it. When management is off, or a provider is outside
`writeProviders` / `applyProviders`:

- mutations and previews (writes) or apply (apply) are refused with
  `management-disabled`; save-and-apply with apply off saves and leaves apply
  `not-requested`;
- target capabilities carry `rollout.write` / `rollout.apply` with the reason,
  rows become read-only, and the UI disables Add/Review and hides apply actions;
- the scheduler skips the provider and queued runtimes are `cancelled` with the
  reason, also at startup;
- saved provider files are never touched.

The shipped default (everything on) is a release decision; turning a provider
off is the operational rollback.

## Crash recovery and idempotency

A request id is bound to a keyed fingerprint of the mutation: a retry after a
lost response replays the stored result (a retry that arrives while the original
is still writing waits for it under the file lock); the same id with a different
mutation is `request-conflict`. A stored failure is replayed for its id, so the
editor mints a new id after any structured error. On startup, an operation left `pending` is reconciled
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
After a save `targetIds` names the saving target and every target that reads the
file (other providers sharing it, and every environment for a user file); past
256 ids it is `[]`, meaning all. The live agent info panel re-reads its
projection on this event while it is open.
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
| Service | `service.test.ts`, `service-providers.test.ts`, `service-pi.test.ts`, `service-grok.test.ts`, `service-sources.test.ts`, `service-transport-fields.test.ts`, `service-rename.test.ts`, `service-limits.test.ts`, `service-rollout.test.ts`, `service-apply.test.ts`, `service-apply-scope.test.ts`, `operations-store.test.ts`, `providers.test.ts`, `references.test.ts` — add/update/rename/remove for all six providers in user and project scope, custom homes, two worktrees, shadowing and fallback, Pi skip/collision rules, Grok compat/trust, secret absence (including `operations.json` and logs), idempotency, recovery, limits, rollout gate, Codex queue, supersession, coordinator and deleted-environment runtimes, container catalog |
| Evidence | `service-evidence.test.ts` (per-provider applied/not-applied rules, bounds, idleness, digest privacy), `http-bridge-mcp-config-evidence.test.ts` (bridge shapes, renderer summary excludes digests), `native-agent-service-provider.test.ts` (no bridge start) |
| Commands | `commands-registry-mcp.test.ts` (correlation ids, rollout commands, reload probe), `http-bridge-mcp-reload.test.ts`, `storage-config-mcp-rollout.test.ts`, `tests/unit/electron/gateway-base.test.ts` (body cap) |
| Bridges | Pi `mcp.test.ts`, `mcp-lifecycle.test.ts`, `agent-session.test.ts`, `http.test.ts`; Cursor `agent-session.test.ts`, `agent-session-mcp-reattach.test.ts`, `http.test.ts`, `persistence.test.ts`; Claude `mcp-config-scope.test.ts`, `session-manager-prompt-mcp.test.ts`, `runtime-health-body.test.ts`; ACP `acp-mcp-inventory.test.ts`; Codex `mcp-reload-route.test.ts`, `process-supervisor.test.ts` |
| UI | `mcp-draft.test.ts`, `mcp-local-validation.test.ts`, `ProviderMcpSettings.test.tsx`, `McpEditorFlows.test.tsx`, `McpEntryFlows.test.tsx`, `McpStatusAndStates.test.tsx`, `AgentInfoMcpSection.test.tsx`, `FullscreenSettingsLayout.test.tsx`, `ActionBar.test.tsx` — focus return, keyboard-only flows, conflict reload, discard prompt, rollout gate, empty/offline/partial states |
| Container reader | Manual smoke against a throwaway container: ok, absent, oversized, offline, shell-metacharacter path |
| Real browser | 2026-09-24, `dev:test` profile `agent-mcp-settings-qa` with the fixture project, Playwright at 1440×900 and 390×844: section and pickers for all six platforms, Control MCP kept separate, add → edit → rename → remove of a Claude project-scope server in a fixture worktree (previews named the worktree path and the execution warning; the file ended `{"mcpServers": {}}`), keyboard open/Escape with focus return, reload rehydration, discard prompt on a dirty target switch, platform-settings deep link. Found that every MCP dialog rendered behind the fullscreen settings layer (default `z-50` under `z-[60]`); fixed with the fullscreen dialog layers and pinned by `McpEditorFlows.test.tsx`; the fix was confirmed in that browser session by raising the layer, not by a second full pass. The agent-panel link was not exercised (no live session in the fixture). Operator MCP files were hashed before and after and were unchanged. |

Not yet verified (plan steps 01 and 14): live probes against the pinned vendor
binaries — that Codex's reload changes an existing thread's tools at its next
turn, OpenCode/Grok pick changes up on restart, Cursor's SDK re-reads
`~/.cursor/mcp.json` on resume, and that removed servers' tools are gone after
apply — plus real-browser, inactive-environment and container QA. Until those
are recorded, treat `pending-next-turn` / `restart-required` as the backend's
plan; `applied` is observed adoption per the evidence rule above.

## Rollback

Set `global.mcpManagement.enabled = false` (or remove a provider from
`writeProviders` / `applyProviders`) to stop mutations and scheduling without a
code change; queued work is retired with an explicit `cancelled` state. Saved
native files keep working with every provider. The two private files under
`<dataDir>/mcp-management/` can be deleted; operation history is then lost and
revisions change, which only forces a reload in open editors.
