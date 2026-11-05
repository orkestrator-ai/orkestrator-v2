# Find inside static documents

## Task analysis

Analysed 2026-11-05 against `main` at `e1f4c875f`, from the work on [4650](4650-static-html-presentation-follow-ups.md) task 2, which made a static report's body searchable once its frame has rendered.

### Tasks

1. **Show the match inside the document**: Find scrolls to the card but highlights nothing in the frame. Status: open.
2. **Index reports that were never shown**: only a mounted frame can report its text. Status: open.
3. **Refresh an open Find bar when text arrives**: matches update on the next query or transcript change. Status: open.

### 1. Show the match inside the document

**Problem.** Find can report "3 of 12" for a word in a report while nothing on screen shows where it is.

**Context.** The matched text sits in a hidden search mirror (`BodySearchRoot` in `ArtifactPartBodies.tsx`), so the highlight is drawn on text that is not displayed. Chart labels behave the same way. The host sends the frame only `render` and `theme`.

**Investigation.** Not attempted. `VirtualizedMessageList` pairs model matches with DOM ranges and reveals a hidden mirror only when it names a `revealKey`, and a document's mirror does not.

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

**Investigation.** Not attempted. `rich-transcripts.md` notes that the static runtime feeds the preview worker image's context digest, so a change there invalidates prepared images and unpublished receipts.

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

**Investigation.** Not attempted.

**Decisions.**

- **Should Find recompute when a body arrives?**
  - **Subscribe, keeping the current match selected (recommended).**
    - Pros: counts and pairing agree as soon as text arrives.
    - Cons: the count changes while the reader is stepping through matches, and the selection has to be tracked by identity rather than by index.
  - **Leave it.**
    - Pros: no change to Find.
    - Cons: the window stays.

## Related

- [4650](4650-static-html-presentation-follow-ups.md): the static document follow-ups this came from.
- [`docs/architecture/rich-transcripts.md`](../../architecture/rich-transcripts.md): Find and static document presentation.
