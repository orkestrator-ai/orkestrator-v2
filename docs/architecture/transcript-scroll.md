# Transcript scrolling

Status: Living — how a transcript viewport decides and writes its position.

Every transcript list (`VirtualizedMessageList`, used by the native agent tab,
reviewers, build pipelines, the Claude tmux tab and the spec chat) gets its
scroll behaviour from one `TranscriptScrollController` per mounted viewport,
created by `useVirtuosoScrollState`. The controller is the only code that
writes the transcript's scroll position; React Virtuoso renders and measures.

| Module | Role |
| --- | --- |
| `apps/web/src/lib/transcript-scroll/scroll-intent.ts` | Pure transition function: follow intent, pauses, the current navigation and its generation |
| `apps/web/src/lib/transcript-scroll/transcript-scroll-controller.ts` | The owner: input, observers, bounded navigations, measured convergence, anchors, diagnostics |
| `apps/web/src/lib/transcript-scroll/virtuoso-scroll-adapter.ts` | The only code touching the raw `VirtuosoHandle` or writing the scroller |
| `apps/web/src/lib/transcript-scroll/scroll-input.ts` | Which input will actually move the transcript (nested scrollers, editors, modals) |
| `apps/web/src/lib/transcript-scroll/prepend.ts` | Pure-prepend detection for `firstItemIndex` |
| `apps/web/src/lib/transcript-scroll/keep-mounted.ts` | Bounded keep-mounted rule shared by the transcript and inner group viewports |
| `apps/web/src/hooks/useVirtuosoScrollState.ts` | Hook: lifetime, persistence, activation policy, compatible return shape |
| `apps/web/src/hooks/useHeldTranscriptPlace.ts` | History paging: semantic place, source indexes, pre-commit re-capture |
| `patches/react-virtuoso@4.18.19.patch` | `cancelPendingNavigation()` on the Virtuoso handle |

## Intent and ownership

The viewport is **following**, **reading**, **navigating** (a bounded
operation owns it) or **inactive**.

- Follow is intent. Growth that leaves the viewport short of the end never
  ends following; a navigation or measurement that lands near the end never
  starts it. Only the reader leaving the end (their own movement, one pixel
  is enough), arriving at it (their own movement), or asking for the latest
  message changes it. Virtuoso's `atBottomStateChange` updates the UI only.
- Every navigation (latest, find, message link, history, restore, row) is one
  operation with a generation. Starting one retires the previous one at every
  layer: its frames, the library's pending work (`cancelPendingNavigation`)
  and, after user input, a native smooth scroll in flight (one same-position
  instant write). Every callback re-checks the generation before writing.
- Pauses (`selection`, `find`, `expanded-artifact`) are idempotent reason
  tokens. Taking one retires an incompatible operation (find keeps its own
  navigation). Releasing the last owes a still-following reader the growth
  that arrived meanwhile — unless a navigation or their own movement
  superseded the pause.
- Literal `false` reaches Virtuoso's `followOutput` whenever following may not
  run (`scrollProps.followEnabled`): its size and viewport paths test
  `followOutput !== false`, so a function returning false still scrolls.
  The same rule applies to the inner group viewport.

### Reader input

`scroll-input.ts` classifies wheel (ignoring pinch-zoom, mostly horizontal
motion and nested scrollers that consume it, honouring
`overscroll-behavior`), keys (Home/End, Page, arrows, Space and Shift+Space;
never in editors, with modifiers, while a modal owns the keyboard or on a
button), touch (past a 6 px slop, vertical only) and pointer-held movement
(scrollbar drags). Any of these that will move the transcript retires the
current navigation, in either direction. A raw `scroll` event alone is not
intent; during a navigation, movement counts as the reader's only with a held
pointer or input given after the navigation began, because the tail of an
earlier gesture overlaps the virtualizer's own compensation writes.

## Measured convergence

Navigations converge on geometry, not on timers. A row target that is not
rendered gets one index navigation (local index, resolved by row key first);
from then on each frame and each resize delivery measures the target against
its desired offset and writes at most one correction per phase per frame.

