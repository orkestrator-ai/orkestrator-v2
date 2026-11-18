# Web page annotations

Status: Living — implemented behind capability negotiation and on by
default. Live implement and Discuss runs pass on all six providers
(2026-10-24); milestones A to C were signed off on 2026-11-14 with a remote
backend, the iOS wrapper, macOS for the native-window gate, and native focus
and keyboard resolve deferred. See [Qualification](#qualification).

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
| Backend storage and service | `apps/backend/src/core/web-annotations/storage.ts`, `web-annotations/store-layout.ts`, `web-annotations/store-rows.ts`, `web-annotations/legacy-import.ts`, `web-annotations/assets.ts`, `web-annotations/sync.ts`, `web-annotations/service*.ts`, `web-annotations/migration.ts` |
| Execution adapters | `web-annotations/brief.ts`, `web-annotations/dispatch.ts`, `web-annotations/tools.ts`; `enqueuePromptQueueMessageIfAbsent` in `storage-prompts.ts` |
| Commands | `commands-registry-web-annotations.ts` (every name in `WEB_ANNOTATION_COMMANDS`) |
| Renderer | `apps/web/src/lib/web-annotations/`, `stores/webAnnotationStore.ts`, `hooks/useWebAnnotations.ts`, `components/browser/annotations/`, `components/chat/WebAnnotationRequestChip.tsx` |

## Capture

**Notes** in a browser tab opens an app-owned column beside the native
preview. The preview host shrinks, so the existing bounds sync resizes the
native view; no renderer overlay is placed above it. Below 720 px the tab
switches between Preview and Notes. The pane layout stores only panel
visibility, selected annotation, filter and width.

Modes: **Element** (hover, click or Enter; ↑/↓ for parent/child), **Text**
(select text, in the document or inside one open shadow root; never touches the
clipboard; sensitive fields refused),
**Region** (drag; arrows move, Shift+arrows resize) and **Page** (immediate).
Escape cancels selection only. Selection listeners ignore events whose
`isTrusted` is not true, so page script cannot choose, confirm or cancel a
target with synthetic clicks or keys.

Electron main assigns the capture id and binds the runtime to the web contents,
document generation and a per-install nonce. Page scripts run in an isolated
world where available. On selection main hides tooltips and pins, masks
detectable sensitive fields (in the page and again in the screenshot pixels),
captures, and probes again. Sensitive fields are found in the document, in
every open shadow root down to `WEB_ANNOTATION_MAX_SHADOW_DEPTH` roots and in
every same-origin frame down to `WEB_ANNOTATION_MAX_FRAME_DEPTH` frames (their
rectangles mapped into the top viewport), by one walk bounded at 100,000 visits
or 100 ms. If sensitive fields are present but
the pixels cannot be masked, or the walk could not finish (budget, deeper
nesting, more than 32 fields on screen), the image is dropped
(`imageExcluded`; a responsive-set width fails as `unsupported`) and only text
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
imports and result captures. Source hints (`evidence.sourceHints`) are stored
and briefed with only their known fields (`webAnnotationSourceHintFields`), and
a hint declaring `verified: true` is refused: only a backend containment check
may verify a location, and even a verified hint stays a candidate location
inside the untrusted evidence.

### Development source hints

A project opts in from a development build plugin by emitting the documented
convention in `WEB_ANNOTATION_SOURCE_ATTRIBUTES`: `data-orkestrator-source`
(`path`, `path:line` or `path:line:column`) and optionally
`data-orkestrator-component` on elements, plus optional
`<meta name="orkestrator-source-root" content="apps/web">` (the project's
directory in the workspace) and
`<meta name="orkestrator-source-producer" content="…">` (the tool's name). An
element capture walks from the selected element through at most 16 ancestors
and keeps the nearest four distinct paths. Absolute paths, `..`, `.`,
backslashes, drive letters and control characters are dropped, and an escaping
root drops every hint rather than guessing. Framework runtime internals (React
fibres and the like) are never read. No package ships for this:
[source-hint-emitter.md](../development/source-hint-emitter.md) has a tested
Babel plugin for projects to copy.

Electron main rebuilds each hint from its known fields with `verified: false`
and drops an invalid hint on its own (`parseSourceHints`). The renderer sends
hints only to a backend that advertises `operations.sourceHints`, which it
does while authoring is on and a workspace path check is wired. Before the
write, the backend runs `checkWebAnnotationWorkspacePaths` (the local worktree
from the host, or `/workspace` inside the container) and sets `verified: true`
on the hints whose path `exists`. A missing, outside-workspace or unchecked
path, or a failed check, stays unverified, and the note is still saved. Only
the path is checked; the line and component are never read. The brief says
that a verified path existed at capture and that the agent still checks the
code. The thread lists the same hints as "Source candidates", marking each
"path found in workspace at capture" or "path not confirmed".

Page identity comes from the real view URL in main, never from the page:
`{kind: "service"}` for registered services, and a route sanitized by
`sanitizeWebAnnotationUrl`. Notes are taken only in service tabs; `{kind: "port"}`
pages remain only on notes saved from manual URL tabs before those tabs lost
their in-app view (8108 task 3), and stay readable in any browser tab's panel.
Credentials and token-like parameters are removed; when that happens the page
is marked `requiresNavigation` rather than guessed.

## Pending spool and acknowledged transfer

Main keeps unacknowledged captures in `<userData>/browser-preview-captures/`
(directory 0700, files 0600, atomic writes). Limits: 4 per preview tab, 16 per
process, 64 MiB of images. A full spool rejects the new capture; older work is
never evicted. Records expire after 24 hours with a content-free event.

One spool serves every window of the process: a read names a capture id, and the
IPC handler refuses any sender that is not a trusted renderer. Images and region
crops cross IPC as PNG bytes, in both directions. The preload makes the data URLs
`BrowserPreviewCaptureApi` returns, with native base64, so main never
base64-encodes a capture. There is no custom scheme for spooled images: a real
Electron run showed no renderer stall near the size limit, and a scheme would have
to add a per-window check that the spool does not have today.

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

A requested Save is remembered by that renderer (`capture-intents.ts`) until the
backend commits it. It deliberately does not live in the backend: the image is
only in this desktop's spool until the upload, so neither the backend nor another
client could finish the save, and web and iOS clients cannot capture at all.
Losing the record costs only the automatic retry; the capture stays pending.

## Backend storage

Metadata lives in the backend database (`orkestrator.sqlite`, see
[storage](storage.md)): one envelope store per environment,
`web-annotations/<environment-id>`, whose collections are listed in
`web-annotations/store-layout.ts`. Each annotation, capture index, entry
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

### Commit cost

A commit costs CPU in proportion to the rows it changes, not to the size of
the environment. The committed manifest and every row in it are deep-frozen,
so an unchanged object is an unchanged row. A transaction works on a
copy-on-write manifest (`web-annotations/working-manifest.ts`): a collection is
shallow-copied the first time the transaction touches it, and that copy
records which keys are written. A change replaces a row
(`tx.manifest.requests[id] = { ...request, state }`) or edits the private clone
`tx.edit(collection, key)` returns. Writing into a committed row throws, so the
transaction rolls back rather than corrupting the committed manifest or
changing a row the commit would not see. At commit only the written rows are
serialized (`planChangedRows`); ordered groups (a thread's entries, the
receipts) keep the append-only position rule. The full diff (`planRows`) runs
only for the one-off legacy import and repair, and under `bun test` it checks
every commit's plan (`verifyRowPlans`).

What is still proportional to the collection is pointer work: the shallow copy
of each collection a commit touches, a copy of the snapshot's row maps, and a
shallow freeze of the copied containers. Copying keeps an older manifest
intact for readers that hold it across an `await`, and for a commit that rolls
back. Each commit reports `storage_commit_rows_serialized` and
`storage_commit_collections_copied` (gauges, per scope);
`web-annotations/payloads.bench.test.ts` asserts that a create at 1,900 notes
serializes and copies exactly as much as one at 1 note.
`bun scripts/web-annotation-commit-profile.ts` measures median CPU per create
as the environment fills. Two before/after runs, each the same script on a
checkout of `93018933` (before) and of the change or later `main` (after),
both on shared agent hosts, so read the proportions rather than the absolute
figures:

| Notes | 2026-10-26, 18 cores, load 10–31: before | after | 2026-11-11, 16 cores, load 7–10: before | after |
| --- | --- | --- | --- | --- |
| 0 | 1.7–2.8 ms | 1.3–2.6 ms | 2.0–2.5 ms | 2.1–3.1 ms |
| 500 | 7.9–9.3 ms | 1.5–2.4 ms | 9.6–10.1 ms | 2.4–3.5 ms |
| 1,000 | 13.8–14.8 ms | 1.8–3.2 ms | 15.9–18.3 ms | 2.9–5.0 ms |
| 1,900 | 18.1–28.3 ms | 2.6–3.8 ms | 26.3–32.8 ms | 3.8–4.1 ms |

The 2026-11-11 ranges are four interleaved runs per side (25 creates per
level, `main` at `498b68766`). Every after run serialized 6 rows and copied 5
collections at every size. The payload bench's growth case
(`web-annotations/payloads.bench.test.ts`, three batches of 60 creates) took
29 / 71 / 110 ms before and 20 / 21 / 25 ms after on 2026-11-11 (47 / 73 /
111 and 26 / 28 / 30 ms on 2026-10-26), with 9 rows and 4,174–4,496 bytes
written per create on both sides. At 1,900 notes the largest remaining share
is the SQLite writes themselves. No run on an idle machine was made: the
row-count assertion above is the regression guard, and timing is diagnostic
only.

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

The renderer runs one sync engine per environment per node scope
(`lib/web-annotations/sync.ts`): environment ids are only unique on their node,
so each scope listens on its own client, reads its own node and fills its own
`webAnnotationStore`. Disposing a scope stops its engines and revokes its image
object URLs. Unsent editor text kept locally is stored per node
(`nodeStorageKey`).

## Anchors and pins

A saved target is a description, never a live element handle. An element
anchor (`anchorFor` in `browser-preview-anchor-script.ts`) records:

- a stable `id` or `data-testid`, only when it is unique in its document,
  frame document or shadow root at capture time;
- semantic identity: tag, implicit role and accessible name;
- visible text with a short prefix and suffix (whitespace is normalized for
  comparison, the original is stored);
- up to eight ancestor descriptors (in the composed tree, so a shadow
  target's hosts are among them, and a frame target's frames too; a frame
  document's `<html>` and `<body>` are not listed) and a CSS path within its
  own root;
- the root scope: `document`; `shadow` with the root path through open
  shadow roots (`hosts`, outermost first, at most
  `WEB_ANNOTATION_MAX_SHADOW_DEPTH` = 8; each host is its tag, a stable id
  unique in its containing root, and a CSS path within that root); or `frame`
  when the target is inside at least one same-origin frame (`path`, outermost
  first, mixing frame steps and shadow-host steps, at most
  `WEB_ANNOTATION_MAX_FRAME_DEPTH` = 4 frames and 8 hosts). A frame step is
  the frame's tag (`iframe` or `frame`), a stable id unique in its containing
  root, a CSS path within that root, and the frame document's `documentPath`:
  the path of its http(s) URL with no origin, query or fragment (token-like
  segments of 32 or more characters read `:opaque`), or `about:srcdoc` /
  `about:blank`. New steps also carry `documentIdentity`, a SHA-256 digest of the
  full URL, to distinguish query and opaque-segment changes without storing raw
  query values. Legacy steps without a digest cannot resolve query or opaque paths. Targets inside closed roots, detached trees or deeper paths
  are recorded as `unsupported`, never as a top-level selector. A frame page
  script cannot read (cross-origin, or sandboxed without `allow-same-origin`)
  is itself the target, `unsupported` with the reason `cross-origin`; nothing
  inside it is read.

Element mode hit-tests the document and then each open shadow root under the
point, because the document retargets a hit inside a shadow root to its host.
A hit a root reports outside itself (slotted light content) is not followed.
↑ from a root's top-level element moves to its host, and ↓ on a host steps
into its open root. A closed root exposes no `shadowRoot` to page script, so
its host is the target, as it always was. A host is an ordinary element in its
own root: selecting one records that root's scope, not `unsupported`.
Desktop clients send a `shadow` scope, on an element or a text range's
container, to every backend; the backend still advertises
`operations.shadowTargets` with authoring, but the renderer no longer reads it
(every backend accepts the scope since same-origin iframes landed, #2363).

Same-origin frames (`browser-preview-frame-kit.ts`) are entered only through
`contentDocument`, which the browser withholds for a cross-origin or sandboxed
frame; the kit also refuses a frame document whose window origin differs from
the top document's. Nothing posts messages to a frame, runs script in one or
changes the preview's sandbox: the isolated world reaches exactly what the
page's own scripts could. Element mode, after descending open roots, enters
each same-origin frame under the point (at most four deep) and hit-tests its
document with the point mapped through the frame's border, padding and any
CSS scale; a hit on the frame document's own `<html>` or `<body>` leaves the
frame as the target. ↓ on such a frame steps into its body's first child and ↑
from there returns to the frame. Rectangles are mapped back to the top viewport
and clipped to each frame's content box, so the highlight, the screenshot and
the pin show only what the frame displays. Before the screenshot the probe
checks that the target's document is still the one its frame shows, so a
frame that navigates after selection makes the capture `stale` like a removed
target. Text selections inside a frame are not captured: the frame keeps its
own selection, which Text mode does not read. The backend advertises
`operations.frameTargets` with authoring; a desktop client sends a `frame`
scope only to a backend that advertises it and otherwise sends the older
`{ kind: "unsupported", reason: "iframe" }`. The brief gives the agent each
frame's `documentPath`, CSS selector and stable id, and each host's tag, CSS selector and stable id, outermost first,
with a note to resolve root steps outermost first in each containing root,
then target `cssPath` and `stableId` in the innermost document or root. Each root step retains its selector so sibling frames can be distinguished.

A text range stores its quote with context plus the anchor of its containing
element, whose scope says which tree the quote is in. Text mode reads a selection
with `Selection.getComposedRanges`, because `getRangeAt` retargets a selection in
a shadow tree to a position around its host. That call reveals only the roots it
is given, so the kit lists the open root of each host at an endpoint and reads
again, one level per pass, at most `WEB_ANNOTATION_MAX_SHADOW_DEPTH` deep. The
two endpoints must be in one tree, because a range and a text map each cover one:
a selection across a light and shadow boundary, or between two roots, is
`unsupported`. So is a document selection `getRangeAt` reports differently, since
one endpoint is then in a closed root the kit cannot read; select all is the one
exception, which Chromium composes as the root element's contents and which keeps
the document's light text. Within an open root the kit instead compares against
`ShadowRoot.getSelection().getRangeAt(0)`: the root-local live range preserves
valid open-root endpoints while exposing disagreement around a nested closed
host. Missing root-local selection support is refused. This prevents silently
saving only the outer text or a closed host's light text. A range at the top
level of a root (text directly under it, or a range across its top-level elements)
has no containing element in the root: its container carries the host's semantics,
the root's scope, no stable id and the path `:host`. Sensitive-field checks follow
the composed tree: a sensitive host refuses everything inside its root, nested
roots included, and Text mode reads the focused field through open roots.

### Resolution rules

A resolution carries a state (`matched`, `missing`, `ambiguous`, `stale`,
`unsupported`, `too-complex`), the rule that decided it, the candidate count,
the document generation and the current rectangle. There is no numeric
confidence score; rules are ordered and each match needs corroborating
identity.

1. **Route and scope** (Electron main, `browser-preview-capture-pins.ts`). A
   note for another logical route is `missing` with `offPage` and is never
   queried against the current page. Page and legacy targets, `unsupported`
   scopes and pages without an addressable identity are `unsupported`. A
   region names captured pixels, so it is `stale` and `historical` unless the
   document generation and viewport width are unchanged. In the page, a
   `shadow` scope resolves its root path first: each host must match exactly
   one element with its tag in the root that contains it (its stable id when
   that is unique, else its CSS path) and still have an open shadow root.
   None, or a host that is closed or not yet attached, is `missing`; several
   are `ambiguous`; an empty or over-long path is `unsupported`. Rules 2 to 5
   then run inside the innermost root only, so a document element with the
   same id or name is never a candidate. A `frame` scope resolves its path the
   same way, step by step: a host step as above, and a frame step must match
   exactly one `iframe` or `frame` element that still shows a same-origin
   document whose `documentPath` and URL digest equal the recorded ones. A frame that
   navigated to another path (or has not loaded yet) is `missing`, so a
   different document with the same structure never stands in; a frame whose
   document became unreadable is `unsupported`. Rules 2 to 5 then run inside
   the innermost frame document or root.
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

Text ranges resolve their container's scope as in rule 1, then search a bounded,
whitespace-normalized text map of that one tree: the document, or the innermost
root. Neither map includes the text of a shadow root nested inside it, so a
document quote is never found in a component or the reverse, and a quote whose
host has become sensitive is `missing`. A unique occurrence corroborated by its prefix or suffix (or the only
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
schedule. A document observer never sees inside a shadow root or a frame's
document, so each open root (at most 64) and each frame document (at most 16
frames) a pass resolves into is observed as well. A frame's `load` (a
navigation or reload inside it) schedules a pass, because it replaces the
document the observer and the matched element belonged to, and scrolling a
frame redraws the pins. Each watched frame also subscribes to its window's
resize and document's font events, and observes the frame, document and body
sizes; navigation and destruction remove these subscriptions. Fully clipped
targets have no visible pin until they return into view. A host that exists
before its custom element is defined has no root yet, and attaching one fires
no mutation, so the layer schedules one pass when that tag is defined
(`customElements.whenDefined`). The preview's isolated world has no
`customElements`, so there the hosts the resolver reported are checked for
`:defined` every 500 ms, at most 120 times per layer. The schedule is
at most one trailing pass per 750 ms, a pause after 120 passes until the host
re-sends pins, no work while the document is hidden, and a shared
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
a session's own chat). Orkestrator never switches a session's mode or opens
a separate Plan session for a discussion. A plan-mode brief tells the agent to answer in its reply
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
(`web-annotations/service-requests.ts`) applies them: an identity update is
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
resolve**, and **Reply / request another change**.

When the turn has finished (the result is not provisional), the note is unresolved,
the request is the note’s latest request with matching content and capture, and the note has
no after-capture in the current result yet, **Capture current result** is
offered as a prompt, **Capture the result**, rather than a plain button
(`ResultCapturePrompt.tsx`, `result-capture-prompt.ts`). It says whether the
preview shows the note's page (compared by page key, never by navigating) and,
when it does not, points to **Open updated page**. The capture is the same
`result` capture as the manual button: the desktop's stable-geometry window,
the original capture's masks reapplied, no navigation or reload, so sign-in
and form state the user set up are what is captured. **Not now** collapses
it to the plain button for that request and note until the renderer reloads.
A card that is mounted when its request settles into review also announces
the prompt in the panel's live region; the prompt itself is derived from the
request and result records, so a missed transition costs only the
announcement. Nothing captures without the user's click: a silent
turn-end capture could record a mid-edit or signed-out page, or a tab that
has moved on (#2311). The prompt needs no capability of its
own: it calls `web_annotation_result_capture` under the existing
`operations.comparison`. Acceptance checks the
expected content revision, capture id and result revision; a newer note or
capture makes the old result historical. Only a human resolves. A new reply on
a resolved note reopens it.

### Advisory result diffs

A backend that advertises `operations.resultDiffs` (on unless the host sets
`resultDiffs: false`; it follows readability, not authoring) computes a region
diff between a note's original capture and one of its after-captures on
request: `web_annotation_result_diff` (`{ environmentId, captureId }`, a
`read` command that stays available in read-only mode) and the agent tool's
`diff` option below. Each comparison of a result card shows **Show what
changed (advisory)** on every client that reads (`ResultDiff.tsx`). The diff
is computed from the stored images each time and never stored: the captures
are immutable, so the answer does not change. It is always `advisory: true`
and worded as evidence, "not a pass or fail"; it never resolves, reports an
outcome or counts as a check.

- **Comparable captures only** (`resultDiffPreconditions` in
  `web-annotations/result-diff.ts`). Known and matching route and service, viewport, scroll
  (within 1 CSS px), zoom, device scale and stored image size; both captures
  complete (not stale) with a full-viewport image (a region crop's source,
  never the crop); the after-capture settled (`stability: "stable"`) and
  carrying an unstable-region mask. Anything else is answered
  `status: "incomparable"` with every reason found, each with a fixed message
  (`WEB_ANNOTATION_DIFF_REFUSALS`). Images are never resized to fit, because a
  resized comparison reports scaling as layout change.
- **The unstable-region mask.** When the backend advertises diffs and the
  desktop reports `resultCapture.unstableRegions`, the renderer starts a
  result capture with `sampleUnstable`; main then takes a second screenshot
  300 ms after the first (`sampleUnstableRegions` in
  `browser-preview-capture.ts`) and compares the two privacy-verified samples at the
  stored resolution after painting the union of their sensitive fields and
  reapplied redactions on both samples, in 16 CSS px cells where any changed pixel counts
  (`unstableRegionsBetween`). The changed cells become `unstableRegions` in
  document CSS pixels (at most 32; more collapse into their bounding box). A
  failed privacy scan, navigation, a size or scroll change between samples, unreadable pixels or a
  comparison over 1 s gives no mask, which makes a later diff refuse rather
  than trust a wrong mask. The renderer forwards the mask only to a backend
  that advertises diffs, and without the flag a result capture is exactly
  what it was before (one screenshot, no extra delay). Recapture repeats sampling
  with the same result options. Dropping the image clears its motion mask.
- **What is compared.** Both images are decoded with `sharp` to 8-bit RGBA.
  Pixels under either capture's recorded redactions and under the motion
  mask are left out. The after-capture carries the final spool masks, including
  edits made in the result editor. Original masks are bound to their capture
  and projected with that image's scroll and scale. A redacted original whose
  mask cache was lost, or a result with incomplete redaction geometry, must be
  captured again before it can be compared. A pixel changed when a channel differs by more than 24;
  changed pixels are counted in 8 px cells, a cell needs two to count, and
  touching cells (diagonals included) form one region. The answer carries the
  changed, compared and excluded pixel counts, the changed share, up to 32
  regions (largest first in count; `truncatedRegions` when there were more)
  in stored-image and CSS pixels, and how many masks and moving regions were
  left out. `compareWebAnnotationRasters`
  (`packages/protocol/src/web-annotations-diff.ts`) is the one comparison,
  used by both the backend diff and the desktop mask.
- **Bounds** (`WEB_ANNOTATION_DIFF_LIMITS`). Both sizes come from the asset
  records and are checked against 4,000,000 pixels before decoding, and the
  decoder gets the same limit; at most two diffs run at once, and a third is
  answered `busy`, never queued; a slot is held until its decode actually
  stops on both reads, even after one decode fails or the request times out; the whole diff, decode included, stops at 5 s
  (`timeout`). A decode failure is `decode-failed`. None of these produce a
  partial diff.
- **Rendering.** The card outlines each region over the after-image in an
  SVG whose view box is the stored image size, so the outlines scale exactly
  with the picture, and lists what was left out. An incomparable answer lists
  its reasons instead of any image. Busy and timed-out comparisons can be retried in place.

Decisions (from to-do 0047, retired 2026-11-18; its earlier decision record
is `git show b2c91abb9:docs/todo/previews-and-annotations/0047-web-annotation-extensions.md`):

- **The diff runs in the backend, on stored assets**, not in each client at
  view time: one implementation serves desktop, web and iOS review and the
  agent tool, at the cost of decode work in the backend process, which the
  pixel ceiling, the two-slot limit and the deadline bound. `sharp` was
  already a backend dependency.
- **The unstable mask is sampled by the desktop, not drawn by the user**: a
  second screenshot within the existing result-capture path costs no user
  effort. It misses animations slower than the sample interval, which is why
  the result stays advisory.
- **Regions, not a pixel overlay image**: outlining cells needs no encoded
  image, so nothing new is stored or collected and the answer is a few
  kilobytes for the agent as well as the card.
- **On demand and unstored**: captures are immutable, so a stored diff would
  only duplicate an answer that can be recomputed, and would need migration
  and collection rules of its own.

## Agent tools

When the agent tools server has a host, credentials bound to a tab get
`get_annotation_request`, `get_annotation_evidence` and
`report_annotation_result`. The request is resolved from backend state for that
tab, never from a model-supplied id alone. Reports are stored as
`agent-reported`, provisional while the request is active, and can never
resolve, retarget or dispatch. Agent checks cannot claim `app-observed`.

While the backend advertises `operations.resultDiffs`, `get_annotation_evidence`
also accepts `diff: true` (and optionally `resultCaptureId`, one of the
request's `resultCaptures`) and adds the [advisory diff](#advisory-result-diffs)
of the annotation's latest after-capture in the assigned request, or
`diff: null` with a note asking the user to capture the result. A capture id
outside that request's result captures for the annotation is answered
`not-result-capture` without being read. Without the capability the tool's
schema and description do not mention diffs.

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
| Desktop + current backend | Capture, author, discuss, request, review, compare, advisory result diffs; development source hints when the page emits them. |
| Desktop + older backend | Capabilities unavailable; no annotation writes. |
| Web / iOS + current backend | List, reply, discuss, request and review, advisory result diffs of desktop captures; capture shown as unavailable. |
| Backend disconnected | Cached content with connection status; unsaved text retained. |
| Storage degraded | Read-only for affected items with the reason. |

What has actually been exercised on a real stack (sign-off and history under
[Qualification](#qualification)):

| Area | Exercised | Not exercised |
| --- | --- | --- |
| Desktop capture and native window | macOS (Electron 44, display scale 1, DPR 2 forced); Linux headless (Electron 45, 2026-11-06 and 2026-11-11, every local case of the Electron spec; 2026-11-16 the same, except that the capture-alignment case passed only alone, [flake 9806](../tests/flaky-tests/previews-annotations-and-gateway/9806-annotation-capture-stale-frame-after-dpr2-relaunch.md)); Linux X11 window on a disposable Xvfb display in CI (`electron-qualification.yml`, weekly since 2026-11-15), with the window really focused, so the keyboard case's OS-focus assertion runs | Windows; a physical Retina display; OS-level focus on a shared desktop; a Linux Wayland window. Under Xvfb the capture-alignment case fails: the highlight measures 3 px taller at DPR 1, zoom 1 ([8095](../todo/previews-and-annotations/8095-annotation-capture-alignment-under-xvfb.md)) |
| Pins and Show on page | Reorder, hot reload, duplication, offscreen, closed and open modal, late-font shift (blocking and script-loaded), expired sign-in redirect (macOS; Linux headless) | — |
| Open shadow roots | An element note and a quote inside an open root captured in the desktop's preview view (isolated world, main-side parse), stored, then pinned and shown on page again after a reload (Linux headless, 2026-11-11) | Closed roots (unsupported); a Linux Wayland or X11 window; macOS |
| Same-origin iframes | Element notes inside a same-origin frame, a nested `srcdoc` frame and an open root inside a frame picked with real pointer input in headless Chromium, with the page scripts in a CDP isolated world (`browser-preview-frame-targets.integration.test.ts`, Linux, 2026-11-17): rectangles through border, padding and scale, resolution after a frame navigation and a reload, masking inside the frame; cross-origin and sandboxed frames captured as the frame only | The desktop's own preview view (Electron); macOS; a stored note's brief on a real agent turn |
| Development source hints | Fixture HTML and a real Vite 8 dev server with the documented emitter, captured from the desktop in a local worktree and in a container (Linux, 2026-11-06); fixture HTML in a container (macOS desktop); the container path check through the gateway (Linux) | webpack, Next.js and other Babel setups (unqualified) |
| Result captures | Stable, unstable (animation, loading font), route, viewport and target differences, expired sign-in (macOS) | The turn-end capture prompt after a real agent turn (unit-tested only) |
| Advisory result diffs | Linux headless, 2026-11-18: native Electron capture and recapture of a fixture with controlled motion, manual redaction in the renderer editor, and a diff computed from the resulting stored image; decoder limits and agent tool rollout in the backend suite; retry and image overlay in the renderer harness | macOS; the capture prompt following a live model turn |
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
- Cross-origin and sandboxed iframes and closed shadow roots are unsupported;
  use Region. So is a text selection inside any iframe, or one that crosses a
  light and shadow boundary or runs between two roots. Element targets inside
  same-origin iframes (four deep) and element targets and text selections
  inside open shadow roots are supported. Sensitive fields inside closed
  shadow roots and cross-origin frames are not masked: page
  script cannot see them. A pin whose host is already defined but attaches its
  shadow root later on its own resolves on the next DOM change or re-send. A
  page too large to
  search in time is labelled as such rather than as a missing target.
- Advisory result diffs need an after-capture taken with the unstable-region
  mask, so after-captures from before `operations.resultDiffs`, from an older
  desktop, or from a page that moved or scrolled between the two samples are
  refused (`no-unstable-mask`). The mask samples only the after page: an
  animation shown only in the original capture is compared. A diff measures
  pixels, not intent; two runs of the same page can differ in rendering noise
  above the tolerance. A thread
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
- Source hints appear only on element captures of pages that emit the
  `data-orkestrator-source` convention; Orkestrator ships no build plugin, only
  a [documented one to copy](../development/source-hint-emitter.md). A verified
  hint proves only that the path existed in the workspace at capture, not that
  the element came from it.
- The capture `producer` is client-declared and labelled as such; nothing
  attests it. Every client uses the same gateway token, so a desktop
  signature would prove only that the caller holds it. Provenance is still
  assigned by the server.
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
  and [Qualification](#qualification).

## Qualification

The feature is on by default. Its qualification ran as to-do 0044 (retired
2026-11-16); every dated run, command and count it recorded from 2026-09-25
to 2026-11-11 is in
`git show a0920f1a7:docs/todo/previews-and-annotations/0044-web-annotation-qualification.md`.
The runs that need a person or a second machine are in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md),
under 0044 (retired) tasks 2 to 4.

### Rollout and rollback

`apps/backend/src/core/web-annotations/rollout.ts` defaults to `enabled`
(decided 2026-10-15); Settings → Web page annotations or
`ORKESTRATOR_WEB_ANNOTATIONS_MODE` overrides it. `read-only` refuses every
authoring command but keeps reads, resolution, drafts and spool recovery.
`disabled` keeps only capabilities, rollout and metrics. In every mode the
reconciler keeps settling requests already sent, and a rollout change must
keep that. Dispatch goes through the same per-tab prompt queue as a chat
send, and annotation-specific failures show on the request card rather than
losing data. Revisit the default if a live run shows duplicate execution,
lost data or a write outside the workspace.

### Real-stack specs

- `e2e/agent-testing/web-annotations-electron.spec.ts`
  (`mise run test:agent:electron`; headless on Linux with
  `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, see
  [agent-testing.md](../development/agent-testing.md#electron-specs-and-their-display)):
  capture without an agent tab across reload and restart, masking, inert
  adversarial strings, pins and Show on page (reorder, hot reload,
  duplication, offscreen, modal, late fonts, expired sign-in), route
  identity, text, region and page modes, open shadow roots, result
  comparisons, source hints (fixture HTML and a real Vite 8 dev server,
  locally and in a container), the native view beside the Notes column at
  several app zooms, keyboard-only create and send, capture alignment at
  preview zoom 0.8, 1 and 1.5 and DPR 1 and 2, and the baselines below. It
  also records the desktop captures the gateway spec replays
  (`web-annotations-native-captures.json`) and fails when they drift.
- `e2e/agent-testing/web-annotations-gateway.spec.ts`
  (`mise run test:agent:browser:isolated`; its `Docker fixture` cases with
  `mise run test:agent:docker`): batches, local and container evidence
  materialization and cleanup, web review in Chromium and WebKit, the live
  implement, needs-input and approval cases behind their opt-ins, and a
  metrics baseline.
- The fault-injection matrix, the stale-result acceptance race and migration
  crash and retry are unit-level (`web-annotation-dispatch-flow.test.ts`,
  `web-annotation-service-results.test.ts`, `web-annotation-migration*.test.ts`);
  the sign-off accepts them for gate A.

### Sign-off

Milestones A to C were written up by a worker agent on 2026-10-25 and
accepted by the maintainer on 2026-11-14. The records below are as accepted,
with the reviewer line filled in; what changed since (Linux runs, open
shadow roots from 0047 (retired)) is in the matrix above. The gate-scope answers:

- **Native-window gate:** Linux is enough; macOS is deferred.
- **Remote backend:** deferred, not in scope now.
- **Gate A:** the unit-level fault, race and migration tests count; no
  real-stack run of the acceptance race or a migration restart is required.
- **iOS:** the WebKit run of the web review case is the engine-level signal
  only; it does not qualify the `WKWebView` wrapper.

Deferred, each with its run in the manual-test checklist where one exists:
a remote backend on another host (0044 (retired) task 2), the iOS wrapper
(task 3), native focus and keyboard resolve with a live provider (task 4),
and the native window on macOS for the gate.

```text
Milestone / PR / commit: A, core loop (capture, store, request, dispatch,
  review); main ba7cc8d4
Implemented scope and remaining deferrals: capture without an agent tab,
  durable spool and recovery, request send and dispatch through the prompt
  queue, evidence materialization and cleanup, needs-input, review. Deferred:
  remote backend on another host; native OS focus and keyboard resolve
Platforms, providers, and client versions exercised: macOS 27.0 (arm64),
  Electron 44.7.0, Docker Desktop 29.9.2, Playwright Chromium and WebKit 27.2;
  live implement on all six providers (2026-10-18/24, Claude and Codex again
  2026-10-25); needs-input and disruption on Claude
Logged commands and results: 0044 (retired), "Runs on 2026-10-25" and earlier
Real workflow and inactive-environment evidence: an approval pending in one
  environment while the client switched to another, reloaded and lost its
  event stream; capture without an agent tab across reload and restart
Fault-injection boundaries exercised: graceful restart and backend SIGKILL
  with an approval pending (withdrawn, never applied); a second answer to an
  applied approval (stale); unit-level matrix unchanged
Capability matrix and known limitations: this document, "Client capability
  matrix" and "Known limitations"
Migration and rollback verification: unit level only (web-annotation-
  migration*.test.ts, web-annotation-rollout.test.ts); not run on a real stack
Reviewer / date: the maintainer, 2026-11-14, accepted

Milestone / PR / commit: B, targets and batches; same commit
Implemented scope and remaining deferrals: anchors, live pins, Show on page,
  hash/query identity, batch reservation. Deferred: shadow/iframe targets
  (0047 (retired))
Platforms, providers, and client versions exercised: macOS Electron (pins,
  Show on page); gateway Chromium (batches)
Logged commands and results: pins after reorder, hot reload, duplication,
  offscreen, modal open/closed, blocking and script-loaded late fonts, expired
  sign-in redirect; overlapping batches from two clients
Real workflow and inactive-environment evidence: batches held across reload
Fault-injection boundaries exercised: two clients racing a send (all-or-none)
Capability matrix and known limitations: pins resolve after a loading page's
  load event; hidden targets are reported, not shown
Migration and rollback verification: not applicable
Reviewer / date: the maintainer, 2026-11-14, accepted

Milestone / PR / commit: C, results, modes and clients; same commit
Implemented scope and remaining deferrals: result captures and comparison
  labels, Discuss modes, web review, container file checks. Deferred: the
  iOS wrapper run; pixel differences (0047 (retired))
Platforms, providers, and client versions exercised: macOS Electron (result
  captures); gateway Chromium and WebKit 27.2 (web review); Docker container
  (file checks, live Claude report)
Logged commands and results: 0044 (retired), "Runs on 2026-10-25"
Real workflow and inactive-environment evidence: web review of a desktop
  capture with no capture available in that client
Fault-injection boundaries exercised: an unaddressable container path check
  is unavailable (unit); a symlink out of /workspace is outside-workspace
Capability matrix and known limitations: as milestone A
Migration and rollback verification: not run
Reviewer / date: the maintainer, 2026-11-14, accepted
```

### Baselines

From the Electron spec's `baselines` case and `web_annotations_metrics`, on
a shared 16-core Linux host at load 5 to 14 (2026-11-11, headless): selection
→ spool median 133 ms (p90 151, max 158; 18 captures), spool → saved median
34 ms (p90 66, max 164; 19), backend create `command_ms` mean 2 / max 6 ms,
asset stage 2 / 4 ms. No latency target is set: shared hosts are never idle
and timing assertions in these suites are a recorded flake source. The
regression guard for storage cost is the row-count assertion under
[Commit cost](#commit-cost).

### OS focus on Linux

The keyboard case's OS-level checks (`isFocused()` on the window and on the
preview while selecting) run only when the window really is focused, and
record `window-focused` and `preview-focused-while-selecting`. Headless
Electron reports focus unconditionally, so a headless run says nothing about
them. The weekly `electron-qualification.yml` job runs the suite in real X11
windows on Xvfb, where the window does take focus: the case passed with both
`true` in every run from its first on 2026-11-15 to the scheduled run on
`main` at `da2561021` on 2026-11-16 (run 43869578513). The workspace realm's
`nativeFocus` and `getFocusedWebContents()` polls that also needed a
frontmost host went with `workspace-realm-electron.spec.ts`, deleted in #1983.
