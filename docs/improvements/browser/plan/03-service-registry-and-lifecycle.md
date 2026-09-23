# 03 — Build the backend service registry and lifecycle

Status: Implemented (`51ec63c0`). Depends on: 02. Unlocks: 04.

## Outcome and code ownership

Add a proposed `PreviewServiceRegistry` owned by the standalone backend, exposed
through `CommandContext`. Definitions persist through `StorageService`; runtime
targets, grants, sockets, and attachment secrets do not. Suggested new modules:
`apps/backend/src/core/preview-service-registry.ts`,
`preview-service-storage.ts`, and `commands-registry-previews.ts`.

Inspect [storage base](../../../../apps/backend/src/core/storage-base.ts),
[storage projects](../../../../apps/backend/src/core/storage-projects.ts),
[registry composition](../../../../apps/backend/src/core/commands-registry.ts),
[context](../../../../apps/backend/src/core/commands-context.ts), and
[environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts).
Use existing storage/lifecycle serialization rather than adding a parallel
renderer-owned registry.

## Implementation tasks

1. Persist a schema-versioned collection of service definitions, with stable
   backend-issued IDs and definition revisions. Store no DNS credentials,
   gateway tokens, cookies, resolved host ports, or connectivity assumptions.
   Persist a stable non-secret backend identity through the same storage owner;
   token rotation and client connection renaming must not change it. Define
   explicit clone/import behavior so copied backend data does not accidentally
   advertise the same live identity as its source.
2. Load and validate definitions during backend initialization. Malformed
   individual records produce bounded diagnostics and an unavailable service;
   they must not crash startup or become an arbitrary proxy target.
3. Seed definitions for existing container entry ports and explicit TCP mappings.
   Use deterministic provenance keys so repeated startup/reconciliation does
   not duplicate them. Distinguish generated definitions from user overrides.
   Do not infer HTTP capability from UDP mappings.
4. Implement compare-and-set registration/update/removal and deduplicate mutation
   operation IDs with a bounded retention policy. Delete/recreate of a service
   creates a new identity unless deliberately restoring its durable definition.
5. Model runtime entries as `unresolved`, `resolving`, `available`, `unavailable`,
   or `revoked`, with layer-specific readiness. A stopped environment retains
   its definition but cannot authorize a live target.
6. Allocate a new backend epoch on startup. Start runtime entries unresolved;
   do not mark persisted services ready before validating their current owner
   and endpoint. Allocate a new endpoint generation on verified binding changes.
7. Publish revisioned snapshots and compact invalidation events after committed
   state changes. Coalesce rapid readiness changes without losing the fact that
   an endpoint was revoked or replaced.
8. Wire environment start/stop/recreate/delete and backend shutdown. Revoke
   affected transport authorization before removing or replacing its target.
   Subsequent grants bind only to the new generation.

## State and race handling

Each asynchronous resolution/probe captures a service revision, backend epoch,
and lifecycle generation. Before committing, compare all three against current
state. Discard stale results from a stopped/deleted/recreated environment.
Concurrent callers share a single resolution job per service; errors settle all
waiters and clear the in-flight record.

Serialize definition changes through the existing storage write mechanism.
Avoid holding the environment lifecycle queue while awaiting network probes
or client rendering. A committed update can schedule resolution outside that
queue using generation checks. A registry listener must not block stdout,
gateway SSE delivery, or unrelated services.

Separate attachment release from service removal. Closing the last view may
allow its transport to idle out but does not delete registration or kill the
development process. Never count mounted React components as backend liveness.
Browser disconnections are handled through leases; explicit release is a useful
optimization, not the only cleanup path.

## Rehydration and events

Return snapshots with `(backendEpoch, registryRevision)`. A client subscribes
before fetching a snapshot, buffers bounded updates during the fetch, then
reconciles revisions. Unknown epoch, expired replay cursor, or revision gap
forces a new snapshot. Bound retained events by count and bytes, or reuse the
existing bounded gateway ring with invalidation events.

Ordinary snapshot reads do not extend attachment leases or keep unrelated
runtime resources alive. Maintain deletion information long enough for the
selected reconciliation scheme; a full snapshot remains authoritative even
after tombstone expiry. Repeated unchanged reads should be conditional.

## Tests

- Repeated startup and seeding produce one stable definition per source.
- Independent clients edit a definition concurrently; stale writes conflict.
- A resolution finishing after stop/delete/recreation cannot revive the old
  endpoint. Endpoint generation advances even when a replacement reuses a port.
- A failed storage write emits no committed-success event.
- Backend restart preserves definitions, changes epoch, and drops old grants
  and connectivity assumptions.
- Lost, duplicate, out-of-order, and expired events recover through snapshots.
- Registry limits reject growth without evicting live authoritative state.
- Environment A resolves while its UI is unmounted; returning shows its current
  state. A renderer reload produces the same answer.
- Registry dispose cancels jobs and removes listeners with no unhandled promises.

## Completion and fallback

Exit with the registry usable entirely through backend commands and tests,
without a mounted frontend. Existing preview behavior can remain unchanged in
this step. Keep the new service available behind a capability until transport
and client integration are ready. Record storage upgrade/downgrade behavior;
disabling the feature preserves definitions without advertising usable access.

## Implementation record (2026-09-23)

`PreviewServiceRegistry` provides compare-and-set mutations with operation-ID dedupe,
tombstones, epochs, generations, and lifecycle revocation. It is persisted in
`preview-services.json`, and the identity lives in `backend-identity.json`. Older backends ignore
both files, so a downgrade keeps definitions for a later upgrade. Validation:
`core/preview-service-registry.test.ts`; see [evidence](evidence.md).
