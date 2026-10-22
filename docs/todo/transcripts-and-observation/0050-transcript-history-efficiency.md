# Transcript and history efficiency

Checked against `main` at `2459b05c` (2026-10-15).

Agent transcripts are the largest repeated data flow in the app. Providers
produce them, bridges summarise them, the backend projects them, clients retain
them, and workflows read them to detect progress. The goal is that an unchanged
read does metadata work only, a changed read costs what changed, and history
and large artifacts are fetched separately from the live window, without making
background work depend on a mounted view. Most of this shipped in #875, and
build-pipeline supervision no longer reads whole transcripts on every pass.
What remains is a Claude cold-hydration path that is not range-bounded,
measurement gaps, frontend structure work gated on profiling, and real-stack
qualification that was never run.

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
- Measurement. `scripts/efficiency/` runs workloads `a` to `j` through
  `mise run efficiency:baseline` (usage and method:
  [efficiency-harness.md](../../development/efficiency-harness.md)).
  `ProgressiveReadPhaseTimer` (`native-agent-progressive-metrics.ts`) splits
  transcript and direct-page reads into source, normalise and scheduler-wait
  phases.

## Outstanding work

### Code

1. Range-bound Claude cold hydration, or record that it cannot be done.
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
2. Close the measurement gaps.
   - Record phase timing for state and discovery reads. Today only transcript
     and direct-page reads report `sourceMs` and `normalizeMs`.
   - Add harness workloads for the batched activity sweep, the file-tree cache,
     reviewer and progress probes, and pipeline checkpoints. Their counts
     currently come only from the owning test suites.
   - Add heap/RSS and event-loop-lag reporting; the harness reports counts and
     retained-byte estimates only.
3. Decide what happens to the joined sync-v1 history fallback. All bundled
   bridges serve v2 pages and OpenCode pages in-process, so the joined path now
   serves only an older bridge behind a newer backend. Keep it, cache its
   pages, or remove it after the support window (see
   [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)). Decide
   the older-bridge fallback in `readHttpBridgeTranscriptSnapshot`
   (`apps/backend/src/core/http-bridge-progressive.ts`) at the same time: a
   bridge that predates `/transcript` is read through its whole `/messages`
   body and trimmed afterwards.
4. Give Codex a per-response row boundary. The bridge infers a model response
   from a reasoning or agent-message item after a tool call
   (`TurnAccumulator.opensModelStep`), so responses that are only a tool call
   share one row. In the 2026-10-18 live run a GPT-6-Luna (low) reviewer made
   130 sequential reads in 16 rows, and 23 at medium effort; only an explicit
   one-sentence note per step gave it 139 rows. A long tool-only run therefore
   grows rows that the window and paging cannot split, against the row
   invariant in `AGENTS.md`. Find a boundary app-server reports (a response or
   step identity on items), or bound the calls one row may hold, and keep the
   rollout reload splitting at the same place.
5. Give Codex replayed rows stable ids, or prove nothing depends on them.
   Every rollout replay mints new row ids (`createMessageId()` in
   `bridges/codex-bridge/src/history/rollout.ts`), and the bridge persists no
   messages, so every row changes id whenever the bridge process restarts. In
   the 2026-10-21 cold-restart runs all 8 rows of an idle conversation and all
   25 to 30 rows of a crashed one came back under new ids; Claude's cold
   hydration also re-keyed 8 of 8 and 17 of 26. A fresh client is safe: it
   paints the cached tail and replaces it with the provider's snapshot, and no
   row showed twice. A client that stays mounted across a bridge-only restart
   (an environment or bridge restart while the backend lives) still holds
   retained history and held places keyed by the old ids. Derive replayed ids
   from rollout identity (turn id plus item or response position, as the live
   stream would assign them), or qualify that a mounted tab with retained
   history shows no duplicates and keeps its place across a bridge-only
   restart.
