# Transcript and history efficiency

Checked against `main` at `2459b05c` (2026-10-15).

Agent transcripts are the largest repeated data flow in the app. Providers
produce them, bridges summarise them, the backend projects them, clients retain
them, and workflows read them to detect progress. The goal is that an unchanged
read does metadata work only, a changed read costs what changed, and history
and large artifacts are fetched separately from the live window, without making
background work depend on a mounted view. Most of this shipped in #875. What
remains is one workflow consumer that still reads whole transcripts on a fast
cadence, a Claude cold-hydration path that is not range-bounded, measurement
gaps, frontend structure work gated on profiling, and real-stack qualification
that was never run.

## Current state

- Bridge reads. All five HTTP bridges (Claude, Codex, Cursor, Pi, Grok/ACP)
  serve the v2 summary, detail and page routes built by
  `packages/protocol/src/node/bridge-transcript-routes.ts`
  (`bridgeTranscriptRouteBody`) over `bridge-transcript-summary.ts`. The
  backend prefers them through `apps/backend/src/core/http-bridge-transcript-v2.ts`
  and falls back to v1 per bridge connection. Wire bounds (locator and cursor
  lengths, page size, detail ceilings) are the exported constants in
  `bridge-transcript-summary.ts`.
- Unchanged reads. Claude keeps a content revision
  (`bridges/claude-bridge/src/services/transcript-revision.ts`). The shared
  token in `packages/protocol/src/node/progressive-transcript.ts` also covers
  title and freshness. Codex reads rollouts with bounded working memory
  (`bridges/codex-bridge/src/rollout-reader.ts`, `transcript-cache.ts`).
- Producer bounds. Cursor bounds its transcript while streaming with no reader
  (`boundTranscriptDuringStreaming`, `boundNestedParts` in
  `bridges/cursor-bridge/src/transcript.ts`) and reports `transcriptBounds`
  from `/runtime-health`. Cursor, Pi and ACP trim linearly with
  `planOldestFirstTrim` / `boundTranscriptInPlace`
  (`packages/protocol/src/node/transcript-budget.ts`).
- Projection. `native-agent-projection-entries.ts` reuses unchanged rows and
  `native-agent-projection-encoding.ts` encodes each row once. Clients that
  negotiate `transcriptPatchVersions` receive part-level patches
  (`packages/protocol/src/native-agent-transcript-patch.ts`); others keep
  whole-message deltas.
- History. `apps/backend/src/core/native-agent-direct-history.ts`
  (`DirectHistoryPageCache`) serves provider pages for v2 bridges, and
  OpenCode pages in-process through `OpenCodeProvider.transcriptPage`.
  Providers without page routes use the joined sync-v1 path, which refreshes
  and fingerprints the retained projection before it serves a page.
- Workflows. Progress probes read a conditional window of the newest
  `PROGRESS_TRANSCRIPT_WINDOW_MESSAGES` (8) messages through
  `readTranscriptProgressSample` (`apps/backend/src/core/transcript-progress.ts`).
  Reviewer views use summary windows, detail references and pages
  (`multi-review-reviewer-transcript.ts`). Pipeline transcripts live in a
  chunk store (`build-pipeline-transcript-store.ts`,
  `build-pipeline-transcript-checkpoints.ts`). Since #969 `build-pipelines` is
  a record layout, so a control save writes one row per changed pipeline.
- Display tails are one SQLite row per session
  (`native-agent-display-tail-store.ts`), checkpointed by
  `NativeAgentDisplayTailScheduler`. See `../architecture/storage.md`.
- Frontend. `apps/web/src/lib/native-history-accounting.ts` caches
  per-message sizes and `nativeAgentProjectionStore.ts` keeps totals
  incrementally, so a tail update no longer re-encodes retained history.
  Retained history is still a flat array (`historyMessagesRef` in
  `useNativeAgentSession.ts`), and display arrays are re-joined on every
  install.
- Measurement. `scripts/efficiency/` runs workloads `a` to `j` through
  `mise run efficiency:baseline` (usage and method:
  [efficiency baseline](../improvements/efficiency/baseline/README.md)).
  `ProgressiveReadPhaseTimer` (`native-agent-progressive-metrics.ts`) splits
  transcript and direct-page reads into source, normalise and scheduler-wait
  phases.

## Outstanding work

### Code

