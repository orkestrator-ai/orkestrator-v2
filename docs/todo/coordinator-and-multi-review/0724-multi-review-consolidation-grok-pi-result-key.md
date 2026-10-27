# Multi Review consolidation on Grok or Pi cannot submit its result

Checked against `main` at `863b5782` (2026-10-27).

A Multi Review consolidation turn is read-only, and Grok and Pi let a
read-only turn call its own result tools only when the prompt names the
attempt with both `workflowResultTool` and `workflowResultKey`. The step
dispatch sends the tool name without the key, so the backend forwards
neither, the bridge's gate refuses `submit_consolidated_review`, the one
reminder is refused the same way, and the workflow fails with a missing
result. Anyone who picks Grok or Pi as the consolidation model is affected.
Found in the task analysis of
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md) (its
task 2).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the refusal with a failing test**: a backend test that a consolidation step's send carries no `workflowResultKey`, plus the bridge-side refusal already pinned. Status: open.
2. **Declare the attempt on consolidation**: send `workflowResultKey` with `workflowResultTool` on the step dispatch and its attach. Status: open (after 1).
3. **Build Pipeline consolidation on Grok and Pi**: check whether its plan-mode turn is gated the same way. Status: open.
4. **Live consolidation on Grok and Pi**: one packaged review per provider with that provider consolidating. Status: open (after 2; batched with 0031).

### 1. Pin the refusal with a failing test

**Problem.** No test covers a Grok or Pi consolidation step, so the missing key is invisible.

**Context.** Reviewer turns were fixed the same way earlier and have tests (`review-fanout-dispatch.test.ts`, `http-bridge-provider.test.ts:101-128`). `multi-review-service.test.ts:4639` asserts only the consolidation's `workflowResultTool`.

**Investigation.** Confirmed by reading the code, not reproduced.
- Consolidation runs with `READ_ONLY_REPORT_TURN` (`apps/backend/src/core/multi-review-service.ts:209`), on create (`:3777`) and on every send (`:3969`).
- The send passes `workflowResultTool` but no `workflowResultKey` (`:3975`); so does the attach (`:3944-3951`).
- `bridgePromptBody` forwards the pair to Grok and Pi only when both are present (`apps/backend/src/core/http-bridge-prompt-body.ts:73-83`), so the bridge receives neither and stores no `workflowResultTurn` (`bridges/pi-bridge/src/http.ts:1419-1422`, `bridges/acp-bridge/src/acp-http.ts:593`, `:678`).
- Pi: `requestToolApproval` blocks any tool outside `READ_ONLY_TOOLS` on a read-only turn unless `isOwnWorkflowResultCall` holds (`bridges/pi-bridge/src/interactions.ts:72-80`), which needs `state.workflowResultTurn` (`bridges/pi-bridge/src/mcp.ts:172-185`).
- Grok: `workflowResultPermissionOption` returns nothing without a turn (`bridges/acp-bridge/src/acp-session.ts:761-767`); a read-only turn's policy is `approvals: "deny"` (`acp-policy.ts:53-58`), so `orkestratorToolPermissionOption` also refuses. `acp-workflow-result-permission.test.ts:171` pins that refusal.
- After the refused turn the step sends its one reminder (`multi-review-service.ts:4184-4199`), refused the same way, then throws `missingWorkflowResultMessage` (`:4201-4209`).
- Both providers are in the default rollout for `consolidated-review` (`packages/protocol/src/workflow-results.ts:327-352`), so the step is `tool-v1` by default (`multi-review-service.ts:3849`).

**Decisions.**

- **What does the failing test assert?**
  - **That a consolidation send and attach for a Grok and a Pi selection carry `workflowResultKey` equal to the request id, in `multi-review-service.test.ts` (recommended).**
    - Pros: pins the exact gap at the call site; the bridge gates are already tested.
    - Cons: does not exercise the bridge, so a key/tool mismatch inside the bridge would pass.
  - **A body-level test through `HttpBridgeProvider` for a consolidation send.**
    - Pros: proves what reaches the wire.
    - Cons: `http-bridge-provider.test.ts:101-128` already pins the body's both-or-neither rule for Grok and Pi; it does not tie the gap to Multi Review.

### 2. Declare the attempt on consolidation

**Problem.** The result key exists (the slot is prepared with `resultKey: request.requestId`, `multi-review-service.ts:3929-3940`) but is not passed.

**Context.** The reviewer path sends both (`apps/backend/src/core/review-fanout.ts:1225-1230`). Fix and prepare steps are sent `readOnly: false` and are not gated, but sending the key there is harmless.

**Investigation.** `workflowResultInstruction(resultKind, request.requestId, …)` (`multi-review-service.ts:3962`) already tells the model to submit under `request.requestId`, so the key the bridge checks and the one the model sends agree.

**Decisions.**

