# 03 — Commands, synchronization, and capability discovery

Status: Not started. Depends on: 01, 02. Milestone: A.

## Deliverable

Expose the annotation service through authenticated, bounded commands and a
recoverable synchronization contract. Provide capability discovery before any
client enables capture, authoring, dispatch, or review.

## Integration points

Add `commands-registry-web-annotations.ts` alongside existing registrars and
register it through `commands-registry.ts`, exported by `commands.ts`. Extend
`CommandContext` and backend initialization/shutdown in `index.ts`. Add a typed
web client under `apps/web/src/lib/web-annotations/`; call the existing native
`invoke` transport rather than opening another unauthenticated service port.

Inspect the command authorization path for local and remote clients before
registration. Follow environment ownership checks in existing commands, and
add tests proving the gateway's authenticated scope cannot be replaced by an
arbitrary request-body environment ID.

## Proposed command surface

All mutations carry a client operation ID, environment identity, and the
expected revision of the object being changed. Inputs are explicit schemas;
do not expose an unrestricted object patch or a generic executable action.

| Command | Purpose and return value |
| --- | --- |
| `web_annotations_capabilities` | Contract version, supported operations/targets, limits, storage availability; no agent credentials. |
| `web_annotations_list` | Filtered, paginated summaries plus environment revision and opaque next cursor. |
| `web_annotation_get` | Annotation metadata and a bounded first entry page; captures/assets separately referenced. |
| `web_annotation_entries` | Entries after a sequence/cursor, with reset handling for expired history. |
| `web_annotation_draft_save` | Revision-checked unpublished editor draft. |
| `web_annotation_create` | Commit a staged capture and host-authored entry, return annotation/capture IDs and revisions. |
| `web_annotation_entry_append` / `web_annotation_entry_edit` | Publish or supersede a human discussion entry. |
| `web_annotation_update` | Narrow title/default-destination changes; no execution or provenance mutation. |
| `web_annotation_capture_replace` | Attach new immutable evidence to the same thread. |
| `web_annotation_resolve` / `web_annotation_reopen` | Explicit human resolution against expected content/result/capture revisions. |
| `web_annotation_delete` | Tombstone inactive feedback; return conflicts for active implementation. |
| `web_annotation_asset_stage` / `web_annotation_asset_get` | Bounded upload/fetch with environment-scoped opaque IDs. |
| `web_annotation_request_prepare` | Validate destination/revisions/capabilities; create a frozen request candidate. |
| `web_annotation_request_send` / `web_annotation_request_get` | Commit/inspect the request handoff, preserving its ID. |
| `web_annotation_request_cancel` / `web_annotation_request_recover` | Delegate to existing queue/dispatch recovery with expected request identity. |
| `web_annotations_changes` | Content-free changes since generation/revision or an explicit reset instruction. |

Preparation is not authorization to dispatch. The host Send action commits the
prepared selection. Implement only commands supported by the current step;
capabilities keep later request operations disabled until step 07 is ready.
Use a dedicated bounded upload route through existing authenticated transport
if its current request ceiling cannot carry an image; do not raise all gateway
command body limits to fit screenshots.

## Snapshot and hint protocol

- [ ] Introduce a content-free `web-annotations-changed` event containing
  environment ID, changed record IDs where bounded, persisted environment
  revision, and backend generation. Oversized change sets request a reset.
- [ ] Persist revision increments with the mutation; use a new generation on
  backend startup. The in-memory hint ring has the count/byte bounds in step 01.
- [ ] `changes` returns a contiguous range, the caller's generation/cursor, and
  latest revision. Expired cursors, future cursors, environment eviction, or a
  new generation return `resetRequired`, not an empty successful delta.
- [ ] Subscribe before fetching the initial snapshot. Buffer hints while loading,
  install the snapshot at its committed revision, and apply only later hints.
  Refetch affected resources rather than replaying optimistic content patches.
- [ ] Tag paginated list cursors with the snapshot/filter revision. If concurrent
  changes make continuation inconsistent, request a refresh rather than skipping
  or duplicating entries silently.
- [ ] Fetch on mount, activation, gateway reconnect, and a detected gap. While
  visible, reconcile the revision at a bounded interval, initially three seconds,
  to recover a missing final event. Stop UI polling when hidden; backend request
  processing continues and activation catches up.
- [ ] Deduplicate concurrent refreshes; bound buffered hints; discard an old
  response after environment/selection changes using request generations.
- [ ] Reuse existing gateway SSE sequencing. Do not change connected frames to
  advance a client's cursor before replay, or subscribe after calculating replay.

## Client store

Add a proposed `webAnnotationStore.ts` and `useWebAnnotations.ts` hook. Cache
bounded summaries/pages by environment, normalize annotation/request IDs, and
keep fetch/error state distinct from domain status. An offline badge must not
turn a running request into failed or an annotation into resolved.

- [ ] Retain dirty editor text across hydration; surface a content revision
  conflict with local and server versions. Do not automatically overwrite one.
- [ ] Use optimistic UI only where reversals are unambiguous. Dispatch and
  resolution require committed backend confirmation.
- [ ] Evict image/object URLs and inactive cached pages using explicit limits.
  Persist editor drafts through the backend, not by serializing the cache.
- [ ] Route transcript links through the existing native-agent session UI. A
  store refresh must not attach or hydrate every idle agent session.

## Capability matrix

Backend capability flags should describe service availability and contract
version. Desktop capture capability additionally comes from preload/native
preview support. Agent image/read-only/tool capabilities come from the selected
session/model. The UI enables an action only when the required layers agree.

| Client situation | Expected behavior |
| --- | --- |
| New desktop + new backend | Full implemented milestone capabilities. |
| New desktop + older backend | Existing legacy flow or explicit unavailable state; no half-migrated data writes. |
| Web/iOS + annotation backend | List, author, discuss, and review saved records; capture only if advertised. |
| Backend disconnected | Read cached content with offline status; preserve unsaved edits and expose retry. |
| Backend storage degraded | Read recoverable records; disable affected mutations with an actionable error. |

## Verification and completion

- [ ] Test unauthorized/wrong-environment record, asset, draft, and request reads
  and writes; reject unbounded payloads before service execution.
- [ ] Test restart generation, gap, cursor expiry, ring overflow/eviction, stale
  list cursors, and a lost final hint while the UI remains mounted.
- [ ] Race snapshot fetch with create/edit/delete and environment switching; the
  installed projection must converge to committed state without leaking records.
- [ ] Assert hints and logs contain no discussion, page content, screenshots,
  raw URLs, tokens, or materialized paths.
- [ ] Verify client/version capability mismatch yields a deliberate fallback.

Done when two authenticated clients converge after concurrent changes and
reconnects, with authoritative state available without mounting a browser tab.
