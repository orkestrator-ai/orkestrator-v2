---
id: 208
title: "Human nodes"
phase: 2
plan: "P2.8"
status: done
depends_on: [203, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 208 · Human nodes

- **Plan:** [P2.8 Human nodes](../composable-graphs.md#p28-human-nodes)
- **Decisions:** D15
- **Depends on:** [203](203-scheduling.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

People take part in a run at explicit points, and a waiting run is visible wherever the user looks.

## Work

- [x] `approve`, `edit` (through the type's form, or as JSON) and `choose` (pick a gate branch).
- [x] A waiting human node shows in the sidebar activity, in the run view and as a coordinator notice, through the existing attention and status-wake paths.
- [x] Optional timeout routes to the `error` port; without one, the run waits, paused rather than failed.
- [x] The answer UI is shared with `ask_human` from [204](204-agent-node-executor.md).
- [x] Run view wiring to item 210 (from 211's Notes): `graphRunRewindBackend` calls 210's wrappers and preview type; restart and code-rewind availability come from `graphRunRestartBlocker` / `graphRunCodeRewindBlocker`.

## Tests

- [x] Inactive-environment path: start, switch away, answer later, return.
  - [x] Component and store level: `GraphHumanNodePanel.test.tsx` (unmount sends nothing, the wait rehydrates from the snapshot on return, the answer is sent, a change event shows it decided); backend: the wait is in the run record (`graph-node-human.test.ts`).
  - [x] Real stack (agent testing): `graph-run-view.spec.ts` "a human approval waits while its environment is away and is answered later", plus the opt-in profile-restart case; see Notes.
- [x] Restart while a human node is waiting.
- [x] The coordinator gets one notice per wait.
- [x] Edit validation, choose routing, and timeout to the `error` port.

## Done when

- [x] Human nodes work across tab switches and backend restarts.

## Notes

- 2026-10-29 · Shapes (`@orkestrator/protocol/graphs/run`, new `run-human.ts`): `NodeActivation.human?: GraphHumanWait {id (UUID), form, openedAt, answer?}`; `GraphHumanAnswer {decision: approve|reject|choose, outlet, edited?: {port, artifactId}, note?, at, by: user|coordinator}`; `GraphHumanAnswerInput {waitId, decision, outlet?, value?, note?}`; `graphHumanAnswerProblem`, `graphHumanAnswerOutlet`, `graphHumanForwardedOutputs`, `GRAPH_HUMAN_BOUNDS` (note 2,000 chars, edit 512 KiB / depth 32, 64 pending), `graphRunPendingInteractions(run)` → `GraphRunPendingInteraction[]` (`kind: "human"` with form, instructions, edit `{port, type, artifactId}`, options, timeoutAt; `kind: "question"` for `ask_human`), `graphPendingInteractionId`. The run validator checks `human`. `GraphActivationFacts.human` carries the wait in a report.
- 2026-10-29 · Executor `graph-node-human.ts` (`createGraphHumanExecutor`, registered under kind `human` in the live registry in `index.ts`; mock runs fall back to it): `start` records a fresh wait and reports `awaiting-human` with `observeAfterMs: null` (or the remaining time to `timeoutMs`); `observe`/`recover` complete an answered wait with its outlet, forwarding single-value inputs (the edited artifact in place of the original); `cancel` returns `cancelled`, except a timeout that finds an answer recorded before the deadline completes with it.
- 2026-10-29 · Answers: `GraphHumanAnswers.answer(location, input, by)` validates, stores an edited value with `GraphArtifactStore.putValue` (type of the original; validation context `choices` of the producing port; lineage `[original]`; producer = the human activation on the edited port; an unchanged value stores nothing), then records the answer through `GraphRunService.updateActivation` (re-validated under the lock; it calls `requestObservation`). Command: `graph_run_answer` with `waitId` → human form `{runId, activationKey, waitId, decision, outlet?, value?, note?}` → `{activationKey, human}`; refusals are `GraphAgentQuestionError` (`invalid-answer`, `not-found`), as for questions. New `graph_run_pending {runId | environmentId}` → pending interactions (rehydratable snapshot). `CommandContext.graphHumanAnswers`.
- 2026-10-29 · Deviation (needed for the plan's "timeout routes to the error port"): 101/107 gave human nodes no outputs, so `onFailure: route` on a human node was a compile error and nothing could read its `error`. Human nodes now have an implicit `error` port (`error@1`, `GRAPH_HUMAN_ERROR_PORT`, `graphNodeOutputSpecs`, `graphHumanRoutesFailures` in `template-model.ts`): `onFailure` defaults to `route` when `timeoutMs` is set (explicit `fail-run` opts out), the plan lists the port (`required: false`), edges read it as `{node, port: "error"}` without an outlet, and the designer draws it as an output handle. The timeout fails the activation with cause `timeout`, 206's route stores `error@1`, and the outlets' consumers are skipped. Plan digests of templates with a timed human node change (no example has one).
- 2026-10-29 · Sidebar (`graph-run-attention.ts`, `GraphRunAttention`, started in `index.ts` after graph runs init): new activity source `graph-run` (`AGENT_ACTIVITY_SOURCES`) set from `graphRunEnvironmentActivity` (working / waiting / idle); each new wait or question records one attention key `graph-run:<sha256(run, wait id)>` via `recordEnvironmentAgentAttention` (unread badge, reason `agent_question`, deduped durably). Driven by `graph-run` changes (500 ms debounce per run) and a reconcile at start. Hook for others: `GraphRunAttention.onWaitOpened(listener)` → `{runId, projectId, environmentId, interactions}` once per new wait.
- 2026-10-29 · Coordinator: I added the `graph-run` association kind minimally (`CoordinatorWorkflowAssociation.kind`, `AGENT_MAIL_NOTICE_RESOURCES` gains `graph-run`) and its status wake in `coordinator-status-wakes.ts` (`observeGraphRun`; local runs only, a node-held association is skipped), reduced by `graph-run-coordinator-status.ts`: `graphRunCoordinatorStatus(run)` (waiting key `waiting:<openedAt>:<wait id>` of the newest open wait; `complete`/`failed`/`cancelled` terminal) and `graphRunWaitNoticeIsNew` (a wait is news only when it opened after the last one reported), so one notice per wait and one at the end. Details are content-free (node names, forms). Item 214 only has to save the association at launch (`kind: "graph-run"`, `resourceId: run.id`) and expose `get_graph_run` (named in the notice); if 214 also adds the kind, keep one copy of each change.
- 2026-10-29 · UI: `GraphHumanNodePanel` renders 211's `GraphQuestionAnswerForm` (new props `allowDecline`, `requireChoice`, `submitLabel`, `textLabel`, `children`): Approve/Reject or the options as choices, an optional note, no decline; for `edit`, `GraphArtifactValueEditor` (the type's form for a flat object schema of strings, enums, numbers, booleans and string lists, optionally nullable, reusing the designer's `graph-form-controls`; else JSON) with live `validateGraphArtifactValue`. The designer's schema editor edits schemas, not values, so it is not reused. Wrappers `answerGraphRunHumanNode`, `listGraphRunPendingInteractions` (`lib/backend/graph-runs.ts`). Actions gain `disabledReason` (Rewind code to here stays listed, disabled with 210's reason, in a running run).
- 2026-10-29 · Agent testing: an isolated profile (`graphs-208-human`, `--fixture --no-agent-credentials --agent-platforms codex`) ran `graph-run-view.spec.ts` (now also checks `graph_run_pending` and a refused `graph_run_answer` through the gateway) and both designer specs: pass; profile stopped and reset. No command on this branch creates a run (launch is item 214; mock runs 213 are on graphs-integration, not here), so "start, switch away, answer later, return" on a real stack remains: add it to `graph-run-view.spec.ts` once a template of system/gate/human nodes can be launched (no provider credentials needed).
- 2026-10-29 · Edit of a list input or a file reference is not offered (approve or reject it as it is); the backend refuses it too.

- 2026-10-29 · Agent testing, real stack (launch path from 214). Profile `graphs-208-realstack` (`dev:test --fixture --no-agent-credentials --agent-platforms claude`), worktree `graphs-208-realstack` at `1be568164` plus this change. `e2e/agent-testing/graph-run-view.spec.ts` gains a credential-free template `qa-human-approve` (prepare-environment → human `approve` "First check" → human `approve` "Second check" → gate) and the scenario "a human approval waits while its environment is away and is answered later": launched from "Run graph…" on an existing environment, the user switches to another environment at once; the run reaches `waiting` with `graph_run_pending` listing only First check; the away environment's sidebar row shows the `waiting` marker and the unread attention bell; First check is answered through the command path (`graph_run_answer`, waitId form) while away, a repeat of that answer is refused; Second check then waits; back in the environment the run tab shows "Waiting for you" and the banner "Second check is waiting for you." with the waiting panel, the same after a reload; Second check is approved from the run view (Approve, note, Send), the run completes, the banner and pending list are empty, the sidebar marker leaves `waiting`; a reload shows Complete and both answers recorded (`approved`/`approve`). There is no CLI or public-action answer path (`orkestrator graph` has no answer command, and the Control MCP graph tools do not answer), so the away answer uses the app command through the gateway. Run: `mise run test:logged -- --name agent-graph-run-view -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-run-view.spec.ts` → 3 passed, 1 skipped (the opt-in restart case); results `output/agent-testing/graphs-208-realstack/browser/results.json`, screenshots `04-human-waiting-away.png`, `05-human-waiting-returned.png`, `06-human-answered-complete.png` under `output/agent-testing/graphs-208-realstack/browser/artifacts/` (not committed).
- 2026-10-29 · Backend restart on a real stack: the harness restarts a profile with state kept (`dev:stop`, then `dev-test.ts` with the stored credential and platform choice, as `cold-restart-live.spec.ts` does), so the spec has an opt-in case (`ORKESTRATOR_AGENT_TEST_GRAPH_RESTART=1`), "a human node waits across a profile restart and is answered afterwards": template `qa-human-restart` (one approval) launched through `graph_run_launch`, waits, the whole profile (backend included) is stopped and started, the same activation and wait id are still pending and the run still `waiting`, the sidebar shows it waiting, it is approved from the run view and completes. Run with `ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-208-realstack-restart ... -g "profile restart"` → 1 passed (13.5 s); screenshot `07-human-waiting-after-restart.png` and the restart launcher log under `output/agent-testing/graphs-208-realstack-restart/browser/artifacts/`. It leaves the profile on a detached launcher (stop it with `dev:stop`); after it the profile no longer reports `testProject`, so run it last or alone. Profile stopped and reset afterwards.

**2026-10-29 · Audit: content-free attention log.** `graph-run-attention.ts`
logged a failed sidebar update with the raw `error.message`. It now logs the
run id and `graphAttentionErrorReason(error)`: a short identifier-like `code`,
else the error's `name`, else "error" (invariant 9). Test:
`graph-run-attention.test.ts` ("graph run attention logs").

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Human executor, answers (`graph_run_answer` human form, `graph_run_pending`), implicit `error` port for timeouts, sidebar activity and attention, coordinator `graph-run` status wake, run view panel and edit form, 210 wiring, tests; real-stack read-side spec passes. · Real-stack inactive-path scenario once 213/214 provide a launch path.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Real-stack inactive-environment path (command answer while away, run-view answer after return, reloads) and opt-in profile-restart case in `graph-run-view.spec.ts`: pass. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · attention failures logged by code or name, never message · awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
