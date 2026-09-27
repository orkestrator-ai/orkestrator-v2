# Web page annotations

Status: Living — implemented behind capability negotiation; real-stack gates
(native window, Docker, live agents) not yet run. See
[the plan](../improvements/web-page-annotations/plan/00-index.md) for the
checklist and outstanding evidence.

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
| Contract | `packages/protocol/src/web-annotations.ts`, `web-annotations-validation.ts`, `web-annotations-fixtures.ts`; capture transport at the end of `browser-preview.ts` |
| Page runtime | `apps/desktop/electron/browser-preview-annotation-script.ts`, `browser-preview-anchor-script.ts` |
| Native capture and spool | `apps/desktop/electron/browser-preview-capture.ts`, `browser-preview-capture-store.ts`, `browser-preview-capture-validation.ts` |
| Backend storage and service | `apps/backend/src/core/web-annotation-storage.ts`, `web-annotation-assets.ts`, `web-annotation-sync.ts`, `web-annotation-service*.ts`, `web-annotation-migration.ts` |
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

Per environment under `<dataDir>/web-annotations/<environment-id>/`:

```text
manifest.json         bounded indexes, request state, receipts, env revision
manifest.prev.json    previous committed manifest
records/<id>/<rev>.json  immutable captures, entries, request bodies, results, draft text
assets/<id>.png       deduplicated by SHA-256 within the environment
staging/              uncommitted work, removed after a grace period
```

Mutations run through one bounded queue per environment. Expected revisions
are checked inside it. Record files are written and synced before the manifest
replacement, which is the commit point. A change hint is emitted only after
commit. Unreadable referenced records mark the item `unavailable`; they never
become an empty list or release a reservation.

`metadataRevision` advances on any change including execution progress;
`contentRevision` advances only on human content. Edits create a superseding
entry so frozen requests still reproduce their source. Deleting is a tombstone
and is refused while an implementation is active.

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

## Requests

**Discuss** asks for analysis without changes. When the destination supports
per-turn plan mode it is requested (`readOnly: "plan-mode"`); otherwise the
request is labelled advisory. Neither is presented as a sandbox. **Request
changes** asks for a repository change with a readable report.

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
   in the worktree or container.
3. `enqueuePromptQueueMessageIfAbsent` appends the message unless the id is
   already queued, claimed, in flight, parked, dispatched or pending in the
   native session.
4. Record the queue receipt.

The reconciler re-drives step 2–4 only for requests still in `prepared`; it
never allocates a new id. It observes state from storage and in-memory activity
snapshots only; it never polls tab-facing bridge routes or hydrates idle
sessions.

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
mode at all; discussion uses plan mode only where it is per-turn.

Cancel removes a still-queued message through the queue's atomic fence. A
claimed or in-flight request is reported as still active, with a typed
refusal. Stop is sent to a running turn only if this request is still the
session's latest dispatched request, so an old card cannot stop a newer turn;
a cancel that arrives after the turn was sent and finished normally settles
it normally with `cancelArrivedLate`. A held or queued request whose
destination was deleted can be moved to another session (`retargetOf`), and a
settled request can be followed up with its remaining items (`followUpOf`).

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

## Client capability matrix

| Client | Behavior |
| --- | --- |
| Desktop + current backend | Capture, author, discuss, request, review, compare. |
| Desktop + older backend | Capabilities unavailable; no annotation writes. |
| Web / iOS + current backend | List, reply, discuss, request and review; capture shown as unavailable. |
| Backend disconnected | Cached content with connection status; unsaved text retained. |
| Storage degraded | Read-only for affected items with the reason. |

## Known limitations

- A turn outcome is `unknown` when the backend could not read the session's
  status without hydrating the transcript; the card says so rather than
  guessing.
- Pending questions and approvals are answerable from the request card only
  when their bodies can be read from the destination session's projection;
  otherwise the card offers **Answer in chat**.
- iframes and shadow roots are unsupported; use Region. A page too large to
  search in time is labelled as such rather than as a missing target.
- Pixel differences are not implemented and are never advertised. A thread
  summary for a different session is a deterministic excerpt of recent
  entries, not a generated summary. Batch byte capacity in the review tray
  counts only images whose records were already read; the backend checks it
  exactly on preparation.
- Discuss is enforced read-only only where the provider applies plan mode per
  turn (Claude today). Elsewhere it is labelled advisory and runs under the
  session's existing permissions.
- A region crop is stored as the capture's second asset; there is no explicit
  crop-to-parent relation. Reported file paths are checked for containment and
  existence in local worktrees only; Docker environments report `unavailable`.
- Pin results are not checked against the page generation. After **Open that
  page** navigates, the pins shown are those sent for the page being left
  until the next pin refresh.
- The capture `producer` field is client-declared; a gateway client can label a
  capture `desktop-native`. Provenance is still assigned by the server.
- The gateway token is a single user credential that reaches every
  environment, as for other environment-scoped commands.
- Not yet exercised on a real stack: Docker materialization, remote backend
  upload, live-agent implementation runs per provider, iOS review, and
  native-window checks at several zoom levels. See the gate records in step 14.
