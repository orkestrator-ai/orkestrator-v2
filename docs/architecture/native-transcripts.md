# Native transcript pipeline

Status: Living — how a native agent transcript travels from a bridge to the
backend, to clients and to workflows, and the bounds on each hop.

Providers produce transcripts, bridges summarise and window them, the backend
projects them and keeps a restart preview, clients retain history, and
workflows sample them to detect progress. The provider's history (Claude and
Codex rollouts, the OpenCode server, a bridge's own store) stays
authoritative; every copy described here is regenerable, except the
build-pipeline transcript store, which is the durable offline copy. Event-led
views follow [event-snapshot-recovery.md](event-snapshot-recovery.md);
native transcript windows keep the contract below instead.

| File | Purpose |
| --- | --- |
| `packages/protocol/src/node/progressive-transcript.ts` | v1 bridge envelope, transcript tokens (`bridgeTranscriptToken`) |
| `packages/protocol/src/node/bridge-transcript-summary.ts` | v2 summaries, detail locators, history pages, wire bounds |
| `packages/protocol/src/node/bridge-transcript-routes.ts` | Route bodies every bridge serves from one `BridgeTranscriptSource` |
| `packages/protocol/src/node/revised-rows.ts` | `RecentlyRevisedRows`: changed rows outside the live window |
| `apps/backend/src/core/http-bridge/transcript-v2.ts` | Backend side of v2: capability learning, bounded reads |
| `apps/backend/src/core/http-bridge/progressive.ts` | Snapshot reads, with the v1 fallback; a `/transcript` 404 is a missing session |
| `apps/backend/src/core/native-agent-transcript-projection.ts` | Owner of the projection read models and their session lifecycle |
| `apps/backend/src/core/native-agent-progressive-transcript.ts` | Transcript view: conditional reads, deltas, preview recovery |
| `apps/backend/src/core/native-agent-history-pages.ts` | Direct history pages |
| `apps/backend/src/core/native-agent-projection-parts.ts` | Shared row, tool-detail and page caches |
| `apps/backend/src/core/native-terminal-messages.ts`, `packages/protocol/src/native-terminal-rows.ts` | Terminal-state rows and where they are placed |
| `apps/backend/src/core/native-agent-direct-history.ts` | v2 history cursors and `DirectHistoryPageCache` |
| `packages/protocol/src/native-agent-transcript-patch.ts` | Part-level patches inside a delta |
| `apps/backend/src/core/native-agent-display-tail-scheduler.ts` | Restart-preview checkpoints |
| `apps/backend/src/core/transcript-progress.ts` | Progress samples and versioned digests |
| `apps/backend/src/core/build-pipeline/transcript-store.ts`, `build-pipeline/transcript-checkpoints.ts` | Durable pipeline transcripts and when they are written |

## Bridge reads

All five HTTP bridges (Claude, Codex, Cursor, Pi, ACP) serve
`GET /session/:id/transcript`, `/transcript/detail` and `/transcript/page`
from one `BridgeTranscriptSource` built per request (messages, generation,
content epoch, completeness, revision), so a locator or cursor minted by one
route resolves against the same history in the others. OpenCode has no bridge;
`OpenCodeProvider.transcriptPage` serves its pages in-process (see
[agent-engines.md](agent-engines.md)).

- **v1** windows raw messages: the newest `BRIDGE_TRANSCRIPT_MAX_MESSAGES`
  (100) within `BRIDGE_TRANSCRIPT_TARGET_BYTES` (512 KiB), with a token
  (`progressive-transcript.ts`). A large tool result counts at full size and
  can push every earlier row out.
- **v2** (`version=2`, `BRIDGE_TRANSCRIPT_SUMMARY_VERSION`) substitutes large
  bodies before windowing, so the window holds rows rather than payloads.
- **Conditional reads.** A read carrying the last token is answered
  `unchanged` with no body when the source did not move. The token covers
  content, title and freshness.
- **Capability discovery.** Capability is learned from answers, never assumed
  (`HttpBridgeTranscriptCapabilities`). A bridge that ignores `version=2`
  answers its v1 envelope, which is read as v1 and remembered. Only a 404 or
  405 from a route means the route does not exist; a timeout, a 5xx or a
  malformed body is a failed read, never a capability verdict. Negative
  answers expire after `TRANSCRIPT_V2_NEGATIVE_TTL_MS` (10 min), because a
  bridge can be upgraded in place. For the same reason a bridge answers an
  unknown session in band (`missing`, `expired`) on the detail and page routes,
  never with 404.
- **Response ceilings** on the backend: 16 MiB for a transcript read, a detail
  read the 16 MiB image ceiling plus 64 KiB, and a page read
  `BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES` plus 64 KiB.

## Summaries and detail locators

A v2 summary replaces a part's large bodies (tool output and error, diff
text, inline image bytes) with a detail: an opaque locator (`detailRef`), the
encoded size, and the fields it holds. Everything a collapsed row needs stays
inline. Bodies up to `BRIDGE_SUMMARY_INLINE_DETAIL_BYTES` (4 KiB) are not
deferred. `GET /transcript/detail?locator=` returns exactly the described value
or an explicit `missing`, `expired` or `too-large`; the locator embeds a digest
of the body it was minted for, so a later change to the same part is never
served as the revision the reader asked for. That is why a locator expires
when a streaming body changes (an accepted limitation).

