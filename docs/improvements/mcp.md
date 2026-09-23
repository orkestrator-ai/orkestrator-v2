# Per-provider MCP server management

Investigation date: 2026-09-21. Repository baseline: `88c2f9cc`.
Status: proposal; no application implementation changes made.

Implementation plan: [index and delivery order](mcp/plan/00-index.md).

## Recommendation

Add a backend-owned MCP configuration service with a provider-specific adapter
for each of Claude Code, Codex, OpenCode, Cursor, Grok Build, and Pi. Give users
one editor, but preserve each provider's configuration format, source precedence,
execution policy, and runtime apply behavior. Do not implement add/edit/remove as
extra buttons calling the existing session connection actions: those actions do
not provide persistent configuration management.

The minimum useful product supports adding, editing, renaming, and removing an
individual server without starting a conversation. It shows the selected backend,
provider, configuration destination, and affected environments before saving.
It distinguishes **saved configuration**, **configuration applied to a runtime**,
and **connection health**. A successful file write must not become a misleading
“Connected” notification.

Use native configuration files as the authority for user and project scopes.
For environment-private container settings, keep an explicitly owned, durable
backend overlay and materialize it into the container; current copied homes are
not a durable configuration store. Keep application-owned MCP connections out of
editable configuration and out of persistence entirely.

“Provider” here means an Orkestrator agent platform, not an underlying model
vendor. Pi and OpenCode can each use several model vendors while sharing their
platform's MCP setup.

## Investigation method and limits

This report traces the checked-in protocol, backend command path, UI, launchers,
five bridges, container bootstrap, and existing plans. Relevant upstream APIs
were checked with Context7 and official provider documentation. No production
configuration was read or changed; no provider processes or MCP servers were
launched, and no dependency installation was needed.

Repository facts below describe the inspected commit. Upstream capabilities are
separately attributed and are not a claim that every one works through our pinned
integration. Live compatibility probes are the first implementation step.

The pinned baseline is:

| Platform | Repository integration/version |
| --- | --- |
| Claude | Agent SDK `0.3.276`; CLI `2.1.276` |
| Codex | CLI/app-server `0.155.0`; committed generated protocol |
| OpenCode | SDK and CLI `1.18.31`; production imports `/v2/client` |
| Cursor | `@cursor/sdk` `1.0.31` |
| Grok | Grok Build `1.0.34`; ACP SDK `1.4.0` |
| Pi | SDK and CLI `0.85.1` |

Sources: bridge `package.json` files, [backend manifest](../../apps/backend/package.json),
and [Dockerfile](../../docker/Dockerfile). See also the
[six-engine architecture](../architecture/agent-engines.md).

## What already exists

### Three different MCP surfaces

1. **Orkestrator as an MCP server.**
   [McpSettings.tsx](../../apps/web/src/components/settings/McpSettings.tsx)
   displays the local Control MCP address, token, rotation, and setup recipes.
   Its title is “Control Orkestrator from another agent.” This is inbound access
   to Orkestrator, not an editor for servers used by a provider.
2. **Provider runtime inventory and connection actions.**
   [NativeAgentMcpServer](../../packages/protocol/src/native-agent.ts) contains
   status, optional scope/transport, tool names/count, error, and advertised
   actions. The action union is `reconnect | enable | disable | sign-in`.
   There are no editable definitions, source revisions, add/remove operations,
   or persistent mutation results.
3. **Pre-session extension discovery.**
   [extension-discovery.ts](../../apps/backend/src/core/extension-discovery.ts)
   uses provider-specific CLI discovery and parsers. Cursor and Pi have limited
   pre-session MCP discovery. Discovery is cached because commands such as
   Claude's MCP listing can actually start configured servers. Opening an editor
   must not reuse a health-checking command as if it were passive file reading.

The existing shared runtime UI is `McpServersPanel` in
[AgentInfoButton.panels.tsx](../../apps/web/src/components/layout/AgentInfoButton.panels.tsx),
wired by [AgentInfoButton.tsx](../../apps/web/src/components/layout/AgentInfoButton.tsx).
Its list is useful for status, but cannot identify which of several same-name
configuration entries should be edited or removed.

### Existing request path

