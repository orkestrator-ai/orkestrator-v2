# 15 — Reuse conditional transcripts for reviewers and workflow progress

Status: Complete — conditional, bounded progress probes over the newest eight messages (e79798e3); lightweight reviewer windows with on-demand details and "load earlier" history pages (c150f423). No live multi-review run. Prerequisites: 09, 11. Finding: E13.

## Outcome

Reviewer displays no longer fetch whole legacy transcripts every four seconds.
Supervisors detect meaningful progress without reading megabytes just to hash
one tail. The backend continues monitoring workflows while all views are closed.

## Owners

- [Reviewer service](../../../../apps/backend/src/core/multi-review-service.ts).
- [Progress tracker](../../../../apps/backend/src/core/multi-review-progress.ts).
- [Reviewer tab](../../../../apps/web/src/components/review/MultiReviewReviewerTab.tsx).
- [Pipeline supervisor](../../../../apps/backend/src/core/build-pipeline-service-supervisor.ts)
  and review-fanout consumers of `provider.messages`.
- Native provider contracts/adapters and existing reviewer/progress tests.

## Implementation

1. Inventory display/progress calls to `provider.messages`, including reviewer,
   consolidation, fix-session usage, build review fanout, and feature-planning
   consumers. Classify each as presentation, progress, usage, or semantic result
   extraction. A lightweight summary cannot replace raw data used to recover a
   structured report or exact task evidence.
2. Add a conditional reviewer transcript response carrying a stable view
   identity, token, bounded summary window, and history capability. Reuse the
   native transcript service/adapters without registering a second competing
   agent session or changing workflow ownership/interactions.
3. Update `MultiReviewReviewerTab` to retain its valid base, install snapshots or
   whole-message deltas, and fetch earlier history/details through the common
   endpoints. Preserve read-only presentation, hidden machine-output filtering,
   reviewer attribution, fork/navigation behavior, and existing action controls.
4. Retain the four-second recovery cadence initially; unchanged replies are the
   first optimization. Share concurrent reads and retain scoped invalidations.
   Step 17 controls visibility/backoff so each view does not invent a separate
   scheduling policy. Finished and gone workflows must still stop polling.
5. Define progress observations using source generation, history epoch, and a
   dedicated meaningful-content progress revision/digest. Generic bridge
   revisions may advance for token usage, access time, or status-only events;
   those cannot automatically reset the no-progress clock.
6. Include nested-agent/tool progress and late updates to earlier parts, not
   only the last row. A saturated/truncated display buffer must not make real
   backend work look stalled; the progress signal can advance independently
   of whether display bytes were retained.
7. Preserve persisted progress baselines. When a generation changes, establish
   the new comparison base explicitly without manufacturing a content change.
   Failed/throttled probes mean “nothing learned”; the existing durable stall
   clock continues according to current policy.
8. Fall back to the new bounded tail endpoint when a meaningful progress signal
   is unavailable. Retain a measured legacy fallback only for older bridges.
   Do not widen the 60-second progress-probe cadence into transcript polling on
   every supervisor tick.

## Compatibility and tests

Add capability negotiation for the reviewer read model before changing clients.
Old callers continue receiving their capped snapshot. New clients cache an
unsupported capability per backend generation, not per failed request.

Test running/pending/finished/gone states; inactive view return; stale result
after reviewer replacement; concurrent reviewers sharing a provider; manual
refresh fencing; tool detail expansion; and content hidden for structured
reviews. Prove progress advances for nested activity but not access-time churn.
Run warning/abandonment tests with failed reads and backend restart.

## Acceptance

An unchanged new reviewer read causes no legacy full-history fetch. A changed
read transfers the bounded changed representation. Supervision remains correct
without any reviewer component mounted. Document each semantic consumer left
on an exact/raw path and its bounded read strategy rather than claiming all
`messages()` calls can be eliminated.

## Execution record

