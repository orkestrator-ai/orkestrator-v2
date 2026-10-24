# Transcript and history efficiency

Checked against `main` at `2459b05c` (2026-10-15); code items 1 to 6, the
measurement gaps and the deferred-item measurements closed against `main` at
`71227437` (2026-10-24).

Agent transcripts are the largest repeated data flow in the app. Providers
produce them, bridges summarise them, the backend projects them, clients retain
them, and workflows read them to detect progress. The goal is that an unchanged
read does metadata work only, a changed read costs what changed, and history
and large artifacts are fetched separately from the live window, without making
background work depend on a mounted view. Most of this shipped in #875, and
build-pipeline supervision no longer reads whole transcripts on every pass.
Every code item is now done or decided (2026-10-24). What remains is
real-stack qualification this node could not run: a long inactive Cursor run,
the pre-acceptance pipeline dispatch window, Electron and Docker with real
providers, a truly hidden browser document, and a mounted tab across a
bridge-only restart.

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
  Build-pipeline stages, reviewers and the consolidation session look at a
  session's transcript only at a persist boundary
  (`DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS`, 5 s), when a turn ends or while
  a stall warning shows, and read the whole body only when that probe moved
  since the committed copy (`refreshMovedTranscript` in
  `build-pipeline-service-supervisor.ts`; the baseline lives in
  `build-pipeline-transcript-checkpoints.ts`). An unchanged session costs one
  probe answered `unchanged` and no save. Bounded `messages({ limit })` reads
  ask the bridge for its tail with `/messages?limit=`.
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
  install. Load earlier messages holds the reader's row in both the native
  and the reviewer tab (`useHeldTranscriptPlace.ts`).
- Measurement. `scripts/efficiency/` runs workloads `a` to `n` through
  `mise run efficiency:baseline` (usage and method:
  [efficiency-harness.md](../../development/efficiency-harness.md)), with
  heap/RSS and event-loop lag on every case. `ProgressiveReadPhaseTimer`
  (`native-agent-progressive-metrics.ts`) splits transcript, direct-page,
  state and discovery reads into source, normalise and scheduler-wait phases.
  `e2e/perf/rich-transcripts-perf.ts --retained-mib N` profiles a large
  retained history in real Chrome. `scripts/codex-parent-exit-live.ts` and
  `scripts/activity-sweep-live.ts` repeat the live parent-death and sweep runs.
- Codex rows. A row opens per model response, using app-server's
  per-response usage report as well as reasoning or messages after a call.
  Replayed rows keep their ids across replays (`replayedRowId`). Every bridge
  checks its parent backend once a second (`PARENT_WATCH_INTERVAL_MS`), and
  the Codex bridge stops a dead backend's turns as a restart mid-turn.
- The pipeline as a whole is described in
  [native-transcripts.md](../../architecture/native-transcripts.md).

## Outstanding work

### Code

1. **Done (2026-10-24): range-bounding Claude cold hydration is recorded as
   impossible, and full hydration is the accepted cost.** The bridge now pins
   `@anthropic-ai/claude-agent-sdk` 0.3.309. Its `getSessionMessages`
   (`nF` → `Xxe` → `Qxe` → `tF` → `wR` in `sdk.mjs`) reads the whole
   `{sessionId}.jsonl` and parses every entry. Above 5 MiB
   (`CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` unset) it reads only the bytes after
   the last compact boundary. It then rebuilds the `parentUuid` chain and
   compaction segments (`fd`), and only then applies `offset`/`limit` as an
   array `slice` (`wR`). So:
   - a range costs the same parse as the whole session;
   - `offset` counts from the start, so a tail read would also need the total
     count, which is the same full parse;
   - `normalizePersistedSessionMessages` and `overlayCommandChanges` build the
     task registry, background-task snapshots and command changes in one
     chronological pass, so a slice would lose the task launches the tail's
     reports fold onto.

   `readPersistedSessionMessages` keeps calling it with no range, single-flight
   through `readPersistedSessionMessagesOnce`. The bound that does exist is the
   SDK's own: past 5 MiB, pre-compaction bytes are never read.
2. **Done (2026-10-24): measurement gaps closed.**
   - Phase timing. Progressive state reads now record `sourceMs`,
     `normalizeMs` and `schedulerWaitMs`
     (`getSessionStateUpdate` / `readProgressiveSessionState` in
     `native-agent-transcript-projection.ts`). Discovery records two samples:
     each view read (cache tier `memory`, `normalizeMs` for assembling and
     hashing the view), and each provider section job when it settles (tier
     `provider`, `sourceMs` and `normalizeMs`). `ProgressiveReadMetrics` now
     keeps 256 samples per domain, so idle polling of state and discovery
     never evicts transcript samples. Covered by the "state and discovery read
     phase metrics" tests in `native-agent-progressive-metrics.test.ts`.
   - Harness workloads `k` to `n` (`scripts/efficiency/workloads-supervision.ts`):
     the batched activity sweep (`k`), the Files panel tree cache (`l`),
     reviewer and progress probes (`m`), and pipeline checkpoints (`n`).
     Workload `d` gained `age-*` checkpoint-age cases that run the real
     `NativeAgentDisplayTailScheduler` on a virtual clock. All counters are
     stable across repetitions and pinned in `tests/unit/efficiency/harness.test.ts`.
   - Heap/RSS and event-loop lag. Every case now reports `resources`: retained
     heap after the cold repetition, heap and RSS peaks, and timer-lateness
     p50/p99/max (`scripts/efficiency/resources.ts`). The sampler is
     timer-based, because Bun 1.4.3's `monitorEventLoopDelay` reported about
     1 ms for a 50 ms synchronous block. Like wall-clock time, these are
     machine-specific and never compared. See
     [efficiency-harness.md](../../development/efficiency-harness.md).
3. **Decided (2026-10-24): both older-bridge fallbacks stay, uncached, until
   [0034](../cross-cutting/0034-mixed-version-compatibility.md) agrees a
   support window.** That covers the joined sync-v1 history path and the
   `/messages` fallback in `readHttpBridgeTranscriptSnapshot`. Every bundled
   bridge serves v2 pages and OpenCode pages in-process, so only an older
   bridge behind a newer backend reaches either path. Caching joined pages
   would add a bounded cache and invalidation rules for a path no bundled
   bridge takes. Removing it before the window is agreed would break exactly
   the skew 0034 exists to protect. Both rows stay in 0034's retirement index,
   which owns the content-free use counters (its item 3). No code changed. The
   existing tests keep both paths honest (`falls back to the legacy messages
   route on a bridge without /transcript` in `http-bridge-provider.test.ts`,
   and the sync-v1 cases in `native-agent-service-projection-lifecycle.test.ts`).
