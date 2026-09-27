# 05 — Persist operation receipts and enforce idempotency

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

A caller can recover the result of one admitted mutation after losing its
response or restarting the CLI/backend. Repeating the same key and intent
returns the original operation; changing the intent conflicts. Deletion or
retention cannot silently turn a replay into a new execution.

## Owners and starting points

- [Storage service](../../../../apps/backend/src/core/storage.ts) and
  [environment deduplication](../../../../apps/backend/src/core/storage-projects.ts).
- [Native dispatch](../../../../apps/backend/src/core/native-agent-service-dispatch.ts)
  and [native storage](../../../../apps/backend/src/core/storage-native.ts).
- [Lifecycle tracking](../../../../apps/backend/src/core/environment-lifecycle-tasks.ts).
- [Control jobs](../../../../apps/backend/src/core/commands-registry-control.ts).
- [Concurrent creation test](../../../../apps/backend/src/core/commands-registry-environments-control.test.ts).

## Work

1. Inventory existing environment, prompt, steer, workflow, and terminal journals.
   Decide which are authoritative for execution and which public receipt fields
   reference them. Add a focused operation store only for missing public identity,
   admission, and correlation; do not create a competing provider dispatch engine.
2. Define the key scope: backend installation, authenticated authority, action,
   target scope, and caller request ID. Canonicalize validated caller intent for
   fingerprinting, including attachment digests if later supported. Persist
   resolved inherited defaults separately on first admission so a replay after
   a settings change returns the original action rather than changing its model.
3. Atomically check/reuse/conflict the key, create its operation ID, and publish
   mandatory state before side effects. Prove concurrent calls converge. A
   publication failure must prevent execution and propagate to the caller.
   Reuse actual storage locking; do not assume a process-local map covers every
   existing multi-instance fixture or shared storage writer.
4. Persist resource IDs as soon as they become known, stage transitions, safe
   failure details, provider correlation, revisions/generation, and terminal
   results. Return partial success with created resource IDs when later stages
   fail. Observation updates must not erase unresolved execution evidence.
5. Define restart handling per stage: queued-before-execution, side-effect-in-flight,
   acknowledged, terminal. Reconcile uncertain external effects using positive
   evidence. If that evidence is unavailable, retain unknown/interrupted state;
   never restart a possibly submitted prompt or GitHub create automatically.
6. Specify retention numerically before shipping: maximum active/terminal count,
   bytes per record and aggregate, terminal retention, and collection cadence.
   Never evict an unresolved operation to admit new work; return capacity errors.
   Resource deletion must preserve enough separate receipt/tombstone state.
7. Solve expiry explicitly. A missing arbitrary string key after garbage
   collection cannot be distinguished from a new key. Use a bounded admission
   namespace/epoch with an expiry fence, or an equivalent proven mechanism.
   Publish its lifetime in capabilities, persist it in client receipts, reject
   retired namespaces, and require explicit new intent to obtain a new one.
   Retain active records beyond ordinary terminal retention. Do not claim
   unbounded exactly-once execution or silently accept an expired replay.
8. Add `run get` by operation ID and a lookup by the original scoped request key
   for lost responses. Unknown/not-found/history-expired are distinct results.
   Public receipt reads must not touch provider liveness or contain prompt text.
9. Before a CLI mutation is sent, save a bounded private local receipt with the
   selected installation, request key/namespace, and action identity. Update it
   with the returned operation/resource IDs. A client receipt records intent,
   not proof of acceptance; never print a secret payload or auto-resubmit it.
10. Keep old environment/request records readable. Legacy records without a
    fingerprint cannot safely validate changed intent: return an explicit
    legacy-recovery limitation rather than inventing equivalence or redispatching.

## Verification

Test same-key concurrent requests, changed payloads, settings changes between
retries, two writers, publication failure, crash before and after external
submission, dropped acknowledgements, partial creation, resource deletion,
retention expiry, clock/epoch boundaries, capacity exhaustion, corrupted state,
and backend installation mismatch. Use real temporary files and controlled
external-effect counters. Restart from the published state without graceful
shutdown to prove recovery.

Verify a CLI killed after submission retains enough identity to query safely,
and that neither a missing local receipt nor an expired backend record causes
automatic submission under a fresh key.

## Acceptance and handoff

- [x] One key admits one canonical intent and conflicting reuse is rejected.
- [x] Acknowledged mandatory records survive the tested restart boundary.
- [x] Lost responses and partial failures remain queryable by stable identity.
- [x] No uncertainty, deletion, or expiry path enables automatic duplicate execution.
- [x] Store limits reject safely without forgetting unresolved work.

Document the actual durability scope: process-restart recovery is not a claim
of power-loss durability without filesystem synchronization evidence. Rollback
must retain receipt data and expose unresolved records for recovery; do not
delete the store when withdrawing a CLI feature.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- Operation store: [`storage-public-operations.ts`](../../../../apps/backend/src/core/storage-public-operations.ts)
  (`public-operations/` index + per-namespace files under the cross-process
  mutation lock; strict reads). Ledger/dispatch/reconciler under
  `apps/backend/src/core/public-api/`.
- Durability scope: records are written before side effects and survive a
  process restart (tested); power-loss durability is not claimed.
- Tests: `public-api-projects.test.ts` (replay, conflict, concurrent
  convergence, restart replay, retired namespace, corrupt store),
  `public-api-recovery.test.ts` (two writers, full namespace, dead generation,
  ambiguous GitHub creation stays unknown). Client receipts saved before
  sending (`client-transport.test.ts`).
