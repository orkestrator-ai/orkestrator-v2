# Web page annotations

Status: Living — implemented behind capability negotiation. Live implement
and Discuss runs pass on all six providers (2026-10-24); Docker, remote and
milestone sign-offs are still open. Gates and evidence are in
[0044-web-annotation-qualification.md](../todo/previews-and-annotations/0044-web-annotation-qualification.md).

Select part of a preview, save a note without any agent open, discuss it with
one chosen native-agent session, request a change, and review and accept the
result in the same thread. Notes, requests and evidence live in the backend and
survive tab changes, missed events and restarts.

## Trust model

Four things are kept apart:

| Concern | Where it lives | Trust |
| --- | --- | --- |
| Human intent | Entries typed in Orkestrator's panel (`host-user`) | Trusted instruction |
| Page evidence | DOM text, attributes, styles, sanitized HTML, screenshots | Untrusted, inert |
| Execution state | `WebAnnotationRequest` lifecycle | Native dispatch is the authority |
| Acceptance | `WebAnnotationResolution` naming exact revisions | Human action only |

The page runtime no longer has a comment box. It only selects a target and
returns bounded evidence. Provenance is assigned by the receiving boundary;
a payload that declares `provenance` is rejected. Legacy browser notes keep
`legacy-page-comment` provenance after migration and stay quoted evidence
until a new host note refers to them.

## Components

| Layer | Files |
| --- | --- |
| Contract | `packages/protocol/src/web-annotations.ts`, `web-annotations-validation.ts`, `testing/web-annotations-fixtures.ts`; capture transport at the end of `browser-preview.ts` |
| Page runtime | `apps/desktop/electron/browser-preview-annotation-script.ts`, `browser-preview-anchor-script.ts`, `browser-preview-pins-script.ts`; host side in `browser-preview-capture-pins.ts` |
| Native capture and spool | `apps/desktop/electron/browser-preview-capture.ts`, `browser-preview-capture-store.ts`, `browser-preview-capture-validation.ts` |
| Backend storage and service | `apps/backend/src/core/web-annotation-storage.ts`, `web-annotation-store-layout.ts`, `web-annotation-store-rows.ts`, `web-annotation-legacy-import.ts`, `web-annotation-assets.ts`, `web-annotation-sync.ts`, `web-annotation-service*.ts`, `web-annotation-migration.ts` |
| Execution adapters | `web-annotation-brief.ts`, `web-annotation-dispatch.ts`, `web-annotation-tools.ts`; `enqueuePromptQueueMessageIfAbsent` in `storage-prompts.ts` |
| Commands | `commands-registry-web-annotations.ts` (every name in `WEB_ANNOTATION_COMMANDS`) |
| Renderer | `apps/web/src/lib/web-annotations/`, `stores/webAnnotationStore.ts`, `hooks/useWebAnnotations.ts`, `components/browser/annotations/`, `components/chat/WebAnnotationRequestChip.tsx` |

## Capture

**Notes** in a browser tab opens an app-owned column beside the native
preview. The preview host shrinks, so the existing bounds sync resizes the
native view; no renderer overlay is placed above it. Below 720 px the tab
switches between Preview and Notes. The pane layout stores only panel
visibility, selected annotation, filter and width.

Modes: **Element** (hover, click or Enter; ↑/↓ for parent/child), **Text**
(select text; never touches the clipboard; sensitive fields refused),
**Region** (drag; arrows move, Shift+arrows resize) and **Page** (immediate).
Escape cancels selection only. Selection listeners ignore events whose
`isTrusted` is not true, so page script cannot choose, confirm or cancel a
target with synthetic clicks or keys.

Electron main assigns the capture id and binds the runtime to the web contents,
document generation and a per-install nonce. Page scripts run in an isolated
world where available. On selection main hides tooltips and pins, masks
detectable sensitive fields (in the page and again in the screenshot pixels),
captures, and probes again. If sensitive fields are present but the pixels
cannot be masked, the image is dropped (`imageExcluded`) and only text
evidence is spooled. A navigation, removed target or layout change is
retried once; otherwise the capture is spooled as `stale` with a reason. A
navigation-stale capture has no image, and its page identity is the page the
target was selected on, read before the first probe. Geometry records viewport, scroll, zoom,
device pixel ratio and the downscale transform (longest side ≤ 2,000 px,
≤ 8 MiB).

