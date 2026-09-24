# 04 — Trusted capture and acknowledged delivery

Status: Not started. Depends on: 01–03. Milestone: A.

## Deliverable

Split selection/evidence collection from user authoring. Keep a pending capture
recoverable until backend persistence acknowledges it; remove the requirement
to have a native-agent tab open before capturing feedback.

## Existing and new owners

Modify the native preview contract, `browser-preview-manager.ts`, the annotation
script, desktop IPC/preload, and `apps/web/src/lib/native/browser-preview.ts`.
Extract proposed `browser-preview-capture-store.ts` and a capture transfer
coordinator rather than expanding `BrowserTab.tsx` into a second backend.

The Electron main process owns a bounded pending spool in app data. The backend
owns committed captures/assets. The renderer coordinates authoring and transfer,
but is never the sole owner after the UI says **Capture saved locally** or
**Saved**. A crash before that acknowledgement may lose transient selection;
do not promise otherwise.

## Selection runtime changes

- [ ] Remove the comment textarea and submit-as-user-intent path from the page
  runtime. Its output is a selected target and bounded page evidence only.
- [ ] Keep the highlight and basic hover summary. Clicking a target suppresses
  its ordinary page action while selecting; exiting selection restores normal
  interaction. Support Escape and parent/child adjustment without submitting.
- [ ] Add explicit start, target-selected, capture-pending, cancelled, and error
  transport states carrying a host-assigned capture/session identity.
- [ ] Bind selection results to the expected native web contents and document
  generation. A page echoing a valid session ID still supplies untrusted data.
- [ ] Keep script return values bounded and schema-validated; sanitize DOM
  structure before serializing instead of reading unbounded `outerHTML` and only
  truncating afterwards. Limit visited nodes, attributes, text, and traversal time.
- [ ] Exclude inspector-owned nodes from evidence and screenshots except the
  deliberate selected-target highlight. Do not capture the app comment panel.

## Coherent screenshots

- [ ] Capture metadata and pixels for the same document generation. Read target
  identity/geometry before and after capture; if target, navigation, viewport,
  or scroll changes, mark stale and offer recapture instead of claiming coherence.
- [ ] Permit at most one bounded recapture for a transient layout change; never
  run an unbounded loop on an animated page or freeze the user's application.
- [ ] Record CSS-pixel rectangle, viewport, scroll offsets, preview zoom, device
  pixel ratio, native image dimensions, and final downscale transformation.
- [ ] Enforce decoded image/metadata bounds from step 01 before upload. Preserve
  the existing screenshot dimension cap and report reduced image resolution.
- [ ] Keep the original evidence immutable when a later capture replaces it.
  A recapture receives a new capture ID and references the same annotation.

## Privacy and provenance at capture

- [ ] Whitelist useful attributes; exclude event-handler text, input values,
  credentials, token-like URL parameters, and hidden form contents. Store a
  bounded redaction summary, never the original sensitive value.
- [ ] Mask visible password/sensitive-field rectangles in the native image where
  detectable. Do not claim this detects every secret in arbitrary pixels.
- [ ] Present the capture in trusted UI before sending. Allow **Exclude image**
  and image-region redaction. For manual redaction, edit the in-memory image
  before committing its final persisted asset; discard the unredacted working
  buffer/spool version when replaced.
- [ ] Do not upload unredacted screenshots merely to generate thumbnails. If a
  temporary local spool is necessary, use private permissions, a short explicit
  lifetime, and no logging; explain local pending state accurately.
- [ ] Do not execute page-provided URLs, scripts, file paths, or selector-derived
  commands. The main process derives trustworthy navigation identity from the
  actual web contents; the backend applies environment/service scope validation.

## Acknowledged transfer protocol

1. Main assigns `captureId` and document generation; selection produces evidence.
2. Main validates/captures/redacts, writes a bounded pending record, and returns
   an opaque descriptor. Reading status does not consume or delete the record.
3. Trusted UI loads the descriptor, receives user redaction/image-exclusion
   choices, and starts a resumable upload using a stable operation ID.
4. Backend stages the image and capture metadata; UI publishes the associated
   host comment through `web_annotation_create` when the user saves it.
5. Backend commits the annotation and returns a receipt identifying capture and
   annotation revisions. Main acknowledges the same capture ID and clears its
   pending record. A duplicate receipt/ack is harmless.

The transfer coordinator resumes pending uploads after reconnect or activation.
If the renderer is absent, the main process retains the pending spool until the
defined expiry; no agent request depends on that renderer remaining mounted.
Use a 24-hour pending expiry with a visible expiry timestamp and a content-free
expired-capture notice. Never expire a backend-committed reference.

- [ ] Retry after a lost backend response queries the operation receipt before
  creating another annotation. Upload and create IDs remain stable across retry.
- [ ] Navigation/hiding destroys only transient inspection listeners/overlays.
  It must not clear the spool, host draft, committed thread, or agent request.
- [ ] Explicit **Discard capture** clears the relevant pending record; it does
  not delete unrelated drafts or the previously committed annotation.
- [ ] At spool capacity, reject another capture with recovery actions; do not
  evict the oldest pending user work silently.

## Verification and completion

- [ ] Extend Electron runtime/manager/IPC tests for stale sessions, malformed
  output, spoofed provenance, duplicate status reads/acks, upload retry, and
  renderer teardown between capture and backend commit.
- [ ] Test navigation during capture, hot reload, target removal, scaling, scroll,
  and native-window screenshot/highlight alignment at multiple zoom levels.
- [ ] Restart the desktop with a pending spool item; recover it without an open
  agent. Verify expiry/discard behavior with an injected clock.
- [ ] Simulate backend disconnect, image-write failure, and quota exhaustion;
  comment and capture remain recoverable, and **Saved** is not shown early.
- [ ] Test capture redaction using synthetic secrets only; inspect stored bytes
  and logs, not just the screenshot preview.

Done when capture can be persisted without an agent tab and survives a renderer
unmount at every acknowledged boundary, with user comments outside the page.
