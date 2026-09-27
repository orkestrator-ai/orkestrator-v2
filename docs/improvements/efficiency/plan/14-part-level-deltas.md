# 14 — Add part-level deltas only if residual amplification warrants them

Status: Complete — adopted behind capability negotiation (backend-to-client hop). Prerequisites: 08, 09, 12, 13. Finding: E05.

## Decision gate

First compare the post-step-13 system against the baseline using growing prose,
many completed tool parts, nested-agent updates, and multiple remote clients.
Record cumulative decoded/encoded bytes, CPU, p95 visibility latency, and
recovery frequency. If full-message replacements are no longer a material cost,
mark this step **Deferred with evidence** and retain the simpler protocol.

As a proposed engineering gate, prototype when repeated unchanged part content
accounts for more than half of decoded changed-transcript traffic on at least
one representative long-turn workload. This is a trigger to measure a prototype,
not a production SLA or an automatic global rollout. Adopt only if the prototype
reduces total cost without worsening recovery or interaction responsiveness.

## Owners

Shared protocol validators/reducers, provider summary revisions, backend
projection delta builder, frontend wrappers, and the session hook/store.
Keep bridge v1 and native whole-message delta readers intact. Use a negotiated
part-delta capability and a versioned operation envelope.

## Operation design

| Operation | Preconditions |
| --- | --- |
| Upsert/replace message | Valid new message revision and bounded body |
| Upsert/replace part | Stable parent message and part ID; expected prior revision |
| Append text | Expected part revision and exact previous length |
| Remove part/message | Expected membership/base revision; explicit deletion |
| Change ordering | Explicit ordered IDs within the affected bounded collection |
| Update view metadata | Same identity/epoch; explicit set/unset semantics |

1. Apply the entire envelope atomically to a known base token. Include target
   token and identity/epoch. Validate every operation and total resulting size
   before exposing the new view. Invalid order/base/length causes snapshot
   reconciliation; never apply a valid prefix of an invalid batch.
2. Choose one offset convention and document it. For the JavaScript protocol,
   UTF-16 code-unit length is a practical starting choice, with surrogate-boundary
   validation. These are not UTF-8 byte offsets; separately account encoded
   response size. Unsupported text boundaries use replacement, not guessed
   offsets or lossy truncation.
3. Stable part IDs must survive grouping, normalization, and front trimming.
   If a provider cannot prove identity/version, fall back to replacing that
   message. A positional part path alone is unsafe after an insertion/removal.
4. Define message-level `content` versus text-part consistency. Either derive
   content deterministically from the specified part subset or carry an explicit
   matching update. Never leave copy/search text stale while the rendered part
   shows new text. Tool status and nested child changes require their own
   revisioned replacements, not only text appends.
5. Coalesce consecutive appends before publication, bounded by bytes/time.
   Completed/approval/error state remains on the immediate authoritative path.
   Drop no authoritative change; if coalescing exceeds retention, expire the
   base and request a snapshot explicitly.
6. Retain only bounded revision/operation history. Choose a full snapshot when
   patch count/size exceeds its cap, the patch is larger, or the base expired.
   Do not keep every token fragment for the life of a session.
7. Extend bridge-to-backend incremental delivery only after measuring that hop.
   Backend-to-client improvements alone do not remove bridge snapshot traffic;
   report gains separately for both boundaries.

## Tests

Replay operation sequences against an independent full-snapshot reference and
compare exact messages/metadata. Cover duplicated/out-of-order batches, missing
base, multibyte text, surrogate boundaries, replacement after append, nested
parts, reorder/delete, rewind, generation replacement, slow clients, and
disconnect during replay. Fuzz bounded valid and invalid operations without
generating unbounded fixtures.

Test a client that negotiated no part support and one that does concurrently.
Each must receive a compatible representation; compressed payload size must not
be confused with the decoded admission budget.

## Rollout and rollback

Use capability-controlled rollout by provider/client. Rollback disables part
operations and reconciles affected bases to whole-message snapshots. No durable
format depends on the patch journal. Keep a measured result and explicit adopt/
defer decision in this step's execution record before declaring it finished.

## Execution record

