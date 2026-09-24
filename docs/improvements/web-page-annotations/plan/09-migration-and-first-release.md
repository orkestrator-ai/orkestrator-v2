# 09 — Legacy migration and first release

Status: Not started. Depends on: 01–08 and gate A in step 14. Milestone: A.

## Deliverable

Move existing browser annotations out of copied native drafts into durable
threads without losing notes, evidence, or uncertain sends. Enable the new core
flow only after its end-to-end recovery checks pass.

## Existing integration points

Inspect `nativeComposeStore.ts`, `useNativeComposeDraftPersistence.ts`,
`compose-draft-persistence.ts`, `storage-drafts.ts`,
`browser-annotations.ts`, `transcript-annotations.ts`, and the draft consumption
paths in `AgentNativeTab.controller.tsx`. Existing annotations may be in several
provider namespaces as well as the generic `agent-native` namespace.

Add a proposed backend `web-annotation-migration.ts`. Migrate persisted data
server-side; do not require every old chat tab to mount and report its draft.
Dirty in-memory drafts need a separate compatibility reconciliation through the
same migration operation when their persistence resumes.

## Inventory and conversion rules

- [ ] Enumerate drafts in bounded pages for one environment. Record draft keys,
  revisions, source annotation IDs, screenshot references, and request ownership
  metadata. Do not log or export their text for diagnostics.
- [ ] Convert only valid entries with `source: "browser"`. Preserve ordinary
  transcript annotations and all unrelated text, mentions, attachments, and
  metadata byte-for-byte where the existing serializer allows.
- [ ] Use `(environmentId, legacyAnnotationId)` as the import identity. The same
  ID across environments is not shared feedback and cannot share authorization.
- [ ] Deduplicate identical copies; import divergent comment/evidence variants
  as distinct attributed historical entries/captures in the same thread. Retain
  their source draft identity internally without promoting them to user intent.
- [ ] Store the legacy formatted evidence as `legacy-unresolved`. Do not parse
  an arbitrary “CSS path:” or URL string into an authoritative target or service
  mapping. A user can reselect later through step 10.
- [ ] Preserve page-origin comment provenance. Do not infer trust because text
  happened to survive draft persistence or was edited in an older UI.
- [ ] Import images only after resolving paths through existing environment-local
  or container attachment readers with containment/ownership checks. Missing,
  inaccessible, oversized, or unsupported files produce visible missing evidence
  records; the comment remains importable.

## Idempotent migration protocol

1. Read a legacy draft at revision R and derive stable import IDs and body hashes.
2. Commit imported annotation records and a migration receipt in the annotation
   manifest. Repeated import with the same IDs/body is a no-op.
3. Compare-and-swap the source draft at R to replace imported browser objects
   with lightweight migrated references, or remove them after the new thread is
   confirmed and the client can expose it. Remove only their linked attachments.
4. If the draft changed, leave it intact and retry reconciliation from its new
   revision. Never delete a user's new edits based on the older snapshot.
5. Persist migration completion after draft cleanup. On a crash between stores,
   the import receipt prevents duplicate threads and the source remains recoverable.

- [ ] A pending/unknown native dispatch owns its submitted snapshot. Do not
  mutate or consume that draft during migration. Defer its cleanup until native
  reconciliation settles, while retaining a read-only imported reference if safe.
- [ ] A legacy confirmed submission is not evidence that its request was
  implemented or accepted. Do not manufacture historical completion/resolution.
- [ ] Concurrent older-client writes cannot resurrect fan-out as new requests.
  Recognize migrated IDs on persistence and map them to the existing thread,
  or reject with a typed upgrade/conflict response while retaining local text.
- [ ] Keep migration progress bounded and resumable per environment; a corrupt
  draft fails that item rather than aborting all other feedback imports.

## Cutover behavior

- [ ] Enable the new browser flow only when backend annotation contracts and
  desktop capture contracts are compatible and steps 04–08 are complete.
- [ ] Stop calling `addBrowserAnnotationToOpenNativeSessions` from the new capture
  path. New annotations never enter all native drafts.
- [ ] Stop `consumeBrowserAnnotations` from deleting migrated records or their
  thread-owned assets when one chat sends. Retain legacy consumption behavior
  only for genuinely unmigrated legacy drafts during transition.
- [ ] Keep old serialized prompt envelopes readable for transcript history and
  forks. New durable annotation links must not break display of old conversations.
- [ ] Add a discoverable **Imported browser notes** view and individual missing
  image/reselect actions. Avoid repeated toasts for every copy of a migrated note.
- [ ] Preserve ability to list/read new records if capture or dispatch is disabled
  during rollout. Separate read, author, capture, and send capability switches.

## Compatibility and rollback

Do not downgrade new records into legacy prompt drafts. A rollback disables new
capture/send entry points while retaining persisted data and recovery commands
for requests already in flight. Existing native-agent work continues. Old app
versions may not understand the new collection; they must not delete its files.

- [ ] Test new frontend/old backend, old frontend/new backend, desktop/web client,
  and interrupted upgrade combinations. Unknown versions return explicit
  unsupported-state errors instead of overwriting newer records.
- [ ] Retain a private backup/reference of migrated source data until migration
  validation succeeds; scope it to the environment and normal data retention.
- [ ] If a rollback build cannot reconcile active new requests, retain the new
  backend service in read/recovery mode or block downgrade until those requests
  are settled. Do not solve incompatibility by deleting dispatch ownership.

## First-release acceptance scenario

Use an isolated synthetic app with a settings form and an intentionally cramped
button. Capture with no agent open; save two notes; choose one session; discuss
one note; request its change; switch environments while it runs; return to its
response; inspect source/diff and updated page; accept; reopen with a follow-up.

Repeat with a legacy note copied into two drafts, divergent comments, a missing
image, and an unknown dispatch. Verify no unrelated native draft changes and no
duplicate turn starts. Run the applicable gate A matrix in step 14 before
enabling the feature by default.

## Completion

- [ ] Migration is idempotent across crash/retry and preserves conflicting notes.
- [ ] Core flow meets gate A, including real native-window checks and background
  recovery; untested provider/client cases remain capability-disabled.
- [ ] Update the documentation catalog and add a living operator/architecture
  guide describing shipped behavior, limits, recovery, and migration status.
- [ ] Record release evidence and rollback behavior; mark milestone A complete
  only after review/merge and the required verification.