1. Stop the build-stage supervisor reading the whole transcript on every pass.
   In `apps/backend/src/core/build-pipeline-service-supervisor.ts`, the branch
   for a running stage (or an idle stage with background work pending) calls
   `refreshTranscript` on every pass. That calls
   `provider.messages(session.sdkSessionId)`, which for HTTP bridges is
   `HttpBridgeProvider.messages`: a full legacy `/messages` body, sliced after
   the fetch. Passes run every `BUILD_PIPELINE_PROGRESS_MS` (1.5 s,
   `build-pipeline-context.ts`).
   - Follow the consolidation path in `build-pipeline-review-fanout.ts`
     ("Running sessions need a full snapshot only at the persist boundary").
     Read the full body only when `shouldPersistTranscript` is due, when the
     status leaves running, and at stage end. Between those points, detect
     movement with `readTranscriptProgressSample`, which makes a conditional
     `transcriptSnapshot` read of the newest messages when the provider has
     one (every HTTP bridge does) and falls back to `messages({ limit })`
     otherwise.
   - The same result currently drives the stall warning: `transcriptChanged`
     clears `stallWarning`. An unchanged probe must not clear it, and a
     rejected probe means nothing was learned, not "no progress".
   - Fix the stale comments that say a save rewrites the whole build-pipelines
     file: the supervisor's running branch, `DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS`
     in `build-pipeline-service-helpers.ts`, and the token-count comment in
     `build-pipeline-review-fanout.ts`.
   - Done when an active build stage issues no full transcript read between
     persist boundaries, and stall warning and abandonment behave as before.
2. Range-bound Claude cold hydration, or record that it cannot be done.
   `readPersistedSessionMessages`
   (`bridges/claude-bridge/src/services/session-manager-persistence.ts`) calls
   `sdk.getSessionMessages(id, { dir, includeSystemMessages: true })` with no
   `limit` or `offset`, so the first history access after a cold start
   normalises the whole session. The pinned `@anthropic-ai/claude-agent-sdk`
   0.3.296 declares `limit` and `offset` (counted from the start) on
   `GetSessionMessagesOptions`. Check three things before relying on them:
   whether the SDK still parses the whole JSONL to serve a range; that a
   start-relative offset needs a total count before a tail read; and that
   `normalizePersistedSessionMessages` and `overlayCommandChanges` build the
   task registry, background-task snapshots and command changes in one
   chronological pass. If no true range read exists, record full hydration
   (single-flight through `readPersistedSessionMessagesOnce`) as the accepted
   cost.
3. Close the measurement gaps.
   - Record phase timing for state and discovery reads. Today only transcript
     and direct-page reads report `sourceMs` and `normalizeMs`.
   - Add harness workloads for the batched activity sweep, the file-tree cache,
     reviewer and progress probes, and pipeline checkpoints. Their counts
     currently come only from the owning test suites.
   - Add heap/RSS and event-loop-lag reporting; the harness reports counts and
     retained-byte estimates only.
4. Decide what happens to the joined sync-v1 history fallback. All bundled
   bridges serve v2 pages and OpenCode pages in-process, so the joined path now
   serves only an older bridge behind a newer backend. Keep it, cache its
   pages, or remove it after the support window (see
   [mixed-version-compatibility.md](mixed-version-compatibility.md)). Decide
   the older-bridge fallback in `readHttpBridgeTranscriptSnapshot`
   (`apps/backend/src/core/http-bridge-progressive.ts`) at the same time: a
   bridge that predates `/transcript` is read through its whole `/messages`
   body and trimmed afterwards.

### Deferred until measured

5. Frontend retained-history structure, only if browser profiling at an 8 MiB
   retained history shows material long tasks or input latency:
   - keep retained pages as immutable entries separate from the live window,
     and assemble display arrays only when membership, order or an entry
     changes;
   - split state-domain from content-domain subscriptions in
     `nativeAgentProjectionStore.ts` and `useNativeAgentSession.ts`;
   - derive search and annotation indexes by revision.
   Add no worker until repeated work is gone and transfer cost is measured.
6. Bridge-to-backend part deltas. Bridges still send whole lightweight summary
   snapshots on change; patches cover only the backend-to-client hop. Measure
   that hop's bytes and CPU before designing an incremental bridge protocol.
7. Per-message provider revisions. `native-agent-projection-entries.ts` still
   walks each provider row once per changed read to compare it with its kept
   copy (read-only, no encoding). Removing the walk needs a trustworthy
   per-message revision from every bridge.

### Qualification