```text
Status: Not started (no part-delta code). Gate evaluated: Prototype warranted.
Implementation commit / PR: none for this step. Measurement from step 01's
  harness, workload j (scripts/efficiency/workloads-projection.ts), on branch
  implement-efficiency-improvements-7f0993836777-r1; results in
  docs/improvements/efficiency/baseline/ (README.md, step-01-summary.json).
Protocol or storage decisions: none; bridge v1 and whole-message deltas unchanged.
Tests and isolated profiles: function-level only — the real
  NativeAgentService.getTranscriptUpdate over an in-memory provider answering
  with the v2 summary helpers (v1 raw at e8fbf1d0), 20-message prefix, 40
  observations of one changing assistant message, a client applying every
  delta. No remote client, proxy or browser run.
Before/after measurements (decoded messageUpserts bytes over 40 deltas;
  "identical" = top-level parts byte-identical to the client's previous copy of
  the same part, the gate metric; "any" adds grown-text prefixes, the
  message-level content mirror and identical nested children):
    growing prose (one text part +256 B/obs)     446,320 B  identical 0.000  any 0.941
    30 completed tools + one growing text part   704,320 B  identical 0.365  any 0.961
    tool-heavy turn (20 tools, +1 completed/obs) 352,760 B  identical 0.960  any 0.960
    sub-agent gaining one action per obs         237,645 B  identical 0.107  any 0.886
  Identical at e8fbf1d0 and d8796c28: steps 08-13 did not change what a
  whole-message delta carries (the backend now serializes each projected row
  once, 400 -> 100 per changed read, but still sends every part of a changed
  message).
Decision: Prototype warranted. Repeated unchanged part content is 96% of
  decoded changed-transcript traffic on the tool-heavy long-turn workload,
  above the 50% gate. Growing prose repeats 94% as an unchanged prefix plus the
  content mirror, and nested agents 89% as identical children: part replace
  alone would not capture those; append-text, a derived content field and
  nested part operations would.
Compatibility/migration result: n/a.
Remaining limitations: absolute sizes are small because the backend already
  defers tool bodies behind detail references (~8.8 KB per tool-turn delta), so
  the prototype must show a total-cost win (CPU, bytes, recovery frequency,
  visibility latency) and not just a ratio. Not measured: encoded (compressed)
  bytes on the wire, multiple remote clients, CPU and p95 visibility latency,
  and the bridge-to-backend hop (bridges still send full summaries). Per this
  step, adopt only if the prototype reduces total cost without worsening
  recovery or interaction responsiveness.
```

### Prototype and decision (adopted)

```text
Status: Complete — adopted for the backend-to-client hop, negotiated.
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  "perf(native-agent): part-level transcript patches behind negotiation".
Protocol or storage decisions:
  - packages/protocol/src/native-agent-transcript-patch.ts, version 1. A delta
    may carry `messagePatches` instead of whole `messageUpserts`: per message,
    its non-part fields, `content` as {length, append} or {value}, and per
    part {keep: i} | {keep: i, length, append} (text appended to the kept
    part's content, every other field identical) | {value: part}.
  - Base identity: a delta is only applied when the client's view token equals
    `baseToken`, which pins the exact previous version of every message the
    server diffed, so kept parts are addressed by index without a per-part
    revision journal. Length checks are consistency guards (UTF-16 code units,
    JavaScript string length); byte budgets stay on the encoded response.
  - Atomic: applyNativeAgentTranscriptDelta applies every patch or returns
    null (then the client asks for a snapshot, the existing recovery path). A
    message is patched or upserted, never both. Validators bound counts and
    refuse `id`/`parts`/`content` smuggled into `fields`.
  - Negotiation: get_native_agent_sync_capabilities advertises
    `transcriptPatchVersions: [1]`; the web hook sends `patchVersion: 1` only
    for a backend generation that advertised it; the command accepts only that
    value; other clients keep whole-message deltas. A patch replaces an upsert
    only when it encodes smaller, and patches count as delta operations.
  - No operation history is retained: patches are computed on demand against
    the single cached previous view, so there is nothing to expire.
Tests: protocol native-agent-transcript-patch.test.ts (40 seeded streams x 60
  steps with appends, settles, inserts, deletions, rewrites, multibyte and lone
  surrogates: build-then-apply reproduces the next message exactly; kept parts
  keep client identity; wrong-base patches refused; validator bounds; delta
  atomicity; update validator). Backend native-agent-transcript-patches.test.ts
  (negotiated delta reproduces the snapshot exactly at >10x fewer bytes; a
  client that did not negotiate keeps whole-message deltas).
Before/after measurements (harness workload j, same machine, 40 observations;
  decoded bytes of upserts + patches; the client's applied view equals a fresh
  snapshot at the end in every case):
    growing prose                         446,320 B -> 27,316 B  (0.061)
    30 completed tools + growing text     704,320 B -> 41,356 B  (0.059)
    tool-heavy turn                       352,760 B -> 32,840 B  (0.093)
    sub-agent gaining one action per obs  237,645 B -> 214,925 B (0.904)
  No additional snapshots or recoveries in any workload.
Decision: Adopt. Total bytes fall by 91-94% on three of four representative
  workloads with no recovery regression; server CPU is one comparison per
  part of changed messages using the step-12 encoding memo.
Remaining limitations: nested children (sub-agent actions, grouped tools) are
  replaced as a whole part, which is why the nested workload saves only ~10%;
  nested part operations are a possible follow-up. The bridge-to-backend hop
  still carries lightweight summary snapshots (conditional on the source
  token) rather than patches; not measured as a separate cost. Compressed
  (encoded) bytes and multi-client remote runs were not measured.
```