```text
Status: Complete (no isolated real-stack multi-review run; see gap closure below)
Implementation commit / PR: worktree branch worktree-agent-a2874c745cf3eb33a
  (commit "perf(workflows): conditional, bounded transcript progress probes")
Protocol or storage decisions:
  - New apps/backend/src/core/transcript-progress.ts. A due progress probe
    calls transcriptSnapshot({limit: 1, targetBytes: 64 KiB,
    representation: "summary", knownSourceToken}). `unchanged` reuses the
    digest the known token was minted with (no body). A snapshot is digested
    as: base = sha256(representation, generation, historyEpoch); content =
    sha256(historyStartIndex + count, count, omittedParts, tail row). The
    source token, revision, title and freshness are excluded, so usage /
    access-time churn is not progress. Summary rows carry detail locators with
    body digests, so nested child/tool output changes are progress.
  - A tail row the byte target cut (omittedParts > 0) is completed from the
    exact newest message (caller's shared read, else messages({limit: 1}))
    and hashed at the snapshot's position/base; an uncut row hashes
    identically. Without this a raw v1 row whose sub-agent task part exceeds
    the target would hide nested progress and look wedged. Cost: one legacy
    read only when the source moved AND the raw tail is oversized.
  - Providers without transcriptSnapshot keep messages({limit: 1}) and the
    exact legacy digest (sha256(legacyTranscriptFingerprint)), so their
    persisted baselines remain comparable.
  - Versioning without a protocol change: every persisted progressDigest
    validator (multi-review, review-fanout, looped structuredWait) accepts
    only 64 lowercase hex, so version-2 digests are marker "70320d16" +
    16-hex base + 40-hex content (still valid for a downgraded backend).
    compareProgressDigests: no prior -> baseline; equal -> unchanged; same
    base -> changed; different base (legacy format, generation/epoch change,
    representation change after a bridge upgrade) -> rebased. A rebase
    replaces the digest and reports neither progress nor a new baseline
    (ProgressObservation.rebased), so commitProgressObservation evaluates the
    durable clock unchanged. Failed/throttled probes remain "nothing learned";
    an `unchanged` answer without a known source is treated as a failed read.
  - Known source tokens (<= 1 KiB) live in the tracker entry with the digest
    they produced (bounded by MAX_TRACKED_SESSIONS, dropped by forget/clear)
    and, for looped review, in a 256-entry map keyed by workflow+dispatch,
    cleared in releaseWorkflowResources. 60 s probe cadence is unchanged.
  - OpenCode transcriptSnapshot no longer seeds its stream cache from a read
    shorter than OPEN_CODE_MESSAGE_HISTORY_LIMIT (a one-message probe would
    otherwise become the "current" transcript every display read serves).
    Display reads (100/500) are unaffected.
  - Efficiency operations added: transcript.progress_unchanged,
    transcript.progress_snapshot, transcript.progress_fallback (review-fanout).
Consumer inventory (provider.messages):
  progress  multi-review-service observeFixSessionProgress (prep/consolidation/
            fix) -> conditional sample; usage read shared only as fallback.
  progress  review-fanout observeReviewerProgress (multi-review + build
            reviewers) -> conditional sample; PassTranscriptReader serves only
            the fallback/completion and usage reads.
  progress  build-pipeline-review-fanout observeConsolidationProgress ->
            conditional sample.
  progress  looped-review structured-wait liveness -> conditional sample,
            applyProgressSample (rebase does not move progressAt).
  usage     multi-review readFixSessionMessages, review-fanout usage reads:
            only OpenCode implements usageFromMessages; its usageMessageLimit
            (64) bounds the read. Unchanged; started only when a probe is due
            (running path) or on terminal/settling observations as before.
  present.  multi-review-reviewer-transcript fallback -> now
            messages({limit: 500}) plus the 2 MiB guard; truncated is reported
            when a full window came back. The display stays on the raw
            representation (it renders tool bodies inline; no detail path).
  present.  review-fanout mirrorTranscript (host onReviewerObserved, build
            pipeline): whole-transcript read; owned by step 16 (E14).
  present.  build-pipeline-service-supervisor refreshTranscript: step 16.
  semantic  native-agent-service-prompt first-prompt naming: emptiness check
            -> messages({limit: 1}) (exact semantics, bounded on OpenCode).
  semantic  feature-planning messages(): assistant-id baseline and result
            extraction need the complete transcript; left exact (Codex HTTP
            legacy read). Bounding needs a cursor/ID contract, not a tail.
  semantic  native-agent projection/reconciliation reads (limit liveWindow or
            OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT) and the non-interactive
            projection fallback: native-agent files, outside this step.
  semantic  opencode-provider child-session hydration: limit
            OPENCODE_SUBAGENT_MESSAGE_LIMIT; unchanged.
Activity batch (item 4 of the brief): advanceInteractiveFix reads one session
  per workflow under that workflow's fence; observeActivityBatch would need a
  cross-workflow coalescer adding latency to fenced decisions. The same
  session is a native-agent tab whose background sweep already batches it.
  Documented in place; not changed.
Tests and isolated profiles:
  - transcript-progress.test.ts: unchanged probe sends the known token, makes
    no messages() call, throttled probes read nothing; token churn is not
    progress; nested child tool output change (real summarizeBridgeMessage)
    is progress; append is progress; generation change rebases (commit ->
    evaluate, progressAt kept) then later movement counts; representation
    change rebases; old-format persisted baseline rebases without progress
    or a new clock and is replaced by a validator-valid digest; persisted v2
    digest compares after restart; failed read = nothing learned and keeps
    the known token; unexpected unchanged = nothing learned; cut row is
    completed and hashes like the uncut row; fallback digest is byte-identical
    to the legacy one; tracker-less clock semantics.
  - transcript-progress-http.test.ts (real HttpBridgeProvider + shared v1/v2
    envelopes): v1 and v2 unchanged probes are < 512 B with no /messages read;
    churn not progress; v2 700 KiB nested output change is progress with
    every body < 16 KiB and no /messages; v1 oversized tail is completed only
    when the source moved and detects the hidden nested change; 404 bridge
    keeps the legacy fallback.
  - multi-review-service-efficiency.test.ts: service-level reviewer probes use
    limit-1 summary snapshots, >= 2 unchanged answers, zero messages() calls,
    persisted digests valid, movement resets progressAt.
  - multi-review-reviewer-transcript.test.ts: fallback asks for limit 500;
    a limit-honouring fallback still reports possible older history.
  - opencode-snapshots.test.ts: short reads do not seed the stream cache.
  - Existing warning/abandonment/failed-read suites (multi-review-service,
    review-fanout-*, build-pipeline-review-fanout, looped-review-*) pass
    unchanged. Full backend suite: `bun test --cwd apps/backend ... ./src
    --parallel=2` PASS; backend typecheck, format:check, lint PASS.
Before/after measurements (deterministic tests, not a profiled machine):
  unchanged due probe: before = full legacy /messages body (700 KiB+ in the
  fixture); after = one conditional reply < 512 B. Changed probe (v2 summary):
  < 16 KiB. Changed probe with an oversized raw v1 tail: 64 KiB window plus
  one legacy read (the pre-change cost).
Compatibility/migration result: persisted legacy digests rebase once without
  progress; providers without snapshots keep legacy digests; digests remain
  64-hex so older backends still load the workflows.
Remaining limitations:
  - Superseded: all five bridges serve v2 summaries since d8796c28. A raw v1
    probe whose tail row exceeds 64 KiB still pays one legacy read
    (unchanged probes never do).
  - A v1 row with no parts whose content exceeds 64 KiB is head-trimmed; a
    rewrite confined to the trimmed head is not seen (appends are).
  - Superseded: the reviewer view uses summary windows with detail
    expansion (below) and history pages (gap closure). The 4 s conditional
    poll from 8c262ba0/0ba8628e remains its refresh cadence.
  - A snapshot answered from a bridge cache (`freshness: cached`) is digested
    like a current one.
```

