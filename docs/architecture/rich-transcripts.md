# Rich transcripts and transcript artifacts

How agent responses render code, diagrams, tables, callouts, disclosures,
media, native charts, workflow snapshots and HTML artifacts, and how durable
artifacts are authored, verified, published and replayed. The specification
this implements is `docs/temp/rich-transcripts.md`; this file describes the
shipped design. Executable HTML specifics live in
[transcript-artifacts-runtime.md](transcript-artifacts-runtime.md).

## Two presentation paths

1. **Markdown text** (`TextPart` → `MessageMarkdown`) goes through a bounded
   react-markdown parse with AST plugins, then trusted native block
   components: `CodeBlock`, `MermaidBlock`, `RichTable`, `RichCallout`,
   `RichDetails`, `ChartFenceBlock`, media. Fences carry no publication
   identity and no backend authority.
2. **Transcript artifacts** are created through Orkestrator's ordinary agent
   tools, stored as immutable revisions, verified by a kind-specific receipt,
   published into a conversation's ledger, and rendered by `ArtifactPart`
   from a `type: "artifact"` transcript part.

Both share `RichBlockFrame` (title, toolbar, error boundary, source
fallback), the scoped view-state store, the render scheduler and the copy /
search conventions.

## Shared contracts (`packages/protocol`)

| Module | Contents |
| --- | --- |
| `rich-content-policy.ts` | Every limit in the specification's policy table. Tests import limits from here. |
| `chart-spec.ts` | Strict `ChartSpecV1` (bar, line, area, scatter, donut) with field-path diagnostics; strict JSON text parsing. |
| `chart-scene.ts`, `chart-svg.ts` | Deterministic scene model (domains, 1/2/5 ticks, geometry, legend, data rows), CSV, and self-contained SVG export. Used by the renderer and the backend validator. |
| `workflow-snapshot.ts` | `WorkflowSnapshotV1`, validation, deterministic role/id layout. |
| `transcript-artifacts.ts` | Kinds, refs, revision/operation/receipt/publication records, verification identity, errors, tool names, `orkestratorToolName`. |
| `transcript-artifacts-validation.ts` | Draft/probe/profile validation; `readTranscriptArtifactRef` (unsupported kinds and versions become placeholders). |
| `transcript-artifact-commands.ts` | UI command names and shapes. |
| `artifact-frame-channel.ts` | The four-message presentation channel, rate limiter, link normalization, in-frame runtime. |
| `artifact-host-ipc.ts` | Desktop live-host IPC contract. |
| `canonical-json.ts` | Canonical encoding for hashes; duplicate-key-rejecting JSON reader. |
| `css-resource-scan.ts` | Tokenizing scan for fetch-capable CSS (`url()`, escapes, `image-set`, `@import`). |
| `tabular-export.ts` | RFC 4180 CSV (exact and spreadsheet-safe), Markdown tables, safe fences. |

## Identity

`apps/web/src/lib/chat/rich-identity.ts` encodes tuples, never concatenated
strings:

- **Block view identity** `(backendId, environment, session, message,
  sourcePartId, stableBlockId)` keys view state and React identity. Streaming
  tokens do not change it.
- **Artifact occurrence identity** adds `(publicationId, artifactId,
  revision)`.
- **Cache identity** adds the content hash, renderer version, theme and
  display parameters. Highlight and Mermaid cache keys also carry the
  conversation scope (`richScopeKey`: backend, environment, session), so
  identical content in two environments or backends never shares a cached
  result; highlight keys also carry a font generation
  (`lib/chat/highlighter/font-generation.ts`, advanced on
  `document.fonts` `loadingdone`). Mermaid keys are scoped when the caller
  passes `useMermaidRenderOptions().options` to
  `peekMermaidPreview`/`requestMermaidPreview`; without it they fall back to
  the detached scope.

`backendId` comes only from the authenticated connection
(`transcript_artifact_capabilities`), provided by `RichTranscriptScopeContext`
in the native agent tab; `generation` changes when the provider session is
replaced so late responses from a discarded session are dropped.
`NativeMessage` provides `RichMessageContext`.

## Bounded client state

- `stores/richContentViewStore.ts`: disclosure, source/preview/data choice,
  wrap, expansion, hidden chart series and diagram viewport, keyed by scoped
  identity. At most 500 inactive entries (LRU), mounted entries bounded
  separately (200), pins bounded (50) with the displaced pin reported to the
  caller. `clearPrefixes` removes one conversation's entries. Expanded views
  (chart, full workflow inspector, Mermaid dialog, expanded code) pin through
  `pinRichViewWithRecovery` (`CodeBlockViewer.tsx`): a block whose pin is
  displaced closes its expanded view and shows a **Reopen** notice; its view
  state is captured at displacement (at most 50 captures) and Reopen restores
  it and pins again, even if the store evicted the entry meanwhile. Pins made
  directly with `pinRichViewKey` bypass this notification.
- `lib/chat/rich-render-cache.ts`: lanes `highlight` (2 concurrent) and
  `diagram` (1); at most 32 queued jobs and 2 MiB queued source (refused with
  `RichRenderCapacityError`, callers show plain source); visible before
  prefetch; in-flight de-duplication with subscriber counting; settled LRU of
  128 entries / 16 MiB with release callbacks; deterministic failures cached
  per input, transient failures not; content-free counters. Queued source is
  counted in UTF-8 bytes. `clearMatching` cancels in-flight work and drops
  settled entries for a deleted scope; `epoch()`/`useRichRenderEpoch()`
  changes on every clear so mounted blocks request cancelled work again.