Bounds (`bridge-transcript-summary.ts`): locators up to
`BRIDGE_DETAIL_LOCATOR_MAX_LENGTH` (2 KiB); tool details up to
`BRIDGE_TOOL_DETAIL_MAX_BYTES` (4 MiB) and file or image details up to
`BRIDGE_FILE_DETAIL_MAX_BYTES` (16 MiB), the same ceilings the backend applies
to its own deferred details; the summariser follows nested parts (`parts`,
`childTools`, `subagentActions`) eight levels deep.

## History pages and cursors

`GET /transcript/page?cursor=` serves the summaries before a position within
one content epoch: up to `BRIDGE_PAGE_MAX_MESSAGES` (200) and
`BRIDGE_PAGE_TARGET_BYTES` (1 MiB), except that a lone row larger than the
target is sent whole up to `BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES` (4 MiB),
because the next cursor starts before a row, never inside it. Bridge cursors
are at most `BRIDGE_PAGE_CURSOR_MAX_LENGTH` (1,024) characters.

The backend has one cursor namespace, direct (v2,
`native-agent-direct-history.ts`). A backend cursor wraps the provider's
cursor with digests of the logical session and provider session and the
provider's history epoch. It must fit `DIRECT_HISTORY_CURSOR_MAX_LENGTH`
(1,024); a provider cursor too long to wrap travels as a backend-held handle
(below). A cursor presented for another session or tab is `invalid`, and so
is any other cursor, including a v1 cursor of the retired joined paging
(0232 task 4, 2026-11-16): `getMessagePage` answers it as expired without
reading anything. The provider rejects a stale epoch itself. Pages are cached
in `DirectHistoryPageCache`, dropped when the session's epoch changes:
`NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES` (64) and
`NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES` (16 MiB) in total,
`NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES` (16) and
`NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES` (8 MiB) per session, with a
`NATIVE_DIRECT_PAGE_CACHE_TTL_MS` (5 min) backstop for a provider that edits
history without rotating its epoch (`native-agent-service-shared.ts`).

A progressive view carries a direct cursor (`historyCursor`; every cursor is
direct, so the `historyPaging` flag that once marked one was removed on
2026-11-16 by to-do 8173 (retired) task 2) whenever its provider pages and
it has older history to load. The provider's `historyCursor` names the position of its snapshot's first row,
which is usable while the view starts at or before it. When the view's own
byte bound drops leading rows the provider sent, the view names its first
kept row instead through the snapshot's `historyCursorBefore`: a bridge
cursor for that row's absolute position, named from the snapshot's
generation and content epoch (`bridgeTranscriptPageCursorFor`, so a window at
the first message, which carries no `historyCursor`, names one too), or, for
OpenCode, which pages by whole message, the cursor before the first kept row
that starts a message. When no kept row can name one (an OpenCode view left
with only an error row), the view pages from the window's end
(`historyCursorAtEnd`). Rows between the view's start and that position come
back on the first page too, and the renderer drops them by id. A provider
cursor too long to wrap travels as a short handle the backend holds
(`DirectHistoryCursorHandles`, bounded by count and bytes; to-do 8110,
retired 2026-11-15). A handle evicted or lost to a backend restart reads as
an expired cursor, and the renderer re-reads the view, which names a new one.
A kept view and a cached page mint their handle again each time they are
served, so neither hands out one the store has since evicted. The
end-of-window cursor names the window's newest row, inclusively (OpenCode's
`openCode2CursorThrough`), never "the newest rows": appends do not move the
epoch, and a page cached under a cursor is immutable within one. Byte bounding happens to ordinary
sessions: a tool call's detail reference is larger than a short output the
bridge summary kept inline, so a window of edits and short commands is
larger once projected than the bridge measured it. Before 0232 such a view
had no cursor, and **Load earlier messages** minted a joined one, a whole
transcript read (the `o` efficiency workload measures both). Joined paging
was removed on 2026-11-16 (0232 task 4): a view whose provider has no page
surface names no cursor, so it has nothing older to load, and the renderer
offers no control for it (a click that finds no cursor retires the control).

**Automatic paging.** The native tab pages without a click
(`useAutoLoadEarlier`): once when it opens on a transcript with earlier
history, so it shows the live window plus one page (up to 200 rows and
1 MiB), and again whenever the transcript's head comes within 800 px of the
viewport. It pages from the cursor the tab holds
(`canLoadEarlierAutomatically`), which is always a direct one. A page has its
own request identity (`native-history-page-fence.ts`), separate from the
live-tail reads: requesting one does not cancel a tail read already in flight,
and a background poll that lands while a page is in flight does not retire
it. The page merges into the live tail current when it lands, after checking
that it is still the newest page, that no mutation took over the transcript,
that session state and the live tail agree on the generation, and that the
generation, paging epoch and cursor it was fetched behind are unchanged.
A page is dropped when a mutation, a later
page, a new session generation, a read that replaced its epoch or cursor (a
rotated history, a collapse to the live tail) or a read that found the
session gone supersedes it. A held row that a poll revised while the page
was in flight keeps the poll's copy. If a poll instead arrives after a page
and carries a conflicting revision, the client keeps the displayed copy,
applies the live tail, and reconciles the held history with a fresh read.
A page that leaves the head where it was (superseded, or
failed) is retried once; after a second
it stops until the head moves some other way. Those two pages per head count
for the whole session, even if the head moved in between, so a transcript that
keeps collapsing back to its live tail cannot load and lose the same page over
and over.

