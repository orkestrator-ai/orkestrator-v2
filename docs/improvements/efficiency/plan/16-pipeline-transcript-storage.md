# 16 — Separate pipeline transcripts from durable workflow control records

Status: Complete — transcripts moved out of the shared control file; per-pipeline control-record partitioning deferred with its measured remaining cost (see record). Prerequisites: 06, 09, 11. Finding: E14.

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

## Execution record

```text
Status: Complete (per-pipeline control-record partitioning deferred)
Implementation commit / PR: the step-16 commit on this branch (the first small
  change shipped earlier as a1bafecb: fixed-size `tf2:` transcript fingerprint)
Protocol or storage decisions: below
Tests and isolated profiles: focused and full package suites below; no
  isolated real-stack profile
Before/after measurements: below (deterministic byte bounds in the suite plus
  one local timing run)
Compatibility/migration result: legacy inline records migrate in place, per
  pipeline with a CAS on the source revision; bounded downgrade export provided
Remaining limitations: below
```

### What was implemented

- **Data classification.** Workflow control state (phase, leases, selections,
  queues, prompt attempts, dispatch/completion evidence, structured review and
  verification results, task snapshot) stays in the control record under its
  existing rules. Display transcripts move to
  `apps/backend/src/core/build-pipeline-transcript-store.ts`: a durable
  (fsynced, one previous generation, never evicted) step-06 manifest store,
  one manifest per pipeline session, immutable content-addressed chunks
  (whole-message JSON arrays packed to 256 KiB) and one unsealed tail chunk.
  Live provider transcripts between checkpoints sit in a bounded in-memory
  cache (`build-pipeline-transcript-checkpoints.ts`, at most 256 pending
  sessions; eviction only means the next observation re-detects the change).
- **Versioned reference** on `PipelineSession`
  (`packages/protocol/src/build-pipeline.ts`): `transcript:
  PipelineTranscriptReference` (version, provider session id, committed
  manifest revision, display revision, retained count and bytes, `complete`,
  `omittedMessages`, `committedAt`), validated by `isPipelineSession`.
  `messageRevision` and `messagesFingerprint` now describe the committed copy.
  `transcriptCheckpointError` is an explicit, content-free "stored transcript
  is behind the provider" state. Inline `messages` stays readable through the
  legacy adapter and is where clients attach a fetched body.
- **Semantic fields extracted.** `finishVerification` resolves
  `structuredRequestId ?? legacyStructuredRequestId ?? recovery`, where
  recovery reads the newest observed transcript, an unmigrated inline array or
  a 64-message stored tail. `legacyStructuredRequestId` is persisted whenever a
  legacy verify session's body leaves the snapshot (migration or first save);
  it is kept apart from `structuredRequestId` because that field also
  classifies review-package preparation turns. The address-issues handoff
  (`build-pipeline-handoff.ts`) takes an explicit bounded `sourceTranscript`
  (first message plus the newest 2,000, more than the 180 k-character budget
  can select), read from the pending copy or the store; a test proves the
  window renders exactly what the full history would. The other audited
  readers (review reports, usage/token counts, retry baselines, interaction
  transcripts, fan-out progress probes) never read `session.messages`; the
  fan-out progress probe was not touched.
- **Write order.** The service save boundary
  (`build-pipeline-service-interactions.ts`) commits every changed transcript
  (chunks, then manifest) and stamps its reference before the control CAS. A
  transcript failure keeps the previous reference, records
  `transcriptCheckpointError`, keeps the pending copy for the next save, and
  never blocks or reorders the control write (phase transitions, queues,
  cancel, leases). Structured results never came from the display transcript.
  The 5 s transcript throttle and the immediate final persist are unchanged;
  "changed" still means "differs from the committed copy".
- **Reads** resolve exactly the referenced manifest revision (current or the
  retained previous generation, each chunk verified by length, checksum and
  message count). If neither matches, another committed generation is served
  and marked substituted; otherwise the session is reported unavailable,
  separately from pipeline state.
- **Migration** (`build-pipeline-transcript-migration.ts`, run in the
  background by a supervised `init`, and also performed by the first save of
  any unmigrated record): per pipeline, import every inline transcript tagged
  with the source control revision, read it back and verify it, then under the
  cross-process build-pipeline lock replace the arrays with references only if
  the revision is unchanged. The control revision itself is left unchanged
  (same workflow state, new representation), so an in-flight supervisor pass
  and renderer cursors stay valid; a concurrent writer wins and the pipeline
  is retried later. Retries are idempotent (content-addressed chunks,
  full-content digest reuse). Control rewrites are batched (8 pipelines) with
  per-pipeline checks. All retained messages are imported (48 MiB per session,
  above the old 32 MiB whole-snapshot bound).
- **Deletion.** Control-record removal and legacy backup scrubbing are
  unchanged; then every manifest generation and chunk the pipeline owns is
  deleted and further checkpoints for it are fenced in-process. A crash in
  between leaves orphans that the startup sweep (orphans older than 10 min,
  then unreferenced chunks) removes. Legacy inline copies in the control
  file's five rotating backups age out after five control writes; deleting a
  pipeline scrubs them immediately.
- **Commands** (`commands-registry-build.ts`,
  `build-pipeline-transcript-projection.ts`). `get_build_pipeline` never embeds
  bodies. With `knownSessions` it answers `unchanged` only when the control
  revision and every held body are current; otherwise it returns the body-free
  record plus per-session windows read straight from the referenced chunks
  (tail overlap of one, whole body when not held), the viewed
  `prioritySessionKey` first, within a 32 MiB response budget (`deferred`
  beyond it), and `unavailable` for unreadable transcripts.
  `list_build_pipelines` strips bodies, including from unmigrated records.
  `export_build_pipeline_for_downgrade` is the bounded explicit export.