- `lib/chat/rich-render-priority.ts`: one IntersectionObserver per
  transcript observes the mounted rows and, individually, the mounted rich
  blocks (implicit root, so the scroller clips). `CodeBlock` and
  `MermaidBlock` register their frame (`[data-rich-block]`) through
  `useRichBlockVisibility()` (a callback ref; register on attach, unregister
  on detach, no per-block observers) and pass that block's visibility to
  `useHighlightedLines({ visibility })` / their diagram request, so a long
  row whose first block is on screen requests idle `prefetch` for the
  blocks further down it. A block or row that intersects the viewport
  requests `visible`; overscan and offscreen ones `prefetch`. First answers
  are synchronous geometry checks when the ref attaches, before child
  effects request work; until the observer has answered for a block it
  follows its row, and outside a transcript everything is visible. A queued
  prefetch is promoted (`scheduler.promote`) when its block (or row) scrolls
  in. Block registrations are capped at `MAX_OBSERVED_BLOCKS` (256) per
  transcript; a block over the cap follows its row. Nothing is queued for
  rows that are not mounted.

## Protected content clearing

`lib/chat/rich-content-reset.ts` is the one place that clears protected rich
content. Caches register themselves (`registerProtectedRichCache`) so the
module imports no transport or hook code: artifact reads and search bodies
(`artifact-requests.ts`), publication ledgers (`useArtifactPublications`),
the authenticated identity (`useTranscriptArtifactCapabilities`), search
projections (`markdown-search.ts`) and resolved media
(`media-resolver.ts`, including the image preview cache). The render
scheduler and the view store are cleared directly.

| Trigger | Call |
| --- | --- |
| Gateway token changed (re-authentication, `applyGatewayToken`) | `clearProtectedRichContent("credentials")` |
| Agent-test session lapsed (`handleCredentialLapse`) | `clearProtectedRichContent("logout")` |
| Browser gateway replaced (`installBrowserGatewayApi` with `replaceExisting`) | `clearProtectedRichContent("gateway-replaced")` |
| Desktop connection switched (`App.tsx` connection list) | `noteRichContentConnection(id)` clears on a change |
| Capabilities report a different `backendId` | `noteRichBackendIdentity(id)` clears before exposing it |
| Environment deleted (`environmentStore.removeEnvironment`) | `clearRichEnvironmentContent(id)`: that environment's view state, render entries, artifact reads and ledgers |
| Conversation deleted or revoked (see below) | `revokeArtifactConversation(scope)` → `clearRichConversationContent(scope)` |

Reads in flight across a clear never repopulate a cache (artifact reads
check their in-flight slot, ledger keys carry a clear epoch, capability
reads a generation), and mounted readers re-read under the new epoch. The
renderer has no explicit logout. Closing a tab clears nothing.

Conversation deletion and revocation are decided from authoritative reads
(`artifact-requests.ts`), because the backend answers `not_found` alike for
a missing publication and an out-of-scope one, and its ledger and draft
lists answer an empty list (not `not_found`) for a deleted conversation:

- The backend's `deleteConversation` announces the conversation's
  `transcript-artifact` hint after its commit. `useArtifactPublications`
  re-reads the ledger; publications are immutable and only removed with
  their conversation, so a ledger that showed publications and now reads
  empty (and complete) is a deletion. The same comparison runs on remount
  against the cached ledger, so a deletion missed while unmounted is still
  recognised.
- A ledger read failing with `not_found` or a permission-style failure
  (HTTP 403, or a `forbidden`/`unauthorized`/`permission_denied`/
  `access_denied` code) means the scope itself is gone.
- A publication or representation read failing with `not_found` or a
  permission failure re-reads the ledger (`verifyArtifactConversation`, one
  in flight per conversation): a scope-level failure as above, or an empty
  ledger for a conversation whose content this window had loaded, revokes
  it; a readable non-empty ledger means only that publication is
  unavailable and nothing is cleared. A conversation this window never
  loaded content for is not cleared on an empty ledger.

Revocation clears once: the conversation is marked `revoked` (bounded
content-free map) until a later non-empty ledger read shows it again, so
readers re-requesting after the clear cannot loop. Transient failures
(`storage_unavailable`, transport errors) clear nothing.

Native sessions have no deletion path to hook. The projection's `missing`
status is reported before a session is ensured or adopted and after a
backend restart, and the `native-agent-session` change with `deleted: true`
(`invalidateNativeAgentSession`) retires a provider mapping on tab teardown,
coordinator conversation close or session replacement; in each case the
conversation's artifacts stay owned by its logical key and reopening it
recovers them, so neither clears anything.

## Publication placement

The backend publication ledger is authoritative. Placement happens in two
places that share one rule set and de-duplicate by publication id: the
backend read path of each transcript (the native projection, and the
workflow transcripts below), and the renderer's merge, which fills in what
the rows it holds do not carry. The same two halves serve the native agent
tab, Multi Review reviewer tabs, build-pipeline stage transcripts and
feature-planning chats.

