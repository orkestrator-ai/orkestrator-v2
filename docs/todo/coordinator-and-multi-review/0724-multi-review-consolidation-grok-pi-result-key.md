# Multi Review consolidation on Grok or Pi cannot submit its result

Checked against `main` at `863b5782` (2026-10-27). Code fixed 2026-10-28 on
`main` at `1d1f0a87`; only the live qualification run is left.

A Multi Review consolidation turn is read-only, and Grok and Pi let a
read-only turn call its own result tools only when the prompt names the
attempt with both `workflowResultTool` and `workflowResultKey`. The step
dispatch sent the tool name without the key, so the backend forwarded
neither, the bridge's gate refused `submit_consolidated_review`, the one
reminder was refused the same way, and the workflow failed with a missing
result. Anyone who picked Grok or Pi as the consolidation model was affected.
Every Multi Review step send and Build Pipeline consolidation now declare the
key.
Found in the task analysis of
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md) (its
task 2).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the refusal with a failing test**: a backend test that a consolidation step's send carries no `workflowResultKey`, plus the bridge-side refusal already pinned. Status: done 2026-10-28 (failed on the old code, passes on the fix).
2. **Declare the attempt on consolidation**: send `workflowResultKey` with `workflowResultTool` on the step dispatch and its attach. Status: done 2026-10-28 on the send; the attach deliberately unchanged (see Assumptions and decisions).
3. **Build Pipeline consolidation on Grok and Pi**: check whether its plan-mode turn is gated the same way. Status: done 2026-10-28: not read-only-gated, but refused under a `deny` or `ask` environment policy; the key is now sent.
4. **Live consolidation on Grok and Pi**: one packaged review per provider with that provider consolidating. Status: open (unblocked by 2; batched with 0031).

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

**Investigation.** Not settled in the first pass: Pi has no plan mode of its own and keeps `state.readOnly` from its last explicit value; ACP keeps the create flag.

Settled 2026-10-28 by reading the code (not reproduced live). The session is
created with `mode: "plan"` and no `readOnly` (`build-pipeline-review-fanout.ts`
`advanceConsolidation`), and `HttpBridgeProvider.createSession` and
`bridgePromptBody` both map that to `readOnly: undefined`, so neither bridge
marks the session read-only: Pi only calls `setSessionReadOnly` for a boolean
(`bridges/pi-bridge/src/http.ts`, create and prompt) and the ACP bridge only
for a boolean (`acp-http.ts`). The turn then runs under the environment's
policy (`resolveEnvironmentExecutionPolicy`, `approvals: "auto-approve"` by
default):

- Default `auto-approve`: Pi returns `{ block: false }` before any attempt
  check (`requestToolApproval`), and Grok's `autoApprovedPermissionOption`
  allows the call. Not gated; it works today.
- `deny` override: Pi blocks with "The execution policy denies this tool
  call." and Grok answers `policyDenialOutcome`, because without a declared
  attempt neither `isOwnWorkflowResultCall` nor
  `workflowResultPermissionOption` admits the call (both precede the `deny`
  branch). Gated.