Run each in an isolated profile per `../development/agent-testing.md`. For
credentials and platforms CI lacks, batch with
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

- A live Grok/ACP session through v2 summary, detail and page.
- Live history paging, and the reviewer "Load earlier messages" control, on a
  session longer than the 100-message live window.
- A live multi-review run: progress probes, reviewer summary windows, detail
  expansion and pages, including real-browser scroll anchoring.
- Claude inactive-tab and background-task runs against content-revision tokens.
- A Cursor run long enough to reach the producer trim thresholds while its
  environment is inactive; return and check the bounded window, sub-agent
  lifecycle and controls.
- Cold restart: populate display tails and pipeline histories, restart backend
  and bridges, confirm the cached preview paints and authoritative state
  reconciles. Also restart a pipeline between dispatch and completion.
- Electron window and Docker environments with real providers; native iOS
  only where the wrapper changes.
- Browser long-task, input-latency and heap/RSS profiling at an 8 MiB
  retained history, including hidden and resumed documents. This is the gate
  for item 5.
- Activity-sweep p50/p95 for 1, 10 and 100 sessions against real bridges.
- Re-measure display-tail cost and the maximum checkpoint age with workload
  `d` now that tails are SQLite rows.

## Constraints and rationale

- Provider histories stay authoritative. Display tails, summary indexes and
  detail caches are regenerable. Pipeline inputs, structured results and
  dispatch journals are durable and are never evicted as caches.
- Display and action authority stay separate. A cached tail may paint, but
  approvals, dispatch, cancellation and workflow advancement use authoritative
  state and generation checks. Detaching a view never cancels work, and
  truncating a display buffer never implies completion.
- Every new wire form is negotiated (v2 discriminator, route presence,
  `transcriptPatchVersions`, the batch activity route), and old readers keep
  v1. A timeout, 5xx or malformed answer is never a capability verdict; only
  404/405 is.
- Encoded JSON bytes, source-file bytes and estimated heap are different
  measures. Never present source-byte accounting as a heap limit.
- Existing limits are ceilings, not targets to raise: live window 100 messages
  and 512 KiB (`DEFAULT_NATIVE_AGENT_LIVE_WINDOW`), projected history 4,096
  messages and 16 MiB (`NATIVE_PROJECTION_MAX_WINDOW_MESSAGES`,
  `NATIVE_PROJECTION_MAX_BYTES` in `native-agent-service-shared.ts`), frontend
  history 4,096 messages and 8 MiB per session and 32 MiB in total
  (`CLIENT_HISTORY_*` in `useNativeAgentSession.ts`), display tails 128 rows
  and 64 MiB. Read the owning constants before changing anything; a soft
  target may be exceeded only below a documented hard cap.
- Progress signals ignore usage, access-time and title churn. A rebase on a
  generation, epoch or digest-format change is neither progress nor a new
  stall clock.
- Pipeline viewers read the committed transcript copy, which changes only at
  persist boundaries, so item 1 does not change what a user sees. The handoff
  window (`transcriptCheckpoints.window`) and `recoverStructuredRequestId` read
  the newest observed copy, so the stage-end full read must happen before them.
- Reducing repeated source reads and serialisation comes before tuning wire
  size or adding transport complexity.
- Accepted limitations, not todos:
  - Detail locators expire when a streaming body changes.
  - Progress probes see only the newest 8 messages.
  - Codex in-flight sharing is keyed by path, not dev and inode.
  - The ACP batch activity route mirrors its single route, which never
    reports `waiting`.
  - One `unavailable` id fails its whole activity group, as a single-route
    500 did.
  - The Cursor cross-write encoding cache was declined: no trustworthy
    mutation key exists.

## Open questions

- Should item 1 use the shared progress probe, or a dedicated source-token
  check?
- Do items 5, 6 and 7 justify their complexity once profiling exists?

## Needs verification

- Whether Grok's ACP `session/new` "Invalid params" rejection, seen in the
  September live run, is fixed. #874 (MCP headers in ACP `{name,value}` form)
  merged the same day and may cover it.
- Whether the SDK's `limit`/`offset` avoids a full JSONL parse. Check current
  docs through Context7 and the SDK source before item 2.

## Related

- [remote-client-bandwidth.md](remote-client-bandwidth.md): remote bytes,
  encoded patch bytes and multi-client runs.
- [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md): reviewer
  transcripts, progress probes and the multi-review benchmark.