A region keeps the full-viewport screenshot (its first image, which
`target.imageRect` addresses) and adds the crop cut from the already-redacted
spool image. The backend records the relation as `capture.regionCrop`
(`assetId`, `sourceAssetId`, `sourceRect`) when the stored sizes agree with
`imageRect` within a pixel; the brief labels the images `viewport` and
`region-crop`. A payload naming `regionCrop`, `producerSource` or the old
`parentCaptureId` is refused: both are assigned by the backend. Every capture
also gets `producerSource`: `client-declared` for a producer named by the
submitting client (any authenticated client can name `desktop-native`, so the
thread says "reported by the client, not verified"), `backend` for legacy
imports and result captures.

Page identity comes from the real view URL in main, never from the page:
`{kind: "port"}` for loopback or gateway previews, `{kind: "service"}` for
registered services, and a route sanitized by `sanitizeWebAnnotationUrl`.
Credentials and token-like parameters are removed; when that happens the page
is marked `requiresNavigation` rather than guessed.

## Pending spool and acknowledged transfer

Main keeps unacknowledged captures in `<userData>/browser-preview-captures/`
(directory 0700, files 0600, atomic writes). Limits: 4 per preview tab, 16 per
process, 64 MiB of images. A full spool rejects the new capture; older work is
never evicted. Records expire after 24 hours with a content-free event.

The renderer:

1. Reads the pending capture (reading never consumes it).
2. Applies **Exclude image** or manual redaction and replaces the spooled image
   before anything is uploaded. The unredacted file is overwritten and removed.
3. Uses operation ids derived from the capture id: first
   `web_annotation_operation_receipt`, then `web_annotation_asset_stage`, then
   `web_annotation_create` (or `capture_replace` / `result_capture`).
4. Acknowledges the capture to main only after the backend receipt. **Saved**
   is shown only then.

A lost response is retried with the same ids and returns the original
receipt. Renderer unmount, reload or restart leaves the capture in the spool;
the panel resumes it on mount.

## Backend storage

Metadata lives in the backend database (`orkestrator.sqlite`, see
[storage](storage.md)): one envelope store per environment,
`web-annotations/<environment-id>`, whose collections are listed in
`web-annotation-store-layout.ts`. Each annotation, capture index, entry
index, request (with its instruction and response excerpt), result, asset
record, receipt and draft is one row; `records` holds the immutable bodies
(captures, entries, request briefs, results, draft text) keyed
`<id>/<revision>`; `meta` holds the environment revision, record bytes,
storage status and legacy-migration receipts. Files stay files under
`<dataDir>/web-annotations/<environment-id>/`:

```text
assets/<id>.png       deduplicated by SHA-256 within the environment
staging/              uploads not yet promoted, removed after a grace period
migration-backups/    private copies of migrated legacy chat drafts
```