```text
AgentInfoButton / McpServersPanel
  -> performNativeAgentMcpAction (web backend/workflows.ts)
  -> perform_native_agent_mcp_action (commands-registry-native.ts)
  -> NativeAgentService.performProjectionMcpAction
  -> NativeAgentRuntimeProvider.mcpServerAction
  -> bridge session route OR OpenCode SDK
  -> projection invalidation
```

The backend interfaces live in
[agent-provider-contract.ts](../../apps/backend/src/core/agent-provider-contract.ts).
[http-bridge-catalog.ts](../../apps/backend/src/core/http-bridge-catalog.ts)
adapts `GET /session/:id/mcp` and the session action routes. Its inventory fallback
maps 404 to an empty list. New management capability discovery must distinguish
an older bridge from a supported provider with no configured servers.

[native-agent-service-projection.ts](../../apps/backend/src/core/native-agent-service-projection.ts)
already carries normalized inventory into snapshots.
[native-agent-service-dispatch.ts](../../apps/backend/src/core/native-agent-service-dispatch.ts)
currently invalidates the selected projection after an action. Persistent user
configuration can affect many environments, so management requires wider,
target-aware invalidation.

### Existing plan is related, but not this feature

[SDK coverage step 07](../plans/sdk-coverage/07-mcp-inventory-and-management.md)
explicitly excludes editing configuration files. Its introduction and checkboxes
also lag the code: shared runtime inventory and several actions already exist.
Use it for historical context, not as evidence that lifecycle controls still
need to be invented.

## Provider capability assessment

“Possible” in the last column describes a proposed implementation, not a shipped
Orkestrator feature.

| Platform | Current input path | Current Orkestrator actions | Persistent CRUD and application path |
| --- | --- | --- | --- |
| Claude | Merged JSON files passed to each SDK query | Reconnect, enable/disable, sign-in via reconnect | Possible with scoped JSON edits; next query naturally reloads; runtime replacement is an optional optimization |
| Codex | Native TOML plus trusted launch/thread overrides | Inventory, OAuth, process-level MCP reload | Possible through versioned config writes and reload; confirm deletion and override behavior |
| OpenCode | Native layered config plus runtime `POST /mcp` injection | Connect/disconnect and OAuth start | Possible with source-aware persistence plus directory-scoped reconciliation; disconnect alone is not removal |
| Cursor | SDK settings sources and inline server definitions | Observed inventory; no management actions | Possible with JSON edits and verified per-send overrides or idle reattach |
| Grok | Native config plus ACP launch-time Orkestrator injection | Vendor inventory; no management actions | Possible with TOML edits and validated ACP reload/resume; do not invent a generic ACP mutation method |
| Pi | Bridge reads MCP JSON and owns clients/tools | Live inventory; no management actions | Possible with JSON edits and safe bridge tool/client rebuild between turns |

### Claude Code

Repository evidence:
[mcp-config.ts](../../bridges/claude-bridge/src/services/mcp-config.ts),
[session-manager-catalog.ts](../../bridges/claude-bridge/src/services/session-manager-catalog.ts),
[session-manager-prompt.ts](../../bridges/claude-bridge/src/services/session-manager-prompt.ts),
and [claude-home.ts](../../bridges/claude-bridge/src/services/claude-home.ts).

- The resolver reads global `~/.claude.json.mcpServers`, that file's
  `projects[cwd].mcpServers`, and project `.mcp.json.mcpServers`.
- Its explicit merge gives `.mcp.json` priority over the per-project entry in
  `~/.claude.json`. This is an existing behavior to verify against the pinned CLI,
  not a precedence rule to copy into a new universal model.
- The files are re-resolved for each query. `projectResources: false` excludes
  project sources. Trusted `orkestrator` and optional `orkestrator-design`
  connections are injected after file configuration.
- Conversion currently handles stdio and HTTP definitions; the declared SDK
  union includes SSE, but `configToSdkFormat` does not translate SSE entries.
  Unknown options cannot safely round-trip through this lossy runtime mapper.
- Live inventory uses `mcpServerStatus`; reads avoid a draining query and can use
  cached inventory. The action path instead uses `session.queryControl` or a
  temporary probe and optional SDK method calls. A successful action on a probe
  is not proof that a saved definition changed or the real session adopted it.
- `claudeJsonPath()` derives from `homedir()`/its test override, whereas launch
  paths elsewhere also use `CLAUDE_CONFIG_DIR`. Resolve the actual runtime home
  consistently before adding writes.

