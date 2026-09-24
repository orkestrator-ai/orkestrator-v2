# 10 — Bound retained validation evidence

Status: Not started. Depends on: 01–03. Finding: T8.

[Plan index](00-index.md) · [Previous](09-platform-qualification.md) ·
[Next](11-flakes-and-test-quality.md)

## Outcome

Keep long-lived environments from accumulating unlimited validation evidence.
Preserve active runs and retained package references, represent expiration
explicitly, and refuse additional capture when protected evidence exhausts the
budget. Never delete a file merely because it resembles a test artifact.

## Owners and separation

- `packages/protocol/src/review-artifacts.ts`: exact artifact layout/identity.
- Backend `review-validation-worker.ts`, `review-validation-service.ts`,
  `review-validation-artifacts.ts`, `review-package.ts`, and `commands-review.ts`.
- `storage-reviews.ts` and build-pipeline persistence: references/pins.
- Environment stop/delete lifecycle: cancellation and exact-root cleanup.
- `ReviewValidationStatus.tsx`: output availability/expiration presentation.

Introduce a focused retention owner, proposed
`apps/backend/src/core/review-artifact-retention.ts`, with environment-side
operations for local and Docker paths. Do not put cleanup timers in React or
reuse the repository runner's unrelated temporary-log pruning function.

## Proposed initial policy

These are implementation starting values to validate, not existing settings:

| Budget | Initial value/policy |
| --- | --- |
| Retained capture bytes per environment | 1 GiB, plus a separately bounded small metadata budget |
| Per-run capture | Preserve existing 256 MiB total and 32 MiB per stream |
| Unpinned completed-run count | 20 most recent within byte budget |
| Unpinned age | 30 days maximum |
| Retention metadata | Bounded index; initial ceiling 1,000 run records including compact expiration records |
| Active/pinned evidence | Never automatically deleted; blocks new admission if necessary |
| Unknown ownership or unreadable metadata | Protected until reconciled; never guessed disposable |

Prune oldest eligible unpinned runs when any limit requires it. Age alone does
not make a pinned package disposable. A user retaining many packages may reach
the quota; expose the reason and an explicit release/export action later if
needed, rather than silently breaking references.

## Durable model and concurrency

- [ ] Add a versioned private environment evidence index recording run identity,
      exact owned directory, lifecycle, byte accounting, timestamps, and pins.
- [ ] Define pin owners: active worker, current review round, active reviewer,
      retained workflow/package, and explicit retained/exported evidence where
      supported. Derive pins from authoritative stored references.
- [ ] Register ownership before capture begins. Maintain an atomic quota
      reservation for the maximum capture allocation of each admitted run.
      Release unused reservation after verified finalization.
- [ ] Count physical retained bytes plus outstanding reservations, preventing
      concurrent producers from each seeing the same free quota.
- [ ] Serialize pin changes, quota admission, and deletion claims under an
      environment-scoped durable lock/journal. Reconcile actual files after
      crashes; no renderer or backend connection must remain alive.
- [ ] Coordinate with the environment worker: a disconnected/stale run is
      protected until its ownership/process state is resolved. Heartbeat expiry
      alone must not authorize deleting output a live command may still use.
- [ ] Protect a package before publishing its reference to a controller. Release
      obsolete pins only after replacement/retirement is durably persisted.
- [ ] Preserve sealed manifest bytes. Track retention/availability in a separate
      bounded catalog, not by rewriting a package and invalidating its digest.

## Pruning algorithm

1. Read bounded metadata and reconcile active/protected owners.
2. Enumerate only the known artifact root without following symlinks. Bound
   entries, bytes inspected, and operation time; use resumable batches if needed.
3. Select completed, owned, unpinned runs using age/count/byte policy.
4. Atomically claim each candidate under the same pin/admission coordination.
   Recheck references before destructive work; a concurrent new pin must win
   or block until the claim is resolved.
5. Move eligible content to an exact owned deletion area where supported,
   persist the deleting state, and remove it with bounded work.
6. Commit compact availability metadata and release byte accounting. Recover
   interrupted deleting states idempotently on the next pass.
7. If protected evidence still leaves insufficient capacity, return an explicit
   evidence-storage-unavailable result before command dispatch.

This describes the required transaction ordering. Confirm the final algorithm
against local and container filesystem semantics before choosing rename/lock
primitives. Do not rely on a filesystem mode bit as an ownership proof.

## Legacy migration and expired reads

- [ ] Inventory legacy directories lazily with bounded traversal. Existing
      package/run IDs and valid manifests may establish ownership; malformed or
      ambiguous directories remain protected and visible as a limitation.
- [ ] Do not promise an immediate hard bound on pre-existing protected data.
      Record over-budget state and block new capture until policy can be met.
- [ ] Keep enough metadata for a retained workflow to say “evidence expired” or
      “evidence unavailable,” distinct from “command produced no output.”
- [ ] Return typed availability through the output endpoint; the modal must not
      endlessly retry a known expired artifact or convert it into an empty pass.
- [ ] Define metadata compaction: expire only records no retained workflow can
      reference; if all index entries are protected, refuse new admission.
- [ ] Run maintenance on new validation admission and lifecycle reconciliation.
      Add periodic backend maintenance only if measurement shows it is needed;
      it must be bounded and independent of active UI.

## Tests

Use temporary roots and small injected quotas. Cover oldest-first pruning,
count/age limits, partial capture, active/pinned preservation, concurrent pin and
prune, quota reservation races, stale worker uncertainty, crash during deletion,
unreadable index, symlink escape, unexpected files, legacy adoption, expired
output reads, and environment deletion during a run.

For package integrity, preserve a pinned log's digest across maintenance. For
storage pressure, fill the budget with pinned runs and assert a new command is
never spawned. Repeat core lifecycle tests against a Docker fixture.

## Acceptance and rollout

New evidence stays within the admitted budget; protected over-budget legacy
data is reported honestly and prevents further growth. No active/referenced
artifact is silently removed. Restart and reconnect recover the same decisions.

Start with a dry-run inventory mode to report bounded candidate counts/bytes.
Inspect representative environments before enabling deletion. This is a rollout
stage, not a second implementation that may remain indefinitely. Rollback may
disable pruning, but must retain admission limits and never resurrect expired
bytes as if evidence still exists.