4. **Done (2026-10-24): Codex has a per-response row boundary.** app-server
   sends `thread/tokenUsage/updated` once per Responses API completion,
   tool-only responses included. A probe of the pinned 0.164.0 showed one
   report after each of four code-mode `exec` calls that carried no reasoning
   or message item, and none in between. `rawResponse/completed` names the
   response, but it arrives only with the experimental API, which the bridge
   declines. The reducer now also emits `model.response.completed`.
   `TurnAccumulator.noteModelResponseCompleted` counts the unconsumed reports,
   and `opensModelStep` opens a row for a new client tool call while a report
   is pending and the live row already holds a call. A count rather than a
   flag means a report that arrives before its own response's item cannot
   swallow the next boundary.

   A reload splits at the same place: the rollout's `token_usage_record`, or
   the older `token_count` event, follows each response's call record
   (`history/rollout.ts`). Limits:
   - A code-mode cell's own calls stream after its response's report, so a
     cell making several calls can split once inside itself. Each report still
     opens at most one row, so rows stay bounded by responses.
   - Without usage reports, the old inference applies.

   Covered by `tool-only responses` in `history/rollout-rows.test.ts` (live
   and reload give the same rows) and the usage-report cases in
   `sessions/turn-accumulator.test.ts`. Proved live on 2026-10-24 (results
   below): GPT-6-Luna made 150 tool-only reads, one code-mode `exec` call per
   response with nothing written in between. The unpatched bridge gave them
   6 rows and an untruncated window; this change gave them 152 rows with a
   100-row tail, and pages to the prompt. Replaying that real rollout twice
   gave one call per row and identical ids.
5. **Done (2026-10-24): replayed Codex rows have stable ids.** Each replayed
   row is named by `replayedRowId(threadId, turnId, kind, ordinal)`, a
   SHA-256 of its place in the rollout (`msg-r-` plus 32 hex characters; a
   gap row by its byte offset). A rollout only grows, so every replay of it
   gives each row the same id. That covers the re-attach after an idle detach,
   which also re-keyed every row before, not only a bridge restart. The first
   replay after live streaming still re-keys rows once: live rows are minted
   at dispatch, before app-server names their turn, so no replay can
   reproduce them. The mounted-tab qualification below covers that one
   transition. Covered by `replayed row ids` in `history/rollout-rows.test.ts`
   (identical across replays, unique, and earlier ids unchanged when the
   rollout grows).
6. **Done (2026-10-24): a Codex turn stops within a second of its backend's
   death.** The cause was the parent watchdog's 15 s poll
   (`DEFAULT_POLL_INTERVAL_MS`), longer than the 5 to 7 s a restarted backend
   takes to start and reap the orphan. `PARENT_WATCH_INTERVAL_MS` is now
   1 s, a signal-0 probe per second, and every bridge uses it: the default
   for Claude and Codex, `BridgeLifecycle` for Cursor and Pi, and ACP's
   overridable default. On detection the Codex bridge calls
   `interruptForParentExit` (2 s budget) before its drain. That marks each
   running turn `stoppedByShutdown`, so it settles as a restart mid-turn
   (`completeRecoveredTurn`), never as a cancel, and a build stage still
   continues it once. Covered by `a dead backend's running turn stops as a
   restart mid-turn` in `app-server-runtime-lifecycle.test.ts`. Live evidence
   is in "Qualification results (2026-10-24)" below
   (`scripts/codex-parent-exit-live.ts`). Most of the gain is the shorter
   poll: app-server's own SIGTERM handling already records `turn_aborted`, so
   the explicit interrupt is a bounded extra.

### Deferred until measured

7. **Closed (2026-10-24): the retained-history restructure is not needed for a
   visible document.** The gate it waited for ran on 2026-10-24 (results
   below). At an 8 MiB retained history in real Chrome, while a response
   streams:
   - no long tasks and no Event Timing entries over 50 ms while typing or
     scrolling;
   - composer latency unchanged (10.1 ms median, 17.8 ms p95, against 10.45
     and 17.7 ms at 5.56 MiB);
   - scroll frames held 16.7 ms;
   - post-GC heap 17.7 MiB.

   The one long task (73 to 76 ms) is the first open of the transcript. So
   immutable retained pages, split subscriptions and revisioned indexes would
   remove no measured latency. If the still-open hidden-document measurement
   below shows a resume cost, that goes in a new file.
8. **Closed (2026-10-24): bridge-to-backend part deltas are not justified.**
   Measured with workloads `e` and `j` on this node. A changed read of a
   100-message window sends the whole v2 summary over the bridge hop: 219,127
   decoded bytes (34,710 gzip). Building, encoding and parsing it took
   0.26 + 0.19 + 0.09 ms (medians of 40, loaded host). The bridge hop is
   loopback, or a container port on the same host. For comparison, the
   backend-to-client hop already patches the same 40-observation streams down
   to 29 to 44 KB in total. About 0.5 ms of CPU per changed read does not pay
   for a second incremental protocol. Reopen it with
   [0052](0052-remote-client-bandwidth.md) if a bridge ever runs remote from
   its backend.
9. **Closed (2026-10-24): per-message provider revisions are not justified.**
   Workload `f` (a changed read of a 100-message window with one changing
   tail, including the read-only walk over every provider row) takes 0.44 ms
   warm p50 and 0.69 ms p95 on this node. Removing the walk would save part
   of that, and it would need a trustworthy per-message revision from all five
   bridges.

### Qualification

Run each in an isolated profile per `../development/agent-testing.md`. For
credentials and platforms CI lacks, batch with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

Done on 2026-10-24 (results below):

- A live Grok/ACP session through v2 summary, detail and page.
- The Claude native case of `transcript-paging-live.spec.ts` re-run with the
  held-place fixes, and a tool-only Codex native case. The backend checks
  passed; the browser held-place check did not, so that defect is tracked in
  [0090](0090-held-place-drift-with-folded-tool-runs.md).
- Browser long-task, input-latency and heap profiling at an 8 MiB retained
  history (the item 7 gate), for a visible document.