- `ask` override: the call is parked as a permission request, and Build
  Pipeline's `UNATTENDED_AGENT_INTERACTION_POLICY` (`authorization:
  "deny-and-fail"`) denies it. Gated.

With the key declared, both bridges admit the attempt's own tools under every
approval policy, so Build Pipeline consolidation now also works under `deny`
and `ask`.

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

As of 2026-10-28:

- Multi Review step dispatch (`MultiReviewService`, the `provider.send` of the
  step loop) sends `workflowResultKey: request.requestId` with
  `workflowResultTool` whenever the step runs on the tool transport, for every
  step kind (preparation, consolidation, Fix) and for their reminder and
  restart-continuation turns, which reuse that send with a fresh request id.
- Build Pipeline consolidation (`build-pipeline-review-fanout.ts`,
  `advanceConsolidation`) sends `workflowResultKey: consolidation.requestId`
  the same way, including on its reminder turn.
- The request id is the prepared slot's `resultKey` and the key named in
  `workflowResultInstruction`, so the key the bridge checks, the key the model
  is told to submit under and the slot's key agree.
- The warm-up attach (`attachAgentBeforeDispatch`) still carries only
  `agentMcp` and `workflowResultTool`; the bridges never read an attempt from
  the attach.
- Pinned by `multi-review-service.test.ts` (the Grok, Cursor, Pi and Codex
  MCP-tools test, the preparation reminder, the Fix reminder and the
  restart-continuation tests) and `build-pipeline-result-reminder.test.ts`
  (consolidation first send and reminder). These failed on the old code.
- `bridgePromptBody` forwards the pair to Grok and Pi only together, as before
  (`http-bridge-provider.test.ts`), and the bridge gates are unchanged.
- Not seen with a real Grok or Pi model.
- Validation 2026-10-28: format check, lint and typecheck clean; focused
  Multi Review, Build Pipeline fan-out and HTTP bridge suites pass. The full
  `mise run test` passed every group except one backend timeout in
  `public-api/test-support.test.ts`, which also fails alone on a clean
  `origin/main` clone under the same host load (flake
  [1245](../../tests/flaky-tests/backend-services-and-tooling/1245-public-api-test-support-harness-timeout-under-load.md)).

## Outstanding work

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

- Task 4: a packaged Multi Review with Grok, then Pi, consolidating, to see
  `submit_consolidated_review` accepted live. Needs Grok and Pi credentials
  in a throwaway `dev:test` profile (with 0031).
- Build Pipeline consolidation on Grok or Pi under a `deny` or `ask`
  environment policy, live: the trace in task 3 is from code only.

## Assumptions and decisions

Made 2026-10-28 while implementing.

- **Where does the key go: the send, the attach, or both?**
  - Options: (a) send only; (b) send and attach, adding `workflowResultKey`
    to `ProviderPrepareDispatchOptions`; (c) attach only.
  - Choice: (a) send only.
  - Why: the Grok and Pi bridges set `state.workflowResultTurn` only from the
    prompt body (`pi-bridge/src/http.ts`, `acp-bridge/src/acp-http.ts`), and
    `HttpBridgeProvider.prepareDispatch` posts only `agentMcp` to `/attach`.
    OpenCode's broker, the one attach consumer of `workflowResultTool`,
    checks the tool name and capability, not a key. A key on the attach would
    have no reader. The reviewer path, the reference for this fix, also sends
    the key on the send only.
  - Pros: no dead field in the provider contract; same shape as reviewers.
  - Cons: departs from the letter of the task list ("send and attach"); if a
    bridge ever arms the gate at attach time, the attach will need the key.
- **Which step kinds send the key?**
  - Options: consolidation only; every Multi Review step kind.
  - Choice: every step kind on the tool transport, as the task analysis
    recommended.
  - Why: preparation and Fix are writable today, so the key is harmless there,
    and one code path covers any step made read-only later.
  - Pros: one shape; no per-kind branch. Cons: the tests assert it per kind.
- **Build Pipeline consolidation: trace first or just send the key?**
  - Options: send the key without tracing; trace each bridge first.
  - Choice: both: sent the key, and traced the bridges by reading the code
    (task 3's investigation).
  - Why: the trace was cheap and answered the "Needs verification" item; it
    found a real refusal under `deny` and `ask` environment policies, not a
    read-only gate.
  - Pros: the doc now states when it failed. Cons: the trace is from code,
    not a live run.
- **How to prove the tests pin the gap?**
  - Choice: ran the new assertions with the two source changes reverted; the
    Multi Review suite failed 10 tests and the Build Pipeline reminder suite 2,
    then all passed with the fix.
  - Pros: shows each assertion bites. Cons: none.
- **Test location.**
  - Options: extend existing tests; add new test files.
  - Choice: extend the existing MCP-tools, reminder and restart tests, and
    record `workflowResultTool`/`workflowResultKey` in the Build Pipeline
    fake provider's `sent` log.
  - Why: those tests already drive each step through the tool transport for
    Grok and Pi selections; a new file would duplicate the harness.
  - Pros: small diff; covers reminder and restart turns too. Cons: the
    Build Pipeline harness runs consolidation on Claude, so its assertion is
    provider-agnostic (the backend sends the same options for every
    provider, and `bridgePromptBody` is already tested per agent).

## Related

- [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md): the
  source analysis and the read-only reviewer fix this mirrors.
- [agent-engines.md](../../architecture/agent-engines.md#attempt-tools-in-read-only-turns-grok-pi)

## Replaces

Nothing; new on 2026-10-27, split from
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md)'s task
analysis.
