# 02 — Define management contracts, capabilities and validation

Status: planned. Depends on: 01. [Plan index](00-index.md).

## Purpose and owners

Add a management contract next to the existing runtime-only
`NativeAgentMcpServer`. Suggested owner:
`packages/protocol/src/mcp-management.ts`, with validation tests beside it.
Do not add editable secrets or full provider config to native-agent projections.
Keep existing inventory and connection-action consumers backward compatible.

## Proposed public objects

| Object | Required information |
| --- | --- |
| `McpManagementTarget` | Opaque target id, backend id, provider, scope, optional environment/project id, display location, trust state, capabilities |
| `McpConfigSource` | Opaque source id, format, owner, writable state/reason, revision, precedence metadata and source display path |
| `McpDefinitionSummary` | Stable source-entry id, exact native name, source id, transport, enabled state if meaningful, protected/read-only reason, effective/shadowed relationship |
| `McpEditableDefinition` | Allowlisted non-secret fields, secret presence metadata, supported field schema, advanced-field preservation marker, entry/source revisions |
| `McpManagementSnapshot` | Target, sources, definitions, effective mapping, relevant operation summaries, revision/generation, freshness/errors and explicit truncation |
| `McpMutation` | Request id, target/source/entry ids, expected revision, operation, field patch, secret edits and apply intent |
| `McpMutationResult` | Saved revision, resulting entry identity, operation id and per-runtime apply states; never raw saved config |

Use source-entry identity independently of provider name, with source id plus an
opaque stable entry identifier. Renaming must preserve UI operation identity
while changing the provider-native lookup name. Runtime correlation also needs a
provider generation and session/directory identity where available.

## Operations and semantics

Support `add`, `update`, `rename`, `remove` and capability-gated persistent
`set-enabled`. Keep runtime `reconnect`, connection toggle and sign-in on their
existing action axis. The UI must not infer persistence from a runtime action's
name. Define a separate `apply` request referring to a saved revision.

`update` is a field patch, not replacement of the whole provider configuration.
Use explicit remove-field operations for optional values. Omission means retain,
including unknown provider fields. Reject incompatible transport fields unless
the request explicitly switches transport and identifies fields to discard.

Secret edits are tagged `keep`, `set(value)` or `clear`. Presence is not a masked
string. A missing secret field does not erase it. Map-entry rename for env/header
keys needs explicit old/new identity so an unchanged secret can move without
being returned to the renderer. OAuth tokens never appear in these DTOs.

Capabilities must include supported scopes/transports/fields, writable operations,
authentication kinds, runtime apply strategy and impact scope. Return reasons for
disabled capabilities. Derive capabilities on the backend from adapter/version,
target state and policy; do not hardcode six sets of UI conditionals.

## Application states

Model persistence and runtime application independently:

```text
save: pending -> saved | conflict | rejected | failed | reconciling
apply per runtime:
  not-requested -> queued -> applying -> applied
                            -> pending-next-turn
                            -> pending-reattach
                            -> restart-required
                            -> blocked-policy
                            -> failed
                            -> reconciling
```

`applied` means the runtime has accepted the intended configuration revision;
connection state remains connected/failed/needs-auth/unknown separately. If the
provider only acknowledges scheduling, stay pending. Old inventory from a prior
generation never proves application. Terminal processes can report
`restart-required` without an automatic restart operation.

## Bounds and validation

Use explicit constants and reject oversized input before allocating unbounded
decoded objects. Initial proposed budgets, to be adjusted with fixture evidence:

| Resource | Initial budget / behavior |
| --- | --- |
| Management mutation body | 256 KiB decoded; gateway and bridge enforce |
| MCP subtree | 1 MiB; refuse an edit that exceeds it |
| Native backing file | 8 MiB for general writers; stricter provider limits win; oversized sources read-only |
| New managed definitions per target | 64; never silently discard existing entries above the limit |
| Name | Provider-valid syntax; 128 UTF-8 bytes maximum, Pi's stricter rule wins |
| Args | 128 entries, 4 KiB each, aggregate request budget still applies |
| Env/header pairs | 64 each, 8 KiB per value; narrower provider limits win |
| URL | 4 KiB; supported scheme, valid parse, no embedded user/password |
| Public error | 2 KiB after redaction; stable code separate from text |
| Catalog page | 100 rows and 256 KiB; opaque cursor or explicit incomplete result |
| Public tool names | Reuse existing bounded runtime inventory; never return schemas/results here |

Bounds are byte bounds as well as counts. Existing larger sources remain intact;
pagination and read-only diagnostics are preferable to replacement from a partial
list. Reject prototype-polluting map keys and normalize header keys for duplicate
detection. Preserve case-sensitive server names exactly; do not silently sanitize
them into collisions.

Validate syntax without DNS, executable launch, package download or connection.
Commands are executable plus argument array, never one shell string. Environment
references remain literal references until the provider resolves them; reject
references to internal bridge/control credentials. Provider-specific fields use
an explicit adapter schema instead of accepting arbitrary config key paths.

## Errors and compatibility

Define stable errors for revision conflict, duplicate name, invalid definition,
protected entry, read-only source, unsupported operation/transport, unknown target,
offline execution target, policy block, malformed/oversized source, ambiguous
source, and runtime apply failure. Include an opaque correlation id and reload
hint, never raw provider stderr or raw config.

Old bridges advertise no management capability. Do not reinterpret a 404 as an
empty writable catalog. A source with read errors can coexist with healthy source
rows; top-level success must still expose the incomplete state.

## Verification and acceptance

- [ ] Round-trip DTO validation and additive compatibility with runtime inventory.
- [ ] Byte/count boundary, invalid union, URL, args and map-key tests.
- [ ] Keep/set/clear cannot be confused with empty string or a masked placeholder.
- [ ] Empty, unsupported, offline, malformed and incomplete catalogs differ.
- [ ] Public serializers exclude secret values, raw config and internal tokens.
- [ ] All adapters can express safe next-turn application without claiming hot reload.

Exit: [03 — target resolution](03-targets-and-inventory.md).
