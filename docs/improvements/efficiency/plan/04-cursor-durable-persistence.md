# 04 — Make Cursor persistence bounds and dispatch barriers trustworthy

Status: Not started. Prerequisite: 01; use step 02 accounting when available.
Finding: E02. Priority: urgent.

## Outcome

An oversized display cache must not stop metadata/journal writes. A durability
barrier must resolve only after the state it covers has been committed. If
essential state cannot be persisted, dispatch fails before the SDK receives it.

## Owners

- [Persistence](../../../../bridges/cursor-bridge/src/persistence.ts),
  [HTTP dispatch/steer routes](../../../../bridges/cursor-bridge/src/http.ts),
  [prompt lifecycle](../../../../bridges/cursor-bridge/src/prompt.ts), and state.
- Existing `persistence.test.ts`, `http.test.ts`, prompt/journal test owners.
- [Pi persistence](../../../../bridges/pi-bridge/src/persistence.ts) provides the
  explicit barrier and metadata-preserving shedding pattern.

## Implementation

1. Inventory essential persisted fields: session and provider IDs, execution
   policy, composer selections needed for resume, prompt/steer journal entries,
   structured results, and any irreversible dispatch evidence. Classify rendered
   transcript arrays separately. Do not call a structured result an expendable
   cache merely because it is large.
2. Replace the silent over-budget return with deliberate bounded construction.
   Measure session metadata and transcript candidates once, select retained
   display windows oldest-accessed first, and serialize the chosen payload.
   Mark dropped history explicitly. Do not mutate live session arrays just to
   fit a persisted display copy.
3. Establish Cursor recovery semantics before shedding the only display copy:
   use existing SDK recovery for sessions that have a resumable provider ID;
   otherwise persist an explicit incomplete state and retain the newest bounded
   tail. Never claim removed history is recoverable if the provider cannot
   supply it. Essential metadata overflow is a real failure, not a trim target.
4. Separate best-effort scheduling from the barrier promise. The queue may own
   a caught promise for later scheduling, but return the original commit promise
   to barrier callers so failure is observable. A barrier schedules an explicit
   write after all preceding mutations; merely waiting for an older scheduled
   write is insufficient.
5. Track a mutation/commit sequence internally or capture the barrier's required
   revision. A mutation during an in-flight write must trigger a subsequent
   write and cannot be acknowledged by completion of the older snapshot.
6. Make shutdown close admission before draining. Serialize the final write with
   the same queue and use unique temporary names; no overlapping truncation of
   one shared `.tmp` file. Document whether the barrier covers process-crash
   durability or also power-loss durability, and use appropriate flush/rename
   behavior for the supported platforms.
7. Audit every `persistBarrier` caller: prepared prompt, steer, terminal journal
   mutation, and session creation. Before SDK handoff, a failed barrier must
   result in no send. After possible handoff, retain ambiguous/dispatched
   semantics; never reclassify a lost response as safe to retry automatically.
8. Bound queued write work by coalescing best-effort updates. Admission failures
   get a clear domain error. Log counts/error classes only, not journal payloads.

## Tests and failure injection

- Three individually valid large sessions exceed aggregate 32 MiB; essential
  fields persist and restart while display trimming is explicit.
- Essential metadata itself exceeds the bound; barrier rejects and SDK send
  count remains zero.
- Inject temporary write, flush, rename, and permission failures separately.
  Verify the previous valid snapshot remains readable.
- Place a new prepared dispatch behind an already-running write. Prove the
  barrier waits for the write containing that request ID.
- Crash/reload after prepare, after SDK acceptance, and before terminal journal
  commit. Same-ID retries reconcile; distinct IDs cannot bypass parked work.
- Race shutdown with a settling run and approval denial; no concurrent final
  writer and no unhandled rejection.

## Migration and delivery

Keep the current persisted schema for the first fix if possible. Truncation
metadata is already represented; changing its meaning needs tests for old files.
A later per-session file split is optional and should use a separately reviewed
migration, not delay this correction. Never restore the silent-success barrier
as a compatibility fallback.
