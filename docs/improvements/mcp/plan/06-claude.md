# 06 — Implement Claude configuration management

Status: done for durable CRUD and next-query application; optional `setMcpServers` replacement not implemented.
Depends on: 01–05. [Plan index](00-index.md).

## Existing owners

- `bridges/claude-bridge/src/services/mcp-config.ts`: source loading, merge,
  runtime translation and protected server injection.
- `services/claude-home.ts`: home/path resolution.
- `services/session-manager-catalog.ts`: inventory and connection actions.
- `services/session-manager-prompt.ts`: per-query config loading and SDK options.
- `types/index.ts`: query-control surface; `routes/session.ts`: session routes.
- `services/mcp-config.test.ts`, `routes/mcp.test.ts`,
  `services/session-manager-catalog-transport.test.ts`: existing regression owners.

Paths above are relative to the Claude bridge except where fully qualified.

## Persistence and discovery

1. Implement a backend Claude source adapter for user, private local and project
   scope. User and private local mutations share one backing JSON transaction.
   Use an actual resolved working directory as the local-map key; do not silently
   move entries between symlinked/canonical path keys.
2. Resolve home/config overrides consistently with the actual launched CLI. Add
   isolated-path tests for custom `CLAUDE_CONFIG_DIR`, ordinary home, coordinator
   home and container home. Do not assume `~/.claude/settings.json` holds MCP
   definitions just because it holds other Claude settings.
3. Keep source documents independently addressable. Expose shadowing between
   user, private local and `.mcp.json` entries. Pin the intended merge order with
   fixtures. If native precedence and the current bridge differ, resolve that
   explicitly before claiming the editor previews effective behavior.
4. Preserve all unrelated JSON, project history, advanced server options and
   plugin settings. Do not serialize a native source through `configToSdkFormat`;
   it is intentionally a runtime subset and currently omits SSE.
5. Implement add/update/rename/remove by source identity with revision checks.
   Validate transport and supported fields against the pinned SDK/CLI. Preserve
   unsupported entries; do not downgrade them to HTTP just to make them editable.
6. Expose persistent enable/disable only after verifying the correct source and
   scope of Claude's persisted disable mechanisms. Existing runtime toggle stays
   a connection action and is not presented as permanent configuration removal.

## Runtime application

Use next-query application as the default. The current prompt path already
resolves MCP config per turn; add a saved/effective config revision to this path
and report when the query actually starts with it. Saving while a query runs
must leave that query's tools and pending interactions intact.

If step 01 validates runtime replacement, extend the typed control surface for
`setMcpServers`, build the entire intended runtime set and interpret its individual
success/error results. Do not pass only the edited server: replacement can remove
other inline servers. Resolve protected Orkestrator/design/workflow connections
from trusted current context and preserve plugin ownership according to the
pinned SDK contract.

Use `readableControl`/draining state consistently. No live control means pending
next query, not “applied” because a short-lived probe accepted an operation.
Do not spawn a probe merely to make persistence look immediate. Optional SDK
methods must produce unsupported results when absent rather than a silent no-op.

Invalidate the config slice cache and all affected session inventories after a
save. Keep old runtime inventory marked with its previous revision until new
evidence arrives. A server can be saved and fail to connect; show both states.

## Authentication and policy

Keep sign-in/reconnect tied to the existing elicitation machinery. Configuration
editing must not generate approval answers, change permission mode, or write
tokens to source JSON. If no live query can carry an authentication interaction,
report the supported next step instead of claiming sign-in completed.

Reapply the effective project-resource policy at every query and reload. A
user-scope mutation may be persisted while excluded from a restricted coordinator;
report policy-blocked for that runtime. The editor cannot use inline options to
bypass the exclusion of project sources.

## Test matrix

- User/local/project same-name collision; native versus bridge precedence fixture.
- Local and user simultaneous writes to one JSON file; unrelated history survives.
- HTTP/stdio and verified SSE paths; advanced unknown fields retain exact values.
- Existing secret kept, replaced and cleared without public exposure.
- Active query, query draining, no query, resumed query and bridge restart.
- Runtime replacement retains injected and plugin servers; partial failure does
  not erase the saved configuration or overstate status.
- Closed-transport failure rejects/defer writes truthfully and preserves cached reads.
- Host project exclusion and coordinator-private home remain effective.
- Removal and rename are reflected in the next query's actual tools, not only UI.

## Acceptance

- [ ] All advertised native scopes support durable CRUD without a conversation.
- [ ] Apply status distinguishes current query from next-query configuration.
- [ ] No temporary probe is treated as proof of persistent/live-session success.
- [ ] Draining/absent controls and unsupported methods are handled explicitly.
- [ ] Protected connections, plugin servers, transcript identity and policy survive.

Next adapter: [07 — Codex](07-codex.md).
