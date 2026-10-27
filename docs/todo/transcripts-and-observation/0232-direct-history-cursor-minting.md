# Mint history cursors directly so joined sync-v1 paging can retire

Checked against `main` at `930189337` (2026-10-26). Items 1 to 3 done on
2026-10-27 against `863b57821`; item 4 waits on the support window.

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
3. Done 2026-10-27. v1 cursors are still served and counted by
   `history.joined-v1-page`. The register row now says what they serve and
   retires them when the Claude `/messages` fallback row has retired, the
   floor is at or above the first Stable release with this change, and the
   counter is quiet.
4. Open, blocked on the support window. Once the register condition holds
   and the counter is quiet on the machines you can reach, remove joined
   paging, the v1 cursor namespace, `projectionHistory` and the renderer's
   mint in `loadEarlierMessages` (a view without a direct cursor then has
   nothing older to load, and the control retires).

## Assumptions and decisions

- **Where to give the renderer a direct cursor (item 1).** Options: (a) keep
  a direct cursor in the progressive view when the backend's bound drops
  leading rows, naming the first kept row through the provider's page route;
  (b) add a direct-cursor mint that reads the provider's summary window on a
  click. Chosen: (a). Why: the measurement shows the no-cursor case is the
  bound dropping rows on ordinary bridge sessions (36 of 40 shell-heavy
  sessions), and (b) does not fix it: a fresh summary read names the same
  snapshot-start position, which the view still starts after, so (b) would
  need the same repositioning and an extra provider read per click. Pros: no
  extra read, no new command, and every renderer in the window benefits
  because they all adopt direct cursors already. Cons: the backend view
  depends on each provider describing its own cursors (`historyCursorBefore`),
  and the first page repeats the rows between the view's start and the named
  position (bounded by one OpenCode message; none for bridges).
- **Who repositions a cursor.** Options: the projection decodes bridge and
  OpenCode cursors itself; or each provider exposes `historyCursorBefore` on
  its snapshot. Chosen: the provider, with the bridge cursor arithmetic in
  the shared contract module that defines the format. Why: provider cursors
  stay opaque to the projection, and OpenCode needs the raw message's
  creation time, which only the snapshot has (a projected row's `createdAt`
  is not a safe stand-in for a provisional message). Pros: one place per
  format; an unknown provider simply names nothing. Cons: a function on a
  snapshot object, which survives spreads but not serialization (no snapshot
  is serialized today).
- **Search forward from the first kept row.** Options: name only the first
  kept row; or the first kept row that can name a cursor. Chosen: the
  latter. Why: an OpenCode view can start at a message's error row, which no
  page can end at; the next message can. A later position never leaves a
  gap, only repeated rows the renderer drops. Cons: a provider that could
  name no early row would make the first page mostly repeats; the renderer's
  duplicate-page skip bounds that.
- **Renderer change for item 2.** Options: gate the renderer's sync-v1 mint
  behind a new capability (`historyPagingVersions: [1, 2]`) or a per-view
  field saying only joined paging can help; or keep the mint as the fallback
  for a view without a direct cursor. Chosen: keep it, documented as a
  compatibility path. Why: renderers already page directly whenever a view
  has a cursor, and on a backend with this change a view lacks one only when
  joined paging is the only way to its history (the Claude `/messages`
  fallback, a bridge without page routes); a backend before this change still
  needs the mint for byte-bounded views. A gate would change no outcome.
  Pros: no protocol change, older renderers fixed by the backend alone. Cons:
  the renderer cannot tell a missing cursor that is legitimate from a bug,
  and the mint stays until item 4.
- **Retirement condition (item 3).** The todo proposed "the floor at or above
  the first Stable release with item 2". Since the fix is in the backend and
  every renderer in the window already adopts direct cursors, the condition
  is instead: no source in the window lacks direct pages (the `/messages`
  fallback row has retired), the floor has passed the first Stable release
  with this backend, and the counter is quiet.
- **Root cause in the bridges.** Options: also make the bridge summary window
  charge a detail reference for short inline outputs, as OpenCode's measure
  does; or only reposition in the backend. Chosen: only reposition. Why:
  bridges in the window would keep the old measure anyway, so the backend
  must reposition regardless. Pros: one change covers every bridge. Cons:
  the bridge still sends a few rows the view then drops (wasted bytes, at
  most the projection's inflation).
- **Multi Review reviewer windows** (`multi-review-reviewer-transcript.ts`)
  have the same "bound dropped rows, no direct cursor" rule but their own
  joined fallback, not sync-v1 paging, so they are out of this file's scope
  and unchanged.
- **Measurement.** Real-world frequency would need live sessions or the
  user's data; neither was used. The measurement is the deterministic
  efficiency workload above. The production instance on this machine has no
  `compatibility-path-usage` store to read (checked read-only on 2026-10-27).

## Constraints and rationale

- A cursor must never leave a gap: a direct cursor is valid only while the
  view starts at or before the position it names (the reason for
  `viewStartsAtSnapshot`, and for naming only kept rows).
- Load earlier messages must keep the reader's place (`useHeldTranscriptPlace.ts`).
- The `sync-v1` projection protocol itself stays while renderers in the
  window use it for live updates; only its paging role is in scope.

## Needs verification

- How often joined pages still happen after this ships: read
  `history.joined-v1-page` (`get_compatibility_path_usage`) on machines
  running a release with this change. Not available here: the live instance
  on this machine keeps no such counter yet, and no disposable profile ran
  real provider sessions.
- A live bridge session of short tool calls (Codex or Claude) in a
  disposable profile: confirm the view reports `historyPaging: "direct"` and
  Load earlier pages without a sync-v1 read. Covered by the bridge-contract
  stub and the browser fixture, not by a live run.

## Related

- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md)
  item 3: the check that found this, and the `/messages` fallback this
  file's item 4 waits on.
- [native-transcripts.md](../../architecture/native-transcripts.md#history-pages-and-cursors).
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md):
  the support window.
