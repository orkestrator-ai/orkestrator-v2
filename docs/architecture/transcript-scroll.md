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
| `apps/web/src/lib/transcript-scroll/arrivals.ts` | Live arrivals: which appended rows and group calls grow in, and their entrance |
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
- The UI's `isAtBottom` (the "Scroll down" button, the pinned refresh
  shimmer) is the geometry, or following that may run, or a latest journey
  that has reached the end. Growth reaches a follower a moment before its
  pin, so geometry alone flickered false while content streamed; the native
  dock reserves its own height (button included) below the transcript, so
  each flicker pushed the transcript up and snapped it back
  (`NativeFollowStability.spec.ts`). Idle upward movement away without end
  growth releases follow even without classified input (browser find,
  focus navigation, assistive technology), so the control remains available
  after the dock lays out again.
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

### Eased navigation

`glideTo` is `navigateTo` with an ease-in, ease-out curve, used by the prompt
navigator (`TranscriptPromptNavigator`, on the native chat shell's left edge).
It is an ordinary row navigation: reader input retires it, reduced motion makes
it a jump, and it ends by converging on measured geometry like any other.

- The curve is applied to the target row's offset in the viewport, not to
  `scrollTop`. Rows measured during the movement shift `scrollTop` without
  moving the target off its curve, and a destination past the end of the
  transcript is replaced by where the scroller stops, so it still decelerates.
- A rendered target gets one curve, scaled to its distance.
- An unrendered target has no known distance, and flying through the rows
  between would mount all of them. The viewport instead eases out of its place
  for one leg, the virtualizer places the target, and a second leg eases in
  from exactly one leg short of where the journey can stop. Equal legs over
  equal distances meet at the same speed, so the jump between them is not seen
  as a stop.

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

Growing the keep-mounted overscan (a row takes focus or a selection) is held
the same way (`holdPlaceAcrossOverscan`). It mounts rows Virtuoso has only
estimated (320 px); when rows above the viewport measure shorter, Virtuoso does
not always compensate, and the rows on screen jumped with no scroll event (464
px in the long fixture when a link was focused, which moved a clicked PR link
off screen before the PR pane even opened). The hold restores the settled
reading anchor. A follower is not held, and neither is a pointer held on the
scroller itself (a scrollbar drag); a pointer held on content (the click that
focused a link) is.

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
- A held place is only as exact as the scroll range allows. A long tool-only
  conversation folds into one group, so its whole transcript (prompt, folded
  group, answer) can be shorter than the viewport once the last page lands.
  The rows the page put above the held row then push it down, and the
  controller ends `clamped` at the top. Nothing can hold that place without
  inventing blank space below the transcript. With room to scroll the same
  page converges to the pixel (`TranscriptPaging.spec.ts`, the folded-group
  cases). Checks of a held place therefore compare the list's position with
  the position that holds the row, limited to the scroll range, rather than
  the row's offset alone.
- History can also drop from under a reader. A new history epoch (a bridge
  restart), or a live tail that joins nothing the tab holds (the first Codex
  replay after live streaming renames every row), makes the session hook fall
  back to the bare live tail, because it cannot tell a replay from a rewritten
  history. `useRestorePlaceAfterHistoryDrop` then notices that a commit took
  the reader's source part from the front while they were not following,
  pages history back until that part (a call id, which a Codex replay keeps)
  reappears, and scrolls to it at its old offset. It gives up after 8 pages
  that bring rows but not the part, 12 empty pages retried 750 ms apart, when
  history runs out, or when newer reader input/navigation supersedes its
  captured controller generation. Source-part loss is checked even if the
  coalesced display head keeps its id. Each independent drop can restore the
  same call again. Recovered history waits for an active, mounted viewport
  and an accepted navigation; ordinary held-page restoration and automatic
  paging stand aside meanwhile. A remounted controller inherits its persisted
  semantic anchor, so a missing part in its first live tail is recoverable
  too. Activation waits while that history recovery owns the place. Covered live by `transcript-paging-live.spec.ts`'s
  Codex bridge-restart step.

## Activation and persistence

`activation: "respect-intent"` (agent tabs, reviewers, Claude tmux):

- a follower catches up to the latest message in one bounded journey;
- a detached reader returns to their semantic place (captured as they left,
  or the last place captured while reading when the pane is already hidden);
- an explicit "scroll to message" request pending for the tab
  (`explicitTargetPending`) wins over both; if it is dropped without
  navigating, the deferred activation runs then.

`activation: "latest"` is the documented exception for views that show what
is happening now: the build pipeline transcript, the Graph Run transcript and
the spec chat.

A view hidden inside a host that stays active passes `visible` separately
from `isActive`; the view is active only while both are true. When it comes
back with the host active throughout (the pipeline inspector's Ticket node or
a Tests view, then the stage again), the policy is not applied: a follower
catches up to the latest message, and a detached reader stays at the offset
the hidden element kept, under either policy. That offset is used rather than
the semantic anchor because a reader looking at the review report in the
footer has no row on screen, so their last captured anchor is an older place.
The `latest` jump applies once the host itself has been left, even if the view
was hidden at the time. The build pipeline transcript passes `visible`; the
Graph Run transcript unmounts in its Details view instead. Before 2026-11-11
the pipeline folded `visible` into `isActive`, so every return to a stage went
to the newest message although its comments said the place was kept (to-do
5620, retired 2026-11-11). `useVirtuosoScrollState.return.test.ts` covers
both kinds of return, and `InspectorTranscriptHide.spec.ts` checks a reader's
first visible frame and settled offset after Ticket and back, in Chromium and
WebKit, with and without the review report.

The two inspector transcripts were measured across a pane hide on 2026-11-05,
in Playwright WebKit (build 2370) and Chromium, at phone and desktop widths
(`e2e/InspectorTranscriptHide.spec.ts`). Every case settled on the newest
message and left the overview's offset alone. They do not use
`useScrollOffsetAcrossHide`; the controller keeps their offset itself.

WebKit puts a re-shown scroller's offset back during a layout that has not yet
sized the contents of a container query container inside it, so the offset is
clamped to a range short by that content, and `scroll` fires at the clamped
offset before the frame's animation callbacks. In a pipeline transcript the
container is the review report in the footer: a reader near the end, or a
follower, came back 466 px (desktop) higher than they left
([flake 6380](../tests/flaky-tests/web-ui/6380-inspector-transcript-hide-webkit-offset.md),
to-do 5620 task 2, retired 2026-11-11). When the scroller is, or wraps, the container, that range would be 0,
which fits the reset to the top that to-do 0860 (retired 2026-11-10) found
in the Multi Review inspector tail (see
[`build-pipeline-view.md`](build-pipeline-view.md#shared-flow-graph)). So the
controller keeps the offset it last observed while the scroller had a box;
once a resize delivery has measured it at zero height, the first
`scroll` or resize delivery after the show writes that offset back, upward
only, since the clamp only lowers it and following growth raises it (Chromium
keeps it, so nothing is written there). That `scroll` is the browser's, not the
reader's: it does not release a follower. A navigation started since the show
(activation) owns the viewport, so the old offset is not written over it.

CI runs `InspectorTranscriptHide.spec.ts` in both Chromium and WebKit, in
both viewport projects. It records the reader's offset once it has held for 5
animation frames (WebKit animates the wheel, and Virtuoso then corrects row
estimates), samples the reader's first visible animation frame with a probe
armed before showing the pane, then checks latest-on-activation.
For both the follower and reader, it samples every animation frame for 750 ms
after reaching the end, checking that the transcript stays at the end and the
overview stays at its saved offset. This bounds the settling claim to that
observation window; it does not qualify real Safari.

Persisted entries (bounded LRU, 200) hold the validated Virtuoso snapshot,
follow intent, the semantic anchor, the scroller width and the layout the
snapshot was measured under (window width and root font size), under a
format version that drops entries from another build. After a reflow the
pixel snapshot is not restored; the semantic anchor places the reader.

## Tool groups

`NativeMessage.tool-group.tsx` renders a run of tool calls in one stable host
whose body never exceeds `min(28rem, 55dvh)`, expanded details included.

- From `TOOL_GROUP_FOLD_MIN_CALLS` (3) calls a head line appears. A group the
  reader saw unfolded folds when it crosses the threshold: its body animates
  its layout height to zero over 500 ms while the head line grows in, in the
  same host (`--tool-group-fold-duration`). A group that arrives long starts
  folded without animating. From then on folding is the reader's, and opening
  and folding animate the same way. The bottom-anchored transcript follows
  the height as it animates; reduced motion makes both immediate.
- From `TOOL_GROUP_VIRTUALIZE_MIN_ENTRIES` (12) entries the body is an inner
  Virtuoso viewport (`data-transcript-inner-viewport`). It owns its scroll
  position and follow preference (a live group opens following its newest
  call, a finished one at its first), keeps place across history merges with
  its own `firstItemIndex`, and protects a selection (or else focus) with the
  shared bound.
  Entries are memoized on the member object and keyed by call id.
- Opening is remembered in `messagePartExpansionStore`, keyed by call id
  within the transcript scope rather than by row: a group by its members'
  call ids, and a call's own disclosure (its output, deferred or not) by its
  own (`toolExpansionKey` in `NativeMessage.shared.tsx`). Coalescing renames
  the row that holds a group whenever earlier rows merge in front of it, and
  Codex's first replay after live streaming renames every row while each call
  keeps its id, so neither may fold what the reader opened. A call without a
  provider id falls back to its row-scoped part key. Covered by
  `NativeMessage.tool-expansion-rename.test.tsx` and, after a real Codex
  bridge restart, by `transcript-paging-live.spec.ts`.
- Anchors for members inside an inner viewport are composite: the transcript
  holds the group frame, the inner viewport puts the member back at its
  on-screen offset (absorbing a clamped transcript). A member the inner list
  has virtualized away (a history page re-filled the group in front of it) is
  asked for with `INNER_SEEK_EVENT` on the inner viewport, for up to 20
  frames; the group scrolls its own list to that entry, and the member is
  then held like a mounted one.

## Live arrivals

With `animateArrivals` (the native tab's `NativeChatShell`), a row a live
update appends, and a call joining a short (plain-body) tool group, grows in
by its real layout height over 300 ms (`data-transcript-arrival`,
`--transcript-arrival-duration`) instead of appearing at full size. As with a
tool-group fold, a follower is pinned to the end on every resize delivery, so
the transcript glides up with the growth rather than jumping a row per
update; growth below a detached reader moves nothing.

- Only a small append counts (`liveArrivals`): the same first key, every
  previous key kept in order, at most `MAX_LIVE_ARRIVALS` (3) new keys.
  History pages, a first fill, rehydration and gap refills, removals and a
  replaced row (the streaming tail renamed, an optimistic prompt replaced by
  its echo) render at once.
- Each arrival animates once, from a layout effect at mount, so it is never
  painted at full size first. One that mounts more than
  `LIVE_ARRIVAL_WINDOW_MS` after its update (the reader was elsewhere), a
  virtualized remount, a hidden pane, reduced motion and a body that already
  scrolls inside its ceiling all render at once.
- The entrance animates `grid-template-rows` 0fr → 1fr, so content still
  streaming into the row is tracked; a 1 px floor keeps Virtuoso from
  measuring an empty row.

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
  navigation. Cancelling a pending index navigation must also publish
  `scrollTargetReached`: a restored snapshot's initial location holds the item
  list at `visibility: hidden` until that signal arrives. Cancelling with no
  pending navigation must not publish it or reveal the list prematurely.
- `followOutputSystem` guards its queued follow (`listRefresh` wait and
  fixed-size frame), its size-increase trap and `scrollIntoViewOnChange` with
  a generation, and exposes `cancelPendingNavigation`, which retires both
  systems at once.

The dependency is pinned exactly. [`virtuoso-cancellation.test.tsx`](../../apps/web/src/lib/transcript-scroll/virtuoso-cancellation.test.tsx) exercises
the real patched library (a control run proves the retry and the queued
follow happen; the cancelled run proves they do not), so a version bump that
drops or breaks the patch fails there. Its restored-snapshot control and
cancellation cases require an existing list that starts hidden and becomes
visible on completion or cancellation. The no-pending-navigation case guards
against premature reveal, and the real `useVirtuosoScrollState` activation and
deactivation cases exercise cancellation through the controller while the
initial navigation is pending. Preserve all of these invariants in both runtime
bundles when regenerating the patch. Regenerate with `bun patch
react-virtuoso@<version>`, reapply the same edits, `bun patch --commit`, then
make sure `node_modules/react-virtuoso` is the store symlink again (the edit
copy otherwise shadows it for root tests).
