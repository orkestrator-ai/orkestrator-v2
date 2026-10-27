# Build Pipeline re-sends a stage prompt after a lost acknowledgement without asking whether it ran

Checked against `main` at `863b5782` (2026-10-27).

When a Build Pipeline stage prompt's acknowledgement is lost, the supervisor
keeps the attempt and re-sends it under the same request id on its next pass,
without asking the provider's `dispatchStatus`. That is safe only while the
bridge still remembers the id. A Claude prompt sent with structured output
gets no durable claim, so after a Claude bridge restart the same id is new to
the bridge and the build or fix turn runs a second time on the same worktree.
It affects anyone whose stage turn hits an ambiguous dispatch and then a
bridge restart; a test pins the re-send as intended. Found in the task
analysis of
[0223-provider-non-delivery-proof.md](0223-provider-non-delivery-proof.md)
(its task 1 and code item 3, split out here as a defect of its own).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the duplicate with a failing test**: a fake provider that forgets an id across a simulated restart, showing the stage turn sent twice. Status: open.
2. **Ask `dispatchStatus` before re-sending**: make `dispatchPending` follow the rule the other three runners use. Status: open (after 1).
3. **Claude structured prompts and the durable claim**: decide whether the Claude bridge should also claim structured prompts durably. Status: open.
4. **Replace the pinned test**: change `build-pipeline-service-recovery.test.ts:672` to the new behaviour and cover each `dispatchStatus` answer. Status: open (with 2).

### 1. Pin the duplicate with a failing test

**Problem.** Nothing shows the duplicate; the only test of this path asserts the re-send is correct because "the bridge deduplicates".

**Context.** Tests must not use live providers. The fake provider in `build-pipeline-review-fanout-test-support.ts` already implements `dispatchStatus` (`:175`).

