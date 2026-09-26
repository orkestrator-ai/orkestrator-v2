# 03 — Bound aggregate state without losing recovery metadata

Status: Planned.  
Depends on: [02](02-mandatory-persistence-and-dispatch-barriers.md).  
Finding: INC-03.  
Next: [04](04-durable-session-lifecycle-acknowledgements.md).

## Target behavior

Several individually valid transcripts cannot silently stop publication of the
whole Cursor bridge. Persist a bounded recovery snapshot, shedding reconstructible
display content first. If essential metadata itself cannot fit, fail mandatory
admission explicitly while preserving the previous valid file.

## Owners and constraints

- [Cursor persistence](../../../../bridges/cursor-bridge/src/persistence.ts):
  aggregate serialization, record projection, and load/restore.
- [Cursor limits](../../../../bridges/cursor-bridge/src/config.ts) and
  [transcript budgeting](../../../../bridges/cursor-bridge/src/transcript.ts).
- [Cursor public snapshots](../../../../bridges/cursor-bridge/src/public.ts).
- [Pi persistence](../../../../bridges/pi-bridge/src/persistence.ts): comparison
  for transcript shedding, not an implementation to copy without checking cost.

Keep the existing 32 MiB published-file ceiling unless measurement justifies a
separate reviewed change. Raising it to hide the aggregate bug is not a fix.
Prefer the existing single-file format plus bounded projection over introducing
a storage migration into this correctness work.

## Classify persisted state before dropping anything

| Category | Examples | Policy |
| --- | --- | --- |
| Recovery identity | Bridge ID, client key, provider agent ID, execution policy | Preserve |
| Dispatch evidence | Prompt/steer records, uncertain outcomes, run fences | Preserve within an explicit safe retention policy |
| User selections | Composer choices and explicit session metadata | Preserve; bound individual values |
| Display transcript | Message text, rendered parts, display-only tool payloads | First candidate for shedding |
| Cached summaries/results | Structured results, todos, model metadata, usage | Classify per consumer; never assume these are disposable |

In particular, a structured workflow result may be the only answer a pipeline
will read after restart. Audit its consumer before trimming it. Transcript
shedding alone cannot promise that every possible essential-state payload fits.

## Implementation tasks

- [ ] Introduce a pure budget/projection helper, preferably in a focused Cursor
  module, that constructs the persisted snapshot without mutating live sessions.
- [ ] Measure serialized UTF-8 bytes, including JSON escaping and envelope
  overhead. Character counts and unescaped source-text sizes are insufficient.
- [ ] Give serialization an explicit scratch-memory bound. Avoid first building
  an arbitrarily large all-session string merely to discover it exceeds the file
  limit. Bound individual record encoding and stop accumulating at the aggregate
  budget, or use a bounded writer with a bounded metadata pass.
- [ ] Compute a stable shedding order: oldest `lastAccessed` first, with a
  deterministic tie-breaker. Work on copied persisted records, not the live
  message arrays currently feeding a tab.
- [ ] Drop or tail-trim display transcripts until the complete serialized
  snapshot fits. Prefer a simple whole-transcript first version if partial
  retention would complicate byte accounting or cursor correctness.
- [ ] Update persisted `droppedMessages`, truncation flags, and omitted counts
  coherently. Do not silently reset the absolute message index to zero. Ensure
  old renderer cursors recover from the authoritative truncated snapshot.
- [ ] Preserve provider identity so an empty rendered copy can still attach to
  the same conversation. Do not promise full history reconstruction unless the
  actual history loader supplies it; otherwise show an explicit truncated view.
- [ ] If minimal essential state cannot fit, throw a typed budget error before
  provider admission. Leave the last complete state file intact and expose a
  bounded health/notice signal with a practical recovery action.
- [ ] Keep close/cleanup capable of reducing state while new dispatch is refused.
  Do not create a failure mode where users cannot close anything because a
  preliminary growth-producing write is required first.
- [ ] Bound session admission or define refusal when retained recovery metadata
  reaches capacity. Do not evict uncertain journals or silently forget sessions
  solely to admit another one.
- [ ] Make repeated streaming persistence at the limit coalesce. Emit a notice
  on state transitions or a bounded rate, not one raw error per token.

## Serialization approach and performance checks

Separate the calculation into an essential-state pass and an optional transcript
pass. A practical implementation can reserve the encoded essential records first,
then add bounded transcript contributions in retention priority order. If using
the existing projection followed by iterative shedding, establish an admission
bound that also bounds the projection and scratch strings; the 32 MiB final-file
limit alone does not bound those allocations.

Avoid repeatedly `JSON.stringify`-ing the entire aggregate once per dropped
session. Track per-record byte contributions and envelope overhead, then verify
the final result once. Include escaped strings and multibyte text in accounting
tests. Reject any mismatch rather than publish above the cap.

## Recovery and compatibility

- Existing version-1 files under the limit should load unchanged.
- Existing large on-disk files should retain current read limits. Do not bypass
  bounded reading to recover an oversized legacy file automatically.
- An older valid snapshot may lack recent state due to the original bug. Report
  missing/unknown through existing reconciliation; never invent dispatch history.
- If new metadata is indispensable, document its defaults for old files and
  the downgrade behavior before adding it. Additive truncation metadata should
  not require a version bump merely for internal refactoring.

## Regression matrix

Proposed file: `bridges/cursor-bridge/src/persistence-budget.test.ts`.

| Case | Required result |
| --- | --- |
| Three 12 MiB transcripts plus small session | File fits; every essential session identity survives |
| Add a new prepared dispatch at aggregate limit | Record is published before provider invocation |
| Exact boundary and boundary plus one byte | Deterministic fit versus shedding/failure |
| Escaped/multibyte content | Actual file bytes obey the configured bound |
| Same access timestamp for multiple sessions | Stable retention order |
| Persisted copy shed while tab is active | Live transcript remains intact |
| Fresh process loads a shed transcript | Explicit truncation and correct base index; same provider identity |
| Essential metadata alone overflows | Mandatory barrier rejects; old file stays valid |
| Close a session after refusal | Space can be reclaimed and later publication succeeds |
| Repeated saturated streaming updates | Bounded queue, diagnostics, and scratch allocation |

Use lowered test-only limits for most cases, plus one real-default boundary
fixture. Do not increase environment-configurable production ceilings merely to
make tests easy. Validate any test seam cannot raise a reviewed production cap.

## Acceptance

- [ ] Aggregate size never produces a successful no-op write.
- [ ] Current identity, selection, and journal state survive publication/restart.
- [ ] Display shedding is explicit and does not mutate the live transcript.
- [ ] Essential overflow blocks new side effects while allowing recovery actions.
- [ ] Byte/count limits also bound intermediate work and diagnostics.
- [ ] Budget tests, existing persistence/transcript tests, and Cursor typecheck pass.
- [ ] Backend projection tests cover truncated authoritative rehydration if its
  payload shape changes; required browser QA is included in step 11.