If an OpenCode view retains only a failed message's inline error row after
dropping its oversized main row, no kept row can name a whole-message cursor,
and naming one before the failed message would strand its main row. That view
pages from the window's end instead (above).

## Changed rows outside the live window

Readers re-read only the live tail, but a late tool result, sub-agent report
or measured change can land on a row that has left it. A bridge notes such a
row in a `RecentlyRevisedRows` list and passes the ids as `revisedMessageIds`;
the v2 summary then carries those rows as `revisedMessages`, up to
`BRIDGE_REVISED_MESSAGES_MAX` (32) rows and `BRIDGE_REVISED_MESSAGES_MAX_BYTES`
(256 KiB). Rows omitted by those bounds change `historyReconciliationToken`,
which tells readers their retained copies may be stale. The token moves with
the content of the omitted rows, so a large row that keeps changing moves it on
every change: the row holding a Claude turn's Agent calls gains parts with each
tool its subagents call, can pass 512 KiB, and once a newer row exists it sits
outside the window.

The native tab therefore never takes rows off screen for a moved token while
the view names a direct cursor. It re-reads the rows it holds, walking back from
the tail's cursor (`reconcileHeldHistory`), and replaces the copies that
changed, at most once per `HELD_HISTORY_RECONCILE_INTERVAL_MS` (30 s). The debt
outlives a remount (`heldHistoryReconcileOwed`) and settles only when a walk
finishes with the token unmoved. Without a direct cursor the rows are dropped
and paged again. A new history epoch always drops them at once, because that
history no longer exists.

The rules for noting a row are in [`bridges/AGENTS.md`](../../bridges/AGENTS.md)
("Transcript rows").

## Row boundaries

Every bridge writes one row per model response (one step of the agent loop),
never one per turn: a turn kept alive by background work can run for hours,
and a multi-megabyte row fits no window. Each bridge's `AGENTS.md` names its
boundary:

- Claude: one root API message id per row
  ([`bridges/claude-bridge/AGENTS.md`](../../bridges/claude-bridge/AGENTS.md)).
- Codex: app-server names no response on its items, so the bridge splits at a
  reasoning or message item after a tool call, and at a new tool call after
  app-server's per-response `thread/tokenUsage/updated` report. A reload
  splits at the same places using the rollout's `token_usage_record` (or the
  older `token_count` event). Replayed rows get deterministic ids from their
  place in the rollout (`replayedRowId` in
  `bridges/codex-bridge/src/history/rollout.ts`), so every replay names them
  alike ([`bridges/codex-bridge/AGENTS.md`](../../bridges/codex-bridge/AGENTS.md)).
- Pi: Pi's `message_start` for an assistant message
  ([`bridges/pi-bridge/AGENTS.md`](../../bridges/pi-bridge/AGENTS.md)).
- Cursor: a top-level `step-started`, or failing that `turn-ended`
  ([`bridges/cursor-bridge/AGENTS.md`](../../bridges/cursor-bridge/AGENTS.md)).
- ACP: a provider `messageId`, else prose or thinking after a tool call, with
  a part cap per row ([`bridges/acp-bridge/AGENTS.md`](../../bridges/acp-bridge/AGENTS.md)).

## Backend projection and client delivery

The backend projects provider rows into the native view, reusing unchanged
rows (`native-agent-projection-entries.ts`) and encoding each once
(`native-agent-projection-encoding.ts`). A client reads with its last view
token and gets one of `unchanged`, `delta` (from a base token it holds),
`snapshot` or `cached` (a persisted or in-memory tail painted while the
provider read runs behind it). A delta is sent only when it holds at most
1,024 operations and encodes smaller than the snapshot.

Part-level patches are negotiated: the backend advertises
`transcriptPatchVersions` and emits patches only for a client that asks for
`NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION` (2), and only when a patch encodes
smaller than the message it replaces. A patch keeps, appends to, or replaces
each part; anything that does not line up (a missing message, an index out of
range, a part digest or length that differs) rejects the whole delta and the
client falls back to a snapshot. Other clients keep whole-message deltas.

### Response encoding

Three transcript reads and the legacy whole projection mark their result
(`markSpliceableResult`), and the gateway writes those with
`spliceEncodedJsonBytes`, copying each row's memoised JSON instead of
serialising it again: `get_native_agent_transcript_update`,
`get_native_agent_live_update`, `get_native_agent_message_page` and
`get_native_agent_projection`. The sync-v1 read
`get_native_agent_projection_update` was removed on 2026-11-16 (to-do 8173
(retired) task 1).
Everything except the rows is serialised natively in one `JSON.stringify`,
with a random per-process placeholder string where each memoised row goes;
the rows are then written straight into one buffer sized from their memoised
byte counts. The output is byte-identical to `JSON.stringify`: anything that
is not a plain object or array is serialised whole, and a body in which some
field already spells a placeholder is serialised whole too. The gateway sends
that buffer and reads the response size from it; an unmarked result is
encoded to bytes once the same way, rather than sized as a string first.

