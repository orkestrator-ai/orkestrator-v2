# 14 — Add part-level deltas only if residual amplification warrants them

Status: Not started; benchmark-gated. Prerequisites: 08, 09, 12, 13. Finding: E05.

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