- Activity-sweep p50/p95 for 1, 10 and 100 sessions against real bridges.
- Display-tail cost and the maximum checkpoint age with workload `d`.
- Codex parent-death detection and shutdown (Code item 6).

Still open:

- A Cursor run long enough to reach the producer trim thresholds while its
  environment is inactive; return and check the bounded window, sub-agent
  lifecycle and controls. Not run on 2026-10-24. Cursor is signed in on
  mbp3, but the production threshold is `MAX_TRANSCRIPT_BYTES` (16 MiB minus
  128 KiB, or 2,000 messages) in `bridges/cursor-bridge/src/config.ts`.
  Reaching it takes a far longer turn than a qualification run, and none was
  budgeted. The cheaper route is `CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES`, which
  can lower it to 256 KiB, but that needs the variable passed through to the
  profile's bridge spawn.
- Hit the pre-acceptance build-pipeline dispatch window live. In the
  2026-10-21 cold-restart runs the backend was killed while the prompt was
  journaled (`pendingPromptAttempt`), but each time the provider already
  showed the build session running, so the retry under the same request id
  before acceptance was proved only by unit tests. A fault hook that holds the
  bridge's prompt route would make the window deterministic. Not done: no
  bridge has such a hook, and adding a test-only stall to a production
  dispatch route is its own change.
- Electron window and Docker environments with real providers; native iOS
  only where the wrapper changes.
- A truly hidden and resumed document at an 8 MiB retained history. Headless
  Chrome kept a page `visible` behind another tab, when minimized and under
  `Page.setWebLifecycleState` freezing (its timers kept running), so only
  `--headed` or Electron can measure it.
- A mounted tab with retained history across a bridge-only restart (Code
  item 5): no duplicate rows and the reader's place kept, through the one
  re-key that remains.

## Qualification results (2026-10-24)

Run on node mbp3 (Mac17,6, Apple M5 Max, 18 cores, macOS arm64, Bun 1.4.3)
on `71227437` plus this change. Other workspaces kept the host busy (load
average 18 to 29 throughout), so timings are upper bounds. Content-free
evidence is in `output/agent-testing/qa-0050-*/`, `output/efficiency/qa-0050-*/`
and `output/benchmarks/rich-transcripts/` (all untracked).

### Codex parent death (Code item 6)

`bun scripts/codex-parent-exit-live.ts --codex <pinned 0.164.0 binary>` starts
a real bridge and app-server on a throwaway `CODEX_HOME`. A `sleep` process
stands in for the backend. The prompted turn runs a 90 s shell script; the
stand-in is then SIGKILLed, and a second bridge starts on the same state.
`main` was run from a worktree of `71227437` with `@orkestrator/*` pointing at
its own packages.

| | `main` (3 runs) | This change (6 runs) |
| --- | --- | --- |
| Parent death noticed | 7,659 to 9,182 ms | 239 to 771 ms |
| Bridge, app-server and the agent's command gone | 7,712 to 9,208 ms | 293 to 797 ms |
| Turns interrupted before the drain | none | 1, in 4 to 98 ms |
| Rollout | `task_started`, `turn_aborted` | the same |
| Next bridge reports the session | `failed`, `interruption: "restart"` | the same |

So a crashed backend's Codex turn now stops before the next backend could
start, and a build stage still continues it once. The dispatch journal still
read `accepted` when the bridge exited, so the restarted bridge recovered the
turn through `recoverUnresolvedDispatches`, exactly as after a crash.

### Grok/ACP v2 routes, and the `session/new` Invalid params finding

A real ACP bridge (`ACP_PROVIDER=grok`) ran on Grok 1.0.67 (model `grok-4.7`,
effort `high`) in a throwaway workspace. The prompt followed a chain of three
small files and a 12.5 KB one. Four runs; the last three were clean, and the
first exposed two mistakes in the probe script, not in the bridge.

| Check | Result |
| --- | --- |
| `session/new` (`POST /session/create`) | 201 every run: the September "Invalid params" rejection no longer happens |
| v2 summary (`limit=2`) | snapshot, 2 rows, `truncated`, history cursor and token, `freshness: "current"` |
| The same read with its token | `unchanged` |
| `/transcript/page` (`limit=2`) | reached the start (`complete: true`), same epoch, no duplicate ids, oldest row the prompt |
| `/transcript/detail` | the 12,547-byte tool output, matching its `detailRef` size |
| `/runtime-health`, `POST /sessions/activity` (v1), close | 200; idle and `missing` answered in band; closed |

Grok made all four reads in one response in the last run, so they share one
row, as ACP's row rule expects.

### Activity sweep against real bridges

`bun scripts/activity-sweep-live.ts` drives the backend's own
`createNativeAgentProvider` / `readActivityGroup` over HTTP against real Codex
(app-server 0.164.0) and Claude bridges. Each bridge holds 100 idle sessions;
no prompts are sent. The single-route rows answer the batch route with 404, as
an older bridge would. 50 sweeps per size after 5 warm-up sweeps, in ms:

| Bridge | Sessions | Route | p50 | p95 | max | Requests per sweep |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | 1 | batch | 0.18 | 0.38 | 0.63 | 1 |
| Codex | 10 | batch | 0.31 | 0.49 | 2.41 | 1 |
| Codex | 100 | batch | 0.37 | 0.65 | 1.16 | 2 |
| Codex | 10 | single | 0.50 | 1.25 | 2.15 | 10 |
| Claude | 1 | batch | 0.54 | 0.94 | 3.69 | 1 |
| Claude | 10 | batch | 0.41 | 0.93 | 1.51 | 1 |
| Claude | 100 | batch | 0.53 | 0.98 | 1.75 | 2 |
| Claude | 10 | single | 0.55 | 1.08 | 2.27 | 10 |

A second run of 100 sweeps on a busier host gave p95 up to 11.3 ms (Codex,
1 session) and a max of 40.5 ms; every sweep stayed under 50 ms. The batch
route takes at most 50 ids, so 100 sessions always cost two requests. Every
session was idle and had never run a turn, so this is request cost, not load.

### Display tails (workload `d`)

An update reads no payloads and writes one; a cold read reads one. Disk use
is 571, 2,736 and 9,312 KiB for 1, 32 and 128 tails. Update cold / warm p50 /
warm p95: 1.54 / 1.23 / 1.29 ms (1 tail), 1.77 / 1.64 / 3.38 ms (32) and
3.28 / 3.34 / 3.67 ms (128). Syscall KiB is Linux-only and absent here.

