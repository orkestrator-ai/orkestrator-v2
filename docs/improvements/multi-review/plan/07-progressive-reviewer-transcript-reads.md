# Step 07 — Progressive reviewer transcript reads

Status: 🟨 Implemented on branch; pending review and merge

Depends on: Steps 01 and 03

## Outcome

Make an active reviewer tab request a bounded authoritative transcript snapshot
using a source token. If nothing changed, return metadata only. If it changed,
transfer a byte- and count-bounded tail directly from the provider snapshot
surface instead of fetching complete history and slicing it in the backend.

Polling remains a recovery backstop; provider/resource events may prompt an
immediate refresh. Hidden or unmounted tabs perform no UI polling and do not
affect the background workflow.

## Protocol shape

Replace the always-full `MultiReviewReviewerTranscript` command response with a
backward-compatible request and explicit union. Names are illustrative; settle
them in the protocol review.

```typescript
interface ReviewerTranscriptRequest {
  workflowId: string;
  reviewerId: string;
  knownSourceToken?: string;
  maxMessages?: number;
  maxBytes?: number;
}

type ReviewerTranscriptResponse =
  | { kind: "unchanged"; sourceToken: string; projection: ReviewerRuntimeProjection }
  | { kind: "snapshot"; sourceToken: string; messages: unknown[]; truncated: boolean;
      projection: ReviewerRuntimeProjection };
```

The backend chooses/caps limits; clients cannot request unbounded history. Keep
workflow phase, reviewer status, report/error, dispatch state, progress/stall,
and timing fields in the small projection for both response variants so
controls remain authoritative even when messages are unchanged.

`sourceToken` is opaque, bounded, and generation-aware. A session replacement,
bridge generation change, expired cursor, or unknown token returns a full
bounded snapshot with a new token. Never derive security decisions from it.

## Backend implementation

- [ ] Add request/response types and strict validators in
  `packages/protocol/src/multi-review.ts`, with count/string limits.
- [ ] Update `commands-registry-reviews.ts` and command dependency types to
  accept an optional token and bounded limits.
- [ ] Change `MultiReviewService.reviewerTranscript` to call the provider's
  bounded `transcriptSnapshot` surface when available. Pass the token through
  rather than calling an unbounded `messages()` and slicing to 500 afterward.
- [ ] For older providers/bridges, use a compatibility fallback with a hard
  response-byte guard. Record fallback use so it can be retired; do not claim it
  is efficient merely because the returned array was sliced locally.
- [ ] Cap both message count and encoded bytes. If one message exceeds the byte
  limit, return the existing safe truncation representation rather than the
  complete payload.
- [ ] Treat malformed/oversize provider responses as a bounded transcript error,
  not a workflow failure. The reviewer workflow continues in the backend.
- [ ] Ensure source tokens and snapshots are scoped to session/reviewer
  generation so an old response cannot replace a new session's UI.
- [ ] Keep transcript content out of resource events, metrics, and logs.

## Web implementation

- [ ] Update the native command wrapper and
  `MultiReviewReviewerTab.tsx` to retain the last source token and messages for
  the mounted reviewer generation.
- [ ] On `unchanged`, update the small projection but keep existing messages.
- [ ] On `snapshot`, atomically replace the bounded message list and token.
  Do not append blindly: snapshots are authoritative and may represent a
  truncated/rebased tail.
- [ ] Reset token/messages when workflow ID, reviewer ID, session generation,
  or environment changes.
- [ ] Keep the existing active-tab-only poll as a slow backstop. Use a relevant
  resource/provider event to request an immediate read, coalescing bursts into
  one in-flight request plus one rerun.
- [ ] Abort/ignore stale UI requests on unmount without cancelling the backend
  review. Response-generation checks prevent late replacement.
- [ ] Show a non-fatal “transcript temporarily unavailable” state while keeping
  report/status controls sourced from the last authoritative projection.

## Consistency and recovery

The command response is a snapshot, not an event replay. It must recover after:

- the tab was inactive through the whole review;
- a renderer reload or resource-event gap;
- a backend or bridge reconnect;
- a reviewer session replacement;
- token expiry or a truncated provider history; and
- the workflow reaching terminal state between request and response.

The backend reads the current workflow before and after the awaited provider
call (or checks a generation captured before it) and discards a transcript that
belongs to a replaced reviewer.

## Tests

- Protocol tests reject negative/excessive limits, oversized tokens, and invalid
  union members.
- Backend tests prove the provider receives bounded snapshot arguments and an
  unchanged token avoids message transfer.
- Byte-limit tests use one huge message, many small messages, and multibyte UTF-8
  content.
- Generation-race tests replace a reviewer while a snapshot is pending.
- Web tests cover unchanged, snapshot replace, token reset, stale response,
  hidden tab, resource-event burst, and transient error.
- Browser QA: open a running reviewer, switch environment for several minutes,
  return after completion, and verify current status, transcript tail, report,
  and recovery controls.
- Baseline comparison records provider bytes, backend response bytes, calls per
  minute, and full-fallback count.

## Acceptance criteria

- Normal unchanged polls carry no transcript messages.
- Changed responses never exceed the backend count/byte budgets.
- Providers with snapshot support do not transfer complete history to let the
  backend slice it.
- Inactive UI causes zero transcript-tab polling while background review
  continues.
- Reconnect/gap/token expiry returns a correct bounded authoritative snapshot.
- Report and recovery controls remain correct even when transcript reading
  fails.

## Implementation record

- Protocol (`multi-review.ts`): `MultiReviewReviewerTranscript` gains optional
  `transcript: "snapshot" | "unchanged"`, `sourceToken` and `truncated`. The
  new `isMultiReviewReviewerTranscriptRequest` validates an optional
  `knownSourceToken` of at most 512 characters.
- Backwards compatible both ways: an old renderer never sends a token and
  always gets a snapshot; an old backend's response has no `transcript` field
  and is treated as a snapshot.
- Backend (`multi-review-reviewer-transcript.ts`): uses the provider's
  `transcriptSnapshot` with 500 messages / 2 MiB, forwarding the provider token
  only when it belongs to the current reviewer session. Tokens are wrapped
  with a session-scope hash, so a replaced session never matches.
- The backend enforces the count and UTF-8 byte bounds itself. It never cuts a
  message; a message that alone exceeds the bound is omitted and marked
  truncated. Providers without the surface use a bounded compatibility read,
  counted as `transcript.ui_fallback`.
- `MultiReviewService.reviewerTranscript` re-reads the workflow after the
  provider call and drops a transcript from a replaced session. Status,
  report and recovery fields are always current.
- Web: `MultiReviewReviewerTab` keeps the last token, folds `unchanged` into
  the messages already shown (`mergeMultiReviewReviewerTranscript`), and
  resets the token when the view is fenced. A new workflow checkpoint (the
  workflow revision moving) triggers an immediate read. The interval poll
  remains the backstop; inactive tabs neither poll nor react.
- Tests: `multi-review-reviewer-transcript.test.ts` (count and byte bounds,
  multibyte, a single huge message, token scoping, foreign/oversize tokens,
  fallback); `multi-review-service-efficiency.test.ts` (unchanged/snapshot
  through the service); `MultiReviewReviewerTab.transcript.test.tsx`
  (merge, token echo, checkpoint wake, inactive tab).
- Not done: the manual real-stack inactive-environment browser QA; see step 10.
