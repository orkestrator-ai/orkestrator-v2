# 10 — Implement Grok configuration management and ACP application

Status: done for native TOML CRUD, `$GROK_HOME`, compatibility provenance in Grok's documented order and
switches, managed files, folder trust, and saved-disabled display. The ACP bridge reports a process-level
MCP inventory with unknown health and a config fingerprint; apply reports restart-required and becomes
`applied` only after the bridge process restarts with the saved bytes. **Not done:** per-session ACP
application and passing user servers at session load (undocumented collision rules).
Depends on: 01–05. [Plan index](00-index.md).

## Existing owners

- `bridges/acp-bridge/src/acp-context.ts`: injected launch servers and vendor MCP
  runtime notifications.
- `acp-session.ts`: initialize/new/load and process/session lifecycle.
- `acp-tools.ts`: additional session operations carrying launch configuration.
- `acp-persistence.ts` and `acp-persist-writer.ts`: persisted session state.
- `acp-http.ts`: private authenticated route surface.
- `acp-mcp.test.ts` and the bridge's fake-agent fixtures.

The ACP bridge serves Grok only in this repository. Do not revive the former
Cursor ACP integration or apply Cursor configuration assumptions here.

## Native configuration and provenance

1. Resolve Grok home and user/project TOML files from actual launcher/binary
   behavior. Represent managed/requirements files as read-only origins.
2. Read native `mcp_servers` entries separately from Claude/Cursor compatibility
   imports. Default new Grok definitions to Grok-native scope so adding one does
   not unexpectedly modify another provider's file.
3. For an inherited compatibility entry, show its source and cross-provider
   consumers. Offer navigation to the owning source or a deliberate Grok-native
   override; never silently edit the compatibility file under a Grok-only label.
4. Preserve native environment interpolation, headers, timeouts, enabled state
   and unknown options. Store source strings without expanding values in backend
   public DTOs. Do not treat Codex TOML fields as interchangeable with Grok's.
5. Implement conflict-checked add/edit/rename/remove and verified persisted toggle.
   Removing a native override may reveal a compatibility entry; make that visible
   in both the preview and final snapshot.
6. If using a Grok CLI writer, pin the exact binary, use structured argv with
   private stdin/file inputs for sensitive values, enforce output/time bounds,
   and prove atomicity/source behavior. Prefer the safe TOML writer when CLI
   operations cannot meet rename or conflict guarantees.

## ACP launch and application

`configuredAcpMcpServers()` currently contributes only the trusted Orkestrator
entry. Preserve that authority. Determine whether newly saved native configuration
is loaded automatically by the pinned Grok process or needs explicit ACP launch
entries. Do not duplicate every native server in both places without proving
collision and replacement semantics.

Implement one typed resolver for effective user plus protected launch input where
explicit input is required. Use it consistently in new, load, resume, fork and
restoration paths that currently call the injected-config helper. Never persist
the resolved bearer-bearing launch set with session history.

Default apply to a verified safe load/reattach boundary. ACP session setup alone
does not imply a standardized live MCP CRUD method. A vendor-specific reload may
be added only with pin/version gating and contract tests. Preserve session id and
conversation history; do not close an active Grok process to force a reload.

Respect the initialized transport capability set. Keep the existing working
Orkestrator payload shape until a probe establishes an alternative shape. General
HTTP/stdio/SSE serialization belongs in the Grok adapter, not in generic frontend
code. Unsupported transport saves/applications must return specific errors.

## Runtime inventory and revisions

The current vendor inventory is stored on shared `agentRuntime`. Before allowing
different session launch sets, decide how to correlate notifications to the
originating child/session. Move session-specific inventory to the owning session
when correlation exists. Otherwise explicitly report process-level inventory;
never copy one session's server list to all sessions as exact truth.

Attach applied configuration revision and child generation to inventory. A stale
notification after reattach cannot acknowledge a newer save. Vendor listing
without sufficient status details remains observed/unknown health rather than
proof that every listed server is currently connected.

Keep runtime callbacks nonblocking and bounded. Missing or malformed provider
metadata should create an actionable diagnostic, not an unhandled rejection or a
complete empty catalog that overwrites configuration.

## Authentication and policy

Treat Grok MCP authentication separately from the provider account credential.
Preserve vendor-owned credential stores and use a verified flow if exposed; no
generic management button should claim it can complete OAuth merely because the
CLI TUI can. Container and remote callback restrictions apply independently.

Audit current project approval/execution policy enforcement in the launch path;
do not assume an old environment-variable comment proves current protection.
Ordinary edits cannot enable project resources for a restricted coordinator or
copy host credentials into an excluded environment.

## Test matrix and acceptance

- [ ] Native user/project and compatibility-source precedence is fixture-tested.
- [ ] CRUD preserves TOML and shows fallback activation after removal.
- [ ] Add in Grok writes no Claude/Cursor source unless explicitly selected.
- [ ] Every ACP new/load/resume path receives the current protected connection.
- [ ] Apply waits for safe boundaries and preserves conversation identity.
- [ ] Transport negotiation and pinned payload shapes work against the fixture
  agent and an isolated real Grok session.
- [ ] Two sessions with different config cannot exchange inventories or tokens.
- [ ] Reload/authentication capabilities are advertised only where proven.

Next adapter: [11 — Pi](11-pi.md).