A mutation stages and promotes its image files first, then runs in one
synchronous SQLite transaction: it reloads whatever another backend committed
(the store revision moved), checks expected revisions, applies the change and
writes only the rows that changed plus the new environment revision. SQLite's
write lock serializes this across processes, so backends sharing a data
directory never overwrite each other. Every read revalidates against the store
revision first. A change hint is emitted only after commit (and when a read
observes another backend's commit). Garbage collection re-reads asset rows in
the transaction that unlinks a file, so it never removes an image another
backend committed. Deleting an environment deletes its store, scrubs freed
pages and the WAL, and removes its files.

The file format of earlier releases (`manifest.json`, `drafts.json`,
`records/`) is imported on first access, once (a lease and the `meta` row
guard it against a second backend). A damaged `manifest.json` imports the
previous copy read-only; a newer-version or unreadable manifest is not
imported at all and the environment stays unavailable. Missing or damaged
records become `unreadable` rows. After a clean import the old files move to
`legacy-json/<timestamp>/web-annotations/<environment-id>/` (kept 14 days);
after an imperfect one they stay in place. Unreadable referenced records mark
the item `unavailable`; they never become an empty list or release a
reservation.

`metadataRevision` advances on any change including execution progress;
`contentRevision` advances only on human content. Edits create a superseding
entry so frozen requests still reproduce their source. Deleting is a tombstone
and is refused while an implementation is active.

Every bound (ids, entries, capture metadata, briefs, pages, threads, spool,
sync ring) is in `WEB_ANNOTATION_LIMITS`. Both character counts and serialized
UTF-8 bytes are enforced: on the desktop before expensive DOM or image work
where possible, and again at backend trust boundaries. A smaller transport ceiling wins
and surfaces as an explicit capacity error. These are release defaults, not
measured usage.

Quotas follow `WEB_ANNOTATION_LIMITS` (2,000 annotations, 5,000 requests,
32 MiB metadata, 512 MiB images per environment; 500 entries / 2 MiB per
thread). Exceeding one returns a `Web annotation capacity exceeded:` error with
usage totals. Tombstoned annotations do not count against the annotation
limit, and settled requests whose annotations were all deleted do not count
against the request limit. A deleted annotation's own captures and thumbnail
stop holding images (request attachments and result evidence still do), so
its images become orphans. Orphaned images are collected after 24 hours in
small batches from the reconciler loop.

## Synchronization

`web-annotations-changed` carries only environment id, generation, revision and
at most 32 changed ids (otherwise `reset: true`). The ring holds 256 hints per
environment for at most 64 environments. `web_annotations_changes` returns a
contiguous range or `resetRequired` for a new generation, an expired or future
cursor, or an evicted environment.

Clients subscribe before fetching, buffer hints while loading, refetch
affected resources, and reconcile every three seconds while visible. Fetch
errors are shown as connection state and never change a request or annotation
status.

## Anchors and pins

A saved target is a description, never a live element handle. An element
anchor (`anchorFor` in `browser-preview-anchor-script.ts`) records:

- a stable `id` or `data-testid`, only when it is unique in the document at
  capture time;
- semantic identity: tag, implicit role and accessible name;
- visible text with a short prefix and suffix (whitespace is normalized for
  comparison, the original is stored);
- up to eight ancestor descriptors and a CSS path;
- the root scope. Targets inside iframes, shadow roots or closed roots are
  recorded as `unsupported`, never as a top-level selector.

A text range stores its quote with context plus the anchor of its containing
element.

### Resolution rules

A resolution carries a state (`matched`, `missing`, `ambiguous`, `stale`,
`unsupported`, `too-complex`), the rule that decided it, the candidate count,
the document generation and the current rectangle. There is no numeric
confidence score; rules are ordered and each match needs corroborating
identity.

1. **Route and scope** (Electron main, `browser-preview-capture-pins.ts`). A
   note for another logical route is `missing` with `offPage` and is never
   queried against the current page. Page and legacy targets, non-document
   scopes and pages without an addressable identity are `unsupported`. A
   region names captured pixels, so it is `stale` and `historical` unless the
   document generation and viewport width are unchanged.
2. **Stable id.** A unique match whose tag, role and name (or text) still
   agree is `matched`. A unique match that disagrees is `stale`: the id was
   reused or the label changed. Duplicate ids fall through to later rules.
3. **Semantic identity.** Elements with the same tag, role and accessible name
   are candidates. Each is checked against identifying ancestors and the
   surrounding text; a disagreement on either contradicts it. Exactly one
   corroborated candidate matches. Several are `ambiguous`, and a single
   candidate with no evidence either way is never matched on this rule alone.
4. **Structural path.** A unique CSS-path match counts only when the anchor
   has a name or text, identity agrees and nothing contradicts it. A path
   alone cannot tell a reordered repeated card from its neighbour.
5. **No corroborated node.** `ambiguous` when more than one plausible
   candidate remains (including a lone uncorroborated one), `stale` when a
   disagreeing candidate was found, otherwise `missing`.

Text ranges search a bounded, whitespace-normalized text map of the document.
A unique occurrence corroborated by its prefix or suffix (or the only
occurrence when no context was stored) matches; several are `ambiguous`; a
contradicted one is `stale`.

Geometry never establishes identity. Every pass has a traversal budget and
deadline, and exhausting it gives `too-complex`, which is distinct from
`unsupported` and `missing`. A changed label is reported, not silently
matched: the user can **Reselect target**, which commits a new capture and
content revision and leaves earlier captures, requests and results untouched.
A live match only moves the pin. It never changes the stored capture or a
request's frozen target.

### Live pins

`browser-preview-pins-script.ts` draws numbered pins only for matched targets,
for up to `visiblePins` (50) open notes on the current page. Unmatched and
off-page notes are listed in the panel with their state. A `MutationObserver`
re-resolves after DOM replacement (hot reload, re-render) on a coalesced
schedule: at most one trailing pass per 750 ms, a pause after 120 passes until
the host re-sends pins, no work while the document is hidden, and a shared
budget of 60,000 node visits or 120 ms per pass. Pins are redrawn (not
re-resolved) on scroll, resize, a settled font load (`loadingdone` /
`loadingerror`) and a change in the document's size, so a web font that
reflows the page without touching the DOM still moves them. A matched target
that renders no box (inside a closed dialog or menu) gets no pin. Main runs its
page scripts only once a loading page has loaded, so while a font holds the
load event pins appear after the font's shift, on the shifted target. Main clears pins for every
new document and emits `pins-invalidated`, so the panel re-sends them from
backend records after a reload, navigation or remount. Every result carries
the document generation it was resolved against; the panel keeps only results
of the newest generation it has seen for the tab, so after Show on page
navigates (or the page reloads) the page being left is never shown as
current.

**Show on page** navigates to the note's logical route through the current
preview routing, waits for the document, resolves the anchor, then scrolls and
highlights (10 s timeout). It never replays a form submission or an
interaction. When the sanitized route is incomplete, sign-in expired (a
redirect away from the route: `navigation-required`, checked on the real stack
with the fixture's `/account` → `/sign-in` redirect) or routing changed, the
panel asks the user to navigate and reselect. A target that matched but
renders no box is reported as `hidden` ("open it, then try again"), not as
shown.

## Requests

**Discuss** asks for analysis without changes. It runs read-only
(`readOnly: "plan-mode"`) when the destination can do that without changing the
session's mode: a per-turn plan mode (Claude, `planModeScope: "turn"`), or a
Codex, Cursor or Grok session whose recorded mode is already Plan
(`planModeScope: "session"`). Otherwise it is labelled advisory, and the
destination picker lists the sessions in the environment that can discuss
read-only; with none, it says how to get one (a Claude session, or Plan set in
a session's own chat). A plan-mode brief tells the agent to answer in its reply
and not submit a plan for approval. Neither mode is presented as a sandbox.
**Request changes** asks for a repository change with a readable report.

Preparation (`web_annotation_request_prepare`) compiles the brief in the
backend and returns the exact destination, instruction, evidence manifest and
issues. It holds no reservation and expires after 15 minutes. Send carries a
client-generated request id reused on retry: the same id and body return the
existing request, a different body conflicts. Implementation reservations for
all selected annotations (up to 20) are taken in one commit, or none are.

The brief starts with `Orkestrator web annotation request <id> (...)`, so a
slash-leading note can never become a slash command and chat can link the turn
back to its thread. Page material is JSON inside
`<orkestrator_web_annotation_evidence>` with every `<` escaped. A deterministic
budget keeps every selected annotation's intent and identity within 64 KiB
before adding optional detail, and records omitted sections.

### Dispatch

Annotation requests use the existing native prompt queue and drainer. Nothing
else calls providers.

1. Commit request, reservations and enqueue intent.
2. Write the selected images to `.orkestrator/annotations/<request>-<digest>.png`
   in the worktree or container (`materializedEvidencePath`; the attachment's
   `relativePath` keeps the brief's own `<digest>.png` name). Once the request
   is settled and its notes are deleted or 7 days have passed, the reconciler's
   garbage-collection pass (every 100 ticks, about 5 minutes) removes that same
   file if it still has the recorded digest; a container file is removed
   inside the container.
3. `enqueuePromptQueueMessageIfAbsent` appends the message unless the id is
   already queued, claimed, in flight, parked, dispatched or pending in the
   native session.
4. Record the queue receipt.

The reconciler re-drives step 2–4 only for requests still in `prepared`; it
never allocates a new id. It observes state from storage and in-memory activity
snapshots only; it never polls tab-facing bridge routes or hydrates idle
sessions. A native turn-end edge also observes that session's active requests
at once (`noteTurnEnded`, loaded environments only), so the turn outcome is read
while the bridge that ran the turn is still up.

| Observation | Request state |
| --- | --- |
| In queue | `queued`, with a hold reason: unsent chat draft, environment stopped, earlier parked prompt, agent busy, destination deleted |
| In flight | `dispatching` |
| Queue dispatch error for this id | `queued`, held `dispatch-rejected`; the queue stays parked for the user — **Retry** (same id) or **Cancel** |
| Removed from the chat queue (queue tombstone) | `cancelled` (`cancelSource: "chat-queue"`) |
| Native `pendingDispatch` for this id | `unconfirmed` — **Retry delivery** (same id) or **Discard** (recorded as possibly run) |
| Dispatched, agent waiting | `needs-input`, with the turn's pending interaction ids on the request |
| Dispatched, turn ended | `completed` (discuss) or `awaiting-review` (implement); `failed` when the recorded turn outcome is a provider error |

Annotation queue items carry a typed `origin` and are frozen: the chat can
reorder or remove them but not edit them or move them into a draft. Removing
one cancels the request; the queue records a bounded tombstone so a removal
is never mistaken for an acknowledged dispatch, and the id is never
republished. The turn outcome comes from the drain's own status read (or one
status read once the turn has ended), recorded content-free on the session.
Implementation requests are sent with the session's current mode, or with no
mode at all. Discussion uses plan mode per turn where the provider scopes modes
to a turn; for a session-scoped provider it is sent in Plan only while the
session's recorded mode is Plan, marked `requireSessionMode: "plan"`. Publish
fails the request if the session left Plan after preparation, and the drain
parks the prompt with the reason (Retry or Cancel) if it leaves Plan while
queued, so the mode is never switched back and the discussion never runs with
write access.

Cancel removes a still-queued message through the queue's atomic fence. A
claimed or in-flight request is reported as still active, with a typed
refusal. Stop is sent to a running turn only if this request is still the
session's latest dispatched request, so an old card cannot stop a newer turn;
a cancel that arrives after the turn was sent and finished normally settles
it normally with `cancelArrivedLate`. A held or queued request whose
destination was deleted can be moved to another session (`retargetOf`), and a
settled request can be followed up with its remaining items (`followUpOf`).

### Request states

Execution state is kept apart from the annotation's open/resolved state. A
prepared brief that has not been sent is outside this lifecycle: the first
state starts when the user commits Send, which is also when implementation
reservations are taken.

| State | Meaning |
| --- | --- |
| `prepared` | Frozen request and reservations committed; not yet in the native queue |
| `queued` | The native queue holds the request id, possibly held with a `blockedReason` |
| `dispatching` | The drainer has claimed it |
| `unconfirmed` | Native `pendingDispatch` for this id: delivery outcome unknown |
| `running` | The session's dispatch receipt lists the id, even before a provider turn id exists |
| `needs-input` | The dispatched turn is waiting on a question or approval |
| `cancelling` | A stop was sent to this request's turn |
| `completed` | A discuss turn ended. Never resolves the annotation |
| `awaiting-review` | An implement turn ended. The annotation stays open until a human accepts |
| `failed` / `cancelled` | Authoritative failure or cancellation, or safe removal before dispatch |
| `abandoned-unconfirmed` | The user discarded an unconfirmed delivery; recorded as possibly run |

The last five are terminal. `WEB_ANNOTATION_REQUEST_TRANSITIONS`
(`web-annotations.ts`) lists the allowed moves, and `applyStateInTx`
(`web-annotation-service-requests.ts`) applies them: an identity update is
accepted, so duplicate and out-of-order updates are idempotent; any other
disallowed move is ignored rather than regressing the request; a terminal
request never changes. Settling releases reservations and clears pending
interactions. A new attempt gets a new request id. `blockedReason` is
orthogonal to state: a held queue is not a failed execution.

The adapter observes native state by polling storage and in-memory snapshots,
so states between two passes can go unobserved. The table therefore allows
more than the plain lifecycle:

- **Forward skips.** From `queued` to `running`, `unconfirmed`,
  `needs-input`, `completed`, `awaiting-review`, `failed` or `cancelled`, and
  from `dispatching` to `needs-input`, `completed`, `awaiting-review` or
  `cancelled`. A turn can
  be claimed, dispatched and finished between passes. The session's dispatch
  receipts are authoritative, and rejecting the skip would leave the request
  stuck. Once dispatch is confirmed, `applyStateInTx` also accepts any move
  that is valid by way of `running`.
- **`dispatching` → `queued`.** The drain rejected the prompt and left the
  queue parked on it. The request is held `dispatch-rejected` until the user
  retries with the same id or cancels.
- **`unconfirmed` →** `dispatching` on **Retry delivery** (same id), a later
  state when receipts settle it, or `abandoned-unconfirmed` on **Discard**.
- **`running` or `needs-input` → `cancelled`** without `cancelling`: the
  destination session was deleted, so nothing can run or be stopped. The
  reason says that work sent earlier may have run.
- **`cancelling` → `cancelled`** once the turn ends, because a stop was
  actually sent. A cancel that arrives after the turn already finished settles
  it normally with `cancelArrivedLate`.

`prepared` never skips ahead. It leaves only through its own publication to
`queued` or a cancel or failure before publication.

### Request cards

A request card shows the execution details the backend records, content-free:
how the turn ended (`turnOutcome`, with the bounded provider error for a
failed turn), the dispatch mode, a typed cancel refusal (a failed stop is shown
as its own state, "may still be running"), a cancel that arrived after the turn
finished, and where a cancellation came from. Pending interactions of the
request's turn are rendered with the native chat's own question and approval
cards and answered through `resolve_native_agent_interaction`; **Answer in
chat** and **Open full conversation** open the chat tab scrolled to the
request's own message (`transcript.messageId`, else `turnId`). A deleted
destination offers **Send to another session…** (prepare with `retargetOf`,
same selections) or **Cancel**; a rejected dispatch offers explicit **Retry**
(same id) or **Cancel**. `followUpOf`, `retargetOf` and `retargetedTo` render
as links. A settled batch offers **Send remaining work…**, which previews the
backend's remaining and excluded notes (`web_annotation_request_follow_up`)
before preparing with `followUpOf`.

Result review keeps the agent's report (outcome, summary, files, checks, cited
evidence, the report revision it carries) apart from what Orkestrator observed
(after-captures with their comparison metadata and the backend's file checks).
File checks cover containment and existence only and never read contents:
local worktrees from the host, container workspaces inside the container
(`check_container_workspace_paths`, `stat` after `realpath` against
`/workspace`). Both take at most 200 paths with a 2 s budget; the container
exec is killed after 5 s, and a check that cannot run reports `unavailable`.

Annotation items in the native chat queue are shown as frozen web annotation
requests with a link to their note: they can be reordered or removed (removal
cancels the request, and says so) but not edited or moved into a draft.

## Review and resolution

A completed request shows a bounded response excerpt fetched on demand
(`web_annotation_request_response`) by locating the marker line in that one
session's transcript, never by taking the latest assistant message. The
excerpt is stored as `agent-reference` history so it survives a deleted
session.

Review actions: **Open updated page** (navigates the preview on the user's
action only), **Open changes** (labelled as the current workspace diff),
**Capture current result** for a side-by-side comparison, **Accept and
resolve**, and **Reply / request another change**. Acceptance checks the
expected content revision, capture id and result revision; a newer note or
capture makes the old result historical. Only a human resolves. A new reply on
a resolved note reopens it.

## Agent tools

When the agent tools server has a host, credentials bound to a tab get
`get_annotation_request`, `get_annotation_evidence` and
`report_annotation_result`. The request is resolved from backend state for that
tab, never from a model-supplied id alone. Reports are stored as
`agent-reported`, provisional while the request is active, and can never
resolve, retarget or dispatch. Agent checks cannot claim `app-observed`.

## Legacy migration

`web_annotations_migrate` runs server-side, 25 drafts per call. The client
repeats while `pendingDrafts` shrinks (at most 40 batches per run); deferred,
stalled or failed imports are retried on a reconcile after a minute. Browser annotations in compose drafts are
imported per `(environment, legacy id)`; identical copies dedupe, divergent
comments become separate `legacy-page-comment` entries, targets are
`legacy-unresolved` (never parsed into selectors), and unreadable screenshots
are recorded as missing evidence. The import commits first, then the source
draft is compare-and-swapped to remove only the imported items and their
attachments. A changed draft is left alone and retried; a draft whose session
has a pending dispatch is not touched. The **Imported browser notes** filter
lists them. Old prompt envelopes still render in transcripts.

The new capture path never writes into native chat drafts.

## Diagnostics

`WebAnnotationMetrics` series are built from closed vocabularies only (command
names, states, operations, agent platforms, evidence sections, anchor states
and rules). Besides command, capture, storage and request lifecycle series they
count evidence the brief omitted or that was unavailable, turn outcomes per
agent, acceptance time (from the request, or from the note when resolved
without one), reopened notes, and anchor resolutions of result captures. The
desktop keeps its own counters (`getCaptureDiagnostics`: pending spool depth
and image bytes against the limits, pin and Show on page resolutions by state
and rule). Settings → Web page annotations → Diagnostics loads both on demand
and copies them as JSON; counts reset when the backend or app restarts.

## Client capability matrix

| Client | Behavior |
| --- | --- |
| Desktop + current backend | Capture, author, discuss, request, review, compare. |
| Desktop + older backend | Capabilities unavailable; no annotation writes. |
| Web / iOS + current backend | List, reply, discuss, request and review; capture shown as unavailable. |
| Backend disconnected | Cached content with connection status; unsaved text retained. |
| Storage degraded | Read-only for affected items with the reason. |

What has actually been exercised on a real stack (details and dates in
[0044-web-annotation-qualification.md](../todo/previews-and-annotations/0044-web-annotation-qualification.md)):

| Area | Exercised | Not exercised |
| --- | --- | --- |
| Desktop capture and native window | macOS (Electron 44, display scale 1, DPR 2 forced); Linux before #969 | Windows; a physical Retina display; OS-level focus on a shared desktop |
| Pins and Show on page | Reorder, hot reload, duplication, offscreen, closed and open modal, late-font shift (blocking and script-loaded), expired sign-in redirect (macOS) | Linux after #969 |
| Result captures | Stable, unstable (animation, loading font), route, viewport and target differences, expired sign-in (macOS) | Pixel differences (not implemented) |
| Live implement | Claude, Codex, Cursor, Grok, OpenCode, Pi (local worktree); Claude in a Docker container | Other providers in a container |
| Live Discuss | All six; read-only on Claude and on Codex/Cursor/Grok sessions in Plan | — |
| Needs input | Claude: approval and clarifying question answered from the request card | Codex (its Ask policy does not gate workspace edits); Cursor, Grok, OpenCode, Pi not run |
| Approvals across disruption | Claude: environment switch, reload, stream loss, graceful restart, backend crash | Other providers |
| Evidence in workspaces | Local worktree and Docker container written, checked and cleaned up | Remote backend on another host |
| Web review | Gateway browser client (Chromium, and WebKit for Safari's engine) | The iOS `WKWebView` wrapper itself |

## Known limitations

- A turn outcome is `unknown` when no running bridge answers the status read
  (the read never starts one), the status is neither idle nor an error, or a
  later request was dispatched first; the card says so rather than guessing.
  The turn-end read makes this rare: live runs on all six providers on
  2026-10-24 settled every request with a known outcome, but a prompt sent from
  chat before the turn end is observed can still supersede one.
- Pending questions and approvals are answerable from the request card only
  when their bodies can be read from the destination session's projection;
  otherwise the card offers **Answer in chat**.
- iframes and shadow roots are unsupported; use Region. A page too large to
  search in time is labelled as such rather than as a missing target.
- Pixel differences are not implemented and are never advertised. A thread
  summary for a different session is a deterministic excerpt of recent
  entries, not a generated summary. The review tray counts images exactly from
  summaries on current backends; against an older backend it counts only
  images whose records were already read. The backend checks the brief exactly
  on preparation.
- Discuss is read-only only on Claude and on Codex, Cursor or Grok sessions
  already in Plan. OpenCode and Pi have no modes; other sessions are advisory
  and run under their existing permissions. A mode changed only inside a
  provider's own terminal UI is not seen (the recorded control is used), which
  errs towards advisory and refusing.
- The crop relation is checked by image size, not by pixels.
- The capture `producer` is client-declared and labelled as such; nothing
  attests it. Provenance is still assigned by the server.
- The gateway token is a single user credential that reaches every
  environment, as for other environment-scoped commands.
- An Ask approval policy does not make every provider wait before an edit:
  Codex applies edits inside the workspace without an approval, so its
  implement requests never enter `needs-input` for them.
- After a restart cuts a turn short, that session refuses new annotation
  requests (`dispatch-rejected`, "Send a message to continue") until the user
  sends a message in its chat; the request card shows the reason.
- Not yet exercised on a real stack: a remote backend on another host, the
  iOS wrapper, Windows, and a physical Retina display. See the matrix above
  and [0044-web-annotation-qualification.md](../todo/previews-and-annotations/0044-web-annotation-qualification.md).
