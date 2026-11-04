# Coordinator pipeline step restart: follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`, on the branch that added
`restart_build_pipeline_step` (ticket "Coordinator tool to restart or
continue a failed build pipeline step").

### Tasks

1. **Crash between the restart and its receipt**: a retry after a backend crash in that window can restart an omitted-step request's new current step again. Status: done.
2. **Live qualification**: restart a pipeline that really failed on a usage limit, here and on a connected node, and watch the coordinator's next status wake arrive. Status: open.

### 1. Crash between the restart and its receipt

**Problem.** `restart_coordinator_build_pipeline_step` runs the restart inside `withCoordinatorReceipt`. If the backend dies after the pipeline mutation is saved and before the receipt completes, the receipt stays pending under a dead PID, and the retry reclaims it and runs the restart again. With `stepId` named, the second run is a no-op (the named session is already superseded, so `restartForCoordinator` reports `alreadyRestarted`). With `stepId` omitted, the pipeline is no longer `failed`, so the step is resolved as the current one, which is the session the first run started, and it is restarted a second time.

**Context.** The receipt contract (`coordinator-action-scope.ts`, `withCoordinatorReceipt`) assumes every action is safe to repeat after a partial run, because its identity derives from the `requestId`. The restart's identity is the rewind it records (`recordRewind` in `build-pipeline-rewind.ts`), which carries no request ID. The window is the time between `ctx.mutate` saving the pipeline and `completeCoordinatorActionReceipt` writing the receipt, plus the supervisor pass in between (`restartLocatedStage` awaits `stageSupervisor.runLocked`).

**Investigation.** Resolved in the review repair: a bounded coordinator restart journal is saved atomically with the pipeline restart intent, including restarts without an old session. Service tests reinitialize the service and retry the same omitted-step request; command tests retry after follow-update failure. The original investigation was code reading only. The leaf side has the same shape under its own receipt (`restart_controller_build_pipeline_step`). A lost node answer is not affected: the leaf's receipt completed, so the retry replays.

**Decisions.**

- **How to close the window?**
  - **Keep a bounded restart journal on the pipeline (recommended).** Persist hashed request identity, hashed intent, and resolved step with the restart intent.
    - Pros: replay survives receipt failure and backend restart, including a restart that supersedes no session.
    - Cons: retains up to 1024 identities per pipeline; new requests are refused at capacity rather than evicting history.
  - **Record the request on the rewind.** Add an optional `requestId` to `PipelineRewind` (protocol type and validator) and have `restartForCoordinator` answer `alreadyRestarted` when the newest rewind carries it.
    - Pros: exactly-once whatever the timing; the record that proves the restart is the restart itself.
    - Cons: a protocol change (`packages/protocol`), so a full test run; a restart that supersedes nothing records no rewind, so that case needs the rewind written anyway.
  - **Resolve the omitted step before admission and send it as a named step.**
    - Pros: no protocol change; a named step's retry is already a no-op.
    - Cons: the resolution runs outside the pipeline lock, so a pipeline that moved on between the read and the restart would have the wrong step restarted, which is what `restartCurrentStep` resolves inside the lock to avoid.
  - **Leave it.**
    - Pros: nothing to do; the window is a crash during one save.
    - Cons: the tool's "never restarts twice" holds only outside a crash.

### 2. Live qualification

**Problem.** The tool is covered by service tests with a fake provider and by command tests with a simulated node link. No run has restarted a pipeline that failed on a real usage limit, or shown the reopened follow waking a real coordinator.

**Context.** The 2026-11-04 incident that prompted the tool: seven pipelines failed at Fix on a Claude 5-hour limit, and `resume_build_pipeline` left them failed.

**Investigation.** Not done; it needs an isolated `dev:test` profile with a coordinator, a pipeline brought to a failed Fix, and for the remote case a second backend attached as a leaf.

**Decisions.**

- **How to produce the failure?**
  - **Fail the step by stopping its bridge past the reconnect deadline (recommended).** That reaches `fail()` with a step `failureContext`, as a usage limit does.
    - Pros: reproducible without exhausting a real account.
    - Cons: not literally a usage limit; the error text differs.
  - **Wait for a real usage limit.**
    - Pros: the exact incident.
    - Cons: not schedulable.

## Assumptions and decisions

### Task 1: Durable restart journal

Chose a pipeline journal independent of rewind records because pre-session failures can restart without superseding any session. Identity and intent hashes plus the resolved step are persisted under the existing pipeline lock with the restart intent. Retries consult this journal before resolving an omitted step or checking current pipeline status. History is capped at 1024 entries and is never evicted. This closes the receipt crash window; live qualification in task 2 remains open.
