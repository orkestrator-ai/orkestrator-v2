# 10 — Correct Grok metadata and preserve Cursor's support boundary

Status: proposed. Dependencies: 01–04. [Index](00-index.md).

## Grok owners and existing behavior

Work in `bridges/acp-bridge/src/acp-session.ts`, `acp-context.ts`, `acp-http.ts`,
`acp-persistence.ts`, `acp-persist-writer.ts`, and `acp-prompt.ts`. Grok already
stores full inventories, replaces them on update, increments session revision,
persists them, and exposes a session commands route. Keep those foundations.

## Grok normalization

1. Read the standard nested `input.hint` field. Legacy `inputHint` and
   `argumentHint` can remain compatibility fallbacks with explicit precedence:
   standard field first, then legacy alternatives.
2. Normalize strings with byte/count bounds, preserving canonical name and
   namespace. An invalid overlong name must be rejected rather than truncated
   into a different executable command.
3. Preserve full-list replacement semantics, including an empty update that
   removes every command. Do not merge deleted commands back from persistence.
4. Distinguish origin from transport: ACP advertised does not prove `builtin`.
   Use unknown/provider origin unless Grok supplies trustworthy metadata.
5. Preserve a received/known-empty state separately from “no update yet”. The
   current optional inventory can support that distinction during migration.
6. Carry catalogue generation/revision into the bridge snapshot and backend
   freshness contract. Persist bounded public metadata; reconstruct execution
   authority on attach after a provider process restart.

## Grok invocation

Continue passing canonical command text through `session/prompt` with supported
content parts. ACP does not require a separate command-execution RPC. Apply the
shared selection/availability checks first, then let Grok interpret its own
command grammar. Preserve multiline free-text arguments and supported images;
do not split them into shell-style tokens.

Retain existing prompt dispatch journaling and attach-before-dispatch behavior.
An inventory update does not prove a command was dispatched. A persisted list
does not authorize re-sending an ambiguous prompt after restart.

## Grok refresh and activity

The current `/global/refresh-catalog` returns success without fetching a new
inventory. Replace that misleading result with the negotiated refresh outcome.
Use actual agent updates or an existing qualified attach/load path; do not
invent an ACP `commands/list` request. Avoid restarting an active Grok process
just to refresh the menu.

Expose stale persisted entries before attachment, then replace them when the
current session reports inventory. If Grok never sends an update, show discovery
unavailable/unknown rather than an authoritative empty list. Metadata reads
must not touch liveness or cause background reattachment.

## Cursor owners and policy

Keep `bridges/cursor-bridge/src/http.ts` session/global command endpoints and
`packages/protocol/src/native-agent.ts` capability behavior consistent.
Report provider discovery as unsupported in the richer snapshot instead of
allowing an empty list to imply loading. Keep the legacy response `{commands: []}`
for old clients.

Do not scan `.cursor/commands`, copy editor command names into the menu, or feed
them to `agent.send` under a claim of SDK support. Cursor project configuration
loading already has deliberate host/container policy boundaries; this work
must not expand them to discover commands.

Supported Orkestrator actions remain separately available. The UI should say
that the provider exposes no native command catalogue while still allowing a
qualified runtime action such as steering. Do not change `slashCommands` to
true solely because application-owned commands exist.

If step 01 finds a real SDK discovery/invocation API, make that a separately
qualified adapter change with exact pin evidence, transport tests, configuration
scope, and capability negotiation. An editor help page is insufficient evidence.

## Tests

- Standard ACP `input: {hint}` survives normalization and persistence; legacy
  hint fallbacks do not override it.
- Inventory replacement, empty replacement, malformed rows, oversized names,
  duplicate names, and Unicode bounds produce deterministic snapshots.
- Commands arriving after attach or while inactive update the backend snapshot
  without polling a liveness-touching route.
- Restart shows stale persisted data until qualification; a removed selected
  command never becomes an ordinary prompt.
- Exact Grok `session/prompt` payload contains canonical command plus arguments
  and supported additional content once.
- Refresh without provider support is reported honestly and does not restart
  an active session.
- Cursor legacy endpoints stay empty; enhanced snapshot says unsupported;
  qualified Orkestrator actions remain usable and separately labelled.

Exit when Grok metadata matches the ACP contract and Cursor makes no unsupported
provider-command promises.
