# 02 — Durable storage, assets, and retention

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 01. Milestone: A.

## Deliverable and code ownership

Add a backend-owned annotation service and storage implementation. Suggested
new modules under `apps/backend/src/core/`: `web-annotation-service.ts`,
`web-annotation-storage.ts`, `web-annotation-assets.ts`, and focused tests.
Register lifecycle through `index.ts` and `commands-context.ts`. Follow
`StorageService` environment ownership and existing atomic-file patterns;
do not introduce a database dependency solely for this feature.

## Persistence layout

Use a dedicated directory below the backend data directory, never renderer
local storage or the repository as the authoritative store. Proposed layout:

```text
web-annotations/<environment-id>/
  manifest.json
  records/<opaque-record-id>/<revision>.json
  assets/<opaque-asset-id>.png
  staging/<opaque-operation-id>/...
```

The manifest contains bounded indexes, record revision references, request
reservations, migration receipts, and an environment revision. Large capture
metadata, request bodies, and entry pages live in bounded records referenced
from it. Store no prompts or image bytes in the listing index.

### Atomic commit protocol

- [ ] Serialize environment mutations through one bounded write queue.
- [ ] Read and validate expected revisions inside the write serialization
  boundary. Prepare immutable record revisions and asset references in staging.
- [ ] Write and durably close new immutable records before atomically replacing
  the manifest. The manifest replacement is the commit point for a multi-record
  annotation/request mutation. Verify crash durability using the platform's
  existing file-sync conventions; atomic rename alone is not a power-loss claim.
- [ ] Emit a content-free change hint only after commit. Return its committed
  revision. A response lost after commit is recoverable by operation ID.
- [ ] Never hold the storage queue while calling an agent, capturing a page,
  invoking Docker, or awaiting user input. External work uses a staged operation
  and a short final commit after revalidating its inputs.
- [ ] On startup, accept only committed manifest references, detect malformed
  referenced records, and report degraded/read-only state for affected items.
  Do not turn unreadable storage into an empty collection or a new dispatch.
- [ ] Remove uncommitted staging records only after a grace period and after
  checking active operations. Keep the previous committed manifest generation
  until recovery checks complete.

Do not claim atomicity across the annotation manifest and existing native queue
files. Step 07 defines an idempotent handoff with reconciliation at that boundary.

## Service methods and concurrency

Implement internal operations for list/get, draft save, create from capture,
entry append/edit, capture replacement, assignment, resolution/reopen, request
prepare/read, tombstone, and migration. Public exposure follows step 03.

- [ ] Require environment ownership on every lookup, including asset and
  transcript references. Resolve destination ownership from backend state.
- [ ] Deduplicate mutation operation IDs with a bounded persisted receipt table.
  A repeated ID and same body returns the original result; a changed body
  conflicts. Request idempotency persists with the request, not a short TTL.
- [ ] Append entries with stable IDs and sequences. Edits create a superseding
  version so frozen request snapshots can still reproduce their source.
- [ ] Keep autosaved editor drafts separate from published entries. Do not
  publish partial typing or let a background hydrate overwrite newer local text.
- [ ] Commit an annotation create, its first entry, and evidence references
  together. A failed asset upload must not produce a falsely complete capture.
- [ ] Support explicit missing-evidence records for legacy migration and a
  deliberately selected text-only fallback; neither is a silent upload failure.
- [ ] Represent deletion with tombstones and revision hints. Environment deletion
  stops new writes/preparations, revokes access, and coordinates asset cleanup
  with existing lifecycle teardown.

## Image ingestion and agent materialization

- [ ] Validate MIME, decoded byte size, dimensions, and the PNG payload. Bound
  base64 and decoded buffers separately; avoid retaining both after ingestion.
- [ ] Deduplicate by a digest within the owning environment. Opaque IDs are
  authorization-scoped references, not arbitrary backend paths.
- [ ] Redact before persistence according to step 04. Store redaction metadata
  and screenshot transformation information with the capture.
- [ ] Read assets through an authenticated bounded fetch, not general events.
  Renderer previews use object URLs and revoke them on eviction.
- [ ] Materialize the exact selected bytes in the target worktree/container using
  existing attachment writers. Record digest and destination mapping per request;
  retries can verify/reuse the same materialization without another dispatch.
- [ ] Use app-generated paths under `.orkestrator/annotations/`. Validate
  containment, environment root, symlink behavior, and container ownership.
  A page cannot select a filename or cause writes outside that directory.
- [ ] On remote workspaces, upload from the desktop to the backend and then
  materialize there. A path on the desktop is not an agent-readable asset.
- [ ] Do not delete a materialized file while a queued/running request or retained
  transcript reference may still need it. Track ownership separately from
  arbitrary user-created files under the same directory.

## Retention and backpressure

- [ ] Enforce step 01 quotas before accepting new records or uploads. Return a
  typed capacity failure and usage totals; leave the existing draft recoverable.
- [ ] Paginate records without parsing every historical capture or request body.
  Bound both loaded index size and per-call record reads.
- [ ] Collect only assets unreachable from current records, retained revisions,
  requests, results, drafts, and pending operations. Use a 24-hour grace period
  for newly orphaned assets; make the clock injectable for tests.
- [ ] Run collection in small backend batches with cancellation/deadline support.
  Never require an annotation panel to mount for cleanup to progress.
- [ ] At history limits, offer explicit archive/export/continuation behavior.
  Never silently truncate comments or remove evidence from accepted work.
- [ ] Bound logs to operation category, counts, timings, and sanitized error code.
  Do not log entry text, DOM, URLs, paths, image bytes, or raw parser exceptions
  that could contain the submitted payload.

## Verification

- [ ] Crash-injection tests before record write, before manifest replacement,
  after commit/before response, and during cleanup recover exactly the committed
  data and operation receipt.
- [ ] Concurrent content edits conflict correctly; two creates with the same
  operation ID create one annotation; progress writes do not erase comments.
- [ ] A corrupt record stays visible as unavailable and never clears a request
  reservation as if execution had not happened.
- [ ] Test quota boundaries, malformed/oversized images, asset access across
  environments, symlink escape, missing containers, and interrupted uploads.
- [ ] Verify a restart preserves drafts, threads, capture references, and request
  snapshots; GC retains every referenced asset and removes only owned orphans.

Done when the service can create and read a full annotation across a backend
restart without any renderer mounted, with tested commit/recovery semantics.