Upstream documents user, project, and private local MCP scopes; local scope is
stored under the project path in `~/.claude.json`. Its published precedence must
be compared with our manual merge. The SDK exposes `setMcpServers` as a runtime
replacement operation with per-server results, alongside reconnect and toggle;
replacement must retain required injected entries and respect plugin behavior.
These calls are not a persistence API.
Sources: [Claude MCP reference](https://code.claude.com/docs/en/mcp) and
[Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript).

Recommended first implementation: preserve native source entries with bounded,
conflict-checked edits; apply on the next query. Expose immediate replacement only
after proving its behavior on this SDK and fixing the draining-control boundary.

### Codex

Repository evidence:
[app-server-engine.ts](../../bridges/codex-bridge/src/engine/app-server-engine.ts),
[app-server-runtime-sessions.ts](../../bridges/codex-bridge/src/app-server-runtime-sessions.ts),
[codex-config.ts](../../bridges/codex-bridge/src/codex-config.ts), and generated
[ConfigBatchWriteParams](../../bridges/codex-bridge/src/app-server/generated/typescript/v2/ConfigBatchWriteParams.ts),
[ConfigEdit](../../bridges/codex-bridge/src/app-server/generated/typescript/v2/ConfigEdit.ts),
[ConfigReadResponse](../../bridges/codex-bridge/src/app-server/generated/typescript/v2/ConfigReadResponse.ts).

- One app-server child serves an environment's threads. Inventory passes a
  loaded thread id when available and avoids attaching an idle thread just to
  read status.
- `reconnectMcpServers()` invokes `config/mcpServer/reload` with no server id.
  The existing per-row “reconnect” is therefore broader than that row.
- Generated config writes include `filePath`, `expectedVersion`, edits with
  `replace | upsert`, and `reloadUserConfig`. Those are strong foundations for
  scoped writes with conflict detection, but do not themselves prove how a
  server entry is deleted. Do not assume assigning `null` deletes a TOML table.
- `listMcpServers` currently asks for one page of 100. A management catalog must
  not mistake that for a complete source catalog or use it to replace all config.
- Trusted launch overrides reference ephemeral credentials. Editing the user
  TOML cannot be allowed to overwrite those connections or accidentally persist
  their tokens.

Official documentation confirms disk configuration writes, MCP reload, paginated
status and OAuth. User MCP definitions use `mcp_servers` in `config.toml`; plugin
servers have separate ownership. The fetched Context7 result included newer
method names inconsistent with our generated contract and an overbroad claim
that configuration was CLI-only. The committed protocol and opened official
app-server reference take precedence for this implementation.
Sources: [Codex app-server](https://developers.openai.com/codex/app-server) and
[Codex MCP configuration](https://developers.openai.com/codex/mcp).

Recommended first implementation: a narrow config-management surface through the
engine for live app-server targets; a safe native-file adapter for stopped
targets if required. Explicitly report reload queued versus observed application
to each thread. Never restart the shared child during an active turn to apply an
MCP edit.

### OpenCode

Repository evidence:
[opencode-capabilities.ts](../../apps/backend/src/core/opencode-capabilities.ts),
[opencode-provider.ts](../../apps/backend/src/core/opencode-provider.ts), and
`configureOpenCodeAgentTools` in
[commands-servers.ts](../../apps/backend/src/core/commands-servers.ts).

- There is no OpenCode bridge; the backend calls SDK v2 directly.
- Current enable/reconnect calls `mcp.connect`, disable calls `mcp.disconnect`,
  and sign-in calls `mcp.auth.start`. No current action writes a saved definition.
- The backend already injects `orkestrator` with a directory-scoped `POST /mcp`,
  including an ephemeral bearer and `oauth: false`. Any reload or config refresh
  must restore that runtime-only entry without persisting it.
- The provider handles `mcp.tools.changed` and refreshes inventory. Config
  changes can affect more than one session in the same OpenCode directory.
- Current normalization largely conveys status, with limited source provenance;
  it bounds error strings but that alone is not credential redaction.

Published config uses an `mcp` map, local command arrays, remote URLs/headers, and
an `enabled` setting. JSON/JSONC configuration is layered, including user,
project, custom-path and inline inputs. OAuth belongs to OpenCode's authentication
machinery. Context7 also returned future API v2 design material; those endpoints
must not be confused with the repository's `/v2/client` import and production
server API.
Sources: [MCP configuration](https://opencode.ai/docs/mcp-servers/) and
[configuration locations](https://opencode.ai/docs/config/).

Recommended first implementation: edit the correct native source with comments
and unknown keys preserved, then reconcile at a safe boundary. Probe `mcp.add`,
config update, disconnect, deletion, and process restart semantics before picking
a reload mechanism. Never use a broad config reset without accounting for all
active sessions and the injected Orkestrator server.

### Cursor

Repository evidence:
[mcp.ts](../../bridges/cursor-bridge/src/mcp.ts),
[agent-session.ts](../../bridges/cursor-bridge/src/agent-session.ts), and
[http.ts](../../bridges/cursor-bridge/src/http.ts).

- Ordinary sessions enable user settings; allowed container sessions also enable
  project/team/plugin settings. `.cursor/mcp.json` is explicitly parsed only
  when both process and session policy allow project resources.
- Inline launch configuration adds the trusted Orkestrator server last. The
  parser accepts stdio, HTTP and SSE; it drops fields outside its known subset.
- Inventory is reconstructed from configured names, system tool lists, and
  observed tool calls. It is not a configuration catalog and cannot reliably
  prove a current connection merely because a tool was used earlier.
- Read-only coordinators have a special hosted-tool path and excluded settings
  sources. A generic “reload all MCP” must not broaden this policy.
- The current bridge attaches SDK agents with MCP options but exposes no MCP
  mutation route. Credential rotation already has detach/reattach machinery.

Current SDK documentation describes user/project files and both creation-time and
per-send `mcpServers`. Per-send definitions replace creation-time inline
definitions for that run; inherited file sources still matter. Local OAuth cannot
prompt for a new login and relies on prior Cursor authorization. Verify these
claims against `1.0.31` before selecting the runtime apply path.
Source: [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript).

Recommended first implementation: source-aware JSON management; prefer next-send
overrides if pinned behavior permits complete replacement/removal. Otherwise
reattach an idle session while preserving its vendor conversation identity.
Do not claim full health or in-app OAuth support from observed tool names.

### Grok Build / ACP

Repository evidence:
[acp-context.ts](../../bridges/acp-bridge/src/acp-context.ts),
[acp-session.ts](../../bridges/acp-bridge/src/acp-session.ts),
[acp-tools.ts](../../bridges/acp-bridge/src/acp-tools.ts), and
[acp-persistence.ts](../../bridges/acp-bridge/src/acp-persistence.ts).

- `configuredAcpMcpServers()` constructs only the injected Orkestrator HTTP
  entry; it is not a parser for the user's full Grok configuration.
- ACP new/load/resume-related paths pass this launch list. Inventory uses vendor
  `*/mcp/servers_updated` notifications and currently stores it in shared
  `agentRuntime`. Per-session configuration requires care to prevent one
  session's list being reported for another.
- The current mapper labels listed entries connected and exposes no actions.
  It does not establish persistent source ownership or a supported hot-reload API.

Grok documents user/project `config.toml` MCP tables and CLI add/remove commands.
It also imports Claude/Cursor-compatible configuration at lower priority. Thus
changing a shared compatibility file can affect Grok even when the user selected
Claude or Cursor. Native Grok writes avoid that ambiguity for new entries. ACP
defines MCP launch configuration and transport capability negotiation; this is
not evidence for a standard live add/remove method.
Sources: [Grok MCP](https://docs.x.ai/build/features/mcp-servers),
[Grok settings](https://docs.x.ai/build/settings), and
[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).

Recommended first implementation: native Grok source editing, compatibility
origins shown explicitly, next-safe-load application. Verify the pinned binary's
merge and removal behavior before advertising an immediate action. Keep the
existing trusted wire shape working; do not replace it mechanically with a
different ACP version's header representation.

### Pi

Repository evidence:
[mcp-config.ts](../../bridges/pi-bridge/src/mcp-config.ts),
[mcp.ts](../../bridges/pi-bridge/src/mcp.ts),
[agent-session.ts](../../bridges/pi-bridge/src/agent-session.ts), and
[http.ts](../../bridges/pi-bridge/src/http.ts).

- Pi's vendor SDK is not the MCP client here. The bridge reads
  `<agentDir>/mcp.json` and, when trusted, `<cwd>/.pi/mcp.json`, then constructs
  clients and registers tools through an inline extension.
- Project entries override user entries; the injected Orkestrator entry is
  protected and capacity is reserved for it. Existing bounds include 1 MiB
  source files and 64 resolved servers.
- Disabled entries are skipped by runtime parsing. They still need to appear in
  a configuration editor. Names are sanitized, so distinct authored names can
  collide after normalization; the editor must reject ambiguous writes.
- A declared SSE input is normalized to HTTP. Do not advertise a real SSE client
  without adding and validating that transport.
- Runtime refresh identity currently tracks the Orkestrator connection, not
  arbitrary user configuration revisions. Updating a file alone cannot guarantee
  an already-attached session rebuilds its extension or removes an old tool.
- Pi runtime rows expose no lifecycle actions. OAuth is not implemented by this
  MCP client; account/provider login is a separate feature.

Recommended first implementation: native JSON source management plus a
revision-aware, between-turn rebuild of MCP clients and the Pi extension. Preserve
the session file, enforce generation ownership on late connects, and ensure a
removed tool cannot still be invoked from the old registry.

## Environment and persistence findings

The management target must be more precise than `{ provider, serverName }`.
It needs backend identity, execution location, provider, scope, source identity,
and, where relevant, environment and project/worktree identity.

[commands-containers.ts](../../apps/backend/src/core/commands-containers.ts)
mounts portable provider inputs read-only at staging paths.
[entrypoint.sh](../../docker/entrypoint.sh) copies selected inputs into writable
container homes. Consequences:

- A backend-user change is not automatically live in existing containers.
- A container-home change must not be written through to the host staging mount.
- Container edits can be overwritten by bootstrap or lost on recreation unless
  they have a separate durable owner and reconciliation policy.
- Pi's copy allowlist currently omits `agent/mcp.json`, despite the bridge reading
  it. This is a concrete delivery gap for host Pi MCP configuration.
- This bootstrap has no equivalent Cursor MCP home copy section. Do not promise
  host Cursor user-MCP propagation without adding and testing a deliberate path.
- Claude filters its copied global JSON; Grok imports only selected files.
  Copying an entire home to solve MCP delivery would also copy unrelated state.

For local worktrees, a provider's user config may be shared by many environments
and by an external terminal or IDE. “User scope” means the user on the selected
backend machine, not necessarily the person at the browser. Project scope refers
to the selected worktree's real file; it is not automatically the parent checkout
or every sibling worktree.

Native-mode and terminal-mode application must be reported separately. Saving a
native file can benefit future CLI launches without controlling an existing tmux
session. Pi's bridge-specific MCP file does not by itself give terminal Pi an MCP
client. Cursor has no managed terminal mode in this repository.

## Proposed product behavior

Use a provider-management view reachable from provider settings and the live MCP
panel. Keep Control MCP setup recognizable as a separate function. A target picker
should offer only scopes the selected adapter can actually read and write:

- **Backend user:** provider-native file on the selected backend; shared impact.
- **Project:** provider-native file in the selected worktree; potentially tracked
  in Git; project trust restrictions still apply.
- **Claude private local:** provider-native per-project entry in private user
  JSON; not synonymous with project scope.
- **This environment:** durable backend-owned container configuration overlay;
  available after the container delivery step is implemented.

Show source entries independently from their effective runtime row. A same-name
lower-priority entry remains discoverable as “overridden.” Removing the winning
entry should preview any entry that will become effective. Plugin, policy-managed,
and Orkestrator-owned definitions are read-only in the server editor.

The form uses explicit transport selection, executable plus argument list for
stdio, URL for remote servers, optional environment/header inputs, and supported
provider-specific advanced fields. Preserve unknown existing fields; do not expose
a universal arbitrary-config write endpoint. A rename is one conflict-checked
operation, never a visible half-completed remove then add.

Existing secrets return only presence metadata. Edits express keep, replace, or
clear; a masked placeholder is never a value. Do not store secrets in renderer
preferences, localStorage, events, diagnostics, or transcripts. Use provider-native
private storage and environment references; a cross-provider credential vault is
not a prerequisite. Project files should default to references and must not
silently gain literal secrets.

Save reports the stored revision and an application result per affected runtime:
applied, pending next turn, pending reattach/restart, policy-blocked, failed, or
unknown/reconciling. Connection failure leaves a valid saved definition editable.
Save and apply is an explicit action because starting stdio runs a process and
connecting to a remote server performs network activity. Passive listing and
form validation do neither.

## Architecture and failure handling

Separate four responsibilities:

1. **Catalog and target resolution:** passive reads, actual paths, provenance,
   capabilities, shadowing, writable scope, source revision.
2. **Persistence:** bounded parsing, minimal native edits, preservation of unknown
   fields/comments, conflict detection, atomic replacement, private permissions.
3. **Runtime reconciliation:** backend-owned operation state, application at safe
   boundaries, affected-session tracking, authoritative status snapshots.
4. **Presentation:** editor drafts and actions; rehydrate catalog and operations
   after navigation or reconnect.

Use a separate management contract alongside the current runtime inventory.
Include expected revision and request id on writes. Lock by actual backing source
file, not only provider: Claude local and user entries share one file, and Grok
compatibility sources can be cross-provider dependencies. External editor changes
must produce conflict/reload behavior instead of lost updates.

Persistence and runtime application are separate commits. A failed connection or
ambiguous bridge response does not undo a successful save or justify resending a
prompt. Reconcile against the stored revision and provider generation. Never
auto-approve an MCP elicitation or approval to complete configuration work.

Protect all internally owned names and owners, including `orkestrator`,
`orkestrator-design`, and `orkestrator_workflow_result`. The last is declared in
[workflow-results.ts](../../packages/protocol/src/workflow-results.ts).
Do not rely on scope labels alone: some existing normalization loses provenance.
Preserve per-tab/per-attempt credentials when forming replacement launch sets.

No runtime reload may interrupt background work because its React view unmounted.
Operations, revisions and pending apply state belong in backend/persistent state;
events only signal that a new snapshot exists. Keep read paths from extending idle
thread liveness. Bound file sizes, catalogs, operations, retries and responses;
truncation must be explicit and cannot authorize replacing a complete catalog.

## Alternatives considered

| Approach | Benefit | Problem | Decision |
| --- | --- | --- | --- |
| Shell out to provider CLI for every edit | Familiar provider semantics | Different scopes/flags, partial edits, subprocess output and secret exposure; no Pi equivalent | Use only a pinned, bounded adapter operation where it demonstrably helps |
| One global Orkestrator registry replacing all provider configs | Uniform UI/schema | Breaks native tools, duplicates sources and authentication, needs overriding every provider's inheritance | Do not make this the default authority |
| Raw native-file editor only | Quick route to saved config | Poor source identity, validation, conflict handling, secret handling and apply feedback | Optional future advanced view, not the primary workflow |
| Provider-native persistence with shared management contract | Fits existing engines and external tools | More adapter work; explicit per-provider differences required | Recommended |

## Implementation risks to close first

1. Prove exact write/delete and apply semantics for pinned versions; a runtime
   disconnect is not persistent deletion.
2. Resolve source precedence, especially Claude's manual merge and Grok's
   compatibility imports. Do not silently change precedence as incidental cleanup.
3. Verify Cursor per-send replacement/removal and SDK resume behavior.
4. Determine OpenCode's safe config-reload blast radius and OAuth completion path.
5. Establish a durable container overlay and an explicit reconciliation policy
   for external edits versus copied defaults.
6. Preserve protected MCP connections and coordinator/review policies across
   every launch, resume, next-turn apply and restart path.
7. Verify transport-specific validation and truthful statuses; unsupported modes
   must remain visible but cannot silently be rewritten to another transport.

These are bounded implementation investigations, not reasons to defer all useful
work. The plan starts with compatibility evidence, then builds contracts,
persistence and reconciliation before wiring six adapters and the UI.

## Definition of success

A user can select a provider and destination, add a server, edit it without losing
advanced configuration or secrets, remove it without erasing unrelated settings,
and understand when affected sessions adopt the result. Conflicts are recoverable.
Changes survive the documented restart/recreation boundary. Reloading the UI or
switching environments during application produces the same authoritative result.
Unsupported runtime operations are explained, and all six providers have verified
add/edit/remove coverage rather than an identical but misleading set of buttons.