**Backend projection** (`native-agent-service-projection-artifacts.ts`).
Every projection read asks the ledger for the conversation's revision
(conversation key = the session's `logicalSessionKey`, owner environment =
the session's environment; publications of any other conversation or
environment are refused even if a ledger returned them) and re-reads its
publications only when that revision moved or a post-commit hint arrived
(the newest 2,000 of at most 10 pages of 1,000, kept for 64 conversations).
It appends a `type: "artifact"` part (`TranscriptArtifactPartWire`,
`sourcePartId: "artifact:<publicationId>"`, `content` from
`artifactPartContent`) to the end of the row holding the publishing call,
after the per-row projection cache: cached rows are never modified, and an
overlaid row is memoized only under the ledger read that produced it.
Placement is decided per read over the rows that read holds. It never
inserts a row, so provider-positioned windows and history indexes do not
move; a publication with no matching call among the rows read is left to
the renderer.

- The progressive transcript token mixes in the ledger revision, and a read
  whose ledger moved since the previous view does not offer the provider its
  source token, so a provider "unchanged" cannot hide a new publication. A
  row inside the window changes in place; a row outside it that the previous
  view or the per-row cache still holds is sent in `revisedMessages` (and
  kept there while it stays outside the window), within
  `NATIVE_AGENT_REVISED_MESSAGES_MAX` and the revised-rows byte bound
  together with the provider's own revised rows. A part-trimmed head row is
  never sent this way.
- Direct history pages are cached as provider rows and overlaid on the way
  out, so a ledger change never leaves a stale cached page.
- The sync-v1 and whole-transcript projections (`getProjection`, read by
  Control MCP, web annotations and the agent information panel) are
  overlaid the same way. The public API's `session transcript` reads the
  progressive view and direct pages, so the CLI sees the parts too.
- Each committed publication announces `native-agent-session` for its
  environment so open views re-read.

**Native agent tab merge.** The tab still reads the ledger per conversation
(`useArtifactPublications`: on mount, on transport generation change, when a
`transcript-artifact` resource event names the conversation key, on a full
resource resync, and with bounded backoff while a publish call in the loaded
transcript is neither in the ledger nor already carrying its part) and
merges it into the loaded messages (`lib/chat/artifact-publication-merge.ts`).
The resource event is only a hint to re-read; a missed event is recovered by
the next authoritative read.

The ledger is paged forward 200 at a time up to 50 pages (10,000
publications) and the newest 2,000 are kept. Nothing is dropped silently:
when older publications were left out, or the read stopped at its page
bound, the merge adds an explicit system notice row
(`orkestrator-artifact-notice:omitted`, "N older artifacts not loaded …").

- **Already placed**: any artifact part present in a loaded row — at the
  top level or inside a tool, agent or task group, typically the backend's —
  counts as placed and is never added again.
- **Anchored by the backend**: a publication whose ledger entry carries
  `anchor.toolCallId` is appended to the row holding the tool part with that
  `toolUseId` (including tool parts inside a tool group). This wins over
  argument matching; when that call is not loaded, argument matching is
  tried.
- **Anchored by arguments**: a successful `publish_artifact` call whose
  arguments name the artifact and revision gets the artifact part appended
  to the end of its own row. Matching uses arguments and the ledger, never
  tool output, so trimmed, flattened or text-only tool results still show
  the artifact.
- **Unanchored**: a backend-attributed row
  `orkestrator-artifact:<publicationId>` placed by publication time, only when
  that time is inside the loaded range; older ones appear when their history
  page loads. Unanchored rows keep `conversationSequence` order among
  themselves even when their clocks disagree. The native tab and the
  workflow surfaces below create these the same way.

Each publication appears once; a newer revision never retargets an older
row. Text, JSON or tool output that resembles a reference never becomes an
artifact part.

Both placements need the publishing call in the reloaded transcript. Codex
code mode runs the call inside an `exec` cell; a history reload renders the
rollout's recorded `McpToolCall` item through the live normalization, so the
reloaded call part equals the live one. A cell with no record falls back to
a bounded strict-JSON parse of `tools.mcp__<server>__<tool>({...})`
(`bridges/codex-bridge/src/history/code-mode-mcp-calls.ts`), which never
reports success and so never anchors on its own.

Limits: a publication whose row neither the previous view nor the per-row
cache holds (deep history the backend has not re-read) reaches an open tab
through its own merge and other readers when they next page that row.

### Workflow transcripts

Multi Review reviewer tabs, build-pipeline stage transcripts and
feature-planning chats read their providers (or their stored copies)
directly rather than through the native projection. Each one is its own
conversation: the workflow session's own durable key in the workflow's
environment, never anything a model supplied.

| Surface | Conversation key | Environment |
| --- | --- | --- |
| Multi Review reviewer | the reviewer's `sessionKey` (`multi-review:<workflow>:reviewer:<id>`, rotated on restart) | the workflow's |
| Build-pipeline stage, fan-out reviewer, consolidation | the stage session's `sessionKey` | the pipeline's |
| Feature planning | `featurePlanningConversationKey(featureId)`; a story's refinement chat adds `:story:<storyId>` | the plan's `codexEnvironmentId` |

**Publishing.** These agents have no tab credential, so every dispatched
turn goes through the same per-turn bookkeeping as a native turn
(`workflow-artifact-turns.ts`, sharing `artifactDispatch` with the native
service): the turn is noted for attribution and a grant bound to the
conversation, turn and provider session is minted, then revoked when the
turn settles (the reviewer's status read shows the turn ended, the stage
goes idle, the planning reply is read, the exchange fails or is cancelled)
or when its send is refused. No grant is minted while artifact publication
is rolled back. The grant reaches the agent the way its provider can carry
it:

