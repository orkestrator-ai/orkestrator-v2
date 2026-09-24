# 02 — Operation contracts and durable records

Status: Planned.  
Dependencies: [01](01-preserve-editing-intent.md).  
Findings: R2, R5; foundational contracts for later steps.

## Outcome

The backend can answer whether a submitted design operation was committed,
rejected, canceled before execution, still running, or has an unknown outcome,
including after a renderer disconnect or backend restart. A response lost
after commit must not cause duplicate append/create work.

## Existing and proposed owners

Modify `packages/protocol/src/design-canvas.ts`, `design-service.ts`,
`design-tools.ts`, and `commands-registry-design.ts`. Extract proposed backend
modules `design-records.ts`, `design-operations.ts`, and `design-errors.ts` if
needed. Keep public document validation separate from private-record validation.
Use existing atomic storage/path-safety patterns; do not add a database solely
for this step.

## Contracts to define first

All names below are proposed. Register commands through `createCommandRegistry`
and reuse the same validated service methods for UI and MCP paths.

| Contract | Required content/behavior |
| --- | --- |
| `DesignCapabilities` | Protocol version; snapshot, operation-status, delta, save, history, renderer health support |
| `DesignTargetVersion` | Canvas ID and revision; frame ID/revision where relevant; private content/structure/viewport identities |
| `DesignOperationDescriptor` | Kind, bounded validated input, observed preconditions, optional gesture/predecessor reference |
| `DesignOperationStatus` | Opaque operation token, state, base/result revisions, typed reason, timestamps; no unbounded HTML |
| `DesignFailure` | Code, safe message, target, retry classification, relevant revisions, optional capacity retry delay |
| `DesignSnapshotEnvelope` | Generation, canvas revision, public document, separately versioned bounded workspace/frame metadata |

Use failure codes for conflict, invalid input/content, unavailable renderer,
capacity, deadline, disconnected backend, deleted canvas, forbidden ownership,
expired operation, and unknown outcome. Preserve a useful legacy conflict
message for old clients while new clients branch on codes, not message text.

Generation describes the backend/reconciliation epoch. It is not an operation
receipt's persistence lifetime. Ordinary backend restart must not erase a
durably committed receipt. Canvas revisions remain monotonic; frame revisions
advance only for changed frames. Content identity changes on HTML changes,
structure identity on mutations that cannot prove element continuity, viewport
identity on width/height changes. x/y changes affect none of those identities.

Keep a private record sequence for every atomic replacement and separate
monotonic workspace/operation-status versions for changes that do not edit the
document. Queue progress, validation results, session links, and export status
must become observable without manufacturing document revisions. Include
created/modified timestamps and bounded actor metadata in the private record;
document modified time changes for content/geometry/name edits, not polling.

## Admission and execution protocol

- [ ] Provide a preparation command that validates and durably stores a bounded
  descriptor, returning a backend-issued execution token. Preparation never
  edits the canvas. Bind the token to environment, canvas, descriptor digest,
  and record incarnation; input cannot be changed when executing it.
- [ ] The client persists the returned token with its draft before executing.
  A lost preparation response is not a lost edit: no execute request occurred.
  Reconcile preparation by a caller correlation ID where retained; abandoned
  prepared entries expire without executing.
- [ ] Execute only tokens already known as prepared/admitted in durable state.
  A repeated execute for a known token returns its state/result, never schedules
  another copy. Unknown or expired tokens cannot create new work.
- [ ] Admit execution independently of the HTTP/UI connection. Once execution
  is accepted, disconnect/unmount leaves it running under backend ownership.
- [ ] Expose read-only lookup and cancel-before-execution commands. Lookup must
  not schedule work or touch native-agent liveness.
- [ ] Bound prepared descriptors, aggregate decoded bytes, and terminal receipts
  using the index budgets. Do not evict running operations to make room.
- [ ] An expired token remains non-executable even after its receipt is pruned.
  A user may prepare a new reviewed intent against a current snapshot; clients
  must never do this automatically to resolve an unknown prior outcome.

This two-phase flow trades one extra round trip for explicit admission and
replay semantics. Measure that cost; do not optimize away its guarantees.
Existing legacy actions can remain one-shot strict-CAS adapters, with no promise
of automatic recovery/retry. New UI and new tool variants use the recoverable
flow. Keep response shapes capability/version gated.

## Private record and atomicity