- **Renderer** (`build-pipeline-persistence.ts`, `BuildChatTab.tsx`): cached
  sessions remember which revision their body is; project list hydration keeps
  held bodies; the viewed stage fetches its committed transcript once per
  revision, prioritized; unreadable, trimmed and lagging transcripts show an
  explicit notice. Completed stages stay viewable offline from the durable
  store after the provider session is gone.
- **Control-record reads** are served from a stat-validated decoded cache in
  the new `storage-build-pipelines.ts` storage layer (one `stat` per read when
  the file is unchanged; per-record clones so callers can still mutate).

### Per-pipeline control-record partitioning: deferred

The shared `build-pipelines.json` remains the control store. It now holds
control state only, so its size scales with pipeline count times the control
record (about 3 KB per pipeline without task attachments), not with transcript
history. Moving each record to keyed storage was deferred as a separate,
riskier change: the build-pipeline resource revision (conditional and scoped
snapshot sync) fingerprints this one file; admission-key and GitHub-reservation
uniqueness would need a cross-pipeline reservation index kept under the same
lock; and legacy import, backup scrubbing and whole-file corruption recovery all
assume one file. Measured remaining cost (one local run, 10 pipelines x 4
sessions x 1,500 messages of about 300 B):

| | Before (inline) | After |
| --- | --- | --- |
| Control file | 25,850,193 B | 30,153 B |
| Bytes per active tail checkpoint | 25.9 MB control file plus backup rotation | 10,774 B tail chunk + 1,500 B manifest + 30,153 B control file |
| Full control-file parse | 50.9 ms | 0.17 ms |
| `getBuildPipeline`, file unchanged | 6.9 ms (read and parse) | 0.05 ms (stat and clone) |
| `listAllBuildPipelines`, file unchanged | read and parse of 25.9 MB | 0.24 ms |

A control write therefore still rewrites every pipeline's control record (plus
five rotated backups), and task snapshots with large base64 attachments still
count against every pipeline's writes and the 32 MiB per-snapshot bound. That
is the condition under which partitioning should be revisited; transcripts no
longer contribute to it.

### Tests

New suites: `build-pipeline-transcript-store.test.ts` (windows; one tail chunk
plus manifest per active update with sealed chunks untouched; idempotent retry;
explicit incomplete state; exact referenced revision after a newer
unreferenced commit; crash after chunk write, then repair; crash after manifest
publish; deletion and fence; orphan sweep),
`storage-build-pipeline-transcripts.test.ts` (migration keeps revisions and
persists the recovered request id; a concurrent writer wins; crash during
migration, then an idempotent restart; first save migrates; deletion removes
chunks and scrubs legacy backups; crash during deletion, then sweep; phase,
queue, lease and cancel updates beyond the former 32 MiB transcript limit;
downgrade export fits or is incompatible; two concurrent admissions across
storage instances cannot share a GitHub reservation; cached reads see another
process's write), `build-pipeline-transcript-checkpoints.test.ts` (bytes per
active tail update across several long pipelines with completed stages; a
failed checkpoint never blocks the control write; crash before and after the
control CAS; bounded handoff window and request recovery from the stored
tail), `build-pipeline-transcript-projection.test.ts`,
`packages/protocol/src/build-pipeline-transcript-reference.test.ts` and
`BuildChatTab.transcript.test.tsx`, plus a service test that recovers a legacy
verification request after its transcript left the control record. Existing
supervisor, recovery, fan-out, handoff, persistence and command tests now read
transcripts through storage.

Commands run (all passed unless noted):

```text
mise exec -- bun run --cwd apps/backend typecheck      # also apps/web and packages/protocol
mise run test:logged -- --name be-e14 -- mise exec -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./src --parallel=3 --only-failures      # PASS (84.5 s)
mise run test:logged -- --name web-e14 -- mise exec -- bun test --cwd apps/web ./src \
  --parallel=2 --only-failures                                               # PASS (130.5 s)
mise run test:logged -- --name proto-e14 -- mise exec -- bun test --cwd packages/protocol \
  --preload ../../tests/setup-node.ts ./src --parallel=2 --only-failures      # PASS
mise exec -- bun test ./tests --only-failures --parallel=3   # root suite: only the two
  # pre-existing mise-tasks documentation failures (plan/13, validation.md)
mise run format && mise run format:check && mise run lint                    # clean
```

### Remaining limitations

- Not run: aggregate `mise run test`, isolated real-stack QA (restart between
  dispatch and completion, inactive-environment transcript catch-up) and the
  step-01 timing profile. The table above is one local run; the byte bounds
  are asserted deterministically in the suite.
- Control records are not partitioned (see above).
- The deletion fence is per process; another backend sharing the data
  directory can leave an orphan that the startup sweep removes later.
- The durable transcript quota is 2 GiB and 16,384 sessions. When exhausted,
  checkpoints are refused with `transcriptCheckpointError` instead of evicting
  history. Retention of completed pipelines is unchanged (kept until deleted);
  changing it is a separate product decision.
- A session manifest names every chunk, so it grows with history (about 200 B
  per 256 KiB chunk).
- Downgrade: the export is per pipeline and read-only. Running an older binary
  against a migrated data directory is not supported by itself: it would see
  sessions without inline transcripts.
