# 02 — Lifecycle authority and durable operations

Status: Implemented on branch; awaiting review. Dependencies: [01](01-immediate-data-loss-safeguards.md).
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

- [x] Introduce a backend service, provisionally `container-lifecycle-service.ts`,
  attached to `CommandContext`. Keep low-level exec/inspect helpers free of
  imports that create cycles with registry composition.
- [x] Inventory all paths that create, start, stop, rename, remove or adopt
  containers. Include direct commands, deletion after PR merge, control tools,
  setup, credential propagation and isolated-profile cleanup.
- [x] Require app/owner labels and matching persisted association for assigned
  resources in production as well as strict profiles. A supplied container ID
  is not proof of ownership. Follow-up volume/network operations use the same
  owner, environment and role validation.
- [x] Handle pre-label resources by explicit adoption with a reviewed identity;
  do not auto-adopt every unlabeled container across multiple installations.
  An existing trusted record can be migration evidence, but mismatches conflict.
- [x] Keep legacy command names as adapters into the service. Raw removal of an
  assigned runtime resolves to the relevant environment operation, preserving
  step 01's data protection.

### Serialization and persistence

- [x] Reuse the existing per-environment queue and shutdown admission tracker.
  Define and test one lock order: environment operation before owned-resource
  mutation; no service should re-enter its own queued public method.
  Namespace lock keys by registry owner as well as environment ID so separate
  test/embedded contexts cannot accidentally share in-memory operation state.
- [x] Add revision-checked storage updates through the current queued/atomic
  storage mechanism. Persist operation intent before invoking Docker.
- [x] Prevent two backend processes from mutating the same registry through an
  exclusive registry writer lease/lock, reusing an existing mechanism if present.
  An in-memory promise queue alone does not coordinate two processes.
- [x] Labels on newly created resources include operation ID and generation so
  a timeout between Docker success and storage update is reconcilable.
- [x] On ambiguous create/start/remove, inspect exact IDs/names/labels before
  deciding the next phase. Missing, foreign, unreachable and malformed are
  distinct results. Never recover using display-name prefixes alone.
- [x] On restart, reconcile unresolved operations before background launch or
  cleanup can act on their resources. Existing durable deletion tombstones
  remain authoritative; extend their implementation rather than replacing them
  with a second contradictory state machine.

### Projections and compatibility

- [x] Emit revisioned operation progress only after persistence. Expose a
  snapshot read that works after missed events and renderer remount.
- [x] Bind old terminal/session handles to the runtime generation, and return
  stale-generation conflicts rather than connecting them to a replacement.
- [x] Add optional fields with explicit defaults for legacy records. Unknown
  future storage/operation versions must block destructive mutations.
- [x] Introduce a minimum-writer/schema marker and ship its enforcement before
  activating new formats. Define a supported rollback version floor. Arbitrary
  historical binaries cannot be retroactively made to honor a new marker;
  downgrade support must be limited to versions that implement the check, with
  installer/launcher protection and documented manual-bypass limitations.
- [x] Regenerate tracked Bun lockfiles if protocol package metadata changes,
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

- [x] Unit/contract tests cover malformed/oversized inputs, revision conflicts,
  deduplication, queue ordering and all rows above.
- [x] Test direct registry invocation and gateway invocation separately; strict
  mode existing tests remain green and production gets equivalent protection.
- [x] Inject process death after intent, Docker success and pointer persistence.
  Restart with the same data directory and verify one authoritative outcome.
- [x] Run a two-backend writer test against a fixture registry; exactly one
  writer must be admitted. Foreign data directories remain independently usable.
- [ ] Unmount/reconnect while an operation is pending and reconstruct status
  from the snapshot without repeating the request. (Backend snapshot and
  replay are covered; the real-browser cycle is part of step 14.)

Ship additive schema and readers before switching every writer. Rollback may
disable new mutations while preserving their operation records; it must not
allow an older writer to ignore them. Exit when every mutating command passes
through this boundary and recovery is proven with real Docker identities.

## Implementation record

- **Contract.** `packages/protocol/src/container-lifecycle.ts`: runtime and
  storage identities, `ContainerOperationRecord`, outcomes, bounded parser,
  `ContainerLifecycleSnapshot`, UUIDv7 operation ids and
  `parseContainerMutationIdentity`. Living doc:
  [container-lifecycle.md](../../../architecture/container-lifecycle.md).
- **Storage.** The record lives on the environment (`containerLifecycle`), so
  it shares the queued atomic environment writes and deletion tombstones; the
  storage layer rejects a record over 64 KiB. Clients get the safe snapshot.
- **Service.** `container-lifecycle-service.ts`: begin (dedupe, horizon,
  revision, stale-operation reconciliation, persist before effect), advance,
  complete, `runContainerOperation`, ownership resolution, exact-label
  candidate search, startup reconciliation and needs-attention resolution.
- **Writers.** Start/create, stop and discard run as operations; create labels
  the container with operation id and generation and adopts an exact candidate
  after an ambiguous failure. Raw `docker_*` commands and `provision_environment`
  are adapters; `reattach_container` is verified adoption.
- **Ownership.** Checked in every profile, before admission. Decision: the
  registry wrapper accepts an exact persisted association without a probe
  outside strict profiles (the association was written by this registry after
  create/adoption); lifecycle mutations always verify labels.
- **Writer lease and schema floor.** `registry-writer-lease.ts`; acquired in
  `OrkestratorBackend.init()` before reconciliation, released on shutdown.
  Decision: writer version 1, rollback floor is the first release with the
  marker, unreadable marker blocks writes.
- **Generation binding.** `expectedRuntimeGeneration` on any command answers
  `runtime-changed` for a replaced runtime.
- **Tests.** `tests/unit/electron/container-lifecycle-service.test.ts`
  (dedupe, bounds/horizon, revision conflicts, unsupported schema, every
  recovery-table row including crash after intent / after Docker success /
  after pointer persistence, ownership verdicts, lease exclusivity and
  reclamation, schema marker, generation binding); updated registry, lifecycle,
  status, PR, terminal and process fixtures to model the ownership probe.
- **Limitations.** Real Docker identity recovery and the browser
  unmount/reconnect cycle are exercised in step 14. Credential propagation and
  isolated-profile cleanup still use their existing owner-scoped paths.
