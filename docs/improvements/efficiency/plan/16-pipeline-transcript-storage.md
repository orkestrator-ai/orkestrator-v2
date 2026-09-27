# 16 — Separate pipeline transcripts from durable workflow control records

Status: Not started. Prerequisites: 06, 09, 11; coordinate with 15.
Finding: E14. Priority: high after storage prerequisites.

## Outcome

Large historical transcripts do not inflate every workflow read/write or prevent
small control transitions from persisting. Completed reports, task inputs,
dispatch evidence, and offline transcript expectations remain recoverable.

## Owners

- [Pipeline protocol](../../../../packages/protocol/src/build-pipeline.ts).
- [Pipeline storage](../../../../apps/backend/src/core/storage-drafts.ts).
- [Supervisor](../../../../apps/backend/src/core/build-pipeline-service-supervisor.ts),
  [helpers](../../../../apps/backend/src/core/build-pipeline-service-helpers.ts),
  [recovery](../../../../apps/backend/src/core/build-pipeline-service-recovery.ts),
  [save boundary](../../../../apps/backend/src/core/build-pipeline-service-interactions.ts).
- [Build commands](../../../../apps/backend/src/core/commands-registry-build.ts),
  [frontend store](../../../../apps/web/src/stores/buildPipelineStore.ts), and
  `apps/web/src/components/build-pipeline/` transcript consumers.

## First small change

Replace persisted `messagesFingerprint` raw tail JSON with a fixed-size digest,
including a representation/version prefix. Read old fingerprints for comparison
or recompute once from the old messages, then write the new form. Keep exact
progress semantics until step 15's richer signal is available. This can ship
before the full storage migration and immediately removes one duplicate tail.

## Data classification

| Data | New owner and retention |
| --- | --- |
| Pipeline phase, controller lease, selections, references | Small durable control record |
| Prompt attempt/idempotency and completion evidence | Durable control/journal; never cache eviction |
| Task inputs, attachments needed for future dispatch | Existing durable input ownership |
| Structured review/build results | Durable result records under existing validity rules |
| Offline display transcript | Per-pipeline/session manifest with bounded chunks |
| Live tail and temporary normalized data | Bounded derived caches; provider can reconcile |

## Implementation

1. Add a versioned transcript reference to `PipelineSession`: owner/session
   identity, committed manifest revision, history completeness, latest display
   revision/progress digest, and optional small preview. Keep legacy inline
   messages readable through an adapter during migration.
2. Extract semantic fields currently recovered from transcript bodies. For
   example, `build-pipeline-service-recovery.ts` falls back to finding a
   structured request ID in `session.messages`; persist that identity explicitly
   before removing inline messages. Audit reports, retry baselines, usage,
   rewind/fork actions, task evidence, and cleanup paths the same way.
3. Store immutable completed transcript chunks and a mutable bounded tail using
   step 06. Reuse the lightweight display representation where sufficient;
   retain exact durable result/input artifacts separately. Do not persist an
   ephemeral detail locator as the only offline copy promised to the user.
4. Preserve the current offline transcript behavior during migration. Import
   all previously retained messages; if retention policy later changes, make
   that a separate product change. New oversized content must produce an
   explicit incomplete/unavailable artifact state without preventing control
   metadata or dispatch evidence from being saved.
5. Commit chunks/manifest before committing the workflow reference. Keep CAS
   revision checks and lease/fence validation at the control-record boundary.
   If the reference commit fails, the chunk is orphaned but the old workflow
   stays valid. If a later read cannot resolve the new manifest, surface that
   transcript failure separately from pipeline action state.
6. Move per-pipeline control records to keyed storage if the shared metadata
   file still makes reads scale with all pipelines. Keep project/environment
   indexes small and rebuildable. Preserve active-build admission uniqueness:
   check/reserve under the existing cross-pipeline admission lock, not isolated
   per-record locks that could admit two active builds for one reservation.
7. Update build transcript commands to read the referenced window/page directly.
   Existing command-level trimming/conditional behavior must remain available;
   do not reattach all transcript bodies when listing pipeline summaries.
8. Use step-09 conditional reads during active supervision. Checkpoint transcript
   changes at bounded intervals and immediately at finalization, but do not
   couple routine display-cache failure to an unsafe workflow phase advance.
   Final structured results must meet their existing durable completion rule.

## Migration and downgrade

Migrate one pipeline at a time under ownership/CAS checks. Import its transcript
chunks, validate manifest counts/checksums, then commit a new schema record.
Record source revision/fingerprint so concurrent supervisor updates cannot be
lost. Retry interrupted migration idempotently. Deletions must fence import and
remove referenced chunks plus sensitive legacy backups.

Keep old data until verification, then retire it under a documented backup
retention policy. Do not leave indefinite dual writes of full transcripts.
Provide a bounded explicit export to the old schema for downgrade when it fits;
if it cannot fit the old 32 MiB snapshot limit, report incompatibility and retain
the current readable format. Switching back to an older binary is not itself a
safe downgrade procedure.

## Tests and acceptance

- Several long pipelines plus completed stages: an active tail update writes
  only changed chunks/manifest and its small control record, not all histories.
- Phase/cancel/queue/lease updates succeed near the former transcript-size limit.
- Structured request/result recovery works without inline transcript arrays.
- Crash after chunk write, after manifest publish, before/after control CAS,
  during migration, and during deletion; no lost committed workflow evidence.
- Preserve offline viewing, exports, review reports, and restart resume behavior.
- Two concurrent admissions cannot violate project/GitHub build reservation
  uniqueness after storage partitioning.

Land digest change, read adapters, schema migration, and writer cutover as
separate reviewable changes. Mark E14 resolved only after the full read/write
and migration path has been exercised.
