# 11 — Batch review and efficient evidence

Status: Not started. Depends on: 06–10. Milestone: B.

## Deliverable

Let users review a page, select related notes, and send one coherent change
request while preserving per-annotation history, outcomes, and capacity limits.

## Code boundaries

Extend the annotation list/brief UI, request preparation/compiler, reservation
logic, and result projections. Reuse the same native queue and dispatch adapter;
batching changes request content, not execution infrastructure.

## Collection and selection

- [ ] Add explicit selection checkboxes and a selected-count summary. Selection
  persists across list pagination through IDs, not by retaining every full record.
- [ ] Support page, status, and destination filters; make hidden selected items
  visible in a summary so changing a filter cannot silently change the batch.
- [ ] Show a review tray with title, route/viewport, latest human intent, evidence
  state, active request, and individual include/exclude controls.
- [ ] Excluding an item only changes this unsent batch. It does not remove the
  annotation, comments, prior request links, or image asset references.
- [ ] Cap the batch at 20 annotations and the combined byte/attachment limits
  from step 01. Show remaining capacity and the exact item causing overflow.

## Batch preparation

- [ ] Freeze every selected annotation's content/capture revisions and selected
  entry IDs in stable user-visible order. Assign reference numbers for display
  while retaining stable IDs for result correlation.
- [ ] Provide one overall instruction and optional per-note desired outcomes.
  Preserve independent criteria; do not let an automatic summary omit a selected
  requirement or convert a question into a requested implementation.
- [ ] Detect obvious unresolved conflicts, such as two human instructions for
  mutually exclusive copy on the same target, and present them for discussion.
  Do not promise automatic semantic conflict detection is complete.
- [ ] Resolve stale/legacy/missing-evidence warnings per item. The user may
  intentionally send historical context, with that choice recorded in the brief.
- [ ] Acquire active implementation reservations for the entire selected set in
  one annotation-store commit. If any item conflicts, send none and name the
  affected items. Avoid hidden partial dispatch.
- [ ] If content/model/evidence changes after preview, invalidate the affected
  preparation and regenerate before send. Progress-only updates do not invalidate.

## Evidence budgeting

Use a deterministic budget allocator so the UI's preview and backend dispatch
contain the same evidence. Budget essential intent/identity for all selected
annotations first, then optional detail. Never make the final selected item
disappear because earlier HTML consumed the limit.

- [ ] Include common route/viewport metadata once where it is truly shared.
  Distinct capture times or document generations must remain distinct.
- [ ] Deduplicate exact image assets by digest. Do not combine different page
  states into a fabricated single screenshot or imply alignment that was not
  captured. Optional crops retain parent image/coordinate provenance.
- [ ] Prioritize visible text and relevant styles over redundant CSS/XPath/HTML.
  Keep the full bounded capture accessible from the annotation, even if not all
  fields are in the prompt.
- [ ] Return an evidence manifest listing included, omitted, and unavailable
  sections per annotation. Require explicit text-only choice if images cannot
  be delivered; do not silently skip an attachment at capacity.
- [ ] If intent and essential evidence alone exceed the budget, block this batch
  and offer splitting. Do not automatically launch multiple independent turns.
- [ ] Bound materialization concurrency and aggregate memory. Twenty accepted
  per-image limits do not imply permission to buffer 160 MiB for one request.

## Execution and partial results

- [ ] One batch maps to one request/turn and one destination. Link that request
  from each participating thread; store canonical execution state once.
- [ ] Track per-annotation reported outcome: addressed, partly addressed,
  not addressed, needs clarification, or unreported. An overall successful turn
  cannot mark every annotation implemented automatically.
- [ ] Let users accept individual current revisions after review. Remaining
  items stay open, even if other items in the same request are resolved.
- [ ] A follow-up selects only remaining/current requirements by default, with a
  link to the previous result. Do not rerun accepted items inadvertently.
- [ ] Cancellation applies to the whole active turn. Explain this on each
  participating thread rather than suggesting one item can stop independently.
- [ ] Keep reservations while execution is active/uncertain. After authoritative
  completion, later requests can address unresolved items without erasing history.

## Verification and completion

- [ ] Test overlapping batches from two clients: at most one request reserves
  each annotation and losing batches do not partially enqueue.
- [ ] Test mixed routes, captures, images/text-only items, held native drafts,
  removed destination, stale revisions, and exact count/byte boundaries.
- [ ] Verify deterministic compilation across renderer refresh/backend restart
  and that the user-visible manifest matches provider-bound attachments.
- [ ] Complete a batch with addressed/unreported/failed criteria; accept one,
  reopen another, and send a follow-up without duplicating prior work.
- [ ] Stress pagination and multi-page selection without loading all historical
  DOM/images. Run gate B from step 14 with realistic synthetic page reviews.

Done when a batch is one explicit, bounded handoff with independent annotation
review, rather than an opaque bundle that loses individual requirements.
