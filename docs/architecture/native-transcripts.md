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
| `apps/backend/src/core/http-bridge-transcript-v2.ts` | Backend side of v2: capability learning, bounded reads |
| `apps/backend/src/core/http-bridge-progressive.ts` | Snapshot reads, with the v1 and pre-`/transcript` fallbacks |
| `apps/backend/src/core/native-agent-transcript-projection.ts` | Projection, conditional reads, deltas, history pages |
| `apps/backend/src/core/native-terminal-messages.ts`, `packages/protocol/src/native-terminal-rows.ts` | Terminal-state rows and where they are placed |
| `apps/backend/src/core/native-agent-direct-history.ts` | v2 history cursors and `DirectHistoryPageCache` |
| `packages/protocol/src/native-agent-transcript-patch.ts` | Part-level patches inside a delta |
| `apps/backend/src/core/native-agent-display-tail-scheduler.ts` | Restart-preview checkpoints |
| `apps/backend/src/core/transcript-progress.ts` | Progress samples and versioned digests |
| `apps/backend/src/core/build-pipeline-transcript-store.ts`, `build-pipeline-transcript-checkpoints.ts` | Durable pipeline transcripts and when they are written |

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

The backend has two cursor namespaces that never mix
(`native-agent-direct-history.ts`):

- **v2 direct.** A backend cursor wraps the provider's cursor with digests of
  the logical session and provider session and the provider's history epoch.
  It must fit `DIRECT_HISTORY_CURSOR_MAX_LENGTH` (1,024); a cursor that would
  not round-trip is not minted, and that page is served the joined way. A
  cursor presented for another session or tab is `invalid`; the provider
  rejects a stale epoch itself. Pages are cached in `DirectHistoryPageCache`,
  dropped when the session's epoch changes: `NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES`
  (64) and `NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES` (16 MiB) in total,
  `NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES` (16) and
  `NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES` (8 MiB) per session, with a
  `NATIVE_DIRECT_PAGE_CACHE_TTL_MS` (5 min) backstop for a provider that edits
  history without rotating its epoch (`native-agent-service-shared.ts`).
- **v1 joined (`sync-v1`).** A cursor names a message id in the backend's own
  joined projection, which is refreshed and fingerprinted before a page is
  served. Every bundled bridge and OpenCode serve direct pages, so this path
  serves only a source without them and renderers that mint a cursor where a
  view has none. It is a retained compatibility path; see the end of this
  document.

A progressive view carries a direct cursor (`historyPaging: "direct"`) when
its provider pages and a usable whole-message boundary remains. The
provider's `historyCursor` names the position of its snapshot's first row,
which is usable while the view starts at or before it. When the view's own
byte bound drops leading rows the provider sent, the view names its first
kept row instead through the snapshot's `historyCursorBefore`: a bridge
cursor moved to that row's absolute position
(`bridgeTranscriptPageCursorAt`), or, for OpenCode, which pages by whole
message, the cursor before the first kept row that starts a message. Rows
between the view's start and that position come back on the first page too,
and the renderer drops them by id. Byte bounding happens to ordinary
sessions: a tool call's detail reference is larger than a short output the
bridge summary kept inline, so a window of edits and short commands is
larger once projected than the bridge measured it. Before 0232 such a view
had no cursor, and **Load earlier messages** minted a joined one, a whole
transcript read (the `o` efficiency workload measures both).

**Automatic paging.** The native tab pages without a click
(`useAutoLoadEarlier`): once when it opens on a transcript with earlier
history, so it shows the live window plus one page (up to 200 rows and
1 MiB), and again whenever the transcript's head comes within 800 px of the
viewport. It pages only from a direct cursor
(`canLoadEarlierAutomatically`), so a joined mint or joined page, each a
whole-transcript read, still needs the button. A page that leaves the head
where it was (superseded by a poll, or failed) is retried once; after a second
it stops until the head moves some other way.

If an OpenCode view retains only a failed message's inline error row after
dropping its oversized main row, no kept row can name a whole-message cursor.
That view uses joined `sync-v1` paging instead; naming a cursor before the
failed message would strand its main row. A provider cursor too long to wrap
also requires joined paging.

## Changed rows outside the live window

Readers re-read only the live tail, but a late tool result, sub-agent report
or measured change can land on a row that has left it. A bridge notes such a
row in a `RecentlyRevisedRows` list and passes the ids as `revisedMessageIds`;
the v2 summary then carries those rows as `revisedMessages`, up to
`BRIDGE_REVISED_MESSAGES_MAX` (32) rows and `BRIDGE_REVISED_MESSAGES_MAX_BYTES`
(256 KiB). Rows omitted by those bounds change `historyReconciliationToken`,
which invalidates retained history so the client pages it again. The rules
for noting a row are in [`bridges/AGENTS.md`](../../bridges/AGENTS.md)
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

Read timings are kept in-process, per domain (`transcript`, `state`,
`discovery`), with source, normalise and scheduler-wait phases
(`native-agent-progressive-metrics.ts`). They hold durations only, never
payloads or session identifiers.

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

**Pipeline transcripts** (`build-pipeline-transcript-store.ts`) are the
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
`build-pipeline-transcript-checkpoints.ts`). The probe baseline is trusted
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

## Retained compatibility paths

Both are in the register of
[version-compatibility.md](version-compatibility.md#register), with their
removal conditions. Checked on 2026-10-26 and again on 2026-10-27: neither
serves only peers outside the support window.

- **Joined `sync-v1` history paging.** `getMessagePage` serves a v1 cursor by
  refreshing the sync-v1 projection, which reads the whole transcript, and
  paging the backend's own joined copy. Every renderer reaches it the same
  way: when the progressive view carries no direct cursor, **Load earlier
  messages** mints one from the sync-v1 projection, which only mints v1
  cursors. Since 0232 a view whose provider pages carries a direct cursor
  when a usable whole-message boundary remains, and every renderer in the
  window adopts it. On this backend the joined path serves sources without
  direct pages (the `/messages` fallback below, a bridge without page routes),
  a provider cursor too long to wrap, and an OpenCode view retaining only a
  failed message's inline error row after its main row was byte-omitted. The
  renderer keeps the mint for those and for backends before 0232. Each joined
  page is counted by why the session's latest view had no direct cursor:
  `history.joined-v1-page.unpaged-source`, `history.joined-v1-page.unnamed-cursor`,
  or `history.joined-v1-page` when it had one or none was read.
  [0232](../todo/transcripts-and-observation/0232-direct-history-cursor-minting.md)
  owns removing it.
- **The `/messages` fallback.** When `/transcript` answers 404 or 405,
  `readHttpBridgeTranscriptSnapshot` reads the whole `/messages` body and
  keeps the newest window itself, so a progress probe there also costs a
  whole read. That serves bridges before #670 and, until 2026-10-26, every
  Claude bridge: its `/transcript` read only resident sessions, so after a
  bridge restart a persisted session answered 404 and only `/messages` loaded
  it. The Claude summary route now loads the session first, so its 404 means
  missing. When `/messages` also answers 404 the session is missing and the
  read is an empty, complete snapshot, not counted as compatibility use.
  `/messages?limit=` is advisory for the same reason.

## Measuring

The function-level efficiency harness reproduces these paths with generated
fixtures and reports exact operation counts: unchanged reads, bridge windows,
projection, history paging, deltas, progress probes, pipeline checkpoints and
display-tail checkpoint age. See
[efficiency-harness.md](../development/efficiency-harness.md).