### Reviewer view: lightweight windows and on-demand details (orchestrator)

```text
Implementation commit: "perf(review): lightweight reviewer transcripts with on-demand tool details"
Decisions:
  - multi-review-reviewer-transcript.ts asks summary-capable providers (those
    exposing transcriptDetail) for `representation: "summary"`; each summary
    part's locator becomes the row's `detailRef` (nested parts included) and
    the bridge-internal `detail` field is dropped. Raw providers keep inline
    bodies exactly as before.
  - New command get_multi_review_reviewer_tool_details(workflowId, reviewerId,
    detailRef) resolves a reference only against that reviewer's own provider
    session (locator shape validated, ≤ 2 KiB); a changed or trimmed body is
    reported "no longer available", never swapped for a newer one; too-large
    bodies render the existing deferred-limit message.
  - MultiReviewReviewerTab provides the reviewer-scoped loader through
    ToolDetailLoaderContext, so the shared NativeMessage rows expand exactly as
    in native tabs. The pipeline transcript normalizer now keeps `detailRef`,
    `imageDetailRef` and the diff `deferred` flag (bounded).
Tests: multi-review-reviewer-transcript.test.ts (summaries requested and
  locators exposed as detailRef; exact body on expansion; changed body and
  forged reference refused; raw providers unchanged);
  MultiReviewReviewerTab.test.tsx (expanding a deferred row calls the reviewer
  loader with workflow, reviewer and reference).
Remaining limitations: superseded by the gap closure below ("load
  earlier" added).
```

