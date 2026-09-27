# 04 — Make Cursor persistence bounds and dispatch barriers trustworthy

Status: Complete — the encoding cache across writes was declined (no trustworthy mutation key); see the record. Prerequisite: 01; use step 02 accounting when available. Finding: E02. Priority: urgent.

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

## Execution record

```text
Status: Complete (encoding cache across writes declined; see limitations)
Implementation commit / PR: PR #853 (typed budget refusal, real barrier promise,
  admission-before-drain, barrier caller audit) plus this change on branch
  implement-efficiency-improvements-7f0993836777-r1 (residuals below).
Protocol or storage decisions: see "Implemented here" below. Persisted schema is
  unchanged (version 1); truncation fields keep their meaning.
Tests and isolated profiles: focused bun suites only (listed below); no
  Electron/Docker profile was needed (no user-visible UI change).
Before/after measurements: structural only — each essential record is now
  encoded once per write (was twice for kept sessions) and each message at most
  once; restore no longer re-encodes every transcript.
Compatibility/migration result: old files load unchanged; new files load in
  older bridges (same fields; key order within a record differs, which JSON
  readers ignore). Leftover `state.json.tmp` from older versions is swept.
Remaining limitations: listed below.
```

### What PR #853 had already delivered (verified at `e8fbf1d0`)

`serializeWithinBudget` charges essential records first and throws a typed
`persistence-budget-exceeded` when they alone overflow; `persistBarrier`
returns the real commit promise and rejects on failure; a barrier joins only a
write whose snapshot has not been taken; `drainPersistence` closes admission
before its final write; every `persistBarrier` caller in `http.ts` refuses
dispatch on failure before the SDK is called.

### Implemented here

1. **Unique temporary files.** Each write creates
   `state.json.<pid>.<seq>.<random>.tmp` beside the state file with
   `flag: "wx"`, mode 0600. Any failure before the rename unlinks it (except
   `EEXIST`, which is not ours). A bounded sweep (first write of the process,
   then at most every 10 minutes; at most 32 deletions) removes this module's
   leftover names: own-pid names immediately (writes are serialized, so none is
   in flight), other-pid and legacy `state.json.tmp` names only once older than
   5 minutes, so an overlapping successor/predecessor is never disturbed.
2. **Durability.** Write → `fsync` the temporary file → rename → `fsync` the
   directory. Directory-flush `EISDIR`/`EPERM`/`EINVAL`/`ENOTSUP` are ignored
   (platforms/filesystems that cannot flush a directory); any other directory
   flush error rejects the barrier even though the rename happened (fail
   closed: the caller asked for a durable write). **Coverage:** a resolved
   barrier is process-crash durable on every platform (atomic rename of a
   complete file) and power-loss durable on Linux. On macOS `fsync` does not
   flush the drive cache (Node exposes no `F_FULLFSYNC`); on Windows and some
   network filesystems directory durability is the filesystem's. Documented on
   `persistNow` and in AGENTS.md.
3. **Newest bounded tail instead of an empty transcript.** Sessions are visited
   newest `lastAccessed` first (id tiebreak); each keeps its newest whole
   messages that fit the remaining bytes and stops at the first that does not,
   so the retained copy is always a contiguous tail. Older sessions are still
   offered whatever room remains. The persisted copy carries exact metadata:
   `droppedMessages` and `droppedParts` advance by exactly what was left out,
   `transcriptTruncated: true`, `revision + 1`; a complete copy keeps live
   values. Live arrays are never mutated. Each message is encoded once
   (`JSON.stringify` + UTF-8 byte length, commas/brackets exact); only four
   scalar truncation fields are re-encoded per candidate. The final byte count
   is still verified against the accounting.