- **OpenCode** keeps its environment-wide `orkestrator` registration beside
  the workflow-result broker, so the grant is the prompt's trusted system
  instruction (`artifactGrant`), as for a native OpenCode turn.
- **HTTP bridges** (Claude, Codex, Cursor, Grok, Pi) replace `orkestrator`
  with the attempt's restricted workflow-result server in tool mode. The
  grant is added to that connection as `agentMcp.artifacts`, and the bridge
  adds a second, artifact-only MCP server, `orkestrator-artifacts`, at
  `/artifact-mcp` on the agent tool server. Its bearer token is the grant
  itself; the agent tool server lists only the seven artifact tools there
  and authorizes every call with that grant, whatever `scopeCapability` the
  model passes. A grant is refused on `/mcp` and every other credential is
  refused on `/artifact-mcp`, so the workflow-result credential still
  carries no artifact authority (`owner.ts` keeps refusing it) and the grant
  none of the result tools. Each bridge reserves the server name, allows its
  tools under every approval policy and in read-only turns (they write only
  to Orkestrator's artifact store), and reattaches when a new turn's grant
  arrives. `orkestratorToolName` treats `orkestrator-artifacts` as an
  Orkestrator server, so its publish calls anchor like any other.

**Placement.** The backend overlays the ledger at each surface's read path
with the native helper (`WorkflowTranscriptArtifacts` over
`ArtifactOverlayIndex`/`overlayArtifactParts`): the reviewer transcript
read, its revised rows and history pages, and every `get_build_pipeline`
message patch. Rows are never inserted, so patch indexes and cursors do not
move. A reviewer's conditional-read token is bound to the conversation's
ledger revision, so a provider "unchanged" cannot hide a new publication.
Feature-planning messages are plain text with no tool calls, so nothing
anchors there; their publications are placed by the renderer as unanchored
rows by publication time, between the request and the reply of the turn
that published them.

**Rendering.** Each surface wraps its rows in a `RichTranscriptScopeContext`
(`useWorkflowTranscriptArtifacts`: `backendId` from the capabilities read,
the conversation above, the provider session as the generation) and merges
the ledger through `useArtifactPublications` and
`mergeArtifactPublications`, so cards resolve in their own conversation,
open views re-read on the conversation's `transcript-artifact` hint, on a
full resync and while a publish call is unresolved, and search, copy, Run
interactive and protected-content clearing behave as in the native tab. A
view that does not know its conversation yet reads nothing.

Limits: an HTTP-bridge workflow turn without a tool-mode connection (a
rollout that disables tool mode for that provider and result kind, or a
stage with no result tool such as PR creation) gets no grant; its
environment-wide `orkestrator` server lists the artifact tools but refuses
them without one. Build-pipeline rows the client already holds are not
re-sent when the ledger moves; the renderer's merge places those.

## Markdown pipeline

`MessageMarkdown` keeps react-markdown and its 32,000-character block /
8,000-character inline caps; the inline renderer still emits phrasing only
and no interactive links. `TextPart` passes a stable `richPartId`
(`sourcePartId` or the part key) to enable the rich path
(`lib/chat/rich-markdown/`):

- `remark-rich-markdown.ts` attaches source offsets, exact fence bodies,
  language and display-only `title`/`file`/`filename` hints, closed/open
  state (a fence clipped by the parser cap is never closed) and block ids of
  the form `kind:offset`, so repeated identical blocks stay distinct and
  appended text never changes earlier ids.
- `disclosure-syntax.ts` is a micromark extension for own-line
  `<details>` / one `<summary>` / balanced `</details>` (nesting at most 4,
  no attributes, never inside code). Recognition is transactional: an
  incomplete, malformed or over-depth candidate is emitted as literal text
  and parsing continues. Bodies are parsed in the same document, so link
  references cross the boundary. No global `rehype-raw`.
- GFM alert blockquotes (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
  `[!CAUTION]`) become `RichCallout`; unknown markers stay quotes.
- Fence routing: closed `mermaid` → `MermaidBlock`; closed `chart` →
  `ChartFenceBlock` (strict `ChartSpecV1`, no publication affordance); `json`
  keeps the existing JSON treatment; `html`, `svg` and JavaScript stay inert
  source. Open fences show source with a generating state.
- `streaming-text.ts` coalesces display updates to at most one frame and
  20 per second per part with an immediate final flush; provider events and
  backend buffering are untouched.
- Omitted characters show a notice with Copy/Open full source.

## Block components

- **Inline code file references**: inline code such as `src/app.ts:12`,
  `src/app.ts:12:4`, `C:\repo\a.ts:3`, `/abs/a%20b.ts:5` or `src/a.ts#L10`
  becomes a link through the same environment-aware `MarkdownLink` /
  `createFileTab` path as prose file links
  (`lib/chat/inline-file-reference.ts` over `parseLocalFileLinkTarget`). It
  requires a directory part, a file-like last segment and a line number;
  bare names, identifiers, URLs and fenced code are never linked. The text
  stays inside `<code>`, so find and copy are unchanged.
- **CodeBlock**: Shiki 4.5 (`shiki/core`, Oniguruma WASM) in a dedicated Web
  Worker (`lib/chat/highlighter/`), languages compiled on first use, React
  token spans, plain source shown immediately and on any failure (with
  retry). Highlighting stops at 32 KiB or 2,000 lines; 24 visual lines shown
  before Expand. Collapsed and expanded views render the same bounded region
  of at most 400 source lines (`INLINE_CODE_LINE_LIMIT`); expanding only
  lifts the height clip. Fences above the highlight limit render that region
  as one plain text node, never one element per line. Lines beyond 400 live
  in one hidden find mirror; the expanded view says how many lines are
  omitted and offers "Open all N lines in viewer". Copy code copies the exact fence body; Copy as Markdown uses
  a fence longer than any backtick run. "Open in viewer" uses a read-only
  dialog; file hints never write files. Run in terminal is offered only for a
  complete, single-line, non-streaming shell fence without control or bidi
  characters, and opens a new plain terminal through the existing terminal
  capability after the click. Deviation: Vite's default worker format bundles
  all grammars into one worker chunk loaded on first highlight; per-language
  chunks would need ES module workers, which the packaged `file://` renderer
  cannot load.
- **MermaidBlock**: rendered by the backend's supervised Chromium job
  (`transcript_artifact_render_mermaid`, strict security, no HTML labels,
  limits re-checked), sanitized again in the renderer (`svg-sanitize.ts`,
  dedicated DOMPurify SVG profile with tokenized CSS checks) before insertion.
  Source/preview toggle, pan/zoom/fit/reset, SVG and PNG export. Syntax
  errors are cached per source and never retried automatically; an earlier
  preview is labelled while a new one renders. Without the headless renderer
  the source is shown with an explanation. Math labels are not rendered
  (HTML labels are off, KaTeX is not used); the backend refuses `$$…$$`
  sources with diagnostic `math_labels_unsupported` and they fall back to
  source. The expanded dialog's
  open state is kept in the scoped view store, so it survives scrolling
  away and back.
- **RichTable**: semantic headers and alignment, local horizontal scrolling,
  wrap and expand, Copy as Markdown / CSV, Download CSV (UTF-8 BOM) and a
  separately labelled spreadsheet-safe CSV. No automatic sorting.
- **Media**: a shared environment-scoped resolver (existing detail refs and
  file reads, the image preview cache), a gallery dialog with keyboard
  navigation, zoom, pan, fit, original size, Copy image and Download
  original, and MIME-aware previews (audio/video with native controls and
  metadata preload, SVG files as images only, HTML attachments as source,
  others as metadata and download). PDFs show a static first-page image and
  the page count rendered by the backend's isolated preview worker
  (`transcript_media_pdf_preview`, see
  [PDF attachment previews](transcript-artifacts-runtime.md#pdf-attachment-previews)),
  or metadata only over 100 pages / 20 MiB, without a worker, or for
  inline-only bytes; Download original always remains.
  Markdown images reserve a bounded 4:3 box until bytes load, then their
  header dimensions (PNG/GIF/JPEG) as `width`/`height`; states are distinct
  (pending, blocked, denied, unavailable with Retry, too large, unsupported
  or over the 40-megapixel decode ceiling, decode failed) and failures keep
  the alt text and permitted actions. File-preview video and audio read no
  bytes until **Load video** / **Load audio**. Activation then opens a
  range-capable stream when the backend reports a `contentOrigin` this
  renderer can reach (`mediaStreamingAvailable`: a hosted content origin,
  or a loopback one from a loopback page or the packaged desktop renderer):
  `transcript_media_open_stream` returns a short-lived capability URL on the
  artifact content origin that the `<video>`/`<audio>` element (native
  controls, `preload="metadata"`, no autoplay) reads with single byte
  ranges. Streamed media is bounded by the backend's maxima (2 GiB host,
  512 MiB container; `STREAMED_MEDIA_MAX_BYTES`), not the 8 MiB inline
  bound. Destroying the viewer pauses the element and closes the capability
  (`transcript_media_close_stream`); nothing else is cancelled. Only files
  the resolver itself would read from a live path stream
  (`mediaStreamTarget`: an absolute host path, or a safe workspace-relative
  container path; never inline, remote or detail-reference bytes). The
  bounded base64 path stays the fallback: no reachable content origin, an
  older backend, a transient staging limit (`renderer_unavailable`,
  `capacity_exceeded`, unknown command), or a stream that errors before its
  metadata loads (a desktop window attached to a remote backend). Refusals
  (`policy_denied`, `not_found`, `package_size_exceeded`,
  `unsupported_kind`) are shown as denied, unavailable, too large or
  unsupported and never retried through base64. Playback that stops after
  metadata (expiry, revocation) offers **Load again**. On the base64 path,
  assets above `INLINE_MEDIA_PLAYBACK_MAX_BYTES` (8 MiB, the existing
  per-attachment limit; `lib/chat/media-presentation.ts`) offer Download
  original instead of playback. A streamed asset within 8 MiB keeps
  Download original, read only when clicked. Markdown images
  (`MediaBlock.tsx`) are images only and do not stream. Attachment
  thumbnails in `NativeMessage.file-parts.tsx` do not yet use these states.
- **Diffs**: edit and shell rows render backend-prepared change projections
  and hunks (raw-lines-v1 counts and bodies from one measurement); the client
  never counts or diffs. Bodies beyond their budget say so and keep exact
  counts. See [change-tracking.md](change-tracking.md).

## Find, copy and accessibility

Find pairs model matches with DOM text per rich block
(`lib/chat/rich-markdown/search-segments.ts`). `markdownSearchProjection`
returns the searchable text plus one segment per outermost keyed block —
code, diagram, disclosure, table — with its stable block id, its range in
the projected text, its range in the part's source and its reveal action
(`open-disclosure`, `show-source`). `getNativeMessageSearchText` carries
`getNativeMessageSearchProjection` (`withSearchProjection`), which numbers
segments by source part. `VirtualizedMessageList` groups DOM ranges by the
outermost `data-rich-block-key` around them (decoded to source part and
block id) and pairs the n-th match of a block with the n-th range inside
that block's element; prose pairs by ordinal among prose ranges only, so a
disagreement inside one block cannot shift any other match. Repeated block
ids in several parts of one message pair by part order. A chart fence is
not keyed (its labels are a mirror beside the chart) and counts as prose.
Reveal acts on the block that holds the active match. **Offset
convention:** every offset is UTF-16 code units (JavaScript string
indices) with no normalization — projected-text offsets, source offsets and
`findAgentChatTextMatches` alike.

`native-message-search.ts` indexes text parts from the renderer's own parse
(`markdown-search.ts`), including hidden disclosure bodies, diagram source
and chart labels, and artifact cards by their search roots: the summary,
then — once the card has loaded and is showing it — the body
(`artifactPartSearchSegments` in `lib/chat/rich-search-text.ts`). A chart
artifact's body root holds its labels (`chartSpecSearchText`), a workflow
snapshot's its title, description, node and edge labels, both as hidden
mirrors bounded to 64 Ki characters; a Mermaid artifact's source is a search
root only while its source view is shown. The card writes that text to a
bounded synchronous cache keyed by publication id
(`rememberArtifactSearchBody` / `cachedArtifactSearchBody` in
`artifact-requests.ts`), so an unloaded body contributes only the summary
and find never reports a match it cannot reveal. Find's projection is
recomputed when the transcript changes, not when a body finishes loading. Toolbar
chrome (`data-rich-chrome`) is excluded from find highlighting and copy.
Find temporarily reveals a hidden match and restores the user's choice when
find closes. Copy code, Copy source, Copy table, Copy data and Copy message
are separate actions; Copy message includes each artifact's one-line text
summary. Toolbar buttons have accessible names and pressed states; dialogs
trap focus, close on Escape and restore focus. Radix returns focus only to a
`DialogTrigger`, so dialogs opened from a toolbar button spread
`useDialogFocusReturn()` (`lib/chat/rich-markdown/dialog-focus.ts`) onto
their `DialogContent` (the source viewer and the expanded table do; the
expanded Mermaid dialog does not yet).

## Transcript virtualization

`VirtualizedMessageList` keeps Virtuoso and its stable header/footer
components; rows are keyed by message id and carry `data-chat-message-key`.

- **Scroll ownership.** One `TranscriptScrollController` per viewport owns
  every scroll write; see [transcript-scroll.md](transcript-scroll.md) for
  follow intent, cancellation, measured convergence, semantic anchors,
  activation, tool-group viewports and streaming Markdown reuse.
- **Follow pausing.** Auto-follow pauses while the reader has a
  non-collapsed selection inside a transcript row, while find is open, and
  while a live interactive artifact is in the panel or full screen or an
  expanded viewer is pinned. `setFollowPaused(reason, paused)` holds one
  reason; taking one retires an incompatible navigation, and Virtuoso
  receives a literal `false` follow prop while any is held. Growth pinning is
  suppressed but owed; releasing the last reason brings a reader who still
  wants the tail to it, unless a navigation or their own movement superseded
  the pause. Lists whose scroll props lack the setter pause locally.
- **Keep-mounted.** The row holding the selection (or, failing that, the
  focused element) is protected: Virtuoso's `minOverscanItemCount` is raised
  just enough toward it — `KEEP_MOUNTED_MARGIN_ROWS` (2) beyond the visible
  range on each side plus the distance to the row — up to
  `KEEP_MOUNTED_MAX_ROWS` (8) rows away. Beyond that, or when the selection
  collapses or focus leaves the row, protection is released and the row
  unmounts like any other; its DOM selection does not survive, its view
  state does. Only one row is protected; because Virtuoso renders a
  contiguous range, rows between it and the viewport are rendered too, which
  the row bound limits. The visible range is held in state only while a row
  is protected, so ordinary scrolling does not re-render the list.
- **Long-transcript fixture.**
  `components/chat/rich-transcript.long-fixture.test.tsx` renders two
  3,000-message transcripts whose environment, session and message ids
  collide (different backends), with 100 rich blocks in clusters (code,
  diagrams sharing five sources, disclosures with nested code, tables, a
  malformed chart), a windowed Virtuoso stand-in and fake renderers that
  record counts only. Over 20 scroll/expand cycles it checks lane
  concurrency (2/1), queue count and bytes, a settled cache that fills to
  its 128-entry bound once and stays there, bounded view state, that settled
  rows do not re-render on unrelated updates, that stale highlight replies
  never replace current content, and that observers, object URLs, mounts
  and pins are released when the transcript closes.

## Performance gate

A real-browser gate compares this renderer with the pre-change commit
`67a6cc31` on the same seeded fixture. It is not part of any test suite; run
it explicitly:

```bash
# This checkout only (numbers, convergence; exit 1 if convergence fails)
mise exec -- bun e2e/perf/rich-transcripts-perf.ts

# Against a baseline checkout (exit 1 on a >10% regression or non-convergence)
git worktree add --detach /tmp/rt-base 67a6cc31   # outside this checkout
#   link node_modules from this checkout (the baseline imports none of the new
#   packages), keeping @orkestrator/* pointed at the baseline's own packages,
#   then copy e2e/fixture/{main.tsx,RichTranscriptPerfFixture.tsx} into it
mise exec -- bun e2e/perf/rich-transcripts-perf.ts \
  --root change=. --root baseline=/tmp/rt-base --runs 5 --cycles 20
git worktree remove --force /tmp/rt-base
```

Options: `--runs N` (default 3, interleaved and order-alternated per run),
`--cycles N` (20), `--keystrokes N` (240), `--cpu-throttle N` (CDP CPU
throttling), `--no-stream` (diagnostic: no streaming response),
`--cpu-profile` and `--no-minify` (CDP CPU profiles with readable names). The
report (numbers only) is written to
`output/benchmarks/rich-transcripts/<run-id>.json`.

**Fixture.** `/rich-transcript-perf`
(`e2e/fixture/RichTranscriptPerfFixture.tsx`) mounts the real
`NativeChatShell` (Virtuoso `VirtualizedMessageList` + `NativeMessage`) with
the real `NativeComposeBar`, whose text state lives beside the shell as in the
agent tab controller, over a seeded synthetic transcript of 3,000 messages:
100 rich blocks (TypeScript, Python, Rust, Bash, JSON and Go fences, Mermaid
fences over five sources, `chart` fences, tables, `<details>` with nested
code, callouts, inline data-URL images), 50 deferred image parts resolved
through `loadToolDetails`, about 67 JSON payloads (tool output and bare JSON
messages) and 20 published chart/Mermaid artifact parts. A fake
`window.orkestrator.invoke` answers capabilities, publications,
representations and Mermaid renders instantly. Highlighting uses the real
Shiki worker. The page builds unchanged against the baseline: modules that
exist only after the change are feature-detected with `import.meta.glob`.
Probes are content-free: row/rich-block/`pre` mount counts (a
`MutationObserver`), highlighter invocations (a wrapper around the worker
backend), constructed/terminated workers, backend call counts, and
`richRenderScheduler.stats()`/`counters`, `artifactRequestCacheStats()` and
`richViewStoreStats()`.

**Method.** Each run builds the fixture with Vite (production React), serves
it with `vite preview`, and uses a fresh headless installed Google Chrome
(`channel: "chrome"`, 1280×900). While a response streams TypeScript into a
code fence (12 characters every 50 ms), it measures:

- **Composer latency:** 240 keystrokes into the real composer, 35 ms apart.
  The latency of each keystroke runs from the `keydown` timestamp to a
  message-channel turn after the next `requestAnimationFrame`. Also recorded:
  Event Timing entries over 50 ms, long tasks, long animation frames and CDP
  main-thread time.
- **Scroll frame time:** 300 wheel events of 300 px up through history,
  recording `requestAnimationFrame` intervals, frames over 33 ms, long tasks,
  long animation frames, queued scheduler work (sampled every 100 ms), mounts
  and highlighter calls.
- **Convergence:** 20 cycles over five fixed history regions. Each cycle jumps
  there, expands up to three collapsed disclosures, wheel-scrolls, and closes
  and reopens the conversation. After a forced GC it samples settled cache
  entries and bytes, queued work, artifact request cache, view state, live
  workers, DOM nodes and JS heap. A sweep then visits all 184 messages that
  hold rich content. The run converges when the settled cache, queue and view
  state stay within `FRONTEND_RENDER_POLICY`, there is at most one worker, and
  revisits after the first rotation do not grow retained state.

**Results (2026-10-20).** Google Chrome 155.0.8059.85, headless; Mac mini
(Mac17,16), Apple M5 Pro (6 Super + 12 Performance cores), 64 GB; macOS 27.0
(26A425); Bun 1.4.3, Playwright 1.64.0, Vite production builds. Five runs per
target, interleaved. The gate compares the median of the per-run medians/p95s.

| Metric | Baseline `67a6cc31` (5 runs) | Change (5 runs) | Δ | ≤10% |
| --- | --- | --- | --- | --- |
| Composer latency median (ms) | 11.4 (10.8–11.65) | 11.9 (10.45–12.65) | +4.4% | pass |
| Composer latency p95 (ms) | 19.1 (18.6–19.51) | 19.4 (18.0–19.61) | +1.6% | pass |
| Scroll frame interval median (ms) | 16.7 (all runs) | 16.7 (all runs) | 0% | pass |
| Scroll frame interval p95 (ms) | 16.76 (16.7–16.8) | 16.7 (16.7–16.8) | −0.4% | pass |

A confirming 3-run session on the final code also passed: composer median
11.7 → 11.95 ms (+2.1%), p95 19.1 → 19.2 ms (+0.5%), scroll frame median
and p95 16.7 → 16.7 ms (0%).

Supplementary (medians of runs, baseline → change):

- **Long tasks.** No long tasks while typing or scrolling in either build, and
  no Event Timing entries over 50 ms. Frames over 33 ms while scrolling were
  0% → 0–0.2%.
- **Main thread.** Busy time was 14.1% → 15.6% while typing and 15.7% →
  16.3% while scrolling.
- **First row.** 463 → 471 ms after navigation.
- **Mounts.** About 1,080 → 1,150 rows mounted per 90,000 px scroll; the
  change also mounts about 44 rich blocks (the baseline has none).
- **Highlighting.** 5 highlighter calls while scrolling. While streaming, 50
  calls per 201 ticks: highlighting runs on completed lines, and resumed
  grammar state is coalesced.
- **Queued work.** Peak queued work sampled was 0 jobs and peak in-flight work
  was 2. Opening the transcript issued one backend call and highlighted
  nothing, so no offscreen block is parsed up front.

Convergence passed in every run:

- **Settled cache.** Entries settle after the first rotation (≈62 → 64, then
  flat) at about 1.2 MB estimated.
- **Sweep.** The all-rich sweep peaks at 108–113 entries and 1.7–1.8 MB with
  nothing queued, within the 128-entry / 16 MiB bound. The fixture has fewer
  distinct render keys than 128, so LRU eviction itself is exercised only by
  the happy-dom long-transcript test.
- **Other state.** The artifact request cache held 6 entries (9 KB). View
  state stayed at 0 (no view choices were made). There was 1 highlighter
  worker and a constant DOM node count.
- **Heap.** Post-GC heap rose by the same +0.35 MiB over cycles 5–20 in
  both builds (change 16.2 → 16.5 MiB, baseline 14.4 → 14.8 MiB).

**Limitations.**

- **Saturated scroll metric.** The scroll metric is vsync-bound at 60 Hz on
  this machine: both builds hold 16.7 ms frames, so main-thread busy time is
  the more sensitive scroll signal.
- **Noise.** Run-to-run spread of the composer median is up to about 18%,
  comparable to the threshold, which is why five interleaved runs and
  medians of medians decide.
- **CPU throttling.** The earlier streaming composer median regression of
  13–20% is fixed by containing each code line's layout and deferring open-fence
  highlighting until closure, while preserving completed line nodes for
  selection. Review qualification on 2026-10-20 used three interleaved runs per
  checkout at `--cpu-throttle 4`, with twenty cycles each: composer median
  12.70 → 13.00 ms (+2.4%), p95 20.20 → 19.91 ms (−1.4%), and unchanged scroll
  median/p95 (16.70/16.80 ms). All runs converged. See the
  [review-fix evidence](../handoff/2026-10-20-rich-transcript-review-fixes.md#throttled-performance-gate)
  and `output/benchmarks/rich-transcripts/2026-10-20T14-43-04-959Z.json`.
- **Headless and single host.** The gate runs headless on one host; it does
  not cover Electron, a 120 Hz display or lower-end hardware.

## Draft inspection

Tool rows of the canonical authoring tools (`create_artifact`,
`update_artifact`, `preview_artifact`, `get_artifact_operation`, detected
with `orkestratorToolName`) carry an **Inspect draft** action beside the
row's disclosure trigger (`ArtifactDraftInspector.tsx`). Its dialog lists
the conversation's drafts (`transcript_artifact_list_drafts`, owner-scoped
like publications) and, for the selected artifact, shows a "Draft — not
published" label unless that exact revision is published, the exact
revision source in 64 KiB slices through `transcript_artifact_read_draft`
(Load more up to 1 MiB displayed; Copy source reads the whole source up to
2 MiB and refuses if the hash changes between slices), the latest
verification's status, error code, diagnostics with codes and locations,
and up to four failed-preview diagnostic captures as images. It re-reads on
`transcript-artifact` events. Nothing in it previews, publishes or runs a
draft. `ToolPart` accepts an optional `mcpServerName`; the renderer does not
pass it yet, so a bare tool name is judged by its title alone.

## Charts and workflow snapshots

`NativeChart` renders the protocol scene as React SVG: legend toggles (view
only), hover/focus inspection, a semantic data table, Source JSON,
Copy/Download CSV, Download JSON and theme-aware Download SVG, fill/dash/
marker patterns so colour is never the only distinction. The same component
serves `chart` fences and published chart artifacts.

`WorkflowSnapshotCard` shows the captured snapshot labelled with its capture
time and revision, an omission notice for summary snapshots, a bounded inline
subset (24 nodes) with a full dialog, and a table alternative. **Open live
workflow** opens a separate `WorkflowLiveInspector` that polls and reacts to
resource change events, with connecting, live, stale/offline, terminal and
unavailable states; it never writes into the snapshot. Node links open
existing Multi Review and Looped Review views; other targets are shown as
unavailable.

## Live interactive host scope

The live host disposes its document and releases the backend live session
when its scope stops being valid: the conversation's environment is deleted
(or marked deleting), the user selects another environment that is not also
in the multi-selection, the authenticated backend changes, or the
conversation's session generation changes. The store records the reason
(`ended`), and the transcript card shows its saved preview with "Interactive
view closed: <reason>" and a Dismiss action. Running it again starts a new
session.

In browser mode the document runs inside the trusted viewer shell served on
the content origin (`/s/<capability>`; see
[transcript-artifacts-runtime.md](transcript-artifacts-runtime.md#content-serving)).
When the artifact frame reloads or tries to navigate, the shell removes it
and notifies the host, which ends the channel and shows the saved preview
with Reset.

## Rollout

`transcript_artifact_capabilities.rolloutFlags` carries three switches. With
`richMarkdown` off, text renders and is indexed through the plain Markdown
path. With `artifactPublication` off, `publish_artifact` is refused while
existing publications stay readable. With `liveInteractive` off, Run
interactive is unavailable and saved previews remain. No switch deletes or
rewrites stored records.