The first version (E11 part 0340) walked the whole result in JavaScript and
joined strings, and the gateway then sized the joined string before writing
it. That made a first snapshot, the read a tab pays on open, reload and every
snapshot fallback, slower than plain `JSON.stringify`, by up to about twice on
rows of a few KiB. Measured on 2026-11-11 (to-do 7553, retired) with
`bun scripts/benchmark-transcript-changed-read.ts --snapshot --gateway
--samples=600`, on beelink2 (Intel Core Ultra 9 285H, Bun 1.4.4) while other
builds were running, so the host was busy; each figure is the median of
per-round means with the two encodings alternating, from two or three runs.
In-process, each column is the gateway's whole encoding (bytes and their
size); through the gateway it is the round trip of one loopback request:

| First snapshot | Body | `JSON.stringify` | Old splice | New splice | Gateway, old splice | Gateway, new splice |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tool-parts`, 20 rows | 46 KB | 14–15 µs | 22 µs | 7–8 µs | 156–170 µs | 113–123 µs |
| `revised`, 100 + 20 rows | 242 KB | 61–73 µs | 125–135 µs | 39–41 µs | 326–345 µs | 187–194 µs |
| `near-full`, 100 rows | 423 KB | 108–153 µs | 202–205 µs | 61–66 µs | 448–488 µs | 243–270 µs |
| `short-incomplete`, 60 rows | 62 KB | 17–20 µs | 30–31 µs | 14–16 µs | 102–108 µs | 79–85 µs |

Changed reads answer with small deltas and were unaffected either way.

The legacy `get_native_agent_projection` is marked too, since 2026-11-11
(to-do 7755, retired). On 2026-11-10 the first splice cost more CPU per read
than `JSON.stringify` on its 100-row, 430 KB projection (about 600 µs against
450 to 500 µs), so it was left out; with the new splice the same benchmark
(`legacy-spliced` against `legacy`) measured 570 to 690 µs against 740 to
820 µs CPU per read on 2026-11-11, and 826 to 873 µs against 987 to 1,044 µs
in a second pair of runs that day with two `dev:test` profiles also running.
Its contract definition now sets `encoded`, like the other four, so its
result is no longer schema-checked in development. Its callers are mostly
in-process (Control MCP environment tools, node coordination), which receive
the same plain object; only reads that cross the gateway gain.
`commands-registry-native-splice.test.ts` pins which commands are marked;
re-measure before marking another.

### Incomplete previews and exact recovery

A provider window marked `complete: false` is either a genuine remainder
(the provider bounded it by count or bytes) or a hydration hole (a two-row
preview of a longer session). When the preview has fewer rows than the live
window (100), no omitted parts, and is neither a summary nor a view that
adopted the provider's page cursor, the backend asks whether its raw rows
already reach the window's 512 KiB target. If they do not, it schedules one
exact `messages` read in the background, at most once a second per view.

Answering that serialises the provider's raw rows, inline tool output
included, which are fresh objects on every read. It cost about 110 µs of a
370 to 440 µs changed read on a 60-row, 500 KB window (benchmark
`short-incomplete`). The answer is remembered per view under the provider's
token (`native-agent-preview-fill.ts`), so a view polled while nothing changes
measures its window once per revision: an interactive-snapshot provider polled
at one revision went from about 320 to about 200 µs of CPU per read
(`short-incomplete-idle`). Only a token that changes whenever the rows do is
trusted, the bridge's `sourceToken` or a derived token carrying the provider's
revision; a token made only of the row count and edge ids stays the same
while a streaming tail grows, so that preview is measured on every read. With
a derived revision token, only true answers are reused: a false answer is
remeasured because a short tail can grow past the byte target before the
revision advances. Explicit source tokens still cache both answers. A
recovery already scheduled for the same token is checked first and skips the
measurement altogether. Measuring row by row with an early stop was tried and
was about 15 µs slower under the target, the only side a byte-cutting bridge
produces, so the window is measured whole.

A part-trimmed head (one row larger than the whole window, reported by
`omittedParts`) also recovers through this read, at most once a second per
view however many readers share it; while a recovery is pending the view keeps
the last recovered transcript. A recovery that a newer revision overtook
while its read was in flight is still committed when the view has not moved
since the read started and the newer revision's recovery is pending, so the
view advances once per recovery even when reading the row outlasts the gap
between revisions; it never replaces a complete transcript that landed
meanwhile.

The recovered head row grows on every read, so no two views share it. The
ring of superseded views that serves a reader one view behind
(`native-agent-transcript-delta-bases.ts`) is bounded per key at 2 MiB, but
always keeps its newest base, up to 8 MiB for that one base, and the grown
row reaches a reader that negotiated patches as its appended text.

Measured with a loopback model (the conditional-reads spec's `trimmed-head`
scenario, see
[agent-testing.md](../development/agent-testing.md#live-conditional-reads-loopback-models)):
exactly one recovery read a second with one reader or two. Before 2026-11-13,
past about a million characters each recovered transcript reached readers as
a whole snapshot of about 3 MB (17.5 to 63 MB per viewer in 20 s), and past
about 1.7 million characters the view stopped moving until the turn ended.
After the fix, every recovered transcript reached every reader as a delta, 20
view changes in 20 s per viewer up to 2.49 million characters, at about
0.9 MB per viewer in 20 s (to-do 7845 (retired); its figures are in
`git show b2ca5530b:docs/todo/transcripts-and-observation/7845-trimmed-head-snapshots-and-stalled-view.md`).

### Deferred display bodies

The projection moves every tool output, error and diff body behind a
`detailRef` (`projectionPart`). It also sends two other bulky values as
previews, with the whole value behind its own reference
(`native-agent-deferred-display.ts`):

- **Tool input.** In a settled call (`success` or `failure`), a top-level
  file-contents or replacement-string field (`content`, `contents`,
  `old_string`, `new_string` and their camel-case and `oldText`/`newText`
  forms, `new_source`, `file_text`) over `NATIVE_DEFERRED_DISPLAY_MIN_BYTES`
  (1 KiB) becomes its first 200 characters and `…`, and the part carries
  `toolArgsDetailRef`. The detail holds the input after the artifact grant
  is redacted. Fields a collapsed row or card draws (`command`, `file_path`,
  `prompt`, `description`, mail `body`, `plan`, todo lists) stay whole, as do
  a running call's input and a plan-file write's contents, which the plan
  approval card reads.
- **Reasoning.** A thinking part over 1 KiB that another part of the same
  row follows (so it has stopped streaming) becomes its first 400 characters
  and `…`, and the part carries `contentDetailRef`.

The renderer fetches both through `get_native_agent_tool_details` when the row
is expanded (`useToolDetails`), as it does outputs. Measured on recorded
Claude sessions (2026-10-31) this cut projected bytes by 6 to 20%; it matters
most for sessions that write or edit large files, whose rows would otherwise
fill a byte-bounded page first. A renderer from before this change shows the
previews and cannot expand them; the `…` marks each cut.

### Terminal rows

A turn's ending (a provider error, an `error` or `stopped` notice, a kept stop
result) is not a transcript row: the provider reports it with session state.
The backend turns each into a system row with a `native-terminal:<kind>:<hash>`
id (`native-terminal-messages.ts`). The full projection appends them to its
messages. The progressive transcript read never sees session state, so the
state view carries them as `terminalMessages`, and the tab shows them after the
transcript; before that field (2026-10-27) a progressive tab never showed a
failed turn's reason, on any bridge platform. Both paths place the rows with
`withNativeTerminalMessages` (`packages/protocol/src/native-terminal-rows.ts`),
which drops a row whose id the messages hold and an error the last row already
states: OpenCode's inline error row, or the error `status` line Codex and Pi
put on a failed turn's last row. A kept stop result is consumed by the full
read the stop answers with, so it is not on the state view. The transcript
view, its tokens and the restart preview stay the provider's rows only.

### Failure presentation

Every failed turn renders through one component, `ProviderFailureAlert`: the
backend's terminal error row, a provider's inline error row (`error-…`) and the
error `status` line Codex, Pi and a Claude startup failure put on a reply. It
names a normalised reason (`@orkestrator/protocol/provider-failures`):
authentication, usage limit, rate limit, billing, model unavailable,
conversation too long, provider unavailable, or a plain turn failure. One table
gives each reason its title and explanation, whichever provider failed, and
the provider's own message stays under Details.

The reason comes from the provider's structured code when it gave one, and from
the error text otherwise. The Claude bridge translates the SDK's API error code
and the Codex bridge app-server's `codexErrorInfo` into `failureReason`, sent
beside `error` on the session snapshot only while the turn is failed. The
backend puts it on the terminal error row as `failure.reason`, or on its
matching status part when both describe the same failure. A reset comes from the
window named by the refusal, or from a single exhausted window when that is the
only reported candidate (`failure.resetsAt`). The
text classifier is permanent: Cursor, Grok, OpenCode and Pi have no code, and
neither do older bridges or rows recorded before the field. Claude's failure
text is often only "Claude ended the turn on an API error.", so its code is
what names the reason.

Each reason lists candidate remedies (sign in, retry, change model), and the
host offers only those it can perform, on the transcript's last row only. A
usage limit and a billing refusal offer no retry. Retry sends one continuation
prompt through the tab's ordinary submit path under a request id derived from
the failure row (`providerFailureRetryRequestId`), so two presses run one turn,
and it is disabled while the composer holds a draft or sending is held. Retry
runs the normal send preflight. The backend checks the current failure and
provider session under the dispatch lease before journaling the request. Find
temporarily reveals matching text in Details and restores the user's prior
choice when Find closes. Change
model opens the composer's model picker. Sign-in is the platform's own control
(Claude's recovery card, OpenCode's credential action). A reset time is shown
only when the provider stated one as a time; otherwise the provider's own words
are quoted as its words.

### One request per round

A visible tab polls, so what a round costs matters more than what one read
costs. A background round over tokens the view already holds sends
`get_native_agent_live_update`, which answers transcript and state with the same
reads and token rules as their own commands (`native-agent-live-update.ts`). A
backend advertises it in `liveUpdateVersions`; one that does not gets the two
commands, and so does any first, manual or post-mutation read, so a cold
transcript never travels with session state. The reads were separate so that a
slow transcript could not hold back state, which carries pending approvals and
the turn phase. The combined read keeps that: a part still running after 250 ms
answers `pending` and the client reads it on its own, joining the read already in
flight. A part that throws answers `unavailable`, as its own command would.

Discovery is not in the round (`NativeDiscoveryReadSchedule`,
`native-session-read-policy.ts`). A section refreshes only when a read finds it
expired, 30 s after its last refresh, and the backend announces a refresh that
changed anything (`discovery-renewal`, `discovery-deadline`, `command-catalog`,
`mcp-action` and the model catalogue causes). So a view reads discovery on those causes, on a
change with a cause it cannot place, on mount, a session change, a resync, a
resume or reconnect, a phase change, an explicit read, and while a section is
still `loading` or `stale` (2 s) or `unavailable` (5 s). A 30 s backstop with the
view's token covers a missed announcement and is what makes the backend look
again; with no read at all nothing would ever refresh, so nothing would ever be
announced. Coalescing a burst of session changes keeps a cause that names
discovery (`coalesceChanges`, `resource-sync.ts`).

A backstop read that finds a section expired answers `unchanged` when nothing
changed (todo 8151). The expired section is still served with its stored
availability (`ready`) while its renewal runs. The view and its token reflect
the renewed value and failure status; a changed value or a new failure is
announced. `stale` means a renewal failed and the value shown is the one before it. A provider runs at
most two section jobs at a time; a section the limit refuses is started when
one of them finishes (`deferredDiscoveryRenewals`), not left for the view's
next read. The command catalogue's `fetchedAt` is left out of the discovery
view, because it moves on every renewal and no view shows it. Before this,
each backstop became a `stale` view, a 2 s follow-up and a second follow-up
for the refused sections, all three whole bodies (about 32 KB each for a
Claude tab). On the loopback model a 120 s idle window went from 4 whole
views (96,676 B) to 5 `unchanged` answers (2,385 B); the attribution and
both measurements are in to-do 8151 (retired 2026-11-16:
`git show eb32124cc:docs/todo/transcripts-and-observation/8151-discovery-reads-during-a-quiet-turn.md`).

A renewal announces when the value changed as a view would show it or when
it first becomes stale after a rejection or the 2 s deadline
(`storeProgressiveDiscovery`). Readers then use their 2 s settling follow-up;
repeated failures and recovery with the same retained value stay silent.
Invalidation removes queued renewals as well as cached sections, including
queued-only sessions when their environment is deleted. A stored value must
not move when nothing did. Two normalisations keep it still: the runtime
section's drift counter is left out of the comparison (`discoveryAnnouncementKey`), and each MCP server's
tool names are stored in one fixed order (`orderMcpServerTools`), because
Codex app-server reports them as a map whose order changes between reads; the
Codex bridge also sorts them before its cut. Before that, an idle Codex view
was told to read again about once every 50 s (six announcements in 300 s,
13.3 reads a minute against Claude's 8; todo 7530). Each discovery
announcement is counted by section and by the content-free value paths that
changed (`discoveryRenewals` in `sessionInvalidations`, below), so the next
moving field is named by an idle run rather than guessed.

What a round costs the bridge was measured on isolated profiles with
loopback models (efficiency batch E10, to-do 6680, retired 2026-11-11:
`git show 1fd391e3a:docs/todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md`).
A state read is four bridge requests: Claude's `/session/:id`, `/questions`,
`/plan-approvals` and `/interactions`, or Codex's `/status`, `/config`,
`/approvals` and `/interactions`. Two more used to ride on every poll:

- **Steer qualification.** `GET /session/:id/steer/dispatch` answers whether
  the bridge can steer, which only changes when the bridge does. A positive
  answer is cached per session for the connection's base URL and token, for
  at most 60 s and 256 sessions (`http-bridge/steer-qualification.ts`); a
  refusal is never cached, so a failing bridge is still asked, and logged, on
  every poll.
- **Bridge health.** Each read resolves its provider through the local
  bridge's start command, which reuses a running bridge only after a
  `/global/health` probe: two per poll per viewer. A passed probe now stands
  for 2 s for the same process, port and token
  (`LOCAL_SERVER_HEALTHY_REUSE_MS`, `local-server-runtime.ts`); a reused
  answer never renews it. The activity sweep's peek still probes on its own
  cadence.

With both, a 20 s streaming window with one viewer made 1 steer probe (was
39) and 9 health probes (was 78; 160 with two viewers). Near the 512 KiB
window bound the bridge spent 3.7–4.2 ms per transcript read on Claude and
Codex alike, on snapshots of about 495 KB that a bridge delta would have cut
13 to 15 times. That was judged too small to justify a new wire form across
five bridges, so bridges still send whole windows and the backend computes
the renderer's delta.

Read timings are kept in-process, per domain (`transcript`, `state`,
`discovery`), with source, normalise and scheduler-wait phases
(`native-agent-progressive-metrics.ts`). They hold durations only, never
payloads or session identifiers.

### After an MCP server action

An MCP server action from the Agent Info panel (reconnect, enable, disable,
sign-in; `performProjectionMcpAction`) invalidates the session's projection,
which also drops its cached discovery sections. That alone tells no open
view: the panel kept the row it had (a reconnected server still `failed`)
until its 30 s backstop, and that read found the MCP section dropped
(`loading`, no value) and kept the old row for another round (todo 7221).

So the action then re-reads the session's MCP list once
(`refreshMcpAfterAction` in `native-agent-progressive-discovery.ts`), stores
it as a `ready` section, and announces `mcp-action`, a cause that names
discovery. The open view reads discovery on that announcement and gets the
acted-on row straight away. Claude's bridge stores the probe's or the live
control's status before it answers the action (`performSessionMcpAction`), so
that read is the list the user acted on, and it spawns nothing: it asks the
running CLI or returns the bridge's retained inventory. A failed read still announces, so the view reads again and schedules the
ordinary discovery job; an identity change while the read is in flight
(a newer epoch) discards it, as it does every discovery job.

## Restart previews (display tails)

The backend keeps one display tail per session in SQLite so a restarted app
can paint before the provider answers (the native display tails store in
[storage.md](storage.md)). Tails are capped at `NATIVE_DISPLAY_TAIL_MAX_BYTES` (512 KiB)
each, `NATIVE_DISPLAY_TAIL_MAX_SESSIONS` (128) sessions and
`NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES` (64 MiB), with LRU eviction
(`native-agent-display-tails.ts`).

`NativeAgentDisplayTailScheduler` holds at most one pending value per session.
A session becomes due `NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS` (2 s) after its
last update, but no later than `NATIVE_DISPLAY_TAIL_MAX_CHECKPOINT_AGE_MS`
(10 s) after it first became dirty, so a session that streams continuously
still gets a recent preview. Due sessions share
`NATIVE_DISPLAY_TAIL_MAX_CONCURRENT_WRITES` (2) writers, so 10 s is a due time
and queueing for a writer comes on top. A deletion fence stops a late write
from bringing back a deleted tail. Shutdown attempts each pending value once
within `NATIVE_DISPLAY_TAIL_SHUTDOWN_DEADLINE_MS` (1.5 s). A tail may paint,
but approvals, dispatch and workflow advancement use authoritative state.

## Workflow reads

**Progress probes** (`transcript-progress.ts`) sample the newest
`PROGRESS_TRANSCRIPT_WINDOW_MESSAGES` (8) rows within
`PROGRESS_SNAPSHOT_TARGET_BYTES` (64 KiB), in the summary representation where
the bridge serves it, conditionally on the last source token (kept only up to
`MAX_PROGRESS_SOURCE_TOKEN_LENGTH`, 1,024). The digest covers the window's
rows and its end position, not the provider's token, so usage, title and
access-time churn are not progress. Digests are versioned: 64 hex characters
holding a marker, a comparison base (digest version, representation, history
epoch) and a content hash. Digests from different bases are not compared: a
bridge restart, history reset, representation change or older baseline
rebases once and reports neither progress nor a stall. A provider without a
snapshot surface keeps the legacy one-row digest
(`PROGRESS_TRANSCRIPT_TAIL_MESSAGES`, 1).

**Pipeline transcripts** (`build-pipeline/transcript-store.ts`) are the
durable copy, never evicted. Manifests live in the database and bodies in
immutable, content-addressed chunk files; only the unsealed tail chunk is
rewritten. A checkpoint stages and fsyncs chunks, then commits the manifest in
the same transaction as the pipeline's control row.
`BUILD_PIPELINE_TRANSCRIPT_LIMITS`: 256 KiB target and 8 MiB maximum chunks,
48 MiB and 1,024 chunks per session, 16,384 sessions, 2 GiB in total, 512 KiB
manifests; oversized content is recorded as explicitly incomplete.
Unreferenced chunks are collected after `BUILD_PIPELINE_TRANSCRIPT_ORPHAN_GRACE_MS`
(10 min).

The supervisor writes a stage's transcript only at a persist boundary
(`DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS`, 5 s), when a turn ends, or while a
stall warning shows, and reads the whole body only when a progress probe moved
since the committed copy (`refreshMovedTranscript`,
`build-pipeline/transcript-checkpoints.ts`). The probe baseline is trusted
only while the committed copy is the read it gated, and a failed probe falls
back to the whole read.

## Ceilings

These are ceilings, not targets to raise.

| Bound | Value | Constant |
| --- | --- | --- |
| Live window | 100 messages, 512 KiB | `DEFAULT_NATIVE_AGENT_LIVE_WINDOW` (`packages/protocol/src/native-agent.ts`) |
| Projected history | 4,096 messages, 16 MiB | `NATIVE_PROJECTION_MAX_WINDOW_MESSAGES`, `NATIVE_PROJECTION_MAX_BYTES` (`native-agent-service-shared.ts`) |
| Client retained history | 4,096 messages and 8 MiB per session, 32 MiB in total | `CLIENT_HISTORY_MAX_MESSAGES`, `CLIENT_HISTORY_MAX_BYTES`, `CLIENT_HISTORY_TOTAL_MAX_BYTES` (`apps/web/src/hooks/useNativeAgentSession.ts`) |
| Backend history page | 100 messages and 512 KiB by default, at most 200 and 1 MiB | `NATIVE_HISTORY_PAGE_*` (`native-agent-service-shared.ts`) |
| Display tails | 512 KiB each, 128 sessions, 64 MiB | `NATIVE_DISPLAY_TAIL_MAX_*` (`native-agent-display-tails.ts`) |

## Retired compatibility paths

None remains. Joined `sync-v1` history paging retired on 2026-11-16 (to-do
0232 (retired) task 4; the to-do as it stood before:
`git show c1fcc573b:docs/todo/transcripts-and-observation/0232-direct-history-cursor-minting.md`).
It served a v1 cursor by refreshing the sync-v1
projection, a whole transcript read, and paging the backend's own joined copy
(`projectionHistory`); the renderer minted such a cursor from the sync-v1
projection whenever its view carried no direct cursor. Every view whose
provider pages now names a direct cursor (above), so the joined path, its v1
cursor namespace, the renderer's mint and the `history.joined-v1-page*`
counters were removed, with no adapter for an older peer
([version-compatibility.md](version-compatibility.md#retired)).

The sync-v1 projection read itself, `get_native_agent_projection_update`, went
on the same day (to-do 8173 (retired) task 1): its renderer wrapper, the
backend's per-session revision store and delta builder, and the
`projectionSyncVersions` capability, with a `native-sessions` bump to version
4. Tool-detail recovery still re-projects the session's live tail from its
whole transcript, now under the `"detail-recovery"` representation of
`refreshProjection` (`NATIVE_DETAIL_RECOVERY_TAIL_*`), so a paged row's detail
reference resolves again after cache eviction.

The `/messages` fallback of progressive reads retired on 2026-11-15
(to-do 0050 task 1; the to-do retired the same day: `git show a8b89f154:docs/todo/transcripts-and-observation/0050-transcript-history-efficiency.md`). Every bridge serves `/transcript`, and the Claude summary route loads
a persisted session before answering, so a 404 there means the session is
missing and the read is an empty, complete window. A 405 fails the read: only
a bridge that predates the route answers it. `/messages` stays for bounded
`messages({ limit })` reads, where `?limit=` is still advisory.

## Measuring

The function-level efficiency harness reproduces these paths with generated
fixtures and reports exact operation counts: unchanged reads, bridge windows,
projection, history paging, deltas, progress probes, pipeline checkpoints and
display-tail checkpoint age. See
[efficiency-harness.md](../development/efficiency-harness.md).

`scripts/benchmark-transcript-changed-read.ts` times one changed progressive
read in process against a provider fake (CPU, wall time, and the characters
serialised and hashed), plus the legacy `getProjection` read encoded both
ways. Its scenarios and how to compare two commits are in the script's header.

### Live bytes per prompt send and turn check

Efficiency batch E9 took its baseline with a provider fake
(`native-agent-transcript-read-bytes.test.ts`: before E9 a prompt send read 33
rows, 271,676 bytes, and a turn check 2 rows, 16,466 bytes, on its 8 KB rows).
The live figures come from `transcript-read-bytes-live.spec.ts`
([how to run it](../development/agent-testing.md#live-bytes-per-prompt-send-and-turn-check-loopback-model)):
a real Claude bridge and CLI against a loopback model, six streamed history
turns first, with no page rendering the session. Bytes are the response bodies
the bridge wrote (none was compressed on that loopback hop), without HTTP
headers; the backend's own timers (activity sweep, change-evidence poll) are
counted apart. Measured 2026-11-13 on `17d28238c`, Claude CLI 2.1.319:

| Read | Bridge requests | Bytes, mean (range) | Of which transcript rows |
| --- | --- | --- | --- |
| Prompt send (`dispatch_native_agent_intent`, 6 s window, model parked) | 11.4 | 18,569 (11,276 to 28,719) | 502: one bounded `/messages?limit` tail read |
| Turn check (`get_native_agent_session_state_update`) | 4.6 | 3,727 (3,683 to 3,988) | 0 |
| Turn check before E9 (one-message projection) | 6.7 | 7,406 (5,572 to 23,757) | 1,189 |
| No command: idle 10 s, or a parked turn 6 s | 0 | 0 (the timers alone: 2,193 to 2,325) | 0 |

A prompt send is the `POST /session/:id/prompt` (117 bytes), two state reads
(3.6 to 5 KB each, growing with the session), the tail read, `/mcp` (700
bytes) and four short interaction lists. On two of five sends a new CLI query
(`/init`) bumped the command catalogue's revision and the backend re-read the
18,152-byte catalogue; without it a send is 11 to 13 KB. A turn check is one
state read and three empty interaction lists, with no transcript read, which
the spec asserts. Real row sizes need a billed turn, an item on the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).
