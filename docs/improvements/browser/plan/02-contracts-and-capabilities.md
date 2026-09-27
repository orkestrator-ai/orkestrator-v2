# 02 — Define contracts, limits, and capability negotiation

Status: Implemented (`d013f6f7`, extended by later steps). Depends on: 01. Unlocks: 03 and shared client work.

## Outcome and ownership

Define one validated preview contract shared by backend and clients. Keep
credentials and private endpoint addresses out of ordinary persisted tab data
and broad environment events. Extend
[protocol browser-preview](../../../../packages/protocol/src/browser-preview.ts)
or split into proposed `preview-services.ts` and `preview-access.ts` modules.
The existing geometry/annotation contract remains compatible.

Add exports through [protocol package metadata](../../../../packages/protocol/package.json)
when splitting modules. Follow the repository lockfile regeneration instructions
if manifests change. Do not introduce an assumed `src/index.ts`; this package
uses subpath exports.

## Data model

Define and validate the following proposed records. Names are design targets,
not existing APIs.

| Record | Required information | Persistence |
| --- | --- | --- |
| `PreviewServiceDefinition` | Schema version, service ID, environment ID, label, target kind, application port, HTTP/HTTPS scheme, configuration provenance, enabled flag | Backend storage |
| `PreviewEndpointSnapshot` | Backend epoch, endpoint generation, address family, transport kind, readiness, observation time, failure category | Runtime; reconstructed after restart |
| `PreviewRegistrySnapshot` | Backend identity/epoch, revision, bounded service list, deletion/reconciliation information | Runtime response |
| `PreviewServiceRef` | Backend identity, environment ID, service ID, app-relative path/query/fragment | Durable tab, subject to existing privacy policy |
| `PreviewAttachment` | Attachment ID, service ID/generation, client/surface kind, lease state | Runtime only |
| `PreviewAccessGrant` | Opaque one-use secret, expiry, intended audience/route binding | Returned only to the trusted initiating client; never persisted |
| `PreviewCapabilities` | Protocol version, supported target/surface/transport modes, auth schemes, limits, publication readiness | Authenticated control response |

A service's label and port are editable configuration; neither is its primary
key. Never place a raw grant in a general snapshot. Backend identity must be
stable, while epoch must change on restart. A sequence reset without an epoch
change is invalid. Serialize revisions without exceeding JavaScript's integer
precision; choose a bounded safe integer or a validated decimal string.

Represent readiness in separate layers: environment lifecycle, target resolution,
reachability, and optional application HTTP observation. Do not overload the
native view's `loading` flag or interpret 401/404 as “server down.”

## Commands and events

Register through [createCommandRegistry](../../../../apps/backend/src/core/commands-registry.ts)
using a proposed `commands-registry-previews.ts` and
[CommandContext](../../../../apps/backend/src/core/commands-context.ts) service.

| Proposed command | Semantics |
| --- | --- |
| `get_preview_capabilities` | Read negotiated support; no credential minting or liveness touch. |
| `get_preview_services` | Authoritative environment-scoped snapshot, optionally conditional on epoch/revision. |
| `register_preview_service` | Validated idempotent registration with an operation ID and expected definition revision. |
| `update_preview_service` | Compare-and-set configuration update; reject conflicting edits. |
| `remove_preview_service` | Disable/revoke before deletion; never stop the app implicitly. |
| `resolve_preview_target` | Resolve service or environment-relative URL intent; return binding/readiness, not arbitrary connect authority. |
| `create_preview_attachment` | Create scoped runtime ownership and obtain the appropriate handoff descriptor. |
| `release_preview_attachment` | Idempotent release of that consumer only. |
| `probe_preview_service` | Explicit bounded/coalesced readiness refresh. |

Define `preview-services-changed` with backend epoch and registry revision.
Prefer a compact invalidation plus conditional snapshot reads initially. If
sending deltas, include deletion tombstones and reject gaps; do not implement
an unbounded per-client event journal. Reuse gateway replay semantics and ensure
new state events are included in the transport's authoritative-state policy.

## Errors