4. **Cross-write encoding cache: deliberately not implemented.** Audit result:
   no trustworthy mutation key exists. `revision` is the rendered-transcript
   counter only — prompt/steer journal writes (`setPromptJournal`), structured
   results, composer, status/error, usage and `subagentLimitExceeded` change
   without it, and `hydrateHistory` pushes messages across awaits before its
   single bump. A per-persist counter bumped by `schedulePersist` callers is
   also insufficient because not every mutation schedules a write immediately.
   Keying a cache on either could publish stale recovery state, so every write
   re-encodes (once per record/message, see 3). Revisit with an explicit
   dirty-tracking API or the per-session file split (steps 06/07).
5. **Failure notices.** A failure episode now remembers which notice text each
   session was shown. A later transition in the same episode (e.g. the
   largest-session set changes) records a notice and bumps `revision` only for
   sessions whose notice text changes; bystanders keep their transcript token.
   The bump is kept for changed sessions because error notices are projected
   as transcript advisories that clients re-read on a revision change. A
   success ends the episode, so a later failure notifies everyone again.
6. **Restore.** `uncheckedTranscriptBytes` is charged with the byte size of the
   file just read (an upper bound for any one transcript in it) instead of
   re-encoding every restored transcript; sessions with no messages are charged
   0. The first read route bounds and measures exactly, so a restored oversized
   transcript is still bounded before it is served (tested).
7. **Tests.** New `persistence-durability.test.ts`; updated
   `persistence-budget.test.ts` (32 MiB fixture now expects the oldest session
   to keep a one-message tail with `droppedMessages` 41/`droppedParts` 8, and
   the prepared-at-limit case to drop that tail rather than the next-oldest
   whole transcript) and `http-dispatch-durability.test.ts` (rename failure
   now asserts no temporary file is left, instead of reading the fixed
   `.tmp`). Plan test coverage:
   - three large sessions over the aggregate 32 MiB: essentials persist,
     restart shows explicit truncated tails (`persistence-budget.test.ts`);
   - essential overflow: barrier rejects; prompt answers 503
     `persistence-budget-exceeded` with SDK send count 0 and the file
     unchanged (`persistence-durability.test.ts`, plus existing budget test);
   - write, flush, rename and permission failures injected separately; previous
     snapshot byte-identical and loadable; directory-flush unsupported vs. real
     failure;
   - prepared dispatch behind an already-running write: `send` happens only
     after a second publication, whose file contains the request as ambiguous;
   - shutdown racing a settling run: one writer at a time, final file valid and
     contains the completed journal, no unhandled rejection. Cursor has no
     parked approvals (`/approvals` is empty by contract), so there is no
     approval-denial leg to race;
   - partial-tail retention with multibyte/escaped text at every budget from
     full to minimal, exact one-byte boundary, older sessions using leftover
     room, and "each message encoded at most once, essential read once".
   Existing crash/reload-after-prepare/acceptance tests
   (`http-dispatch-durability.test.ts`, `http-prompt-outcome.test.ts`) are
   unchanged and pass.

### Commands run

- `mise run test:logged -- --name br-all2 -- mise exec -- bun test ./bridges/cursor-bridge/src --parallel=2 --only-failures`
  → PASS (616 pass, 4 skip, 0 fail across 34 files).
- New file repeated 5× (`persistence-durability.test.ts`) → 14/14 each run.
- `mise exec -- bun run --cwd bridges/cursor-bridge typecheck` → exit 0.
- `mise run format`, `mise run format:check` → clean; `mise run lint` → exit 0,
  no warnings in `bridges/cursor-bridge`.
- Not run: full `mise run test` (orchestrator runs it after merge); no isolated
  Electron/Docker QA (no UI change).

### Remaining limitations

- No cross-write encoding reuse (item 4 above); a scheduled write still
  re-encodes every session once. Bounded by the 32 MiB file budget and write
  coalescing.
- Power-loss durability is best-effort outside Linux (macOS drive cache,
  Windows directory flush).
- A directory-flush failure after a successful rename reports failure although
  the new file is visible; a restart then reads the prepared record as
  ambiguous (conservative, never a double dispatch).