- Converged: within 1 px for two frames with no measurement change (no
  resize delivery, no virtualizer scroll compensation) between them.
  Clamped boundaries are a legitimate outcome.
- Budget: 30 frames or 750 ms, then the operation ends where it stands. A
  target still not rendered re-issues index navigation at most twice.
- Pre-paint: resize deliveries reconcile synchronously, and so does the
  mutation observer during an operation (list margin and header changes resize
  nothing). The operation's frame is re-requested from each resize delivery
  so it runs after the frame Virtuoso requests for its own measurements.
- A row target stays mounted while it converges, within the keep-mounted
  bound; beyond it the protection is released.
- Protection overscan only grows for one protected row
  (`useRatchetedOverscan`). A larger overscan re-renders the list, and the
  range measured during that re-render can need less, which would shrink it
  and re-render again: without the ratchet that cycled until React's update
  depth limit (a reader moving while a history page loads).

### Reflow

A change of the scroller's width re-wraps text, and Virtuoso keeps
`scrollTop`, so a reader's row would move by however much the rows above it
grew or shrank (114 px for a 1200 → 420 px window in the long fixture). The
controller observes the scroller itself; on a width change while reading, it
starts a bounded `reflow` navigation to the place captured before it (the
reading anchor, refreshed when the reader's scrolling or a measurement change
settles). Its first correction runs in the operation frame, after Virtuoso has
applied the new row sizes; correcting in the resize delivery as well
compensated the same growth twice for one painted frame. A follower is kept at
the end by growth, and another navigation keeps converging on its own target.
A hidden pane (zero width) keeps its last width, so showing it at another
width counts as a reflow. Persisted pixel snapshots from another layout are
not restored (see Activation and persistence).

## Semantic anchors and history

A place is `{ rowKey, index, partId, offsetPx, inner? }`: a display row by
identity, optionally a source part inside it (`data-transcript-part-id`, set
for tool calls and prose parts that carry a source part id), and that
element's top relative to the viewport.

- `HeldTranscriptPlace` resolves a held place through indexed maps built once
  per projection: source part → row, row id → row, boundary source → row.
  When nothing survives it restores nothing (never the latest message).
- The list re-captures the place immediately before each data commit while a
  history page is held (`getSnapshotBeforeUpdate`), so a reader who moved
  while the page loaded is held where they are now.
- A pure prepend of `k` display rows lowers `firstItemIndex` by `k` in the
  same render (`pureprependCount` over row keys, tolerating a live append or
  a replaced streaming tail, and locating a renamed head by its second row).
  Virtuoso then keeps the rows on screen; measured convergence settles the
  estimate error.
- Index spaces: `itemContent`, `computeItemKey` and `rangeChanged` receive
  absolute indices (offset by `firstItemIndex`) and are normalized at the
  list boundary; `scrollToIndex` takes the local index. Everything else
  (find matches, `data-chat-message-index`, protected rows) is local.
- Coalesced tool runs keep a surviving row id while any member survives (a
  page merging calls in front, live calls behind), so they are not renamed and
  remounted. Projections parsed afresh on every read (reviewers) pass a
  caller-owned alias map, pruned to the projection.

## Activation and persistence

`activation: "respect-intent"` (agent tabs, reviewers, Claude tmux):

- a follower catches up to the latest message in one bounded journey;
- a detached reader returns to their semantic place (captured as they left,
  or the last place captured while reading when the pane is already hidden);
- an explicit "scroll to message" request pending for the tab
  (`explicitTargetPending`) wins over both; if it is dropped without
  navigating, the deferred activation runs then.

`activation: "latest"` is the documented exception for views that show what
is happening now: the build pipeline transcript and the spec chat.

Persisted entries (bounded LRU, 200) hold the validated Virtuoso snapshot,
follow intent, the semantic anchor, the scroller width and the layout the
snapshot was measured under (window width and root font size), under a
format version that drops entries from another build. After a reflow the
pixel snapshot is not restored; the semantic anchor places the reader.

## Tool groups