**Investigation.** Confirmed by reading the code, not reproduced.
- `BuildPipelineSupervisor.dispatchPending` (`apps/backend/src/core/build-pipeline-service-supervisor.ts:1723`) never reads `dispatchStatus`. On `AmbiguousPromptDispatchError` it returns and keeps `pendingPromptAttempt` (`:1844`).
- The session pass calls it again whenever the attempt's session is not `running` (`:568-579`), and after a restart notice once a continuation was sent (`:533-539`).
- The only `dispatchStatus` read in Build Pipeline is consolidation (`build-pipeline-review-fanout.ts:850-866`), which parks through `countIdlePoll` instead.
- Claude bridge: the durable claim is taken only when `outputSchema === undefined` (`bridges/claude-bridge/src/routes/session.ts:908`). A structured prompt is deduplicated only through the in-memory `structuredOutputRequestId` (`bridges/claude-bridge/src/services/session-manager-lifecycle.ts:258-261`, set in `session-manager-core.ts:310`), which is not persisted.
- Narrowing found in this pass: with the default rollout every Build Pipeline stage kind on every provider is `tool-v1` (`DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS`, `packages/protocol/src/workflow-results.ts:348`; `workflowToolEnabled`, `build-pipeline-context.ts:266`; every schema'd phase has a kind, `:192-201`). A `tool-v1` prompt has no `outputSchema`, so Claude claims it durably, restores it after a restart and refuses the re-send with 410 `dispatch-outcome-lost` (`bridges/claude-bridge/src/routes/session.ts:829-841`, mapped to `PromptRejectedError` by `apps/backend/src/core/http-bridge-prompt-body.ts:97`). The Claude duplicate therefore needs structured output: `global.workflowResultTools` narrowed in `config.json` (`apps/backend/src/core/index.ts:378`) or an attempt admitted before tool mode. Other routes to a duplicate follow 0223's survey: OpenCode (same-id dedupe in the server unverified, 0223 task 4) and an ACP journal entry left off disk over its byte budget.

**Decisions.**

- **What does the failing test model?**
  - **A fake whose same-id dedupe lives in memory and is cleared by a simulated restart, answering `unknown` afterwards (recommended).**
    - Pros: models the Claude structured case exactly; needs no bridge process.
    - Cons: a fake, so it proves the backend rule, not the bridge.
  - **A real-bridge restart test like `tests/multi-review-claude-bridge-restart.test.ts`.**
    - Pros: exercises the real Claude dedupe and restart.
    - Cons: slower and heavier; the defect is in the backend rule, which the fake already reaches.

### 2. Ask `dispatchStatus` before re-sending

**Problem.** A re-send under the same id trusts every provider to deduplicate across restarts, which 0223's survey shows not all do.

**Context.** The fan-out, Multi Review steps (`multi-review-service.ts:3989-4000`) and Build Pipeline consolidation already require `dispatched` or `pending` for the exact id and park otherwise (0112). `ProviderDispatchStatus` is `dispatched | pending | unknown | lost` (`agent-provider-contract.ts:346`). The HTTP bridges answer `unknown` for a missing route or no record (`http-bridge-provider.ts:255-273`), and the Claude bridge answers `lost` for a restored claim (`routes/session.ts:1289-1292`).

**Investigation.** `AmbiguousPromptDispatchError` extends `ProviderUnavailableError` (`agent-provider-contract.ts:324`), so a "definite non-send" check must test for the ambiguous subclass first. `PipelinePromptAttempt` (`packages/protocol/src/build-pipeline.ts:701`) records no previous dispatch outcome today.

**Decisions.**

- **Where is the fix?**
  - **In the backend: `dispatchPending` asks `dispatchStatus` for an attempt whose last send was ambiguous; `dispatched`/`pending` clears the attempt, `lost` fails the stage, `unknown` parks within the idle-poll bound and then fails closed (recommended).**
    - Pros: one rule for all four runners; covers OpenCode and ACP as well as Claude; no bridge change; leaves room for 0223's `absent`.
    - Cons: a stage whose ambiguous send never arrived now fails after the bound instead of recovering by re-send, until `absent` exists.
  - **In the Claude bridge only: claim structured prompts durably and keep the re-send.**
    - Pros: the smallest change for the case in the title.
    - Cons: leaves OpenCode and ACP exposed; changes the duplicate answer for structured prompts, which callers must then read differently.
- **When may `dispatchPending` still re-send under the same id?**
  - **Only when the last error was a definite non-send (`ProviderUnavailableError` that is not ambiguous, or a preparation error before the write), recorded as an optional field on `PipelinePromptAttempt` (recommended).**
    - Pros: keeps today's recovery for refused connections; follows 0027's "never re-send an ambiguous request" rule.
    - Cons: one additive protocol field; an older backend reading it must ignore it.
  - **Re-send on `unknown`.**
    - Pros: no new field; no recovery lost.
    - Cons: `unknown` is exactly "delivered and forgotten" in the bug, so it keeps the defect.
- **What about a bridge that predates the `/dispatch` route?**
  - **Treat its `unknown` like any other: park and fail closed (recommended).**
    - Pros: fails safe; the route is already required by the other three runners, so no new compatibility path.
    - Cons: an older bridge's lost acknowledgements now fail the stage.
  - **Keep the re-send when the route is missing.**
    - Pros: no change for old bridges.
    - Cons: needs the provider to tell "no route" from "no record", which `dispatchStatus` deliberately folds together.

### 3. Claude structured prompts and the durable claim

**Problem.** Even with task 2, a structured Claude prompt answers `unknown` after a restart instead of `dispatched` or `lost`, so it parks and fails rather than being recognised.

**Context.** 0223's open question: the claim's in-process duplicate answer (`routes/session.ts:948-953`) returns `already-processed` with no structured payload.

**Investigation.** With the default rollout, Build Pipeline rarely sends a Claude structured prompt (task 1), so the benefit is limited to non-default configuration and older attempts.

**Decisions.**

- **Change the Claude bridge as well?**
  - **No, not now: rely on task 2 and record the reason (recommended).**
    - Pros: no change to structured dedupe that Multi Review and planning also use; the default path is already claimed.
    - Cons: a configuration without Claude tool mode fails closed after a restart rather than reading `lost` at once.
  - **Yes: claim structured prompts durably and read the result through `structured-output` on a duplicate.**
    - Pros: `dispatched` and `lost` answers for every Claude prompt.
    - Cons: touches every caller of structured output; an older Claude bridge still answers `unknown`.

### 4. Replace the pinned test

**Problem.** `build-pipeline-service-recovery.test.ts:672` ("retains the attempt and retries the same request id after a lost response") asserts the re-send.

**Context.** The neighbouring test at `:695` (no redispatch while the session is running) stays valid.

**Investigation.** The fake provider's `dispatchStatus` can be scripted per request id, as `build-pipeline-restart-continuation.test.ts:161` already does with `spyOn`.

**Decisions.**

- **What replaces it?**
  - **One test per answer: `dispatched` and `pending` clear without a send, `lost` fails the stage, `unknown` parks then fails at the bound, and a definite non-send re-sends under the same id (recommended).**
    - Pros: pins the whole rule; mirrors the consolidation tests.
    - Cons: five cases to maintain.
  - **Invert the single test to "does not re-send on `unknown`".**
    - Pros: minimal.
    - Cons: leaves `lost`, `dispatched` and the non-send branch unpinned.

## Current state

- `dispatchPending` re-sends a retained attempt under the same request id with
  no dispatch check (`apps/backend/src/core/build-pipeline-service-supervisor.ts:1723`,
  `:1844`), reached from the session pass at `:533-539` and `:568-579`.
- Build Pipeline consolidation, Multi Review steps and the fan-out already
  require `dispatched`/`pending` for the exact id and park otherwise
  (`build-pipeline-review-fanout.ts:850-866`).
- The Claude bridge claims a prompt durably only without `outputSchema`
  (`bridges/claude-bridge/src/routes/session.ts:908`); structured dedupe is in
  memory only.
- The default workflow-result rollout makes every stage `tool-v1`, so the
  Claude duplicate needs a narrowed `global.workflowResultTools` or an older
  attempt; a re-sent claimed Claude id is refused with 410 rather than run.
- `build-pipeline-service-recovery.test.ts:672` pins the re-send.
- Not reproduced; confidence that the path exists is high, that it is reached
  with default settings on Claude is low.

## Outstanding work

### Code

1. Add a failing test in which a fake provider forgets an id across a
   simulated restart and the build stage is sent twice.
2. In `dispatchPending`, ask `dispatchStatus` for an attempt whose last send
   was ambiguous: clear on `dispatched`/`pending`, fail on `lost`, park within
   the idle bound on `unknown`, and re-send under the same id only after a
   definite non-send (a new optional field on `PipelinePromptAttempt`).
3. Replace the test at `build-pipeline-service-recovery.test.ts:672` with one
   case per answer.

### Qualification

- None beyond the tests in Code. A live restart check is batched in 0223's
  qualification item.

## Constraints and rationale

- Never re-send an ambiguous request under a new id, and fail closed when
  unsure ([0027](0027-multi-review-scale-and-cost.md) invariants).
- A dispatch-status read must not touch session liveness, hydrate or
  re-attach (`AGENTS.md`).
- `unknown` is never evidence that a prompt did not run.

## Open questions

- None.

## Needs verification

- Whether OpenCode deduplicates a re-sent `promptAsync` with the same message
  id (owned by 0223 task 4); if it does, OpenCode is not exposed today.

## Related

- [0223-provider-non-delivery-proof.md](0223-provider-non-delivery-proof.md):
  the source analysis and the `absent` answer that would let `unknown` cases
  recover.
- [0112-review-fanout-dispatch-recovery.md](0112-review-fanout-dispatch-recovery.md):
  the parking rule this adopts.
- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0223-provider-non-delivery-proof.md](0223-provider-non-delivery-proof.md)'s
task analysis.