### Gap closure: late progress and reviewer history (e79798e3, c150f423)

```text
Progress over recent messages (plan item 6, e79798e3):
  - The probe digested only the newest message, so a tool result or
    reasoning part landing on an earlier message looked like a stall. It now
    requests the newest 8 messages (one conditional 64 KiB read) and digests
    all of them plus the window end. Unchanged transcripts keep their digest;
    usage/title/access churn is still not progress.
  - An oversized newest message (the bridge trims whole older rows first) is
    completed from the exact read of the last 8 messages, only when the
    source moved.
  - Digest marker 70330d16 (was 70320d16). An older tail-only or unmarked
    digest rebases once without progress; digests stay 64-hex.
  - Providers without snapshots keep the one-message legacy digest.
  - Tests: transcript-progress.test.ts (late update to message N-2 is
    progress for a tool result and a reasoning part; churn unchanged;
    oversized newest still exposes the earlier update; old-version digest
    replaced once without progress, including on the durable clock);
    transcript-progress-http.test.ts (v2 and v1 late earlier tool result is
    progress without a whole-transcript read; v1 byte-dropped head stays
    comparable; v1 oversized newest message).
  - Limitation: an update to a message older than the 8-message window, or
    one dropped from it by the byte cap, is not seen.
Reviewer "load earlier" (plan item 3, c150f423):
  - get_multi_review_reviewer_history_page(workflowId, reviewerId, before,
    limit?, targetBytes?); request cursor <= 1,024 characters, limit 1-200,
    target <= 1 MiB; responses validated on the client.
  - Cursors reuse the native formats: direct (v2) cursors served by one
    provider transcriptPage summary read; joined (v1) cursors name a message
    by digest for providers that cannot page. A direct cursor is minted only
    when the tail's byte bound dropped no leading rows. Every cursor carries
    digests of the reviewer, its provider session and the history epoch: a
    foreign cursor is refused, a replaced session or rewritten history
    answers expired (never an empty or complete page), and a restart during
    the read is re-checked.
  - The joined fallback reads at most 2,000 messages and never more than the
    provider accepts (new optional messageReadLimit; OpenCode 64). A cursor
    minted because the provider reported older history it can no longer
    return pages to "unavailable", not "complete".
  - Tab: "Load earlier messages" control with the native chat tab's
    loading state; dedupe by id; scroll anchoring via the shared helper;
    aged-out rows kept while the live tail still overlaps, pages dropped
    with a notice when it does not or the epoch changed; expired drops pages
    and re-reads a full snapshot for a fresh cursor; at most 2,000 earlier
    messages held.
  - Tests: multi-review-reviewer-transcript.test.ts (direct pages to the
    start with details; rotated epoch and replaced session expire; foreign,
    native and junk cursors refused; joined fallback bounded and expiring on
    rewrite or epoch change; OpenCode ids; bounded-tail provider read limit;
    provider-reported-but-unreturnable history is unavailable);
    multi-review-service.test.ts; commands-state-sync.test.ts (bounds);
    MultiReviewReviewerTab.test.tsx (prepend, dedupe, detail expansion,
    expiry reset, inactive-to-active continuation, unreachable notice);
    backend.test.ts (wrapper validation).
  - Limitations: messages without ids cannot be deduplicated or anchor a
    joined cursor (the tab says so); scroll anchoring centres the anchor
    rather than keeping the pixel offset and is untested in a real browser;
    no live multi-review run, and live paging needs > 100 messages.
```
