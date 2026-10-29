# Mint history cursors directly so joined sync-v1 paging can retire

Checked against `main` at `930189337` (2026-10-26). Items 1 to 3 done on
2026-10-27 in #1323 (`5b5cfcdf8`); item 3's counter split done on
2026-10-29 against `79f3bc97e`. Item 4 waits on the support window.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`, which is the parent of
#1323 (`5b5cfcdf8`), so the investigation below describes the code before
items 1 to 3 landed. Its line numbers are stale. Re-checked against
`79f3bc97e` on 2026-10-29; see **Assumptions and decisions** for where the
recommended options were followed and where they were not.

### Tasks

1. **Direct cursor wherever the provider pages**: keep a direct cursor through a backend byte bound, or add a direct mint from the summary window, chosen by a measurement of the no-cursor cases. Status: done (2026-10-27, #1323: a direct cursor through the byte bound).
2. **`loadEarlierMessages` pages directly**: stop calling the `sync-v1` projection to mint a cursor, with tests for a byte-bounded view, an OpenCode window, a prefix collapse and a held place. Status: done (2026-10-27, #1323; the mint remains only as the fallback for a view without a direct cursor).
3. **Keep v1 cursors for older renderers and record the condition**: keep serving v1 cursors, counted by `history.joined-v1-page`, with the retirement condition in the register. Status: done (condition 2026-10-27; counter split by cause 2026-10-29).
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
bridges without the v2 transcript contract. It could not retire: the path
was not only an older-bridge path. The renderer itself minted its first
history cursor through it whenever the progressive view carried no direct
cursor, and that cost a whole transcript read on bridges that page directly.

## Current state

- A progressive view carries a direct cursor (`historyPaging: "direct"`)
  whenever its provider pages. While the view starts at or before the
  snapshot's first row (`viewStartsAtSnapshot` in
  `native-agent-transcript-projection.ts`) that is the provider's own
  `historyCursor`. When the view's byte bound dropped leading rows the
  provider sent, `firstNamedCursor` asks the snapshot's new
  `historyCursorBefore(messageId)` for the first kept row that can name one:
  - HTTP bridges (`positionedCursorBefore`, `http-bridge-transcript-v2.ts`)
    move the snapshot's `bp1.` cursor to that row's absolute position with
    `bridgeTranscriptPageCursorAt`
    (`packages/protocol/src/node/bridge-transcript-summary.ts`). The format,
    and every bridge's page route, is the shared helper's since v2.21.0, so
    every bridge in the window accepts the moved cursor; the bridge still
    checks generation, epoch and position.
  - OpenCode (`openCodeCursorBefore`, `opencode-snapshots.ts`) names the
    cursor before a message, so only the first row of a message's rows names
    one (an error row does not); the search moves on to the next message.
  Rows between the view's start and that position return on the first page
  and the renderer drops them by id.
- The trigger is ordinary, not exotic: a tool call's detail reference is
  larger than a short output the bridge summary keeps inline, so a window of
  edits and short commands is larger once projected than the bridge measured
  it. Efficiency workload `o` (40 seeded sessions per case,
  `scripts/efficiency/workloads-projection.ts`), `origin/main` against this
  branch:

  | Case | Views whose bound dropped rows | Direct cursor (before → after) | Joined mints on click (before → after) | Messages those mints read (before → after) |
  | --- | --- | --- | --- | --- |
  | Bridge, short tool outputs (≤ 40 bytes) | 36 / 40 | 4 → 40 | 36 → 0 | 7,485 → 0 |
  | Bridge, half short, half 200 B–6 KB | 0 / 40 | 40 → 40 | 0 → 0 | 0 → 0 |
  | Bridge, 200 B–6 KB outputs | 0 / 40 | 40 → 40 | 0 → 0 | 0 → 0 |
  | OpenCode, short tool outputs | n/a | 40 → 40 | 0 → 0 | n/a |

  OpenCode's window measure already charges a detail reference
  (`openCodeDisplayBytes`), so its view only loses rows when a measure drifts
  (an artifact part, a new projected field); the backend test reproduces that
  by windowing to twice the target.
- Every renderer in the window adopts a direct cursor whenever the view
  carries one (`adoptDirectCursor` in `useNativeAgentSession.ts`, present in
  v2.21.0), including after a prefix collapse. So the fix reaches older
  renderers too; the renderer code did not need to change, only its comment.
- The sync-v1 mint in `loadEarlierMessages` is now a compatibility path. On a
  backend with this change it runs only for a view without a direct cursor:
  a source with no direct pages (the Claude bridge's `/messages` fallback,
  [0050](0050-transcript-history-efficiency.md), or a bridge without page
  routes) or a provider cursor too long to wrap. Against a backend before
  this change it still serves byte-bounded views.
- `getProjectionUpdate` still mints only v1 cursors, and `getMessagePage`
  still serves them (`history.joined-v1-page`), for those callers. Pinned by
  `a pageable provider's sync-v1 projection still mints a joined v1 cursor`
  in `native-agent-service-summary-transcripts.test.ts`. The register row in
  [version-compatibility.md](../../architecture/version-compatibility.md#register)
  states who it serves and when it retires.

## Outstanding work

1. Done 2026-10-27. The progressive view keeps a direct cursor when its
   bound drops leading rows, naming the first kept row through the
   provider's page route (`historyCursorBefore`). The measurement above
   decided it.
2. Done 2026-10-27. `loadEarlierMessages` pages from the view's direct cursor
   and never calls the sync-v1 projection while the view has one. Covered:
   - backend: `a view whose byte bound drops rows the bridge sent pages from
     the first row it kept` (summary transcripts) and `a window the view
     cannot hold whole pages directly from the first message it kept`
     (OpenCode history), both walking to the first message with no gap or
     repeat, no joined page and no whole read; both fail without the fix;
   - provider mappings: `a cursor moved to a later position pages exactly the
     rows before it` (protocol), `a cursor before a later row of the window
     pages exactly the rows before it` (HTTP bridge), `names a cursor before
     any kept message, but never inside one` (OpenCode);
   - renderer (`direct cursors a bounded view names` in
     `useNativeAgentSession.progressive.test.tsx`): a byte-bounded view, an
     OpenCode window starting at an error row, a prefix collapse (tail jump)
     and the rows on screen across the first page, each with the joined mint
     mocked to throw;
   - held place in a real browser: `native: paging before prose in a
     byte-bounded view holds the original tool position`
     (`e2e/TranscriptPaging.spec.ts`, fixture flag `bounded`), with the
     fixture failing on any sync-v1 command.
3. Done 2026-10-27, counter split 2026-10-29. v1 cursors are still served.
   Each joined page is now counted by why the session's latest progressive
   view carried no direct cursor (`directHistoryGaps` in
   `native-agent-transcript-projection.ts`):
   - `history.joined-v1-page.unpaged-source`: the source has no direct pages
     (the Claude `/messages` fallback, a bridge without page routes);
   - `history.joined-v1-page.unnamed-cursor`: the source pages, but no kept
     row named a cursor (the OpenCode error-row case, or a first-message
     snapshot whose projected rows exceed the backend byte bound) or the
     cursor was too long to wrap;
   - `history.joined-v1-page`: the view had a direct cursor, or no view was
     read, so the caller paged with a v1 cursor it did not need.
   Before this change the base id counted every joined page. Covered by
   `a joined page after … counts under its own cause` (summary transcripts,
   both causes, failing without the change), the counter assertions in `a
   view retaining only an error row uses joined paging …` (OpenCode history),
   and the unchanged pinned test `a pageable provider's sync-v1 projection
   still mints a joined v1 cursor`, which reads no view and so stays on the
   base id. The register row names the three ids and retires the path when
   the Claude `/messages` fallback row has retired, the floor is at or above
   the first Stable release with 0232, the first-message byte-bound,
   cursor-boundary and cursor-length cases have direct recovery, and all
   three counters are quiet.
   The source's `historyPageable` capability now distinguishes pages from
   unpaged sources independently of cursor presence. Regression coverage
   includes a pages-enabled bridge sending its entire 75-row history at
   start index zero while the backend drops leading rows. A later complete
   view or direct cursor clears an earlier cause; projection-history capacity
   eviction and missing-session sync-v1 invalidation clear it too. These paths
   are covered in the summary-transcripts and transcript-projection owners.
4. Open, blocked on the support window. Once the register condition holds
   and the counter is quiet on the machines you can reach, remove joined
   paging, the v1 cursor namespace, `projectionHistory` and the renderer's
   mint in `loadEarlierMessages` (a view without a direct cursor then has
   nothing older to load, and the control retires).

## Assumptions and decisions

### The Task analysis predates the work (all tasks)

The Task analysis was written against `863b5782`, the parent of #1323, so it
describes tasks 1 and 2 as open when #1323 had already done them. On
2026-10-29 the code at `79f3bc97e` was checked against each decision, and
only the work the recommended options still called for was done: the
counter split (task 3) and the cause measurement it carries (task 1). Where
#1323 took a different option from the one marked recommended, the reason is
given below and still holds.

### How the no-cursor cases are measured (task 1)

Options: a reason counter where `directHistoryCursor` is undefined, per
provider, on the progressive metrics (recommended); or reasoning from
fixtures. Chosen: both, in two steps. #1323 measured the case that decided the
mechanism with deterministic efficiency workload `o` (see **Current state**).
On 2026-10-29 the reason counter was added, with two changes from the
recommendation:
- **It counts joined pages, not views.** A view without a cursor that nobody
  pages costs nothing. The cause is recorded per session when the view is
  projected and attributed when a joined page is served.
- **It lives in the compatibility-path store, not `ProgressiveReadMetric`,
  and it has no provider label.** `ProgressiveReadMetric` keeps 256
  in-memory samples and is read only by tests, so it is not a surface anyone
  can read on a real machine. The compatibility store persists across
  restarts and is read through `get_compatibility_path_usage` and
  `/api/metrics`. Its rule is "no session, agent, URL or version", so the
  causes stand in for the provider. `unpaged-source` is in practice the Claude
  `/messages` fallback. `unnamed-cursor` includes the OpenCode error-row case,
  an overlong cursor, and a pageable first-message snapshot whose projected
  rows exceed the backend byte bound without naming a new cursor.

The original reason names were `byte-bound-dropped-leading`,
`window-not-whole` and `no-provider-cursor`. Since #1323 the first two only
remain where no cursor can be named, so they collapse into `unnamed-cursor`,
and `no-provider-cursor` is `unpaged-source`.

### Which mechanism gives the view a direct cursor (task 1)

Options:
- (a) keep a direct cursor in the progressive view when the backend's bound
  drops leading rows, naming the first kept row through the provider's page
  route;
- (b) add a direct-cursor mint that reads the provider's summary window on a
  click (recommended in the Task analysis).

Chosen: (a), in #1323. The code shows (b) is the wrong choice:
- The no-cursor case is the bound dropping rows on ordinary bridge sessions
  (36 of 40 shell-heavy sessions). A fresh summary read names the same
  snapshot-start position, and the view still starts after it, so (b) would
  need the same repositioning plus an extra provider read per click.
- The analysis's objection to (a), that it misses the OpenCode window and a
  prefix collapse, does not hold. OpenCode names a cursor through
  `openCodeCursorBefore`. After a collapse the renderer adopts whatever
  direct cursor the new view carries (`adoptDirectCursor`, present since
  v2.21.0). Both cases are covered by tests.

Pros: no extra read, no new command, and every renderer in the window
benefits because they all adopt direct cursors already. Cons: the backend
view depends on each provider describing its own cursors
(`historyCursorBefore`). The first page also repeats the rows between the
view's start and the named position: at most one OpenCode message, and none
for bridges.

### Who repositions a cursor (task 1)

Options: the projection decodes bridge and OpenCode cursors itself; or each
provider exposes `historyCursorBefore` on its snapshot. Chosen: the provider,
with the bridge cursor arithmetic in the shared contract module that defines
the format. Why:
- provider cursors stay opaque to the projection;
- OpenCode needs the raw message's creation time, which only the snapshot
  has. A projected row's `createdAt` is not a safe stand-in for a provisional
  message.

Pros: one place per format, and an unknown provider simply names nothing.
Cons: it is a function on a snapshot object, which survives spreads but not
serialization. No snapshot is serialized today.

### Search forward from the first kept row (task 1)

Options: name only the first kept row; or the first kept row that can name a
cursor. Chosen: the latter. Why: an OpenCode view can start at a message's
error row, which no page can end at; the next message can. A later position
never leaves a gap, only repeated rows the renderer drops. Cons: a provider
that could name no early row would make the first page mostly repeats. The
renderer's duplicate-page skip bounds that.

### What the renderer does without a direct cursor (task 2)

Options: feature-detect a new mint and fall back to the `sync-v1` mint
(recommended); require the new backend; or gate the mint behind a new
capability or view field. Chosen: keep the `sync-v1` mint as the fallback for
a view without a direct cursor, which is the recommended fallback. Mechanism
(a) adds no command, so the thing to detect is the view's own cursor. Why:
- renderers already page directly whenever a view has a cursor;
- on a backend with 0232 a view lacks one only when joined paging is the
  only way to its history, so a gate would change no outcome;
- a backend before 0232 still needs the mint for byte-bounded views.

Pros: no protocol change, and older renderers are fixed by the backend alone.
Cons: the mint stays until item 4. The renderer cannot tell a legitimate
missing cursor from a bug, but the split counters now can.

### The pinned backend test (task 2)

Options: keep `a pageable provider's sync-v1 projection still mints a joined
v1 cursor` as the older-renderer contract, with direct tests beside it
(recommended); or invert it. Chosen: keep it (recommended). It still asserts
the base `history.joined-v1-page` id, which is right: it reads no
progressive view.

### Splitting the counter, and what to key it on (task 3)

Options: split `history.joined-v1-page` by cause (recommended); or keep one
counter. Chosen: split. The analysis expected the split to key on which
command minted the cursor, but mechanism (a) added no command. Every renderer
in the window also behaves alike (each adopts direct cursors and mints only
without one), so the backend could not tell an older renderer from the
current one even in principle. The split therefore keys on why the session's
latest view had no direct cursor, which is what decides whether the path can
retire:
- `unpaged-source` goes quiet when the `/messages` fallback retires;
- `unnamed-cursor` goes quiet when those cases get direct recovery;
- the base id should already be quiet on a current backend.

Pros: task 4's "counter is quiet" check now means something per cause, and
the bridge and boundary retirements are separated. Cons:
- the base id's older totals mix every cause, so read `lastSeenAt` after
  this release rather than `count`;
- the cause is the latest view's, held in a map of at most 512 sessions, so a
  page for a session evicted from it counts on the base id. Projection-history
  eviction and sync-v1 invalidation also discard the corresponding cause.

Newer ids already persist safely through older backends sharing the
database, since `normalizeCompatibilityPathUsage` keeps unknown ids on write.

### The retirement condition (task 3)

The todo proposed "the floor at or above the first Stable release with item
2". The fix is in the backend, and every renderer in the window already
adopts direct cursors, so the condition is instead:
- no source in the window lacks direct pages (the `/messages` fallback row
  has retired);
- the first-message byte-bound, cursor-boundary and cursor-length cases have
  direct recovery;
- the floor has passed the first Stable release with 0232;
- all three counters are quiet.

### Root cause in the bridges (task 1)

Options: also make the bridge summary window charge a detail reference for
short inline outputs, as OpenCode's measure does; or only reposition in the
backend. Chosen: only reposition. Why: bridges in the window would keep the
old measure anyway, so the backend must reposition regardless. Pros: one
change covers every bridge. Cons: the bridge still sends a few rows the view
then drops. Those are wasted bytes, at most the projection's inflation.

### Multi Review reviewer windows (scope)

`multi-review-reviewer-transcript.ts` has the same "bound dropped rows, no
direct cursor" rule, but its own joined fallback rather than `sync-v1`
paging. It is out of this file's scope and unchanged.

### Where item 4 lives (task 4)

Options: keep it here as the last item (recommended); or move it to 0034.
Chosen: keep it here, so the file closes when the path is gone.

### Measurement data (tasks 1 and 3)

Real-world frequency would need live sessions or the user's data; neither was
used. The deciding measurement is the deterministic efficiency workload.
The production instance on this machine had no `compatibility-path-usage`
store to read (checked read-only on 2026-10-27). The split counters start
collecting with the first release that carries them.

## Constraints and rationale

- A cursor must never leave a gap: a direct cursor is valid only while the
  view starts at or before the position it names (the reason for
  `viewStartsAtSnapshot`, and for naming only kept rows).
- Load earlier messages must keep the reader's place (`useHeldTranscriptPlace.ts`).
- The `sync-v1` projection protocol itself stays while renderers in the
  window use it for live updates; only its paging role is in scope.

## Needs verification

- How often joined pages still happen after this ships, and why: read
  `history.joined-v1-page`, `history.joined-v1-page.unpaged-source` and
  `history.joined-v1-page.unnamed-cursor` (`get_compatibility_path_usage`) on
  machines running a release with the split. Not available here: the live
  instance on this machine keeps no such counter yet, and no disposable
  profile ran real provider sessions.
- A live bridge session of short tool calls (Codex or Claude) in a
  disposable profile: confirm the view reports `historyPaging: "direct"` and
  Load earlier pages without a sync-v1 read. Covered by the bridge-contract
  stub and the browser fixture, not by a live run.

## Related

- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md)
  item 3: the check that found this, and the `/messages` fallback this
  file's item 4 waits on.
- [native-transcripts.md](../../architecture/native-transcripts.md#history-pages-and-cursors).
- [`version-compatibility.md`](../../architecture/version-compatibility.md#the-support-window):
  the support window.