The checkpoint policy makes a tail due 2 s after its last update or 10 s
after it first became dirty, whichever comes first
(`NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS`,
`NATIVE_DISPLAY_TAIL_MAX_CHECKPOINT_AGE_MS`), and writes share a pool of 2.
The new `age-*` cases run the real scheduler on a virtual clock:

| Case | Writes | Updates coalesced | Age p50 / max (ms) | Peak writes |
| --- | --- | --- | --- | --- |
| 1 session, update every 250 ms for 60 s, 5 ms writes | 6 | 234 of 240 | 10,000 / 10,000 | 1 |
| 128 sessions, 5 ms writes | 768 | 29,952 of 30,720 | 10,100 / 10,315 | 2 |
| 128 sessions, 50 ms writes | 768 | 29,952 of 30,720 | 10,150 / 13,150 | 2 |
| 10 updates over 900 ms, then quiet | 1 | 9 of 10 | 2,900 / 2,900 | 1 |

So the maximum checkpoint age is 10 s plus the write-pool queue. That is
about 10.3 s at the measured 3.3 ms write with 128 tails, and 13.2 s if every
write took 50 ms. The 2026-10-21 crash runs (a cached tail at most 10 s old)
are consistent with it.

### Browser at an 8 MiB retained history (the item 7 gate)

`mise exec -- bun e2e/perf/rich-transcripts-perf.ts --runs 3 --cycles 10
[--retained-mib 8]` ran in Google Chrome 155.0.8059.85, headless, against
production builds. The fixture mounts the real `NativeChatShell`
(`VirtualizedMessageList`, `NativeMessage`) and `NativeComposeBar`. A response
streams into its tail (12 characters every 50 ms) throughout, and each tick
re-derives display rows over the whole array. `--retained-mib 8` pads the same
3,000 messages to 8.0 MiB of encoded JSON, keeping them under the
4,096-message client cap. Medians of the three runs:

| Metric | Default (5.56 MiB) | 8 MiB |
| --- | --- | --- |
| First row after navigation | 632 ms | 538 ms |
| Long tasks while opening | 0 ms (one run 51 ms) | 74 ms (one task per run, 73 to 76 ms) |
| Composer latency median / p95 | 10.45 / 17.71 ms | 10.1 / 17.82 ms |
| Long tasks while typing; Event Timing over 50 ms | 0; 0 | 0; 0 |
| Main thread busy while typing | 9.0% | 8.2% |
| Scroll frame median / p95 | 16.7 / 16.7 ms | 16.7 / 16.7 ms |
| Long tasks while scrolling; frames over 33 ms | 0; 0% | 0; 0% |
| Back in front after 10 s behind another tab: first frame, long tasks | 26.4 ms, 0 | 21.7 ms, 0 |
| Post-GC JS heap after the cycles | 16.78 MiB | 17.7 MiB |
| Convergence (cache, queue, workers, DOM) | passed | passed |

Limits:

- Headless Chrome kept the covered page `visible`, and also kept it visible
  minimized and under `Page.setWebLifecycleState({ state: "frozen" })`, whose
  timers kept running. So the "behind another tab" row is not a hidden
  document. `--headed` (or Electron) is needed for that, and it stays in
  Qualification.
- The fixture renders the shell from an array; it does not run
  `useNativeAgentSession`'s retained-page join or the projection store's
  subscriptions. Workload `g` covers their accounting.

### Live paging: Claude native, and tool-only Codex (Code item 4)

Profile `qa-0050-paging` (`dev:test --fixture --credential-source claude
--credential-source codex --agent-platforms claude,codex`), the native case of
`e2e/agent-testing/transcript-paging-live.spec.ts`, 150 stops. Annotations are
in `output/agent-testing/qa-0050-paging/evidence/`.

| Case | Rows | Live window | History pages | Stops | Browser |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku | 152 | 100, `truncated`, cursor, 52 omitted | 12 + 40 to the prompt, `complete` | all 150 in order; stop 2's deferred detail resolved (13,267 B) | reader's row moved 124 px on the first click (limit 8): [0090](0090-held-place-drift-with-folded-tool-runs.md) |
| Codex GPT-6-Luna, tool-only, unpatched bridge | 6 | 6, not truncated | none | all 150, in 6 rows | not reached (`rows > 100` failed) |
| Codex GPT-6-Luna, tool-only, this change | 152 | 100, `truncated`, cursor, 52 omitted | 12 + 40 to the prompt, `complete` | all 150 in order; deferred detail resolved (13,261 B) | same 124 px drift as Claude |

The tool-only prompt is `ORKESTRATOR_AGENT_TEST_PAGING_CODEX_NOTES=0`. The
unpatched row is the first attempt. `dev:test` runs local bridges from
`bridges/<name>/dist/index.js` and never rebuilds them, so that run used the
bundle from before this change: the item 4 defect reproduced live. AGENTS.md
now says to rebuild before such a run. The rollout of the patched run held
150 responses, each a single-`cat` `exec` call followed by a
`token_usage_record`. Replaying it offline gave 151 assistant rows with at
most one call each, unique `msg-r-` ids, and the same ids on a second replay.
It also gave one more leading user row than the live view, which is not a
boundary difference.

