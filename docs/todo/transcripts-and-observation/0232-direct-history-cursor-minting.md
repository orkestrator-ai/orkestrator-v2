# Mint history cursors directly so joined sync-v1 paging can retire

Checked against `main` at `930189337` (2026-10-26).

Found while closing
[0050](0050-transcript-history-efficiency.md) item 3, which was meant to
retire joined `sync-v1` history paging once the support window passed
bridges without the v2 transcript contract. It cannot retire yet: the path
is not only an older-bridge path. The renderer itself mints its first history
cursor through it whenever the progressive view carries no direct cursor, and
that costs a whole transcript read on bridges that page directly.

## Current state

- The progressive transcript view carries a direct cursor
  (`historyPaging: "direct"`) only when the provider's snapshot has a
  `historyCursor` and the view still starts at or before the snapshot's first
  row (`viewStartsAtSnapshot` in `native-agent-transcript-projection.ts`). A
  backend byte bound that drops leading rows the provider sent, or an
  OpenCode window the view does not hold whole, leaves it without one.
- The renderer adopts only direct cursors
  (`useNativeAgentSession.ts`, around `adoptDirectCursor`). Without one,
  **Load earlier messages** (`loadEarlierMessages`) calls
  `getNativeAgentProjectionUpdate` with `forceSnapshot: true` to mint a
  cursor, and pages with `getNativeAgentMessagePage`. The same happens after a
  prefix collapse discards held cursors.
- `getProjectionUpdate` refreshes the `sync-v1` projection: for an HTTP
  bridge that is `interactiveSnapshot`, a whole `/messages` read. It mints only
  v1 cursors (`firstHistoryCursor`), so `getMessagePage` then serves joined
  pages from the backend's own copy (`history.joined-v1-page`) even for a
  bridge or OpenCode that pages directly. Pinned by `a pageable provider's
  sync-v1 projection still mints a joined v1 cursor` in
  `apps/backend/src/core/native-agent-service-summary-transcripts.test.ts`.
- Every in-process provider (OpenCode) and every bridge in the support window
  serves direct pages, so no provider needs joined paging for itself.
- Renderers in the support window (v2.21.0 onwards) take the same mint path,
  so the backend has to keep answering it until the floor passes the
  renderer release that stops using it
  ([version-compatibility.md](../../architecture/version-compatibility.md#register)).

## Outstanding work

1. Give the renderer a direct cursor wherever the provider can page: either
   have the progressive view keep a direct cursor when the backend's bound
   drops leading rows (name the first row it kept, through the provider's page
   route), or add a direct-cursor mint that reads the provider's summary
   window, not the whole `sync-v1` projection. Decide which with a measurement
   of how often each no-cursor case happens.
2. Make `loadEarlierMessages` use it and stop calling the `sync-v1`
   projection for paging. Cover a byte-bounded view, an OpenCode window, a
   prefix collapse and a held place across the first page.
3. Keep serving v1 cursors for older renderers, counted by
   `history.joined-v1-page`, and record the retirement condition in the
   register: the floor at or above the first Stable release with item 2.
4. Once the condition holds and the counter is quiet on the machines you can
   reach, remove joined paging, the v1 cursor namespace and
   `projectionHistory`.

## Constraints and rationale

- A cursor must never leave a gap: a direct cursor is valid only while the
  view starts at or before the position it names (the reason for
  `viewStartsAtSnapshot`).
- Load earlier messages must keep the reader's place (`useHeldTranscriptPlace.ts`).
- The `sync-v1` projection protocol itself stays while renderers in the
  window use it for live updates; only its paging role is in scope.

## Related

- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md)
  item 3: the check that found this.
- [native-transcripts.md](../../architecture/native-transcripts.md#retained-compatibility-paths).
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md):
  the support window.