- **How should consolidation declare its attempt?**
  - **Send `workflowResultKey: request.requestId` alongside `workflowResultTool` on the step send and attach, for every step kind (recommended).**
    - Pros: the reviewer path's shape; no bridge change; covers any future read-only step.
    - Cons: needs the backend test of task 1 for each step kind.
  - **Make consolidation turns writable on Grok and Pi.**
    - Pros: no protocol change.
    - Cons: widens a turn that reads untrusted reviewer output to workspace writes; contradicts the read-only report-turn rule.
  - **Refuse Grok and Pi as consolidation models.**
    - Pros: no silent failure.
    - Cons: a parity loss for no technical reason.
- **What about Codex, which also receives `workflowResultTool`?**
  - **Leave Codex unchanged (recommended).** Codex receives the tool name without a key (`http-bridge-prompt-body.ts:59-65`) and its sandbox, not a tool gate, holds read-only.
    - Pros: no change to a working path.
    - Cons: two shapes remain in the prompt body.
  - **Send the key to every bridge.**
    - Pros: one shape.
    - Cons: Codex and Claude bridges must accept or ignore an extra field; widens the change for no fix.

### 3. Build Pipeline consolidation on Grok and Pi

**Problem.** Build Pipeline consolidation also sends `workflowResultTool` without the key (`build-pipeline-review-fanout.ts:832-834`, attach at `:796-804`), but with `mode: "plan"` and no `readOnly` (`:824`), which becomes `readOnly: undefined` (`http-bridge-prompt-body.ts:34`).

**Context.** Whether it is gated depends on the session's read-only flag at create (`:686-688`) and on how each bridge treats plan mode.

**Investigation.** Not settled in this pass: Pi has no plan mode of its own and keeps `state.readOnly` from its last explicit value; ACP keeps the create flag.

**Decisions.**

- **How is it settled?**
  - **Send the key from Build Pipeline consolidation as well, whatever the answer (recommended).**
    - Pros: one change; correct even if the turn is gated later.
    - Cons: the question of whether it fails today stays unanswered.
  - **Trace each bridge's plan-mode handling first.**
    - Pros: tells whether a second user-visible failure exists.
    - Cons: costs time and changes nothing in the fix.

### 4. Live consolidation on Grok and Pi

**Problem.** The fix has not been seen with a real Grok or Pi model.

**Context.** 0029's qualification item already runs read-only Grok and Pi reviewers; Grok's permission request must carry the call's arguments for the key check.

**Investigation.** Needs Grok and Pi credentials in a `dev:test` profile.

**Decisions.**

- **How is it run?**
  - **Add consolidation by Grok and by Pi to 0029's packaged-review run (recommended).**
    - Pros: one set-up covers reviewers and consolidation.
    - Cons: blocked on the same credentials.
  - **A separate run per provider.**
    - Pros: isolates a failure.
    - Cons: twice the set-up.

## Current state

- Multi Review step dispatch sends `workflowResultTool` without
  `workflowResultKey` on send (`multi-review-service.ts:3975`) and attach
  (`:3944-3951`); consolidation is read-only (`:209`, `:3969`).
- `bridgePromptBody` forwards the pair to Grok and Pi only together
  (`http-bridge-prompt-body.ts:73-83`).
- Pi and Grok refuse non-read tools on a read-only turn that declared no
  attempt (`pi-bridge/src/interactions.ts:72-80`,
  `acp-bridge/src/acp-session.ts:761-767`; pinned by
  `acp-workflow-result-permission.test.ts:171`).
- The step then spends its one reminder and fails with a missing-result error
  (`multi-review-service.ts:4184-4209`).
- Not reproduced; confidence high from the code.

## Outstanding work

### Code

1. Add failing tests that a Multi Review consolidation send and attach on
   Grok and Pi carry `workflowResultKey` equal to the step's request id.
2. Pass `workflowResultKey: request.requestId` with `workflowResultTool` on
   Multi Review step send and attach.
3. Do the same for Build Pipeline consolidation
   (`build-pipeline-review-fanout.ts:796-834`).

### Qualification

- A packaged Multi Review with Grok, then Pi, as the consolidation model:
  the consolidation validates and submits `submit_consolidated_review`.
  Batch with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Constraints and rationale

- A read-only turn must not gain workspace writes; only the attempt's own
  tools, for calls naming its key, may pass the gate ("Attempt tools in
  read-only turns" in
  [agent-engines.md](../../architecture/agent-engines.md#attempt-tools-in-read-only-turns-grok-pi)).

## Open questions

- None.

## Needs verification

- Whether Build Pipeline consolidation on Grok or Pi is gated today (task 3).

## Related

- [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md): the
  source analysis and the read-only reviewer fix this mirrors.
- [agent-engines.md](../../architecture/agent-engines.md#attempt-tools-in-read-only-turns-grok-pi)

## Replaces

Nothing; new on 2026-10-27, split from
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md)'s task
analysis.