The Claude case is the re-run this file asked for. Its backend half now
passes. The browser half stopped at the same 124 px offset as Codex. That
offset is the same across two providers, and tool-run folding (#1108) landed
after the 2026-10-18 fixes, so it points at the shared renderer or the spec.
It is tracked as new work in 0090, not here.

## Qualification results (2026-10-21): cold restart

Real cold restarts of the whole profile (backend, bridges and Electron), idle,
mid-turn and mid-dispatch, on `9b3f53a2` plus this change, on a loaded macOS
arm64 host (load average about 10 on 18 cores). Profile `qa-cold-c5a8`
(`dev:test --fixture --credential-source claude --credential-source codex
--agent-platforms claude,codex`), Codex 0.162.1 on GPT-6-Luna (low) and Claude
Haiku (`claude-haiku-5-5`). The spec is
`e2e/agent-testing/cold-restart-live.spec.ts`; how to run it is in
[agent-testing.md](../../development/agent-testing.md#live-cold-restart). A
graceful restart is `dev:stop` and a fresh launcher; a crash `SIGKILL`s this
profile's backend first, so nothing drains. Each turn follows a trail of files
and each prompt carries a random tag, so lost, duplicated and reordered rows
are countable without reading prose. Measurements are Playwright
annotations, summarised below; the final Codex run's and the Claude run's
`results.json` are kept in `output/agent-testing/qa-cold-c5a8/evidence/`.
Restarts took 4.9 to 9.5 s.

| Scenario | Result |
| --- | --- |
| Native Codex, idle graceful restart | Pass. The first read after the restart was the persisted tail (`freshness: "cached"`) with exactly the 8 rows from before. A client following updates from it (never forcing) converged on the provider's rows: no lost or added content, no repeated prompt. All 8 rows came back under new ids (Code item 5). The browser showed the prompt and the closing word in exactly one row each, before and after the restart and after a reload. |
| Native Codex, backend `SIGKILL` mid-turn | Pass after the fix below. The crash came 16 to 17 s after the sixth stop. The cached tail held 23 to 26 of the 25 to 30 rows that existed then, never a row the provider lacked, and always the prompt (the 10 s checkpoint age bound held). The turn went `recovering` then `error` (restarted mid-turn). The provider kept every stop read before the crash and the client converged on it. A follow-up finished the trail, and every prompt and closing word showed once in the browser. |
| Native Claude, idle and crash | Pass. Same checks. Cold hydration split a thinking part into its own row (9 rows for 8) and re-keyed the rows, with no content lost. After the crash the cached tail lagged 7 rows (Haiku reads about a stop a second) and the turn settled straight to `error`. |
| Build pipeline, backend `SIGKILL` with the build prompt journaled | Pass (3 runs). Each kill landed while `pendingPromptAttempt` was set and the session already showed running. After the restart the stage kept its session, the task prompt reached the provider once, at most one restart continuation was sent, no prompt repeated, and the build finished the trail. The pre-acceptance half of the window was not isolated live (see Qualification). |
| Build pipeline, graceful restart mid-turn | Pass (2 runs). The committed history was readable straight after the restart, before the provider answered, with all earlier content. By then the supervisor had already committed the bridge's replay, so ids differed (Code item 5). The stage continued once on the same session and finished, and the final history held every earlier row's content once. |
| Build pipelines, idle graceful restart | Pass. With both pipelines cancelled, every stage history (2 or 3 sessions) came back byte-identical. |

Fixed in this change:

- **A crash erased the interrupted Codex turn's last row.** On restart the
  bridge recovers an unresolved dispatch (`recoverUnresolvedDispatches` in
  `bridges/codex-bridge/src/app-server-runtime-lifecycle.ts`). It reused the
  replay's last assistant row as the recovered turn's render target, and a
  render replaces its row's parts, so finalizing the interrupted turn wiped
  that row. Live, this was the step note and the read of stop 21. The model
  still had stop 21 in context and went on to stop 22, so the transcript
  skipped a stop. Recovery now reuses the last row only when it is an empty
  assistant row, and otherwise opens a fresh one. Covered by `bridge-process
  recovery keeps the replayed rows of the interrupted turn` in
  `app-server-runtime-lifecycle.test.ts`.
- **The spec's second restart saw a zombie launcher.** The launcher an
  earlier restart starts is the Playwright worker's child, and `spawnSync`
  blocked the worker's event loop, so the dead launcher stayed a zombie that
  `dev:stop` reported as surviving. The spec runs `dev:stop` asynchronously.
  `multi-review-live.spec.ts` uses the same pattern but restarts only once.

Findings that are not defects:

- A client that holds the persisted tail's token gets `snapshot` answers marked
  `cached` (the in-memory entry) and then `unchanged`, so its view never reads
  `current` although its rows are the provider's. The web client treats
  `cached` as current (`useNativeAgentSession.ts`), so nothing shows.
- A backend-served page in an agent-test profile shows the "server now runs
  44.7.0" banner; that is
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md) item 8.

Validation: `mise run check` passed. The Codex bridge suite passed with the new
test (2,200 passed, 34 skipped) once `PORT` was unset. With the agent tab's
inherited `PORT` the `item-to-parts` file cannot start, registered as
environmental flake
[0660](../../tests/flaky-tests/agent-bridges/0660-codex-item-to-parts-inherited-port.md).
The final run of the whole spec on Codex passed (261 s), and the Claude native
case passed separately (150 s). The profile was stopped and reset afterwards.
A full `env -u PORT mise run test` (707 s) failed only on a recurrence of
[0248](../../tests/flaky-tests/environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)
(5137.87 ms), whose unchanged owning file passed with the documented command.

## Qualification results (2026-10-21): Claude revision tokens

Claude's content-revision tokens with the view off screen, run on
`9b3f53a2` plus this change on a loaded macOS arm64 host. Profile
`qa-revtok-2ead` (`dev:test --fixture --credential-source claude
--agent-platforms claude`), Claude Agent SDK 0.3.296, model Claude Haiku. The
spec is `e2e/agent-testing/claude-revision-tokens-live.spec.ts`; how to run
it is in
[agent-testing.md](../../development/agent-testing.md#live-revision-tokens-with-inactive-views).
Content-free timelines are the annotations in
`output/agent-testing/qa-revtok-run<N>/browser/results.json` (N = 1 through 4).
These run artifacts are local and untracked. The historical runs below predate
the stricter conditional-content and per-case lifecycle assertions; they do not
qualify those new assertions.

One session, two cases. In the first, a prompt starts a background Bash
command (`sleep 45`) and the test switches to a second tab in the pane. In the
second, a prompt starts a background subagent (`sleep 40` inside it) and the
test selects another environment. In both, the turn ends, the task finishes
and Claude answers the task report while the view is off screen. The test
reads the session as a view does, with its last transcript and state tokens,
every 2 s.

| Check | Result |
| --- | --- |
| No missed update | Pass (runs 3 and 4; runs 1 and 2 passed it before failing on spec checks). Every change reached the reader as a delta or snapshot, including the task report folding onto its launching row and Claude's answer to it. The background task went from running to `completed` in session state, and the answer row arrived 50 to 56 s after the switch for the Bash case. |
| No needless re-read | Pass. Once settled, ten reads in a row answered `unchanged` for transcript and state in every case and run. Overall the inactive-tab case took 1 snapshot, 4 or 5 deltas and 31 or 32 `unchanged` answers over about 72 s. A final read of the settled session with its token answered `unchanged`. |
| The off-screen view does not poll | Pass. From 2 s after the tab switch or environment switch, the page sent nothing for the session (the empty `inactive-*-inactive-timeline` annotations). |
| State on return, tab switch | Pass. The kept view sent its old token, got one transcript snapshot (the content had moved), showed the newest row within 120 to 220 ms, and then sent only conditional reads answered `unchanged`, about every 1.5 s. |
| State on return, environment switch | Pass. The remounted view restored its transcript token, so its first transcript read was conditional (a snapshot, because the content had moved) and the rest `unchanged`. The newest row showed within 300 to 355 ms. |
| Reload | Pass. The cold client read once without a token per mount, showed the newest row within about 1.9 s, and then settled to `unchanged`. All four markers were in the backend rows in order. |

Bridge unit coverage: the mutation matrix in
`bridges/claude-bridge/src/services/session-manager-transcript-revision.test.ts`
gained two rows, a task report settling its launching row and a report with
no row to attach to. Both pass, and the suite records no marker repair.

Findings that are not defects:

- A dev profile renders under `React.StrictMode`
  (`apps/web/src/renderer-entry.tsx`), so a remount mounts the view twice and
  every read is doubled for about 300 ms. A production build mounts once.
- A remount re-reads session state without a token on purpose: the shared
  cache carries tokens but not the state value, and `useNativeAgentSession`
  does not let a mount claim state it never read. Transcript tokens are kept.
- Haiku once ran the requested foreground `sleep 8` in the background, saying
  the harness had blocked it. The spec now uses a foreground `echo`.

Spec fixes made during the runs: run 1 asserted that idle reads after an
environment switch kept their state token (see the remount note above). Run 2
looked for an older row on screen after the reload, but the list is
virtualized and the row had scrolled out of the DOM. Neither was a product
defect.

Not run here: a production build (no StrictMode double mount), an Electron
window, a container environment, and Codex, whose background terminals
change an idle view in the same way. The profile was stopped and reset
afterwards.

## Qualification results (2026-10-18)

Live history paging past the 100-message window and a live Multi Review, run
on `a5d338c1` plus this change on a loaded macOS arm64 host. Profile
`qa-paging-c2fa` (`dev:test --fixture --credential-source claude
--credential-source codex --agent-platforms claude,codex`), with toolchains
seeded from the host: Claude 2.1.296 and Codex 0.162.1. Models: Claude Haiku
(`claude-haiku-5-5`) and Codex GPT-6-Luna (low). The spec is
`e2e/agent-testing/transcript-paging-live.spec.ts`; how to run it is in
[agent-testing.md](../../development/agent-testing.md#live-transcript-paging).
Content-free measurements are the Playwright annotations in
`output/agent-testing/qa-paging-c2fa*/browser/results.json`.

To push a transcript past the window, each case lays a trail of files whose
names chain to each other, so the agent must read them one per step. The stop
each tool call read places every row, so the checks need no model prose.

| Scenario | Result |
| --- | --- |
| Native Claude, 150 stops: backend window and paging | Pass (4 runs). 152 rows; the live window held 100 and reported `truncated`, `omittedMessages: 52` and `canLoadEarlier`. Following the cursor in 40-message pages took 2 chained pages (12 + 40) to the first prompt, with `complete: true`, one `historyEpoch`, no duplicate row ids and all 150 stops in order. |
| Native Claude: browser **Load earlier messages** | Live tab: the rows that aged out of the window were already retained, so the click had nothing new to fetch and retired. After a reload it loaded stops 1 to 51 and the oldest row was the prompt, but the reader's row was pushed down 761 px (rows were short enough to keep it on screen) and later, with the first fix, the list jumped to the bottom. Both fixed below. The run with all fixes could not complete: from about 17:30 every Claude turn ended in a 429 rate-limit error (8 attempts to 19:38). |
| Native Codex, 150 stops (`ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_PLATFORM=codex`) | Pass with the fixes. 152 rows, pages 12 + 40, all stops in order. After a reload the click kept the reader's row on screen: it moved from index 0 to 103 and the list scrolled to 17,169 px instead of staying at the top. A loaded tool row expanded to its deferred output. |
| Multi Review, end to end after the fixes (`ORKESTRATOR_AGENT_TEST_PAGING_FIRST_REVIEWER=codex`: two Codex reviewers, medium and low, while Claude was rate-limited) | Pass (9.2 min). Settled `ready` with no stall. The long reviewer had 138 rows: a 100-row tail and one 38-row page to its prompt, all 130 stops in order. In the reviewer tab, Load earlier messages moved the reader's row from index 0 to 74 and kept it on screen; the oldest row was the prompt and a loaded tool row expanded. |
| Multi Review progress probes | Pass. No reviewer was ever reported stalled. Probes run once per 60 s interval (`DEFAULT_PROGRESS_PROBE_INTERVAL_MS`): a Codex reviewer running 219 to 221 s showed 3 or 4 distinct progress clocks; a Claude reviewer running 48 to 100 s showed 1 or 2 (a baseline, then one move); a Codex reviewer running 247 s showed 5. |
| Multi Review reviewer window, pages and conditional read | Pass (Codex reviewer). 139 rows: a 100-row summary tail (`truncated`, no fallback), a repeated read with its source token answered `unchanged` with no messages, and one cursor page of 39 rows reached the prompt (`complete`, same epoch) with all 130 stops in order. |
| Multi Review reviewer tab **Load earlier messages** | Pass. The reader's row went from index 5 to index 81 and stayed on screen, the oldest row after loading is the prompt, and a tool row from the loaded page expanded to its output. The run then failed on a spec selector for returning to the Multi Review tab (fixed; it is needed only when two reviewers are long). |
| Multi Review detail expansion through the API | Not exercised. Every Codex tool body fitted the 4 KiB inline summary limit, so the paged history carried no `detailRef`; expansion was checked in the browser instead. |

Fixed in this change:

- **The native tab lost the reader's place on Load earlier messages.** The
  list keeps its offset when rows are prepended, so a page pushed the reader's
  row down by the page's height. The tab now holds the place the reviewer tab
  already held. Both use `HeldTranscriptPlace`
  (`apps/web/src/hooks/useHeldTranscriptPlace.ts`).
- **Held places were lost when same-minute rows merged.** Display rows
  coalesce consecutive tool-only rows from the same minute
  (`coalesceAdjacentToolMessages`), and the block takes its first row's id. A
  page ending in the same minute as the tail's first row merged into it and
  renamed it, so an id-only anchor (the reviewer tab's, before) found nothing.
  A held place now also matches the block's last source row.
- **A jump to a row after a prepend could pin the reader to the tail.**
  Virtuoso caches row sizes by index, so the first jump after a prepend uses
  stale sizes and can clamp at the bottom; reaching the bottom re-engaged
  stick-to-bottom, and growth pinning held the list there. While an explicit
  `scrollToIndex` and its corrections run, reaching the bottom no longer
  re-engages stick (`useVirtuosoScrollState.ts`).

Findings that are not defects:

- A Claude reviewer runs under `READ_ONLY_TURN_POLICY` with
  `projectResources: false`, so it never loads `CLAUDE.md`. With the trail
  protocol in an `AGENTS.md` that was part of the change, Haiku still reviewed
  without walking it (0 stops in 3 runs). The long reviewer is the Codex one.
- Codex infers its row boundary. Without a message between steps, GPT-6-Luna
  made 130 sequential reads in 16 rows (low effort) and 23 rows (medium);
  logged as Code item 4.

Validation: `mise run check` passed; the new `useHeldTranscriptPlace` tests,
the `useVirtuosoScrollState` guard test, and the native and reviewer tab
suites passed. Full `mise run test` before and after merging `origin/main`
failed only on flakes whose owning files pass alone:
[0480](../../tests/flaky-tests/coordinator-and-multi-review/0480-coordinator-fetch-remotes-submodule-timeout.md)
(new), a [0180](../../tests/flaky-tests/environments-and-containers/0180-worktree-tracked-edit-cache-hit.md)
recurrence and [0481](../../tests/flaky-tests/backend-services-and-tooling/0481-pty-resize-before-stty.md)
(new); web passed 7,963 with 0 failures.

Not run here: the Multi Review case with a Claude reviewer completing after
the fixes (the host's Claude account was rate-limited, 429, from about 17:30;
the earlier Claude-and-Codex runs settled `ready` and passed every reviewer
check except the reviewer-tab selector), a real-browser check of the Claude
native case after the last fix (logged below), and other providers. The profile was stopped and
reset afterwards.

## Assumptions and decisions

Made on 2026-10-24 while closing the code items. Each lists the options
considered, the choice, and why.

1. **Claude cold hydration (item 1).**
   - Options: (a) pass `limit`/`offset` to `getSessionMessages`; (b) write a
     bridge-side JSONL tail reader; (c) accept full hydration.
   - Chosen: (c).
   - Why: the SDK parses the whole file and rebuilds the chain before it
     slices, so (a) saves nothing and still needs a full count for a tail.
     (b) would have to copy the SDK's chain, compaction and delivery rules,
     and normalization needs a chronological pass anyway.
   - Pros: one source of chain semantics; single-flight already bounds
     concurrency; the SDK skips pre-compaction bytes past 5 MiB.
   - Cons: the first history access after a cold start still parses the
     whole post-compaction session.
2. **Codex row boundary (item 4).**
   - Options: (a) `rawResponse/completed`, which names the response; (b) the
     per-response `thread/tokenUsage/updated`; (c) cap the calls a row may
     hold; (d) timing gaps.
   - Chosen: (b), counted, with no cap.
   - Why: (a) needs `experimentalApi: true`, which the bridge declines on
     purpose. (b) is on the stable surface, was observed once per response
     on the pinned 0.164.0, and the rollout records it at the matching place,
     so live and reload agree. A cap would split real responses at arbitrary
     places and diverge between live (items) and reload (call records) for
     code mode. Timing is not evidence.
   - Pros: real boundaries; bounded rows; no protocol opt-in.
   - Cons: a code-mode cell making several calls can split once inside
     itself; a provider that reports no usage falls back to the old
     inference; a parallel call starting after its own response's report can
     land in the next row.
3. **Replayed row ids (item 5).**
   - Options: (a) deterministic replay ids; (b) also derive live ids so the
     first replay matches; (c) only qualify a mounted tab.
   - Chosen: (a), with (c) left as qualification.
   - Why: live rows are minted at dispatch, before app-server names the
     turn, and a recovered turn's rows interleave with replayed ones, so
     deriving live ids risks collisions with no reliable ordinal. (a) alone
     removes the re-key on every idle re-attach and on every restart after
     the first.
   - Pros: no id collisions (thread-scoped hash of turn, kind and ordinal);
     no wire change.
   - Cons: the first replay after live streaming still re-keys every row.
4. **Parent death (item 6).**
   - Options for detection: keep 15 s; 5 s like Cursor and Pi; 1 s; a pipe
     the bridge reads to EOF.
   - Options for the turn: drain only (app-server's SIGTERM); interrupt
     first.
   - Chosen: a shared 1 s `PARENT_WATCH_INTERVAL_MS` for every bridge, and
     for Codex a 2 s-bounded interrupt that settles as a restart mid-turn.
   - Why: the next backend reaps orphans 5 to 7 s after it starts, so
     detection must be well inside that. A signal-0 probe per second is
     negligible. A pipe would change how the backend spawns detached bridges.
     Settling as a restart, not a cancel, keeps the build pipeline's
     continue-once behaviour (verified live).
   - Pros: 0.3 to 0.8 s to stop instead of 7.7 to 9.2 s; one constant for
     every bridge.
   - Cons: about 1 wake-up per second per bridge; the interrupt adds up to
     2 s if app-server hangs; the measured gain comes mostly from the poll,
     not the interrupt.
5. **Older-bridge fallbacks (item 3).**
   - Options: keep; cache joined pages; remove.
   - Chosen: keep both, uncached, until 0034's support window.
   - Why: only skewed installs reach them, and 0034 owns retirement and the
     use counters.
   - Pros: no new cache; no broken skew.
   - Cons: two compatibility paths stay; an older bridge still pays whole
     reads.
6. **Progressive metrics (item 2).**
   - Options: one shared 256-sample ring; a ring per domain. For discovery:
     time the view read, the provider jobs, or both.
   - Chosen: a ring per domain, and both discovery samples (tier `memory`
     for the view read, `provider` for each settled job).
   - Why: idle views poll state and discovery far more often than
     transcripts change, and the jobs run behind the view read, so neither
     sample alone shows where the time goes.
   - Pros: transcript samples survive polling; phases sum within the
     duration.
   - Cons: up to 768 samples kept instead of 256; `list()` without a domain
     is no longer chronological across domains.
7. **Harness resources.**
   - Options: `perf_hooks.monitorEventLoopDelay`; a timer-lateness sampler.
   - Chosen: the timer sampler (5 ms), with forced collections around each
     repetition.
   - Why: Bun 1.4.3's histogram reported about 1 ms for a 50 ms block.
   - Pros: sees blocking calls of a few ms.
   - Cons: heap figures refresh only at a collection, so peaks undercount;
     the figures describe the harness process, not production.
8. **Items 8 and 9.**
   - Options: design now; keep deferred; close on the measurement.
   - Chosen: close both on the measurement.
   - Why: about 0.5 ms of CPU per changed read on a loopback hop, and a
     0.44 ms changed read including the walk, do not justify a second
     incremental protocol or per-message revisions from five bridges.
   - Pros: no speculative protocol work.
   - Cons: a remote-bridge deployment would need the question reopened
     (pointer left to 0052).
9. **Browser gate method (item 7).**
   - Options: a new fixture mounting `useNativeAgentSession` against a fake
     gateway; extend the existing rich-transcript perf gate.
   - Chosen: extend the gate with `--retained-mib`. It pads the same 3,000
     messages to about 8 MiB, so the history stays under the 4,096-message
     client cap, and it adds a covered/shown phase.
   - Why: it reuses a calibrated real-Chrome harness whose streaming tail
     re-derives display rows over the whole array on every update, the cost
     item 7 is about.
   - Pros: same metrics as the shipped gate; comparable with its baseline.
   - Cons: it does not run the hook's own retained-page join or the store's
     subscriptions, and headless Chrome cannot hide the page.
10. **Live evidence scripts.** `scripts/codex-parent-exit-live.ts` and
    `scripts/activity-sweep-live.ts` are committed so the runs can be
    repeated. The Grok probe stayed out of the tree, because the ACP routes it
    exercised already have unit coverage. The paging spec gained
    `ORKESTRATOR_AGENT_TEST_PAGING_CODEX_NOTES=0` for a tool-only Codex run.
11. **Assumptions.**
    - The pinned SDK and Codex versions (0.3.309, 0.164.0) are what ship, so
      evidence against their code and binaries stands for the release.
    - The 5 to 7 s orphan-reap delay measured on 2026-10-21 still holds.
    - A busy shared host gives upper-bound timings; deterministic counters
      are unaffected.
    - Code mode is the default Codex tool surface (every probe call was a
      code-mode `exec`).

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
  persist boundaries, so a stage reads the provider's whole transcript only
  there, and only when a progress probe moved since that copy. The probe
  always precedes the read, and its baseline is trusted only while the
  committed copy is the read it gated, so a failed or deferred checkpoint is
  read again. A failed probe teaches nothing: the whole read decides, and an
  unchanged probe never clears a stall warning. The handoff window
  (`transcriptCheckpoints.window`) and `recoverStructuredRequestId` read the
  newest observed copy, so the pass that sees a turn end reads the whole
  transcript whatever the probe says.
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
  - Pipeline reads fall back to the whole body at each boundary for a provider
    without the bounded snapshot surface and after a failed probe. A bridge
    that predates `/transcript` answers the probe itself from `/messages`, so
    a moved transcript costs it two whole reads at a boundary.
  - `/messages?limit=` is advisory: a bridge that predates it answers its
    whole window, and the backend keeps its own slice.

## Open questions

- Answered (2026-10-24): do items 7, 8 and 9 justify their complexity once
  profiling exists? None of them do: items 8 and 9 on the backend
  measurements, item 7 on the 8 MiB browser gate for a visible document. A
  hidden document is still unmeasured (Qualification).

## Needs verification

All three checked on 2026-10-24.

- **Why a re-activated Claude view takes several state and discovery
  snapshots before `unchanged`. Verified: values filling in, not a dropped
  token.** A section past its 30 s lifetime reads `stale`. A provider runs at
  most two section jobs at a time, and the commands job takes one slot. So a
  view back from 60 s away reads `[ready, stale, stale]` (commands follow
  their catalogue state), then `[ready, ready, stale]`, then all `ready`,
  then `unchanged`. That is three snapshots, each with a changed value, and
  the reader's token is honoured as soon as nothing changed. Pinned by
  `discovery on return to an idle view` in
  `native-agent-progressive-metrics.test.ts`. The state snapshots are the
  already documented cases: content that moved while away (tab switch), and
  on an environment switch the remount's deliberate token-less state read
  plus the dev profile's StrictMode double mount.
- **Grok's ACP `session/new` "Invalid params". Verified fixed:** it succeeded
  in every 2026-10-24 run on Grok 1.0.67.
- **Whether the SDK's `limit`/`offset` avoids a full JSONL parse. Verified: it
  does not** (SDK 0.3.309 source; Code item 1). Context7 was not
  authenticated on this node, so the check is against the shipped
  `sdk.mjs`/`sdk.d.ts`, which is the code that runs.

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): remote bytes,
  encoded patch bytes and multi-client runs.
- [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md): reviewer
  transcripts, progress probes and the multi-review benchmark.
- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md): the
  read side of idle native sessions.
- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md): the
  container file-tree watcher deferred from the file-tree cache work.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md): retiring
  the sync-v1 fallback.
- `../architecture/storage.md` (display tails, pipeline transcripts),
  `../architecture/agent-engines.md` (OpenCode history paging), `AGENTS.md`
  (v2 route, batch activity and Cursor bound invariants).
- [native-transcripts.md](../../architecture/native-transcripts.md): the
  living guide to the native transcript pipeline, written on 2026-10-24 to
  fix the drift this file used to list (the v2 envelope, detail locators,
  page cursors, patch negotiation, progress digests, display-tail checkpoints
  and the pipeline transcript store had lived only in code docblocks).

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
- `docs/improvements/efficiency/baseline/README.md` (usage, method and
  limitations moved to `../development/efficiency-harness.md`; its "Not
  measured here" gaps are in the measurement and qualification items above)
- `docs/improvements/efficiency/baseline/final-summary.json` (historical #875
  comparison)
- `docs/improvements/efficiency/baseline/step-01-summary.json` (superseded by
  `final-summary.json`)