`NativeMessage.tool-group.tsx` renders a run of tool calls in one stable host
whose body never exceeds `min(28rem, 55dvh)`, expanded details included.

- From `TOOL_GROUP_FOLD_MIN_CALLS` (3) calls a head line appears. Folding is
  the reader's choice: a group the reader saw unfolded stays open when it
  crosses the threshold; a group that arrives long starts folded. Nothing
  animates layout height (opening fades in, folding is immediate).
- From `TOOL_GROUP_VIRTUALIZE_MIN_ENTRIES` (12) entries the body is an inner
  Virtuoso viewport (`data-transcript-inner-viewport`). It owns its scroll
  position and follow preference (a live group opens following its newest
  call, a finished one at its first), keeps place across history merges with
  its own `firstItemIndex`, and protects a selection (or else focus) with the
  shared bound.
  Entries are memoized on the member object and keyed by call id.
- Anchors for members inside an inner viewport are composite: the transcript
  holds the group frame, the inner viewport puts the member back at its
  on-screen offset (absorbing a clamped transcript).

## Streaming Markdown

`lib/chat/rich-markdown/incremental-parse.ts` reuses the parsed tree of a
streaming part's completed, provably safe prefix (a line after a blank line,
outside fences, that cannot join the block before it; definitions,
footnotes, raw HTML and carriage returns disable reuse). Positions are in
document coordinates and cached nodes are deep-copied per parse; every
transform, the URL policy and sanitisation still run over the whole tree,
and the final non-live render is always a full parse. Equivalence with a full
parse is tested for every streamed prefix of the fixtures.

## Diagnostics

The transcript scroller exposes its controller's content-free counters as
`orkTranscriptScrollDiagnostics()` (`SCROLL_DIAGNOSTICS_PROPERTY`): writes,
library cancellations, operations started and their outcomes, stale
callbacks refused, user interruptions, pause and scroller retirements, growth
pins and operation frames/corrections. Browser specs and the performance
runner read them; nothing else does.

## Known limitations

- Virtuoso 4.18.19's upward-scroll compensation treats a same-count height
  change as growth above the viewport while the last scroll direction was up.
  Growth below a reader landing during their upward wheel animation can
  therefore shift the view by that growth; a settled reader is unaffected
  (browser-tested). Correcting it from outside cannot tell the reader's own
  animated scroll from the library's write (`scrollend` fires more than once
  per wheel gesture), so it is left to a future library patch or migration.
- Find indexes text parts only (as before); tool entries inside a group are
  not searched, so inner virtualization cannot shift find's pairing.
- Exact reading-line preservation inside a reflowed paragraph is block-level:
  a prose part keeps its top, not a specific word.
- The native tab's background poll (every 500–1500 ms) retires a history page
  still in flight (`useNativeAgentSession`'s refresh sequence), so a page
  slower than the poll never lands and the reader has to ask again. That is the
  session hook's paging policy, predating this design; the "reader moves while
  a page loads" browser test therefore runs against the reviewer view.

## Maintaining the Virtuoso patch

`patches/react-virtuoso@4.18.19.patch` edits `dist/index.mjs`, `dist/index.cjs`
and `dist/index.d.ts`:

- `scrollToIndexSystem` gains a navigation generation and a cancel stream;
  its list-refresh retry and 1200 ms cleanup timer check the generation, so a
  timer queued before cancellation cannot retry or clean up a newer
  navigation.
- `followOutputSystem` guards its queued follow (`listRefresh` wait and
  fixed-size frame), its size-increase trap and `scrollIntoViewOnChange` with
  a generation, and exposes `cancelPendingNavigation`, which retires both
  systems at once.

The dependency is pinned exactly. `virtuoso-cancellation.test.tsx` exercises
the real patched library (a control run proves the retry and the queued
follow happen; the cancelled run proves they do not), so a version bump that
drops or breaks the patch fails there. Regenerate with `bun patch
react-virtuoso@<version>`, reapply the same edits, `bun patch --commit`, then
make sure `node_modules/react-virtuoso` is the store symlink again (the edit
copy otherwise shadows it for root tests).