Use a discriminated result/error contract with stable categories:
`unsupported`, `not-found`, `environment-stopped`, `target-unmapped`,
`target-unverified`, `connection-refused`, `dns-failed`, `tls-failed`,
`connect-timeout`, `headers-timeout`, `generation-changed`, `access-expired`,
`forbidden`, `capacity-exceeded`, and `configuration-conflict`.

Include retryability, failure layer, and a safe user message. Raw socket errors,
upstream bodies, arbitrary URLs, and credentials do not belong in public error
messages. Do not retry an application mutation because an error is labeled
transient; that flag concerns resolving/attaching unless explicitly specified.

## Initial limit budget

Use these as proposed conservative starting values, measured in step 14. Keep
them centralized/configurable within validated ceilings, not scattered magic
numbers. Altering them requires recording the resource impact.

| Resource | Starting budget / policy |
| --- | --- |
| Definitions | 32 per environment; 1,024 per backend; reject registration over the bound |
| Snapshot | 2 MiB serialized; bounded pagination with revision consistency if exceeded |
| Label / identifier / navigation input | 120 / 128 / 8,192 UTF-8 bytes; reject oversize |
| Bootstrap grants | 60-second one-use TTL; 8 pending per client/service; 256 backend-wide |
| Preview sessions | 30-minute idle, 8-hour absolute lease; explicit renewal before expiry |
| HTTP forwarding | 32 active per service, 128 backend-wide; immediate bounded overload response |
| HTTP headers | 32 KiB total and 100 fields on each hop; validate before forwarding |
| Upgrade/tunnel connections | 8 per service, 128 backend-wide, counting handshakes |
| Tunnel data frame | 32 KiB; 256 KiB queued per direction; 64 MiB aggregate queue ceiling |
| Control frames | 8 KiB each; 32 pending per connection; reject unknown/oversized shapes |
| Connect / response headers | 10 seconds / 30 seconds; cancellation propagates |
| Ordinary body idle / owned-resource cleanup | 60 seconds without progress / 5-second graceful cleanup, then force-close owned resources |
| Ordinary upload / download | 128 MiB / 512 MiB total, streamed; configurable service limits |
| Long-lived SSE/WS/tunnel | Bounded queues and session lifetime; no small cumulative response-body cap |
| Compatibility rewriting | Preserve existing 8 MiB body, 8,192 chunks, 64 MiB aggregate decode bounds |
| Probe jobs | 4 concurrent backend-wide; coalesce per service; bounded scheduling queue |

These are admission limits for this feature, not changes to unrelated gateway
command-body or agent transport limits. Layered budgets count distinct resources:
an outer native tunnel and its inner application WebSocket must not accidentally
consume the same named slot twice, nor escape both counters. Define accounting
ownership and expose it in tests before enabling either transport.

Ordinary resource budgets and streaming exceptions must be explicit in the
capability contract. Admission counts include requests waiting for upstream
headers. Streaming a 512 MiB response does not permit buffering it in memory.
Handle a body limit exceeded after headers by terminating the response with a
recorded category rather than attempting to change the already-sent status.

## Negotiation, tests, and completion

New clients encountering a specifically unsupported capability command use old
behavior. Authentication failure, malformed capability data, or network failure
must not be misclassified as an old backend. Advertise each mode only when its
server dependencies are actually ready. TLS publication failure may disable
browser preview while leaving desktop transport available.

Test schema boundaries, unknown fields/versions, unsafe URLs, opaque IDs,
redaction, error mapping, deterministic serialization, and old/new capability
combinations. Include forged backend/environment identity. Add contract fixtures
that later steps consume. Exit with documented request/response examples using
synthetic IDs and no usable credentials, and passing protocol/owner typechecks.

## Implementation record (2026-09-23)

`packages/protocol/src/preview-services.ts` and `preview-access.ts` hold the contracts, limits,
error categories, capabilities, tab URIs, and tunnel frames. `preview-http1.ts`,
`preview-header-policy.ts`, `preview-forward.ts`, and `preview-websocket.ts` are shared by the
backend and desktop. Validation: 57 protocol tests; see [evidence](evidence.md).
