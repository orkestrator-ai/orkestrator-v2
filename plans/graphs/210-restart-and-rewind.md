---
id: 210
title: "Restart and rewind"
phase: 2
plan: "P2.10"
status: done
depends_on: [201, 203, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 210 · Restart and rewind

- **Plan:** [P2.10 Restart and rewind](../composable-graphs.md#p210-restart-and-rewind)
- **Decisions:** D8
- **Depends on:** [201](201-run-record-and-storage.md), [203](203-scheduling.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Restarting or rewinding a node reruns exactly what depended on it.

## Work

- [x] Restart a node: supersede its activation, every activation that transitively consumed its artifacts, and those artifacts; rerun it with the same inputs. Independent branches are kept.
- [x] Inside a loop, rewind the iteration counter.
- [x] Code rewind from the node's input `workspace@1` commit, reusing the preview, refusals, backup ref and reset in `build-pipeline-code-rewind.ts`.
- [x] A repeated request is a no-op; restarting a superseded node is refused.
- [x] Commands `graph_run_restart`, `graph_run_rewind_code_preview`, `graph_run_rewind_code` on `GraphRunService`, with web wrappers for the run view (211).

## Tests

- [x] Independent branches survive a restart.
- [x] Exactly the descendants are superseded.
- [x] Code rewind preview, refusals and backup ref.
- [x] Loop restart rewinds the iteration; repeated requests are no-ops; superseded and replaced activations are refused; the pipeline's code-rewind tests pass unchanged.

## Done when

- [x] Restart and code rewind work from any node.

## Notes

- 2026-10-29 · **Files.** Protocol `packages/protocol/src/graphs/run-rewind.ts` (export
  `@orkestrator/protocol/graphs/run-rewind`): `graphRestartScope`, `graphRunRestartBlocker`,
  `graphRunCodeRewindBlocker`, request/result/preview shapes. Backend
  `apps/backend/src/core/graph-run-rewind.ts` (`GraphRunRewinds`, `GraphRunRewindError`,
  `graphCodeRewindBackupRef`, `graphRunPendingCodeRewind`, `reopenGraphRunForRewind`),
  `workspace-code-rewind.ts` (Git side shared with the pipeline), commands in
  `commands-registry-graph-runs.ts` (`registerGraphRunRewindCommands`), web wrappers
  `apps/web/src/lib/backend/graph-run-rewind.ts`. Tests: `run-rewind.test.ts`,
  `graph-run-rewind.test.ts`, `graph-run-rewind.test.ts` (web).
- 2026-10-29 · **What a restart supersedes (deviation from "lineage only").** Artifact lineage
  alone is not enough: a gate or human node forwards artifacts its upstream produced, a
  skipped or pre-start failed activation records no inputs, and a loop's later iterations
  must go when its counter rewinds. `graphRestartScope` therefore supersedes, to a fixpoint:
  (1) the lineage (what the restarted activation produced, what consumed it, what derives from
  it, and the producer of any derived artifact, e.g. an edge delivery); (2) every live
  activation that reads a superseded activation's node over an edge or carry at a matching
  position (same loop → same iteration, carry → next; `zip` → same branch; otherwise any),
  whether or not it consumed an artifact; (3) every member activation of a loop at an
  iteration after the earliest superseded one. Loop counters move back to that earliest
  iteration (`scope.loopIterations`; `applyGraphRewind` moves the node's own loop).
  Forwarded artifacts stay live with their producers.
- 2026-10-29 · **201 helper fixed.** `graphLineageDescendants` seeded the root's recorded
  outputs even when another activation produced them, so restarting a gate superseded its
  upstream producers. It now seeds only what the root produced; its doc points to
  `graphRestartScope` for the full rule. Existing tests unchanged.
- 2026-10-29 · **Semantics (consistent with the pipeline's `restartStep`/`rewindCode`).**
  Running/waiting/paused runs restart and run (`paused → running`: a restart is an explicit
  instruction to keep going, as the pipeline revives a paused one); complete/failed/cancelled
  runs reopen to `running` (`finishedAt`, `error`, `errorCause`, `cancelRequestedAt` cleared;
  the only move out of a terminal status, `reopenGraphRunForRewind`); `provisioning` and
  `cancelling` refuse. Restarting an attempt a later attempt replaced is refused. Both refuse
  once an `open-pull-request` node produced a PR and the environment's PR is merged, and at the
  51st rewind (`limit`). Admitted activations in the scope are stopped first through their
  executor's `cancel` with the new reason `restarted` (3 calls, 250 ms apart, then settled
  `cancelled` regardless, as the pass does), all in one CAS save with the artifact marks.
- 2026-10-29 · **Idempotency.** `requestId` is the rewind's id: repeating it returns
  `{repeated: true}` and changes nothing; reusing it for another activation/kind is
  `invalid-request`. Without an id, a request naming the activation the newest rewind of the
  same kind superseded (a code rewind: with the same `from` HEAD) is the same request.
- 2026-10-29 · **Code rewind.** Target = the commit of the node's input `workspace@1` (or
  `list<workspace@1>`) artifacts; none, unreadable or several different commits refuse. Extra
  refusals beyond the pipeline's: mock run; any admitted activation (graph `pause` lets
  admitted work settle, so "pause first" plus "no running node" is the pipeline's rule); a
  commit of a node outside the restart (a live `workspace@1` artifact not superseded) that
  HEAD contains and the target does not would be dropped. The reservation is the pipeline's
  (`withWorkspaceCodeRewindReservation`: exclusive environment fence, bound worktree path,
  `assertNoOtherWorkflowWriting` over pipelines and graph runs, native agents quiescent).
  `GraphRewind.code {headRef, from, backupRef, upstream, upstreamCommitsDropped}` is saved
  with `pending: true` before `git reset --hard` (backup ref
  `refs/orkestrator/graph-run-rewinds/<run>/<rewind>`), then `pending` is cleared. A crash in
  between is finished by the pass's new `prepare` hook (`GraphRunPassDependencies.prepare`)
  before a running run plans again (skipped and retried in 30 s while it cannot), and by any
  later restart/rewind command. `GraphRewindCode.pending?: true` was added to the protocol and
  its guard.
- 2026-10-29 · **Shared with the pipeline.** `inspectCodeRewind`, `resetWorktreeToCommit`,
  `EnvironmentGit`, `CodeRewindInspection` moved to `workspace-code-rewind.ts` and are
  re-exported from `build-pipeline-code-rewind.ts`; the pipeline's reservation now calls
  `withWorkspaceCodeRewindReservation` + `assertNoOtherWorkflowWriting` (which also refuses
  while a graph run on the environment has admitted work). Pipeline tests unchanged and green.
- 2026-10-29 · **For 211.** Actions: `restartGraphRunActivation({runId, activationKey,
  requestId?})`, `previewGraphRunCodeRewind({runId, activationKey})` (`blocked`, `head`,
  `targetCommit`, `commits`, `upstream`, `pullRequest`, `uncommittedPaths`, `supersedes {activations,
  artifacts, nodes}`), `rewindGraphRunCode({runId, activationKey, expectedHead: preview.head,
  requestId?})`; results `{run, rewind, repeated}`. Grey out with `graphRunRestartBlocker` /
  `graphRunCodeRewindBlocker`. A rewind's `superseded.activations` lists exactly what collapses into
  "Previous attempt"; `rewind.code` shows the backup ref; a pending code rewind is
  `graphRunPendingCodeRewind(run)`. Error codes forwarded by the gateway: `not-found`,
  `invalid-request`, `invalid-state`, `limit`, `unavailable`.
- 2026-10-29 · **For 214.** `GraphRunService.restart(runId, key, {requestId?, requestedBy})`,
  `previewCodeRewind`, `rewindCode(runId, key, expectedHead, …)`; pass `requestedBy:
  "coordinator"` from the control MCP. Code rewinds need `environmentGit` and
  `codeRewindReservation` on the service (wired in `index.ts`). The CLI/MCP could expose
  restart later; not in P2.14's list.
- 2026-10-29 · **Bounds.** Every rewind stores its superseded keys and ids; 50 rewinds with very
  large scopes could reach the 16 MiB record bound, which `saveGraphRun` refuses
  (`record-bytes`).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Restart scope, restart, code rewind (shared Git module, journaled reset, pass hook), commands and web wrappers, with tests (`run-rewind.test.ts`, `graph-run-rewind.test.ts`) that evidence the Phase 2 restart and code-rewind exit criteria. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