6. Stop a Codex turn promptly when its backend dies. In every 2026-10-21
   crash run the Codex turn read two to five more stops after the backend was
   `SIGKILL`ed, and in the run whose log was kept the bridge was still alive
   when the next backend started (5 to 7 s later) and was killed by the orphan
   reaper (`apps/backend/src/core/local-server-reaper.ts`). The parent
   watchdog (`startParentWatchdog` in `bridges/codex-bridge/src/index.ts`)
   should end the bridge and its app-server child well before that. If the app is not reopened, a turn keeps
   running unsupervised. Measure the watchdog's detection and shutdown time
   and make the bridge interrupt the turn as soon as its parent is gone.

### Deferred until measured

7. Frontend retained-history structure, only if browser profiling at an 8 MiB
   retained history shows material long tasks or input latency:
   - keep retained pages as immutable entries separate from the live window,
     and assemble display arrays only when membership, order or an entry
     changes;
   - split state-domain from content-domain subscriptions in
     `nativeAgentProjectionStore.ts` and `useNativeAgentSession.ts`;
   - derive search and annotation indexes by revision.
   Add no worker until repeated work is gone and transfer cost is measured.
8. Bridge-to-backend part deltas. Bridges still send whole lightweight summary
   snapshots on change; patches cover only the backend-to-client hop. Measure
   that hop's bytes and CPU before designing an incremental bridge protocol.
9. Per-message provider revisions. `native-agent-projection-entries.ts` still
   walks each provider row once per changed read to compare it with its kept
   copy (read-only, no encoding). Removing the walk needs a trustworthy
   per-message revision from every bridge.

### Qualification

Run each in an isolated profile per `../development/agent-testing.md`. For
credentials and platforms CI lacks, batch with
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- A live Grok/ACP session through v2 summary, detail and page.
- Re-run the Claude native case of `transcript-paging-live.spec.ts` with the
  held-place fixes. Claude's tool-only rows coalesce into tall per-minute
  blocks, the case that first lost the place and then pinned the list to the
  tail; the fixes were proved live on Codex and in unit tests, but every Claude
  attempt after them hit the account's 429 rate limit.
- A Cursor run long enough to reach the producer trim thresholds while its
  environment is inactive; return and check the bounded window, sub-agent
  lifecycle and controls.
- Hit the pre-acceptance build-pipeline dispatch window live. In the
  2026-10-21 cold-restart runs the backend was killed while the prompt was
  journaled (`pendingPromptAttempt`), but each time the provider already
  showed the build session running, so the retry under the same request id
  before acceptance was proved only by unit tests. A fault hook that holds the
  bridge's prompt route would make the window deterministic.
- Electron window and Docker environments with real providers; native iOS
  only where the wrapper changes.
- Browser long-task, input-latency and heap/RSS profiling at an 8 MiB
  retained history, including hidden and resumed documents. This is the gate
  for item 7.
- Activity-sweep p50/p95 for 1, 10 and 100 sessions against real bridges.
- Re-measure display-tail cost and the maximum checkpoint age with workload
  `d` now that tails are SQLite rows.

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

- Do items 7, 8 and 9 justify their complexity once profiling exists?

## Needs verification

- Why a re-activated Claude view takes two or three session-state and
  discovery snapshots before it settles to `unchanged`. In the 2026-10-21
  run a tab switch took one state snapshot and three discovery snapshots in
  about 150 ms, and an environment switch took two state snapshots and three
  discovery snapshots per mounted view. Transcript reads were unaffected.
  Find out whether the discovery value is still filling in (a catalogue
  arriving after adopt) or whether a token is being dropped, and stop the
  repeats if it is the latter.

- Whether Grok's ACP `session/new` "Invalid params" rejection, seen in the
  September live run, is fixed. #874 (MCP headers in ACP `{name,value}` form)
  merged the same day and may cover it.
- Whether the SDK's `limit`/`offset` avoids a full JSONL parse. Check current
  docs through Context7 and the SDK source before item 1.

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
- `docs/improvements/efficiency/baseline/README.md` (usage, method and
  limitations moved to `../development/efficiency-harness.md`; its "Not
  measured here" gaps are in the measurement and qualification items above)
- `docs/improvements/efficiency/baseline/final-summary.json` (historical #875
  comparison)
- `docs/improvements/efficiency/baseline/step-01-summary.json` (superseded by
  `final-summary.json`)
