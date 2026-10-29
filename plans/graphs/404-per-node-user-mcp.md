---
id: 404
title: "Per-node user MCP servers"
phase: 4
plan: "Phase 4"
status: in-progress
depends_on: [106, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 404 · Per-node user MCP servers

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D12
- **Depends on:** [106](106-capability-profiles.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A node can be given specific user MCP servers, not just denied them.

## Work

- [x] Write the design note in this file's Notes (written and built on 2026-10-29).
- [ ] Get the design note agreed by the user. (The user was asked how to handle Phase 4 design notes on 2026-10-29; the question timed out unanswered, and the coordinator proceeded on its recommended option — write the note, build, and have the user review the note in the pull request. Agreement is still pending.)
- [x] Per-session injection of user MCP servers in each bridge (Claude, Codex, OpenCode, Cursor, Grok, Pi), split:
  - [x] Claude: filtered inline set, `strictMcpConfig`, read-only turns keep the grant.
  - [x] Codex: per-thread `mcp_servers.<name>.enabled = false` from `config/read`.
  - [x] Pi: the bridge's MCP client starts only granted servers; read-only gate admits them.
  - [x] OpenCode: per-session permission rules over the shared instance's servers.
  - [x] Cursor: no settings sources, granted servers inline (ordinary turns; read-only gap in Notes).
  - [x] ~~Grok~~ (not possible: Grok loads every server in its own configuration and ACP can only add servers; documented as a gap in Notes, graphs.md and agent-engines.md, compiler warns).
- [x] `mcp:<server>` grants as well as denies.
- [x] Compiler: `capability-mcp-grant` is a warning per provider that cannot deliver the grant; new `capability-mcp-grant-read-only`; enforcement matrix gains the user-MCP selection axis.
- [x] Designer: the capabilities form (212) grants or denies servers from the user's configured list.
- [x] Docs: `docs/architecture/graphs.md`, `agent-engines.md`, `mcp-management.md`.

## Tests

- [x] Per-provider tests that a granted server is present and an ungranted one absent.

## Done when

- [x] Per-node MCP servers ship on every provider that supports them, with gaps documented.

## Notes

**2026-10-29 · Design note (written first, per the user's standing Phase 4
instruction: design, then build; reviewed in the pull request).**

*Where user MCP servers come from today.* Each provider's own configuration
files, which the Settings "MCP servers" section reads and edits
(`apps/backend/src/core/commands-registry-mcp.ts`, `mcp-management/`;
[mcp-management.md](../../docs/architecture/mcp-management.md) has the source
table): Claude `~/.claude.json` (+ private-local and `.mcp.json` with project
resources), Codex `$CODEX_HOME/config.toml` (+ trusted project config), OpenCode
user/project `opencode.json(c)`, Cursor `~/.cursor/mcp.json` (+ project), Grok
`$GROK_HOME/config.toml` (+ compatibility imports), Pi `~/.pi/agent/mcp.json`
(+ project). Every bridge loads that whole set into every session; only the
reserved Orkestrator servers (`agentMcp`) are attached per session.

*Wire form.* A new optional field on the execution policy,
`capabilityPolicy.userMcpServers?: string[]`: the configured (user or, with
project resources, project) MCP servers the session may load, exactly these
names; `[]` means none; absent keeps today's behaviour (every configured
server, minus `mcp:<server>` denials). At most 32 names, each matching the
`mcp:<server>` grammar. It never carries a server definition: the bridge
filters the set it already loads from the user's own files, so a template can
only *select* a server the user configured, never add one or change its
command, URL, env or headers. Reserved Orkestrator servers are not user
servers and are never filtered. Older bridges ignore the field (their
validators ignore unknown `capabilityPolicy` keys), so on them the session
keeps every configured server; the matrix rates that as it does any older
bridge (106's rule). Helpers: `nativeAgentUserMcpGrant(policy)` (the list
minus denied servers) and `nativeAgentAllowsUserMcpServer(policy, name)`.

*Policy.* `mcp:<server>` in a node's `allow` **grants** that server for the
node's session; `deny` removes it (and wins over a grant); a ceiling or
environment denial of `mcp:<server>` removes it too (it lands in
`removedByCeiling`/`removedByEnvironment`). Every compiled graph policy carries
`userMcpServers` (sorted grants, default `[]`), so **graph nodes get no user
servers by default**. `CompiledGraphCapabilities.mcpServers` lists the grants.
Credentials stay in the provider files and bridge processes; nothing new is
logged (names only, as today).

*Per provider* (`NATIVE_AGENT_USER_MCP_SELECTION`):

| Provider | How the session gets exactly the subset | Turns | MCP axis tier |
| --- | --- | --- | --- |
| Claude | Inline `mcpServers` filtered to the grant, plus `strictMcpConfig: true` so the CLI loads no MCP file itself (and no plugin MCP server); granted servers' tools join `allowedTools`, and on a read-only turn the read-only hook admits their prefixes | ordinary and read-only | provider-configured |
| Codex | Per-thread config: `config/read` lists the effective `mcp_servers`, and every configured server outside the grant gets `mcp_servers.<name>.enabled = false` on `thread/start`, `thread/resume` and `thread/fork`; granted servers get `default_tools_approval_mode = "approve"` unless the policy asks. A thread whose policy changes must go through `reloadThread` (resume ignores overrides on a loaded thread); graph sessions are fresh per activation, so their config is set once. A server name that is not a bare TOML key cannot be disabled reliably, so the thread is refused | ordinary and read-only | provider-configured |
| Pi | The bridge's own MCP client connects only to granted file servers (`resolvePiMcpServers` filter), so nothing else is registered through the `orkestrator-mcp` extension; the read-only gate admits granted servers' tools by exact registered name | ordinary and read-only | enforced |
| Cursor | A restricted session drops the `user`/`project`/`team`/`plugins` setting sources (the SDK would otherwise load every server itself) and passes the granted servers inline from `~/.cursor/mcp.json` (+ `.cursor/mcp.json` with project resources). Gap: user rules and plugins do not load for such a session. Read-only attaches keep loading only Orkestrator's entries, so grants are not delivered there | ordinary only | provider-configured |
| OpenCode | One shared `opencode serve` per directory, so servers cannot be attached per session. The session's permission rules deny `<server>_*` for every server `mcp.status` lists outside the grant (fail closed when it cannot be read); rules are re-applied when the listed set changes. The processes still run | ordinary and read-only | provider-configured |
| Grok | Gap: Grok loads every server in its own configuration and ACP `session/new` can only add servers | none | advisory |

*Compiler.* 106's `capability-mcp-grant` error becomes a **warning per enabled
provider that cannot deliver the grant** (Grok always, Cursor for a read-only
node), detail `<capability>`, message naming the provider. A new warning
`capability-mcp-grant-read-only` says a granted server on a read-only node runs
outside the read-only boundary (a stdio server is a local program with the
user's rights); the post-hoc workspace guard still checks the workspace. The
MCP axis stays secondary (it does not lower the overall tier) and appears on
every policy that sets `userMcpServers` or denies a server.

*Designer.* 212's capabilities form gains an "MCP servers" section: the
servers the user configured (read from the existing MCP management snapshot
commands, user-scope sources only, names only), each grantable or deniable;
names already in the spec but not configured stay listed as "not configured".

*Alternatives rejected.* Backend reads the server definitions and sends them
to the bridge (rejected: secrets on the wire, and a template could then point
at definitions the user never configured); per-tool deny lists only (rejected:
cannot express "none by default" for servers the template does not know).

**2026-10-29 · Implementation facts.**
- Protocol (`native-agent-capabilities.ts`, re-exported from `@orkestrator/protocol/native-agent`):
  `capabilityPolicy.userMcpServers?: string[]` (validated by `isNativeAgentExecutionPolicy`
  through `isNativeAgentUserMcpServerList`: at most `NATIVE_AGENT_USER_MCP_SERVERS_MAX` = 32
  unique names matching the `mcp:<server>` grammar), `isNativeAgentMcpServerName`,
  `nativeAgentUserMcpGrant`, `nativeAgentAllowsUserMcpServer`, `nativeAgentRestrictsUserMcp`,
  `NATIVE_AGENT_USER_MCP_SELECTION` / `nativeAgentUserMcpSelectionDelivered(platform, readOnly)`.
  `nativeAgentPolicyForBridge` carries the effective grant. Codex, Cursor and Pi now translate
  `mcp` in `NATIVE_AGENT_BRIDGE_EXTENDED_TRANSLATIONS` (a deny is held through the same
  filter), so the `projectResources: false` stand-in is left only for Grok.
- Graphs: `CompiledGraphCapabilities.mcpServers`; the compiled policy always sets
  `userMcpServers`; grants removed by the ceiling or environment are listed in
  `removedByCeiling`/`removedByEnvironment`. `checkGraphCapabilities(spec, access, {providers})`
  (the compiler passes its enabled providers). `GraphCapabilityIssue.provider` names the
  provider of a `capability-mcp-grant` warning (the compile diagnostic carries it in the
  message). The capability statement says which user servers the node has ("none of the
  user's own MCP servers" by default); a plan compiled before 404 keeps the old deny line.
  Matrix: `userMcpSelectionAxis` (Pi enforced; Claude, Codex, OpenCode, Cursor
  provider-configured; Grok advisory), secondary, never lowers the tier.
- Bridges: Claude `userMcpServerFilter`, `claudeUserMcpQueryOptions`,
  `claudeGrantedMcpServerNames` (`services/mcp-config.ts`), `getMcpRuntimeConfig(..., allowConfigured)`,
  `readOnlyTurnPolicy` carries the grant, `mcpSourceScopeForPolicy` answers `user` for a read-only
  turn with a non-empty grant. Codex `codexConfiguredMcpServerNames`, `codexUserMcpThreadConfig`
  (`codex-config.ts`), engine `userMcpThreadConfig`/`policyThreadConfig`; reserved names
  `orkestrator`, `orkestrator-design`, `orkestrator-artifacts`, `codex_apps`. Also fixed
  `codexReadOnlyTurnPolicy`, which dropped `extendedDeny` (a 106 regression) and would have
  dropped the selection. Pi `piUserMcpServerFilter` (`mcp-config.ts`, matches Pi's sanitised
  ids), `resolvePiMcpServers({allowServer})`, `isGrantedUserMcpTool`. Cursor
  `cursorUserMcpServerFilter`, `cursorSettingSources`, `cursorMcpServers({userServers, configHome})`.
  OpenCode `apps/backend/src/core/opencode-user-mcp.ts` (`openCodeUserMcpRules`,
  `openCodeConfiguredMcpServersFor`), wired through `openCodePermissionRules({configuredMcpServers})`,
  `OpenCodeSessionPolicy` (re-reads `mcp.status` each turn for a selecting session and re-applies
  when the list changes) and `OpenCodeReviewSessionPermissions` (create, reviewer enable, restore).
- Web: `graph-designer-mcp.ts` (`loadConfiguredUserMcpServers`, `useConfiguredUserMcpServers`:
  backend targets' `backend-user` sources only, names valid for `mcp:<server>`, at most 64),
  `GraphMcpServersEditor.tsx` mounted in `GraphCapabilitiesEditor`.
- Tests: protocol `native-agent-capabilities.test.ts`, `graphs/capability-profiles.test.ts`,
  `graphs/capability-enforcement.test.ts`, `graphs/compile-diagnostics.test.ts`; Claude
  `mcp-config-user-selection.test.ts`, `session-manager-prompt-mcp.test.ts`; Codex
  `engine/app-server-user-mcp.test.ts`; Pi `mcp-user-selection.test.ts`; Cursor
  `mcp-user-selection.test.ts`; backend `opencode-user-mcp.test.ts`, `http-bridge-provider.test.ts`;
  web `GraphMcpServersEditor.test.tsx`.

**2026-10-29 · Gaps and limits.** Grok: unsupported (see the table). Cursor: a selecting
session loads no Cursor settings source, so it also runs without the user's and project's Cursor
rules and plugins; read-only turns deliver no grant. Claude: `strictMcpConfig` means no plugin
MCP server loads for a selecting session (plugin servers cannot be named in a grant: `:` is
outside the grammar). OpenCode: the other servers' processes still run in the shared instance;
only their tools are refused. Codex: the selection is set when a thread starts, resumes or forks;
a thread whose selection changes while loaded needs `reloadThread` (graph sessions are new per
activation, so this does not arise today). Older bridges (for example in a container image built
before this change) ignore `userMcpServers` and load every configured server. The MCP settings
apply plan does not read the selection, so a save to an ungranted server is still reported for a
graph session. Live provider runs were not done here (no live-credential qualification for this
item); every mechanism is covered at the option-builder level against each bridge's real
session/query config code.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Design note, then per-session user MCP selection in the protocol, compiler, matrix, Claude, Codex, Pi, Cursor and OpenCode (Grok documented as a gap), designer picker, docs and tests. · complete; awaiting PR
- 2026-10-29 · coordinator · Split the design-note box: written, but agreement is still pending (the user's answer was never received; the build went ahead on the coordinator's recommended default). · Awaiting the user's review.
