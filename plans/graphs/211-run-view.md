---
id: 211
title: "Run view"
phase: 2
plan: "P2.11"
status: in-progress
depends_on: [201, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 211 · Run view

- **Plan:** [P2.11 Run view](../composable-graphs.md#p211-run-view)
- **Decisions:** D16, D17
- **Depends on:** [201](201-run-record-and-storage.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users watch and control a run in the same visual language as Multi Review and the Build Pipeline.

## Work

- [x] Tab type `graph-run` in `apps/web/src/contexts/TerminalContext.tsx`.
- [x] `graphRunFlowModel(plan, run)` over `apps/web/src/components/flow-graph/`: replicated activations share a column, loops unroll to the right, superseded activations collapse into "Previous attempt" nodes, nodes not yet reached are faded.
- [x] Inspector: transcript (`PipelineSessionTranscript`), input and output artifacts rendered by type, profile and enforced tier, guard results.
- [x] Actions: retry, restart from here, rewind code to here, skip, open session, approve/edit/choose, pause, resume, cancel.
  - [x] Retry, skip, open session, pause, resume and cancel (backend commands in this item).
  - [x] Restart from here and rewind code to here: UI and preview dialog built against `GraphRunRewindBackend`; connected to item 210's wrappers by item 208 (see Notes).
  - [x] Approve, edit and choose: the human node slot `GraphHumanNodePanel`, filled by item 208.
- [x] Rehydrate from snapshots only.
- [x] Backend read side: `graph_runs_list`, `graph_run_get` (revisioned, `knownRevision`), `graph_run_cancel|pause|resume|retry|skip`, bounded `graph_run_artifact` and `graph_run_transcript`.
- [x] Transcript capture: the agent executor's `captureTranscript` is wired to the content-addressed transcript store.

## Tests

- [x] Projection unit tests.
- [x] Component tests for faces, inspector and actions.
- [x] Agent-testing run of the inactive-environment path: start, switch away, finish, return.

## Done when

- [x] Runs are observable and controllable from the run view.

## Notes

- 2026-10-29 · Shapes: `@orkestrator/protocol/graphs/run-view` (new export): `GraphRunSummary`, `graphRunSummary`, `GraphRunGetResult` (`changed`/`unchanged`), `graphRunViewSnapshot` (drops `repairPrompt`/`continuationPrompt`), `GraphRunArtifactView` (value inline up to `GRAPH_RUN_VIEW_BOUNDS.maxArtifactViewBytes` = 512 KiB, else `valueOmitted: "too-large"`; reference artifacts give file metadata and descriptor only), `GraphRunTranscriptView`, `graphRunActions`, `graphActivationRetryRefusal`, `graphActivationSkipRefusal`, `compareGraphRunsNewestFirst`. Command table in `docs/architecture/graphs.md` ("The run view"). Errors: `GraphRunServiceError` codes `invalid-request` (new), `not-found`, `invalid-state`, `disabled`.
- 2026-10-29 · Retry (decided here; report §8.4 "retry one branch"): a `failed` position that is the newest attempt of its slot, in a `running`/`waiting`/`paused` run. `GraphRunService.retry` records a user `restart` rewind over `graphLineageDescendants` plus never-started skipped/failed/cancelled markers of plan-downstream nodes created at or after the failure (`graph-run-user-actions.ts`, `planGraphRunRetry`), saved with the artifact supersede in one transaction. A failed run is restarted instead (item 210). Consumers that already ran without the failed branch's output are not rerun; restart the consumer for that.
- 2026-10-29 · Skip (decided here): only `waiting`/`ready` positions (held back by a pause, a workspace lock or the run's limits) settle `skipped`, so required consumers skip too. Skipping an admitted (running) activation would need a durable skip request handled by the pass's cancel path; not built.
- 2026-10-29 · Transcripts: `graph-run-transcripts.ts` `createGraphRunTranscriptCapture` stores provider messages in the build-pipeline transcript store under owner `graph-run:<runId>`, session = activation key; captures on settle and at most every 15 s while running (the host now calls the capture on every observation with `settling`); the manifest commits in its own transaction before the run record names it. The orphan sweep treats existing graph runs as live owners; `deleteGraphRunsByEnvironment` deletes their transcripts. Storage: `commitGraphRunTranscript`, `describeGraphRunTranscript`, `readGraphRunTranscript`.
- 2026-10-29 · Deviation: the inspector does not mount `PipelineSessionTranscript` itself (it takes a `BuildPipeline` and its store); `GraphActivationTranscript` uses the same stack (`toPipelineTranscript`, `VirtualizedMessageList`, `NativeMessage`, `useWorkflowTranscriptArtifacts`) fed from `graph_run_transcript`.
- 2026-10-29 · Web: `components/graph-run/` (`graph-run-flow.ts` projection, `GraphRunFlowGraph`, `GraphRunTab`, `GraphRunInspector`, `GraphArtifactView`, `GraphActivationTranscript`, `GraphQuestionAnswerForm` (reusable for 208), `GraphHumanNodePanel` (208's slot), `GraphRunCodeRewindDialog`, `GraphRunsList`, `graph-run-actions.ts`, `graph-run-open-tab.ts`), `stores/graphRunStore.ts`, `lib/backend/graph-runs.ts`. Tab data `TabInfo.graphRunData = {runId, title?}`; the designer lists runs under its library. An "open session" tab of a read-only turn opens in plan mode.
- 2026-10-29 · To connect after merge: (1) 210: point `graphRunRewindBackend` in `apps/web/src/lib/backend/graph-runs.ts` at `restartGraphRunActivation` / `previewGraphRunCodeRewind` / `rewindGraphRunCode` (`lib/backend/graph-run-rewind.ts`; `GraphRunRestartResult.run` is what the view applies), switch `GraphRunCodeRewindPreview` to 210's protocol type, and replace the restart/rewind availability in `graph-run-actions.ts` with `graphRunRestartBlocker` / `graphRunCodeRewindBlocker` (show the blocker as a disabled reason). The seam already calls 210's command names with a `requestId`, so it works before that rewiring. (2) 208: fill `GraphHumanNodePanel`. (3) 213/214: the agent-testing scenario below.
- 2026-10-29 · Agent testing: no launch path exists on this branch (no command creates a run until 214; mock runs are 213), so "start, switch away, finish, return" cannot run on a real stack yet. `e2e/agent-testing/graph-run-view.spec.ts` (browser suite) covers the read side on a real stack: empty runs list, `graph_runs_list`/`graph_run_get` through the gateway, switch away and back, reload. The inactive path is covered by component tests (`GraphRunTab.test.tsx` "Rehydration": unmount sends nothing, a run that finished meanwhile shows its final state on remount, change events re-read). Add the real-stack scenario to that spec once 213/214 land.

- 2026-10-29 · Item 208 connected (1) and (2): `graphRunRewindBackend` calls 210's wrappers with 210's `GraphRunCodeRewindPreview`; `graph-run-actions.ts` uses `graphRunRestartBlocker` (restart offered for a started, current attempt; a running activation restarts in place) and `graphRunCodeRewindBlocker` (Rewind code to here listed but disabled with the reason, via the new `GraphRunActionSpec.disabledReason`); `GraphHumanNodePanel` answers human nodes (see 208's Notes).

- 2026-10-29 · Agent testing, real stack: the launch → switch away → finish → return scenario 214 added to `graph-run-view.spec.ts` ("a graph launched from Run graph… finishes while its environment is away and rehydrates") passed again on profile `graphs-208-realstack` (3 passed, 1 opt-in skipped; `output/agent-testing/graphs-208-realstack/browser/results.json`), with the human-node scenario of item 208 (answer from the run view after returning, reloads). 214's first pass: profile `graphs-214-launch`, 2/2 (see 214's Notes).
- 2026-10-29 · Done when, evidence. Observe: projection and face tests (`graph-run-flow.test.ts`, `GraphRunTab.test.tsx` "faces", "inspector", "rehydration"), the read side and two launched runs on a real stack. Control, each action through the view: retry, pause, resume and cancel (`GraphRunTab.test.tsx` "retry, pause, resume and cancel go to the backend…"; Resume was only checked for presence before, it is now clicked and its snapshot applied), restart from here and rewind code to here with its preview ("restart and rewind code use the restart backend…"), skip and open session ("skip is offered for a queued position…"), approve, edit and choose (`GraphHumanNodePanel.test.tsx`), an agent's question ("answers an agent's question through graph_run_answer"); availability rules in `graph-run-actions.test.ts`; backend commands in `commands-registry-graph-runs.test.ts`, `commands-registry-graph-human.test.ts`, `graph-run-user-actions.test.ts`, `graph-run-rewind.test.ts`. On a real stack only approve was driven through the view (208's scenario); retry, restart, rewind, skip, pause, resume, cancel, edit and choose are proven at component and command level, not by a Playwright run (a credential-free template cannot fail an agent branch, and these need no live check beyond the gateway, which the approve path exercises).

**2026-10-29 · Audit: admission blocks in the run view.** A ready activation's
`blocked` reads through `graphActivationBlockText` (`run-view.ts`) in the flow
graph's status pill and the inspector's "Waiting" section, e.g. "Waiting:
Build Pipeline is writing this environment"; neither shows while the run is
paused. Tests: `run-view.test.ts`, `GraphRunTab.test.tsx`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Run view: commands, retry/skip, transcript capture, `graph-run` tab, projection, inspector, actions, tests, read-side browser spec. · Connect 210 rewind wrappers and 208 human slot after merge; real-stack inactive-path run after 213/214.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks, item 208) · 210 rewind wiring and 208 human slot connected; Actions ticked. · Real-stack inactive-path run after 213/214.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Real-stack inactive path rerun with 208's human scenario; Resume now clicked in the tab test; Done when ticked with evidence. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · run view shows admission blocks · awaiting PR
