# 08 — Bound steer history without enabling duplicate delivery

Status: Planned.  
Depends on: [02](02-mandatory-persistence-and-dispatch-barriers.md),
[03](03-aggregate-persistence-budgeting-and-recovery.md).  
Finding: INC-07.

## Target behavior

Cursor's steer records have explicit count and byte bounds both live and after
reload. Exceeding the bound never lets an exact retry be mistaken for a new
instruction. Unknown remains unknown, and the active run can keep executing
even if additional steering must be refused until it settles.

## Owners

- [Cursor steer route](../../../../bridges/cursor-bridge/src/http.ts) and
  [session state](../../../../bridges/cursor-bridge/src/state.ts).
- [Cursor persistence](../../../../bridges/cursor-bridge/src/persistence.ts).
- [Pi retention comparison](../../../../bridges/pi-bridge/src/state.ts).
- [Backend HTTP mapping](../../../../apps/backend/src/core/http-bridge-provider.ts),
  [steer dispatch service](../../../../apps/backend/src/core/native-agent-service-dispatch.ts),
  and [durable storage](../../../../apps/backend/src/core/storage-native.ts).
- [Shared action outcomes](../../../../packages/protocol/src/native-agent.ts).

## The replay problem to solve explicitly

A FIFO `Map.delete(oldest)` is not enough. Although a status probe for an evicted
ID returns `unknown`, the current POST handler treats a missing entry as a new
request. If that entry targeted the still-active run, resending it can deliver
the same steering text twice.

Use the existing `expectedRunId` fence, not an assumption that the backend will
never retry. Verify that restored/recovered run IDs are stable and correctly
identified before evicting records belonging to a run that might become active
again. The guarantee is for an exact attempt, including its expected run;
changing the target run is a new operation, not recovery of the old one.

## Recommended retention design

- Start with a maximum of 256 retained records per session to match the existing
  prompt/Pi scale, and an explicit encoded-byte budget, proposed at 512 KiB.
  Confirm that the permitted request/run ID lengths and record envelope fit.
- Protect every record that could still target the current or recovering run,
  including completed/delivered records needed to reject exact retries.
- Evict only records fenced to runs proven no longer targetable, preserving a
  bounded recent-history tail when space permits. Probe evicted IDs as unknown.
- If protected records alone fill the budget, reject a new distinct steer
  before journal mutation/provider invocation. Do not evict an active-run record
  to make room. Known duplicates still receive their existing result.
- If recovery cannot establish which legacy entries are safe to drop, mark
  steering unavailable for that recovered run and preserve a bounded persisted
  uncertainty fence. Do not truncate then treat forgotten IDs as fresh requests.

The exact field names are an implementation choice. The admission/refusal and
restart guarantees above are acceptance requirements. Any alternative, such as
signed run-scoped sequence tokens, must demonstrate the same guarantees and
justify its larger protocol change.

## Implementation tasks

- [ ] Add reviewed count/byte limits to Cursor config. Bound decoded record
  strings during restoration as well as live request parsing.
- [ ] Introduce one journal owner/helper for admission, update, lookup, retention,
  and hydration. Replace direct `steerJournal.set` in HTTP and load paths.
- [ ] Track encoded byte contributions on insert/update/remove; an update must
  not double-charge the same key. Include identifier and digest overhead.
- [ ] Check duplicate ID plus input digest plus expected run before admitting
  anything new. A duplicate with changed payload or run remains a conflict.
- [ ] Reserve capacity synchronously before awaiting publication. Two concurrent
  fresh requests must not both pass a capacity check for the last slot.
- [ ] Preserve prepared/ambiguous entries while their target is still possible.
  Publish any necessary fence/retention metadata before permitting a side effect.
- [ ] Add an explicit capacity rejection: proposed HTTP 429 with
  `outcome: "rejected"`, `reason: "steer-capacity-exceeded"`, the request ID,
  and a bounded “wait for this turn to finish” message. This is a new contract,
  not a shape the current provider already understands. Never report idle or
  applied merely because the bridge refused an operation it knows was not sent.
- [ ] Extend the normalized action outcome with a typed rejection and bounded
  reason/error fields. Update HTTP parsing, storage, service, and renderer
  consumers exhaustively. Accept definitive refusal only for the verified
  response shape/status associated with this request; generic 429/5xx responses
  and malformed bodies retain conservative handling.
- [ ] Update `dispatchNativeAgentSteerOnce` explicitly: a definitive rejected
  outcome clears its pending record, scrubs pending backups, and does not add
  the ID to delivered history. The current implementation catches every thrown
  dispatch error as unknown, so throwing `PromptRejectedError` alone cannot
  implement this behavior. Preserve that conservative catch for other errors.
- [ ] A lost capacity-rejection response may still leave the backend uncertain.
  Do not add an unbounded ledger of rejected IDs to avoid that. Preserve the
  existing reconciliation/discard path and never infer `absent` from no entry.
- [ ] On run settlement/change, release eligible protected history and make
  capacity available. On resumed live runs, retain/fence the corresponding
  records before reporting steering available.
- [ ] Hydrate legacy oversized journals under bounded read/parse limits. Preserve
  the current file-read cap and record which active-run history became uncertain.
- [ ] Expose any saturation/degraded-state notice through backend snapshots,
  with count/limit metadata only; do not log input digests or user identifiers
  unless existing diagnostics policy explicitly permits those fields.

## Regression matrix

Proposed file: `bridges/cursor-bridge/src/steer-journal.test.ts`, plus focused
HTTP/provider/storage cases.

| Case | Required result |
| --- | --- |
| 300 requests against one active run | Count/bytes stay bounded; overflow is explicitly refused before delivery |
| Retry earliest active-run request after capacity | No second SDK delivery; original acknowledgement/conflict survives |
| Retry same ID with different text | Conflict, never new delivery |
| Run changes after history evicted | Old expected-run retry cannot steer the new run |
| Restart and recover the same active run | Protected records/fence prevent forgotten-request replay |
| Long allowed IDs hit byte cap before count cap | Admission refuses at byte limit |
| Two concurrent requests take last slot | At most one reserves it |
| Journal publication fails | No SDK steer; capacity accounting remains consistent |
| Delivered result publication fails | Unknown/delivered evidence preserved; no accidental retry |
| Legacy oversized/corrupt entries | Bounded load and explicit uncertainty, no silent fresh-ID interpretation |
| Backend receives definitive capacity rejection | Correct pending-attempt cleanup and actionable feedback |
| Backend loses that response | Existing uncertain recovery remains available |

## Validation and acceptance

- [ ] Live and restored steer state obey both bounds.
- [ ] Exact-key replay is safe at saturation, after eviction, and after recovery.
- [ ] A full steer journal does not stop the running agent or ordinary status reads.
- [ ] Backend storage never treats generic network/server errors as safe rejection.
- [ ] New journal/HTTP tests, Cursor typecheck, affected backend/protocol tests,
  and shared typechecks pass through the standard logged workflow.
- [ ] If a new notice/control outcome is visible, isolated browser QA covers
  saturation, inactive-tab return, reload, and recovery without losing the draft.

Do not claim infinite deduplication history with a finite journal. Document the
run fence and retention guarantee, and keep expired history conservatively
unknown. Pi's simple bound is a useful comparison, not proof that blindly
copying its eviction policy solves Cursor's replay contract.