- [ ] Define a private, versioned record containing the public v1 document,
  bounded workspace/frame metadata, pending descriptors, and terminal receipts.
  Store it in a distinct filename/extension from portable `.orkdes` files.
- [ ] All document changes and their terminal receipts become authoritative in
  one atomic record replacement: write bounded temporary bytes, sync, rename,
  sync the parent directory where supported, then publish hints.
- [ ] Compute a result from a read snapshot, validate it, and commit with a
  final revision/incarnation check. A process crash before the atomic boundary
  leaves the old document; after it, the new document and committed receipt agree.
- [ ] Build the final record from the latest private state under its commit
  lane. Do not overwrite recently admitted descriptors or updated receipts
  with a private-record copy captured before rendering. Verify the relevant
  document preconditions, merge unrelated operation metadata, and advance the
  private record sequence atomically.
- [ ] Mark prepared/executing operations interrupted on restart when no terminal
  record proves their outcome. Pure computation that never committed must not
  be replayed automatically. Later export operations need separate destination
  reconciliation because their file write is outside this transaction.
- [ ] Reserve canvas identities for create/import in bounded provisional records
  before execution. A successful create publishes the same reserved identity;
  a retry cannot create a second canvas. Provisional records count toward
  admission/quota reservations and expire safely if never executed.
- [ ] Persist deletions as a record state/tombstone rather than deleting the
  only evidence of the operation. Step 06 exposes that state to clients.
- [ ] Retain exact descriptor hashes privately only where required for integrity;
  never emit content-derived identifiers into logs or metrics.

## Migration and compatibility

1. Add dual readers: valid new private record first, otherwise legacy backend
   `.orkdes`. A corrupt existing private record is an explicit recovery state,
   not permission to silently fall back to an obsolete legacy copy.
2. Migrate lazily on the first mutation, preserving canvas/frame IDs and
   revisions. Construct private metadata deterministically from the legacy
   snapshot; migration itself is not a user edit.
3. Commit and verify the new record before retiring the old source. Maintain a
   bounded pre-migration backup with clear ownership and retention.
4. Export remains strictly portable version 1. Strip internal metadata, tokens,
   receipts, session identifiers, history paths, and backend host details.
5. Detect unsupported future private versions without overwriting them. Provide
   an explicit recovery/export route and startup diagnostic.
6. Rollback to old binaries after a new-format write is not automatic. Supply a
   verified export/conversion procedure; never let old code unknowingly edit
   the stale legacy copy. Ship reader support before enabling migration.

## Implementation checklist

- [ ] Add independent schema/validation tests for public and private formats.
- [ ] Make byte limits account for escaped serialization, metadata, pending
  inputs, receipts, and temporary files; reject before replacing old state.
- [ ] Keep receipt payloads compact; identify committed frames/revisions and
  fetch authoritative content separately when requested.
- [ ] Add explicit no-op outcome shape without deciding all no-op detection
  rules yet; step 14 implements broader detection.
- [ ] Preserve environment authorization on preparation, execution, lookup,
  cancel, export, and provisional-create enumeration.
- [ ] Publish only after durability. Repeated receipt reads emit no duplicate
  document-change hint.
- [ ] Use narrow storage fault injection around write, sync, rename, and event
  publication so crash-boundary tests do not rely on arbitrary timing.

## Required tests

| Fault/scenario | Required evidence |
| --- | --- |
| Execute response lost after commit | Lookup returns committed revision; second execute does not modify again |
| Crash before commit boundary | Old document intact; no committed receipt claims success |
| Crash after replacement before event | New snapshot/receipt agree; missed event is repaired |
| Duplicate token with changed input or other environment | Rejected before work |
| Receipt expired/pruned | Execute fails explicitly; no duplicate work |
| Lost preparation response | No mutation executes without an execute request |
| Concurrent creates at quota limit | Only reserved capacity admitted; no overrun after restart |
| Legacy document migration interrupted | Either old or complete new record is usable, never mixed fields |
| New record corrupt with legacy backup present | Recovery surfaced; backup not silently treated as current |
| Portable export/import | v1 schema unchanged; all private fields excluded |

## Completion / review slices

- [ ] Protocol types, capability negotiation, and compatibility tests.
- [ ] Private-record reader/writer and migration tests, enabled for isolated QA.
- [ ] Admission/execute/status/cancel with crash and duplicate-execute tests.
- [ ] Command/MCP adapters and bounded cleanup, followed by migration rollout
  notes. Step 03 switches the UI only after the contracts are ready.