- [native-agent-idle-observation.md](native-agent-idle-observation.md): the
  read side of idle native sessions.
- [container-state-observation.md](container-state-observation.md): the
  container file-tree watcher deferred from the file-tree cache work.
- [mixed-version-compatibility.md](mixed-version-compatibility.md): retiring
  the sync-v1 fallback.
- `../architecture/storage.md` (display tails, pipeline transcripts),
  `../architecture/agent-engines.md` (OpenCode history paging), `AGENTS.md`
  (v2 route, batch activity and Cursor bound invariants).
- Living-doc drift to fix:
  - No architecture doc describes the native transcript pipeline. The v2
    envelope and capability discovery, detail locators and page cursors,
    backend cursor namespaces, the direct page cache bounds, patch
    negotiation, progress digest versioning, the display-tail checkpoint
    policy and the pipeline transcript store quota live only in code
    docblocks (`bridge-transcript-summary.ts`, `native-agent-direct-history.ts`,
    `transcript-progress.ts`, `native-agent-display-tail-scheduler.ts`,
    `build-pipeline-transcript-store.ts`). `event-snapshot-recovery.md`
    explicitly excludes native transcript windows. Candidate:
    `docs/architecture/native-transcripts.md`.

## Replaces

- `docs/improvements/efficiency/README.md` (findings shipped; follow-up
  measurement)
- `docs/improvements/efficiency/transcripts.md` (E01 to E09, done)
- `docs/improvements/efficiency/frontend-and-workflows.md` (E10, E13, E14 and
  the "Areas inspected" measurement targets; E11 is in
  `remote-client-bandwidth.md`, the E12 container watcher in
  `container-state-observation.md`)
- `docs/improvements/efficiency/validation.md` (probes reproduced by harness
  workloads `a` to `c`)
- `docs/improvements/efficiency/plan/00-index.md` (architectural decisions and
  budget policy, carried into "Constraints and rationale")
- `docs/improvements/efficiency/plan/01-baselines-and-instrumentation.md`
  (measurement gaps)
- `docs/improvements/efficiency/plan/02-linear-transcript-budgets.md` (done)
- `docs/improvements/efficiency/plan/03-cursor-background-bounds.md` (live
  trim-threshold run)
- `docs/improvements/efficiency/plan/04-cursor-durable-persistence.md` (done)
- `docs/improvements/efficiency/plan/05-claude-transcript-revisions.md`
  (inactive-tab and background-task runs)
- `docs/improvements/efficiency/plan/06-keyed-storage-primitives.md`
  (superseded by #969)
- `docs/improvements/efficiency/plan/07-display-tail-storage.md` (superseded by
  #969; re-measurement)
- `docs/improvements/efficiency/plan/08-transcript-contracts.md` (done;
  architecture-doc gap)
- `docs/improvements/efficiency/plan/09-provider-transcript-adapters.md` (live
  Grok run)
- `docs/improvements/efficiency/plan/10-codex-rollout-reader.md` (done)
- `docs/improvements/efficiency/plan/11-direct-history-paging.md` (Claude cold
  range read, sync-v1 decision, live paging)
- `docs/improvements/efficiency/plan/12-incremental-backend-projection.md`
  (per-message revisions)
- `docs/improvements/efficiency/plan/13-frontend-history-accounting.md`
  (structure items and profiling)
- `docs/improvements/efficiency/plan/14-part-level-deltas.md` (bridge hop;
  encoded and multi-client bytes are in `remote-client-bandwidth.md`)
- `docs/improvements/efficiency/plan/15-reviewer-and-progress-reads.md` (live
  multi-review run)
- `docs/improvements/efficiency/plan/16-pipeline-transcript-storage.md`
  (conditional reads during supervision; control partitioning superseded by
  #969)
- `docs/improvements/efficiency/plan/17-read-scheduling-and-activity.md`
  (sweep latency)
- `docs/improvements/efficiency/plan/18-file-tree-caching.md` (done; the
  deferred container watcher is in `container-state-observation.md`)
- `docs/improvements/efficiency/plan/19-integration-and-rollout.md` (unrun
  qualification; remote rows are in `remote-client-bandwidth.md`)
- `docs/improvements/efficiency/baseline/README.md` (kept; its "Not measured
  here" list)
- `docs/improvements/efficiency/baseline/final-summary.json` (historical #875
  comparison)
- `docs/improvements/efficiency/baseline/step-01-summary.json` (superseded by
  `final-summary.json`)
