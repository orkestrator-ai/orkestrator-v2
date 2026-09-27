# 02 — Lifecycle authority and durable operations

Status: Not started. Dependencies: [01](01-immediate-data-loss-safeguards.md).
Return to [index](00-index.md).

## Goal

Give every container mutation the same ownership, serialization, idempotency
and recovery rules. Keep the Docker CLI, but stop allowing registry aliases to
bypass the environment lifecycle. Establish the state contract used by the
remaining steps before adding volumes and networks.

## Existing integration points

- [Registry wrapper](../../../../apps/backend/src/core/commands-registry.ts)
  already checks supplied `containerId` arguments in strict profiles. Extend
  that protection rather than assuming those profiles are currently unguarded.
- [Docker registry](../../../../apps/backend/src/core/commands-registry-docker.ts),
  [environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts)
  and [server/deletion lifecycle](../../../../apps/backend/src/core/commands-servers.ts).
- [Ownership names](../../../../apps/backend/src/core/docker-ownership.ts),
  [task tracker](../../../../apps/backend/src/core/environment-lifecycle-tasks.ts)
  and [command context](../../../../apps/backend/src/core/commands-context.ts).
- [Backend models](../../../../apps/backend/src/core/models.ts),
  [storage mutations](../../../../apps/backend/src/core/storage-projects.ts),
  [web types](../../../../apps/web/src/types/index.ts) and
  [protocol exports](../../../../packages/protocol/package.json).

## Proposed contracts

Add `packages/protocol/src/container-lifecycle.ts` as a proposed shared contract.
Export it through the package's existing subpath pattern. Define validated
requests/results, safe snapshot fields and error codes separately from private
backend operation details. Do not serialize Docker inspect output wholesale.

| Record | Required information |
| --- | --- |
| Runtime identity | Container ID, owner, environment, runtime generation, resolved image ID, optional registry digest, observed boot ID |
| Storage identity | Storage format, storage-set ID, workspace generation, volume role/name references; initially legacy-layer mode |
| Operation | ID, kind, revision, phase, source identity, candidate identity, requested configuration revision, timestamps and bounded failure code |
| Snapshot | Current identities, readiness/setup state, recoverable operation status, revision and allowed actions |
| Mutation request | Operation ID, environment/resource identity, expected revision and operation-specific preservation/discard intent |

Start with one persisted current operation per environment plus a bounded recent
outcome list for deduplication. Proposed bounds: 32 recent outcomes and 64 KiB of
metadata per environment, excluding user data. Never evict an unresolved
operation to meet a bound; refuse new conflicting work instead. Choose retention
semantics so an expired request ID returns an explicit unknown/conflict result,
not silent redispatch of an old destructive request.

## Implementation tasks

### Ownership and command routing

- [ ] Introduce a backend service, provisionally `container-lifecycle-service.ts`,
  attached to `CommandContext`. Keep low-level exec/inspect helpers free of
  imports that create cycles with registry composition.
- [ ] Inventory all paths that create, start, stop, rename, remove or adopt
  containers. Include direct commands, deletion after PR merge, control tools,
  setup, credential propagation and isolated-profile cleanup.
- [ ] Require app/owner labels and matching persisted association for assigned
  resources in production as well as strict profiles. A supplied container ID
  is not proof of ownership. Follow-up volume/network operations use the same
  owner, environment and role validation.
- [ ] Handle pre-label resources by explicit adoption with a reviewed identity;
  do not auto-adopt every unlabeled container across multiple installations.
  An existing trusted record can be migration evidence, but mismatches conflict.
- [ ] Keep legacy command names as adapters into the service. Raw removal of an
  assigned runtime resolves to the relevant environment operation, preserving
  step 01's data protection.

### Serialization and persistence

- [ ] Reuse the existing per-environment queue and shutdown admission tracker.
  Define and test one lock order: environment operation before owned-resource
  mutation; no service should re-enter its own queued public method.
  Namespace lock keys by registry owner as well as environment ID so separate
  test/embedded contexts cannot accidentally share in-memory operation state.
- [ ] Add revision-checked storage updates through the current queued/atomic
  storage mechanism. Persist operation intent before invoking Docker.
- [ ] Prevent two backend processes from mutating the same registry through an
  exclusive registry writer lease/lock, reusing an existing mechanism if present.
  An in-memory promise queue alone does not coordinate two processes.
- [ ] Labels on newly created resources include operation ID and generation so
  a timeout between Docker success and storage update is reconcilable.
- [ ] On ambiguous create/start/remove, inspect exact IDs/names/labels before
  deciding the next phase. Missing, foreign, unreachable and malformed are
  distinct results. Never recover using display-name prefixes alone.
- [ ] On restart, reconcile unresolved operations before background launch or
  cleanup can act on their resources. Existing durable deletion tombstones
  remain authoritative; extend their implementation rather than replacing them
  with a second contradictory state machine.

### Projections and compatibility

- [ ] Emit revisioned operation progress only after persistence. Expose a
  snapshot read that works after missed events and renderer remount.
- [ ] Bind old terminal/session handles to the runtime generation, and return
  stale-generation conflicts rather than connecting them to a replacement.
- [ ] Add optional fields with explicit defaults for legacy records. Unknown
  future storage/operation versions must block destructive mutations.
- [ ] Introduce a minimum-writer/schema marker and ship its enforcement before
  activating new formats. Define a supported rollback version floor. Arbitrary
  historical binaries cannot be retroactively made to honor a new marker;
  downgrade support must be limited to versions that implement the check, with
  installer/launcher protection and documented manual-bypass limitations.
- [ ] Regenerate tracked Bun lockfiles if protocol package metadata changes,
  following AGENTS.md even when dependencies did not change.

## Recovery table to implement

| Observed state | Required action |
| --- | --- |
| Intent exists, no matching Docker resource | Retry only the safe, not-yet-performed phase under the same operation ID |
| Create timed out, one exact labeled candidate exists | Adopt that candidate into the operation; do not create another |
| Multiple matching candidates | Mark needs-attention; preserve all data and reject new writers |
| Docker unreachable | Retain state and show retryable uncertainty |
| Candidate belongs to another owner | Refuse operation and preserve the registry record |
| Deletion tombstone exists | Resume its cleanup; block setup, queues and agents from recreating state |
| Client repeats completed request | Return the stored outcome without repeating its effects |

## Verification and exit criteria

- [ ] Unit/contract tests cover malformed/oversized inputs, revision conflicts,
  deduplication, queue ordering and all rows above.
- [ ] Test direct registry invocation and gateway invocation separately; strict
  mode existing tests remain green and production gets equivalent protection.
- [ ] Inject process death after intent, Docker success and pointer persistence.
  Restart with the same data directory and verify one authoritative outcome.
- [ ] Run a two-backend writer test against a fixture registry; exactly one
  writer must be admitted. Foreign data directories remain independently usable.
- [ ] Unmount/reconnect while an operation is pending and reconstruct status
  from the snapshot without repeating the request.

Ship additive schema and readers before switching every writer. Rollback may
disable new mutations while preserving their operation records; it must not
allow an older writer to ignore them. Exit when every mutating command passes
through this boundary and recovery is proven with real Docker identities.
