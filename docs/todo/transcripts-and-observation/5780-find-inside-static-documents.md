# Find inside static documents

## Task analysis

Analysed 2026-11-05 against `main` at `e1f4c875f`, from the work on [4650](4650-static-html-presentation-follow-ups.md) task 2, which made a static report's body searchable once its frame has rendered. Tasks 1 and 3 re-checked and built against `main` at `6e796ca32`; see Assumptions and decisions.

### Tasks

1. **Show the match inside the document**: Find scrolls to the card but highlights nothing in the frame. Status: done (2026-11-05).
2. **Index reports that were never shown**: only a mounted frame can report its text. Status: open.
3. **Refresh an open Find bar when text arrives**: matches update on the next query or transcript change. Status: done (2026-11-05).

### 1. Show the match inside the document

**Problem.** Find can report "3 of 12" for a word in a report while nothing on screen shows where it is.

**Context.** The matched text sits in a hidden search mirror (`BodySearchRoot` in `ArtifactPartBodies.tsx`), so the highlight is drawn on text that is not displayed. Chart labels behave the same way. The host sends the frame only `render` and `theme`.

**Investigation.** `VirtualizedMessageList` pairs model matches with DOM ranges and reveals a hidden mirror only when it names a `revealKey`, and a document's mirror does not. The cost the note under task 2 warns of does not apply to this task: see Assumptions and decisions.

**Decisions.**

- **How should a match be shown?**
  - **Add a host-to-frame message naming the query and active occurrence, and highlight inside the frame (recommended).**
    - Pros: the reader sees the match; the frame's policy (`connect-src 'none'`) gives a query nowhere to go.
    - Cons: widens the channel in the other direction; the frame's text walk and Find's ordinals must agree; a deferred card has no frame to ask.
  - **Keep navigating to the card.**
    - Pros: no channel change.
    - Cons: in a long report the reader has to search again by eye.

### 2. Index reports that were never shown

**Problem.** Find misses text in a report until the reader has reached it in this session, and after a reload until they reach it again.

**Context.** Nothing is read or framed for a block the reader has not reached, deliberately, so that a long history preloads nothing. 4650 listed backend extraction as the alternative to reporting from the frame.

**Investigation.** Not attempted. `rich-transcripts.md` notes that the design runtime (`installDesignRuntime`) feeds `STATIC_RENDERER_HASH` and the preview worker's bundle, and so its context digest, so a change there invalidates prepared images and unpublished receipts. The worker change this task recommends changes the digest whatever else it does: every install with a prepared image is told to prepare it again. The transcript's presentation runtime, which task 1 changed, is not part of that.

**Decisions.**

- **Where should text for an unvisited report come from?**
  - **Extract it at verification, in the preview worker, and store it with the publication (recommended).**
    - Pros: available without a frame, from the same sanitized document; works after a reload.
    - Cons: adds a stored representation; touches the worker; existing publications need a backfill or stay as they are.
  - **Mount frames for unread reports when Find opens.**
    - Pros: no backend change.
    - Cons: reads and frames a whole history on one keystroke, against the frame slot limit.

### 3. Refresh an open Find bar when text arrives

**Problem.** With Find open, a reader who scrolls to a report does not see its body's matches until they edit the query or the transcript changes.

**Context.** `useAgentChatFind` recomputes on its items and query. The search cache now notifies subscribers (`useCachedArtifactSearchBody`), but Find does not subscribe. Until it recomputes, a body's mirror holds DOM ranges the model has not counted, which can shift prose pairing in the same message; chart bodies have the same window.

**Investigation.** The problem held as stated. The stated cost of tracking by identity understated one thing: a body arriving inside a row also moves the matches after it in that row, so neither the row and offset nor the occurrence stay valid.

**Decisions.**

- **Should Find recompute when a body arrives?**
  - **Subscribe, keeping the current match selected (recommended).**
    - Pros: counts and pairing agree as soon as text arrives.
    - Cons: the count changes while the reader is stepping through matches, and the selection has to be tracked by identity rather than by index.
  - **Leave it.**
    - Pros: no change to Find.
    - Cons: the window stays.

## Assumptions and decisions

### Task 1: does the frame message need a digest or receipt invalidation?

No. The check the ticket asked for first came out against the note's wording, which said "the static runtime". There are two runtimes: `installDesignRuntime` verifies, and is what `STATIC_RENDERER_HASH` hashes and what the worker bundles. `installStaticHtmlPresentationRuntime` presents, and only the web client imports it.

Measured by staging the worker context before and after this work: `sha256:98003332ac1f1ac122e0eba4fc47ba2156396bf7cd96c9c329ef362ebedb3a26` both times, with a byte-identical `preview-worker.mjs`. So users rebuild nothing and re-verify nothing, and `preview-worker-context-digest.test.ts` now pins that the presentation runtime stays out of the bundle. `STATIC_HTML_PRESENTATION_RUNTIME_VERSION` went to v3; it is only part of the in-memory read cache key and of no receipt, so at most a document is read again once.

One trap is real. `STATIC_PRESENTATION_POLICY` is in the worker bundle, so adding the query limit to that table would have invalidated every prepared image for a value the worker never reads. As a control, adding it there moved the digest to `sha256:4887bcd5…`. The limit lives in `static-html-presentation.ts`.

### Task 1: how the match is drawn

The recommended option fitted and was built. How to draw it inside the frame was not specified:

- **CSS Custom Highlight API (chosen).**
  - Pros: nothing is written into the document, so the query cannot reach its DOM or be observed by its CSS, its height and text walk do not change, and Find's own highlights already use it.
  - Cons: a browser without it shows no highlight (it still reveals and scrolls). Text hidden only by the document's CSS cannot be shown.
- **Wrap matches in `<mark>`.**
  - Pros: works everywhere.
  - Cons: rewrites the document the receipt verified, can change its layout and height, splits text nodes the walk reads, and puts the matched text under authored CSS selectors.

### Task 1: where the ordinals come from

The text walk now records each character's node and offset, and both the `text` report and Find use that one walk. It replaced regular-expression passes over the assembled string, which could not be mapped back. A test checks the walk against those rules, and another runs the real runtime against `findAgentChatTextMatches`. Sending a character offset instead of an occurrence was not needed, and the ticket names an occurrence.

### Task 1: bringing the match on screen

The ticket asked for a highlight inside the frame. In a report taller than the viewport a highlight off screen leaves the reader searching by eye, which is the problem this task states, so the frame reports the match's box as two numbers (`find-match`, at most ten a second, so stepping quickly cannot trip the channel's flood limit) and the transcript's navigation refines onto it. The reader moving still ends that.

### Task 3: identity of the selection

- **Row, source in the row and offset in that source (chosen).**
  - Pros: exact, and holds no message text, so nothing joins the protected-content clearing.
  - Cons: the projection gains `roots`, and a row with no projection falls back to row and offset.
- **Diff the row's old and new text.**
  - Pros: no projection change, and works for any getter.
  - Cons: ambiguous exactly when it matters. A body that starts like the text after it (both begin with the query) cannot be told from text inserted after that text, so the selection jumps to the wrong match. It also holds row text in state.

The guard against navigating twice to one match moved from `VirtualizedMessageList` into the hook, keyed on this identity. The list's version keyed on the character index, so a body arriving before the match in its row would have pulled a reader who had scrolled away back to it.

## Related

- [4650](4650-static-html-presentation-follow-ups.md): the static document follow-ups this came from.
- [`docs/architecture/rich-transcripts.md`](../../architecture/rich-transcripts.md): Find and static document presentation.
