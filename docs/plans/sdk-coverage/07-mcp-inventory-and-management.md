# 07 — MCP inventory and management

**Status:** ⬜ Not started · 0/17 tasks · Depends on: 02, 04

## Goal

Today MCP is a count in the runtime summary plus a settings-pane discovery
that shells out to each CLI. Cursor cannot see a server at all; Claude reads
fields that are structurally always undefined; no platform can reconnect,
toggle or sign in to a server from Orkestrator. Add one normalized MCP model,
served by the backend from each SDK's live status API, with the small set of
actions the SDKs actually offer. One generic panel renders it. Pi has no MCP
client and reports an empty list.

## Normalized model

`packages/protocol/src/native-agent.ts`:

```
NativeAgentMcpServer = {
  id: string
  name: string
  status: "connected" | "connecting" | "failed" | "needs-auth" | "disabled" | "unknown"
  scope?: "user" | "project" | "orkestrator" | "plugin"
  transport?: "stdio" | "sse" | "http"
  toolCount?: number
  tools?: string[]            // names only, bounded
  error?: string              // redacted, bounded
  actions: Array<"reconnect" | "enable" | "disable" | "sign-in">
}
NativeAgentRuntimeSummary.mcpServers stays a number for the badge;
NativeAgentRuntimeSummary.mcp?: NativeAgentMcpServer[] carries the list.
```

Bridge routes on every bridge:

- `GET /session/:id/mcp` → `{ servers: NativeAgentMcpServer[] }`
- `POST /session/:id/mcp/:serverId/:action` with `action ∈ reconnect |
  enable | disable | sign-in`. `sign-in` returns `{ url?: string }` and any
  follow-up comes through the interaction contract (plan 04's `mcp-url`).

Backend: `NativeAgentRuntimeProvider.mcpServers?(sessionId)` and
`mcpServerAction?(sessionId, serverId, action)`. Config of which servers to
launch stays where it is (`~/.claude.json`, `.mcp.json`, `.cursor/mcp.json`,
Orkestrator's own control MCP); this plan is status and lifecycle, not
config editing.

## Tasks

### Protocol, backend, renderer

- [ ] Add the types and the provider methods; protocol and contract tests.
- [ ] `HttpBridgeProvider` maps the routes; 404 → capability absent, empty
  list.
- [ ] Projection carries `runtime.mcp`; the settings-pane discovery in
  `extension-discovery.ts` keeps working for environments with no session
  but is marked as the fallback.
- [ ] One generic panel in `AgentInfoButton.tsx` replacing the per-platform
  MCP rows at `:1682-1740`: list, status pill, tool count, and action
  buttons driven by `actions`. Presentation only.

### Claude bridge

- [ ] Replace the `init.mcp_servers` read (`session-manager-prompt.ts:1200-1203`)
  with `Query.mcpServerStatus()`; map `needs-auth`, `pending`, `disabled`
  distinctly instead of collapsing to `failed`; carry `tools`, `scope`,
  `serverInfo`.
- [ ] Actions: `reconnect` → `reconnectMcpServer()`, `enable`/`disable` →
  `toggleMcpServer()`. Report Orkestrator's own control server with
  `scope: "orkestrator"`.
- [ ] `sign-in`: when a server is `needs-auth`, the SDK's elicitation
  (plan 04) carries the URL; map it to `mcp-url`.
- [ ] Stop parsing `~/.claude.json` and `.mcp.json` in
  `services/mcp-config.ts` for status purposes; keep it only for the
  Orkestrator control server injection (plan 15 revisits the rest).

### Codex bridge

- [ ] Serve `mcpServerStatus/list` (diagnostics-only today,
  `engine/app-server-engine.ts:861`) on the route; map
  `mcpServer/startupStatus/updated` into live status changes.
- [ ] `sign-in` → `mcpServer/oauth/login`; the resulting URL goes through
  `mcp-url`. `reconnect` → `config/mcpServer/reload` for that server.

### OpenCode (backend)

- [ ] `mcpServers` from `client.mcp.status`; `reconnect` → `mcp.connect`/
  `mcp.disconnect`; `sign-in` → `mcp.auth.start` then `mcp.auth.callback`
  through the interaction contract. Handle `mcp.tools.changed` SSE (plan 13)
  to refresh the list.

### Cursor bridge

- [ ] Pass Orkestrator's control MCP server and, inside containers, the
  project's `.cursor/mcp.json` entries through `AgentOptions.mcpServers`
  (never set today). Status comes from the `system` message's tool list
  (plan 02) since the SDK has no MCP status call; report `unknown` where it
  cannot tell. Actions: none.
- [ ] Remove the "Cursor's SDK bridge does not expose an MCP server list"
  error branch in `extension-discovery.ts:485-494` once the route answers.

### Grok bridge

- [ ] Populate `mcpServers` on `session/new` and `session/load` from the same
  Orkestrator control server config the other bridges receive (today always
  `[]`, `acp-session.ts:347`). Status from `*/mcp/servers_updated` (count
  today) with names only, since entries may carry keys.

### Pi bridge

- [ ] Serve an empty list with a comment; capability absent. Extension-
  registered tools are not MCP.

## Verification

- [ ] Bridge tests per platform with a fake MCP server: status transitions,
  each action, redaction of `error`.
- [ ] Browser: Claude fixture with one healthy and one failing server;
  reconnect the failing one from the panel; reload and confirm the status
  came from the snapshot.

## Out of scope

Editing MCP config files from the UI. Codex `mcpServer/tool/call` and
`resource/read`. Pi.
