# Mint history cursors directly so joined sync-v1 paging can retire

Checked against `main` at `930189337` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Direct cursor wherever the provider pages**: keep a direct cursor through a backend byte bound, or add a direct mint from the summary window, chosen by a measurement of the no-cursor cases. Status: open.
2. **`loadEarlierMessages` pages directly**: stop calling the `sync-v1` projection to mint a cursor, with tests for a byte-bounded view, an OpenCode window, a prefix collapse and a held place. Status: open (waits on task 1).
3. **Keep v1 cursors for older renderers and record the condition**: keep serving v1 cursors, counted by `history.joined-v1-page`, with the retirement condition in the register. Status: partly done (the register row exists).
4. **Remove joined paging**: delete joined paging, the v1 cursor namespace and `projectionHistory` once the floor passes the renderer from task 2. Status: blocked (on task 2 shipping in a Stable release and the support window).

### 1. Direct cursor wherever the provider pages

**Problem.** When the progressive view has no direct cursor, the first **Load earlier messages** click forces a whole `sync-v1` projection: for an HTTP bridge that is a whole `/messages` read, even though every supported bridge and OpenCode can page directly. Long sessions pay this on the first click, and after every prefix collapse.

**Context.** Found while closing 0050 item 3, which assumed joined paging was only an older-bridge path. The constraint is that a cursor must never leave a gap: a direct cursor is valid only while the view starts at or before the row it names.

**Investigation.** The description holds at HEAD. `viewStartsAtSnapshot` is at `apps/backend/src/core/native-agent-transcript-projection.ts:2452`. With no `historyStartIndex` (OpenCode) it requires every snapshot row and `droppedProjectedMessages === 0` (`:2429`, `:2454`); otherwise it needs `boundedStartIndex <= snapshot.historyStartIndex`. The direct cursor and `historyPaging: "direct"` are set at `:2456` and `:2600`. Neither file has changed in this area since `930189337`. No metric tells the two no-cursor causes apart: `ProgressiveReadMetric` (`native-agent-progressive-metrics.ts`) records outcome, tier and `joined`, but not why no direct cursor was issued. The measurement the item asks for therefore needs a new counter first.

**Decisions.**

- **How should the no-cursor cases be measured?**
  - **Add a content-free reason counter where `directHistoryCursor` is undefined (recommended).** Count `byte-bound-dropped-leading`, `window-not-whole` and `no-provider-cursor` per provider, read from the existing metrics surface.
    - Pros: cheap, needs no prompts or content, and answers the question on real machines.
    - Cons: needs a release to collect data before the design can be chosen.
  - **Reason from fixtures and the bound constants instead.**
    - Pros: no waiting for field data.
    - Cons: guesses at how often real sessions cross the byte bound, which is the very thing the item says to measure.
- **Which mechanism?**
  - **A direct-cursor mint that reads the provider's summary window (recommended).** A narrow command returning a cursor naming the first row the view holds, built from `/transcript?version=2` or OpenCode's window.
    - Pros: covers the byte-bound case, the OpenCode case and a prefix collapse with one path; no whole read; the existing gap rule applies unchanged.
    - Cons: a new renderer-to-backend command, which older backends lack, so the renderer must fall back to the current mint.
  - **Keep a direct cursor through the backend byte bound.** Have the progressive view name the first kept row through the provider's page route.
    - Pros: no extra round trip; the cursor arrives with the view.
    - Cons: does not cover the OpenCode window case or a prefix collapse, so the `sync-v1` mint survives for those.

### 2. `loadEarlierMessages` pages directly

**Problem.** The renderer is the main user of the joined path, so nothing can retire until it stops minting through `sync-v1`.

**Context.** Load earlier messages must keep the reader's place (`useHeldTranscriptPlace.ts`). The `sync-v1` protocol stays for live updates; only its paging role is in scope.

**Investigation.** `apps/web/src/hooks/useNativeAgentSession.ts:3252` (`loadEarlierMessagesPage`) still calls `getNativeAgentProjectionUpdate` with `syncVersion: 1` and `forceSnapshot: true` (`:3265`) whenever `historyCursorRef.current` is empty, then commits the joined cursor through `planSyncMaterialization`. Direct cursors are adopted only from the live projection (`adoptDirectCursor`, `:1664`). A prefix collapse that does not adopt a direct cursor discards held cursors (`:1672`), which sends the next click back to the mint. The backend test that pins the current behaviour is `apps/backend/src/core/native-agent-service-summary-transcripts.test.ts:289`.

**Decisions.**

- **What should the renderer do against a backend without the new mint?**
  - **Feature-detect and fall back to the `sync-v1` mint (recommended).**
    - Pros: a new renderer still pages against an older backend in the window.
    - Cons: the old path stays in the renderer until the backend floor also passes.
  - **Require the new backend.**
    - Pros: deletes the renderer path at once.
    - Cons: breaks paging for a newer renderer on an older backend, which the support window forbids.
- **What happens to the pinned backend test?**
  - **Keep it as the older-renderer contract and add a direct-mint test beside it (recommended).**
    - Pros: protects older renderers until task 4.
    - Cons: two tests for one behaviour during the window.
  - **Invert it to assert that no v1 cursor is minted.**
    - Pros: makes the new intent explicit.
    - Cons: wrong while older renderers still depend on the v1 cursor.

### 3. Keep v1 cursors for older renderers and record the condition

**Problem.** Older renderers in the window keep minting v1 cursors, so the backend must keep answering them, with a recorded condition for when it may stop.

**Context.** The support window runs from v2.21.0 (0034, `version-compatibility.md`).

**Investigation.** The register row already exists, with the condition "0232 has made the renderer page directly, and the floor is at or above the first Stable release with that renderer" (`docs/architecture/version-compatibility.md:114`). The counter is recorded unconditionally on every non-direct page (`native-agent-transcript-projection.ts:3929`; id at `compatibility-path-usage.ts:31`). It cannot tell an older renderer from the current one, or from an older bridge, so it can never go quiet while the current renderer still uses the path. Recording the release is the only part left, and it can be done only once task 2 ships.

**Decisions.**

- **Should the counter be split by cause?**
  - **Split it once task 2 lands: `history.joined-v1-page` for older renderers and a separate id for older bridges with no page route (recommended).**
    - Pros: lets task 4's "counter is quiet" check mean something; separates the renderer and bridge retirements.
    - Cons: the backend cannot see the renderer version directly, so the split must key on which command minted the cursor.
  - **Keep one counter.**
    - Pros: no change.
    - Cons: the counter stays noisy, and task 4 has to rely on the version floor alone.

### 4. Remove joined paging

**Problem.** Joined paging keeps `projectionHistory`, a byte-bounded per-session cache (`native-agent-transcript-projection.ts:770`), plus the v1 cursor namespace and `firstHistoryCursor` (`:1692`), all for compatibility only.

**Context.** The retirement condition is in the register. Removal also needs the counter quiet on the machines the maintainer can reach.

**Investigation.** Nothing to remove yet. Removing this does not affect the `sync-v1` live-update protocol.

**Decisions.**

- **Keep this item here or move it?**
  - **Keep it here as the file's last item (recommended).**
    - Pros: the file closes when the path is gone, matching how 0050 handled its own retirement.
    - Cons: the file stays open for a whole support window after task 2.
  - **Move it to 0034 once task 3's condition is recorded, and finish this file after task 2.**
    - Pros: this file finishes sooner; 0034 already tracks window-gated removals.
    - Cons: splits the history of one path across two files.

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
