# Agent workflow results through tool calls

Status: implemented, 2026-09-09. This document retains the design analysis and
rollout checklist that guided the implementation. The delivered behavior is
documented in
[`../technical-architecture/agent-engines.md`](../technical-architecture/agent-engines.md);
read that first if you only need to operate the transport.

The delivered path uses domain-specific MCP submission tools backed by the
durable `WorkflowResultService`. New qualified attempts persist `tool-v1` before
dispatch, omit provider final-output schemas, and read only the accepted tool
result. The tools expose the existing domain schema, return bounded correction
feedback, issue stable receipts, deduplicate retries, reject conflicting writes,
and retain acceptance across backend restarts. Result storage and capability
identity use private files, atomic replacement, explicit size/count limits, and
a cross-process mutation lock. The attempt-scoped MCP URL and signed capability
remain stable across a normal backend restart.

Codex and Claude are enabled for build, review, and pipeline workflows because
their pinned bridges already support per-turn `agentMcp` configuration and the
restricted Claude policy explicitly admits that named server. Feature planning
uses Codex and is enabled end to end. OpenCode, Pi, Cursor, and ACP/Grok remain on
their persisted legacy structured-output transport until their native tool
attachment, isolation, and reconnect behavior is qualified. Old records without
transport metadata continue through their legacy readers; feature planning also
records its tagged format explicitly as `planner-block-v1` for new fallback
attempts.

The backend controller still owns turn settlement, worktree and package checks,
validation execution, pool application, stage changes, and PR verification.
Submission acceptance never performs those effects. Existing authoritative
workflow snapshots provide background and inactive-view rehydration, while the
result inbox bridges the crash window between model submission and controller
consumption.

Admission is gated by the backend-owned `global.workflowResultTools` setting: a
master switch plus per-provider and per-result-kind lists, read and written
through `get_workflow_result_tools_rollout` and
`set_workflow_result_tools_rollout`. The gate is evaluated once per attempt and
the outcome is persisted, so disabling a combination moves new attempts to the
legacy transport without stranding work already in flight. Bounded, content-free
delivery metrics are available through `get_workflow_result_metrics`.

Each workflow snapshot carries a bounded `resultSubmission` projection —
`preparing`, `correcting`, `received`, or `needs-attention` — written by the
controller on the same poll that reads the result. The renderer displays it and
owns no part of the submission lifecycle. `received` is deliberately not
presented as a passing or completed outcome.

What remains unbuilt is provider coverage, not transport behavior. OpenCode,
Cursor, ACP/Grok, and Pi have no per-turn MCP attachment in any path, including
interactive tabs, so enabling them needs bridge protocol work plus live
qualification, and neither is done here.

## 1. Objective

Replace agent-authored workflow results extracted from final assistant messages
with explicit, validated tool submissions. An agent should be able to submit a
result, receive actionable validation errors, correct the data in its current
working context, and receive a durable acceptance receipt.

The backend must remain responsible for deciding when the workflow can advance.
A tool call that successfully records a result is not proof that the agent has
finished its commands, that validation passed, or that a PR exists.

The target behavior is:

1. The backend prepares a result slot for a particular workflow attempt.
2. The assigned agent receives the tool for that slot and its input contract.
3. The agent does its work and submits the complete result.
4. Invalid input receives bounded, field-specific feedback without changing
   workflow results or repeating the underlying work.
5. Valid input is persisted before the tool returns an acceptance receipt.
6. The agent ends its turn with an ordinary human-readable response.
7. The backend reconciles the exact turn, verifies the relevant external state,
   and consumes the accepted result once.
8. Reloads, lost responses, inactive environments, and process restarts recover
   from persisted state.

This changes the result-delivery mechanism. JSON remains the transport encoding,
schemas remain necessary, and domain validation remains authoritative. Tool
calling alone does not guarantee valid arguments, meaningful findings, delivery,
or exactly-once execution of external side effects.

## 2. Scope and exclusions

### In scope

- Feature discovery state and story refinement.
- Review preparation metadata and validation-plan discovery.
- Independent review reports in build pipelines, multi-review, and looped review.
- Multi-review consolidation and its source attribution checks.
- Looped-review reconciliation against the active finding pool.
- Fix completion reports.
- Build-pipeline verification verdicts.
- Looped-review PR completion reports.
- Shared result storage, validation, tool exposure, recovery, and UI projection.
- Compatibility for persisted work created before migration.

### Out of scope

- Replacing JSON serialization in HTTP, IPC, SSE, JSONL RPC, storage, config,
  provider transcripts, worker snapshots, or ordinary CLI responses.
- Removing runtime validation because a tool has an input schema.
- Making the model responsible for backend-owned command execution or scheduling.
- Replacing review judgment, changing confidence policy, or weakening evidence
  requirements to obtain a passing result.
- Changing approval policy, repository permissions, PR authorization, or merge
  behavior. The existing prohibition on agents merging into `main` still applies.
- Reworking the coordinator, adding delegation, or adding new agent providers.
- Enabling repository-controlled extensions in restricted review sessions.
- Requiring a tool server for short title or environment-name generation jobs.
- Introducing a general-purpose workflow scripting API.

Environment slug generation and session titles retain their small output parsers
and sanitizers. A separate small improvement can give slug generation the output
schema already used by title generation. Agent-written `orkestrator-ai.json`
remains a repository artifact: validate the file itself, not a chat assertion
that the file is valid.

## 3. Current implementation and migration inventory

Paths in this document are relative to the repository root unless linked.
Proposed filenames and interfaces are marked as new; they are not existing APIs.

### 3.1 Workflow consumers

| Area | Existing code | Current behavior | Planned submission |
| --- | --- | --- | --- |
| Feature discovery | `packages/protocol/src/feature-planning.ts`; `apps/backend/src/core/feature-planning.ts` | Extracts a terminal `<feature_planner_state>` JSON block from assistant prose, persists the reply, then applies its state | `submit_feature_plan_state` |
| Story refinement | Same modules | Extracts `<story_refinement>`, checks the target story, and applies the update | `submit_story_refinement` |
| Validation discovery | `apps/backend/src/core/review-validation-prompts.ts`; `packages/protocol/src/review-validation.ts` | Receives a command plan; validates bounds, dependency order, paths, and shape; backend executes it | `submit_validation_plan` |
| Preparation metadata | `apps/backend/src/core/looped-review-prompts.ts`, `parseReviewPreparationResult` | Validates command outcomes, artifact metadata, uncommitted-file explanations, and limitations | `submit_review_preparation` |
| Reviewer reports | `apps/backend/src/core/review-fanout.ts`; `build-pipeline-review-fanout.ts`; `build-pipeline-service-supervisor.ts` | Reads provider structured results and validates complete review reports | `submit_review_report` |
| Consolidation | `apps/backend/src/core/multi-review-service.ts`, `deriveConsolidatedProvenance` in `review-fanout.ts` | Validates the report and its claimed source findings before deriving attribution | `submit_consolidated_review` |
| Finding reconciliation | `apps/backend/src/core/looped-review-service.ts`, `parseReconciliation` and `applyReconciliation` | Checks pool IDs, report coverage, duplicate indexes, and matching additions/updates | `submit_review_reconciliation` |
| Fix results | `apps/backend/src/core/looped-review-prompts.ts`, `parseFixResult`; multi/looped-review controllers | Rejects contradictory completion, failed validation, duplicate file entries, and unresolved limitations | `submit_fix_result` |
| Pipeline verification | `apps/backend/src/core/build-pipeline-service-recovery.ts`, `finishVerification` | Validates `{complete, rationale}`, checks the worktree, and chooses the next stage | `submit_verification_result` |
| PR report | `apps/backend/src/core/looped-review-prompts.ts`, `parsePrResult`; `looped-review-service.ts` | Validates a PR URL, then invokes `verify_environment_pr` | `submit_pr_result` |

Do not infer that every build-pipeline stage consumes the fix-result or PR-result
schema. Trace each stage's actual `schema` selection and completion branch in
`build-pipeline-service-supervisor.ts`; migrate the contracts those branches
really use. Preserve existing stage behavior while changing its result source.

### 3.2 Provider transport differences

The shared `StructuredOutputResult` contract currently means that a provider
produced a value; domain acceptance happens above that contract.

| Provider path | Current implementation | Consequence |
| --- | --- | --- |
| Claude bridge | `services/session-manager-prompt.ts` passes `outputFormat: {type: "json_schema", schema}` and reads `resultMsg.structured_output` | Already uses a dedicated SDK result surface; the migration benefit is immediate domain feedback and durable backend acceptance |
| Codex bridge | `engine/app-server-engine.ts` forwards `outputSchema`; `app-server-runtime-base.ts` parses the authoritative final agent message | Retain native structured output for legacy slots; tool slots should not constrain final assistant prose |
| OpenCode backend | `opencode-provider.ts` embeds the schema through `openCodeStructuredPrompt`; its `promptAsync` call does not currently pass `format`; reads `info.structured` when available, otherwise parses text | The backend workflow path is materially different from renderer helpers that can pass `format`; do not claim backend schema enforcement based on those helpers |
| Pi bridge | `prompt.ts` appends schema instructions and parses `getLastAssistantText()` | Tool registration needs a trusted native extension, not an assumed MCP client |
| Cursor SDK bridge | `prompt.ts` appends schema instructions and recovers JSON from the final output | Qualify per-session tool configuration and callback behavior |
| ACP bridge / Grok | `acp-http.ts` and `acp-prompt.ts` append schema instructions and recover JSON from text | Qualify actual ACP MCP support, including restored sessions |

The text recovery implementation in `packages/protocol/src/structured-output-text.ts`
also handles fences, prose, and thinking tags. It must remain available for
legacy output and unrelated transcript rendering until its remaining callers
have been audited.

### 3.3 Recovery already present

- `StructuredOutputReadUnavailableError` distinguishes an observation failure
  from a terminal structured-output failure. Preserve this distinction.
- `review-fanout.ts`, `multi-review-service.ts`, and pipeline recovery implement
  bounded schema/domain repair turns. The repair prompt explicitly says not to
  repeat review analysis, validation, or file edits.
- Looped review treats several malformed results as definite failures; retry
  can dispatch a fresh request. Tool correction should reduce these failures
  without automatically re-running stages that already mutated the repository.
- Feature planning persists the assistant reply separately from its state
  application and marks `stateApplication` to make recovery idempotent.
- Workflow controllers already have revision checks, operation IDs, leases, and
  dispatch reconciliation. Extend those mechanisms rather than bypassing them.

### 3.4 Existing tools are a foundation, not complete integration

`apps/backend/src/core/agent-tools.ts` provides authenticated MCP tools scoped to
an environment/project and optionally a tab. It currently has a 512 KiB request
body cap, in-memory credentials, and a listener on a dynamically selected port.
These details matter for both payload size and backend restart recovery.

`control-mcp-server.ts` serves broader application-control operations. Workflow
reporting must not inherit that broad authority merely to submit a result.

`ProviderCreateSessionOptions` and `ProviderSendOptions` have `agentMcp`, and
interactive native-agent paths resolve tool connections. Workflow controllers
also create providers/sessions directly. Adding a tool only to the interactive
path will leave those workflows without it.

Although `http-bridge-provider.ts` forwards `agentMcp` for multiple providers,
forwarding a property does not establish that each bridge uses it. In particular,
Cursor's MCP configuration and ACP's configured-server helper currently read
process environment variables. Environment-wide credentials are insufficient to
isolate concurrent reviewers.

## 4. Design decisions

1. **Use typed submission tools backed by one service.** Share admission,
   validation, persistence, receipts, and recovery. Keep tools domain-specific so
   each agent receives a focused input schema and useful description.
2. **One complete accepted result per slot.** Start with atomic whole-result
   submission. Do not introduce incremental finding mutations or partial report
   assembly in the first version.
3. **Separate prompt dispatch from result submission.** Existing dispatch IDs
   deduplicate work sent to the provider. A result key identifies where that
   work reports its outcome. Neither replaces the other.
4. **Persist before acknowledging.** Tool success means the result and receipt
   are durably recorded. A successful callback followed by a failed save is not
   an accepted result.
5. **Acceptance and workflow completion are separate.** Submission handlers do
   not run validation commands, advance stages, create PRs, or wait for the
   submitting agent to become idle.
6. **Validate against current authoritative context.** Reconciliation uses the
   pinned pool/report revision; consolidation uses the selected reviewer
   reports; verification uses the correct validation/worktree baseline.
7. **Keep one authoritative transport per attempt.** Select tool submission or
   legacy structured output before dispatch and persist that selection. Never
   accept whichever channel happens to respond first.
8. **Preserve backend ownership and execution policy.** The renderer projects
   results. A restricted review worker can submit its own report without gaining
   file writes, general networking, or workflow-control permissions.
9. **Qualify provider support with executable tests.** Tool availability,
   error feedback, session isolation, and reconnect behavior must be demonstrated
   on the pinned implementation before enabling that provider.
10. **Simplify schemas after transport parity.** First reuse the existing
    payloads and validators. Later remove redundant backend-derived fields with
    an explicit schema-version change.

## 5. Shared protocol

### 5.1 New modules

Add these small, focused modules rather than expanding existing large files:

| Proposed module | Responsibility |
| --- | --- |
| `packages/protocol/src/workflow-results.ts` | Public result kinds, receipt/status/error types, schema versions, shared limits |
| `packages/protocol/src/workflow-result-schemas.ts` | Tool input schemas and schema registry; imports existing domain schema definitions |
| `apps/backend/src/core/workflow-result-contracts.ts` | Maps result kinds to validators and context requirements |
| `apps/backend/src/core/workflow-result-service.ts` | Admission, correction accounting, acceptance, receipt lookup, recovery coordination |
| `apps/backend/src/core/workflow-result-tools.ts` | MCP registration and translation of service responses into tool results |
| `apps/backend/src/core/workflow-result-credentials.ts` | Narrow caller capabilities, private connection renewal, revocation |
| `apps/backend/src/core/workflow-result-storage.ts` | Storage adapter interface and shared pure mutation helpers |
| `apps/backend/src/core/workflow-result-provider.ts` | Provider capability selection and trusted session/turn bindings |

Workflow-specific atomic storage methods remain in the owning storage classes
or extracted sibling modules. Do not make a new independent result database
authoritative alongside workflow snapshots without a transaction design.

Export the public protocol module through `packages/protocol/package.json`.
Regenerate both tracked lockfiles with the pinned Bun version when changing
package metadata, as required by `AGENTS.md`.

### 5.2 Result kind and transport

Illustrative proposed types:

```ts
type WorkflowResultKind =
  | "feature-plan-state"
  | "story-refinement"
  | "validation-plan"
  | "review-preparation"
  | "review-report"
  | "consolidated-review"
  | "review-reconciliation"
  | "fix-result"
  | "verification-result"
  | "pr-result";

type WorkflowResultTransport = "tool-v1" | "structured-output-v1" | "planner-block-v1";

interface WorkflowResultBinding {
  version: 1;
  resultKey: string;
  kind: WorkflowResultKind;
  schemaVersion: number;
  transport: WorkflowResultTransport;
  promptRequestId: string;
  workerEpoch: string;
}
```

The backend also stores the owning workflow type/ID, stage, round/pass/reviewer
identity, environment/project, provider session identity, and applicable context
revision. These are trusted bindings, not fields the model chooses.

`workerEpoch` changes when the assigned worker is replaced. It is distinct from
the controller lease: a backend controller restart can adopt the same live
worker without invalidating a legitimate in-flight submission.

Bind a live provider generation/run identity when available. A generation that
dies loses write authority; a replacement must receive a new epoch/binding.
Historical receipts remain readable through authorized recovery paths.

### 5.3 Model-facing arguments

Each submission tool accepts:

```ts
interface SubmitWorkflowResult<T> {
  resultKey: string;
  result: T;
}
```

- `resultKey` is a backend-issued correlation key, not an authentication secret.
- The tool's registered kind and caller capability determine the allowed schema.
- Do not expose a generic `{kind: string, payload: any}` schema.
- Do not accept caller-supplied environment ownership, controller leases,
  provider identity, provenance, or stage transition instructions.
- Where the provider adapter can bind the key privately in a native tool closure,
  it may omit the visible key while preserving the same backend contract.
- Keep the advertised schema stable within a session when possible. Validate
  whether the current slot authorizes the tool at call time. If the provider
  caches tools, do not assume `tools/list_changed` refreshes them mid-turn.

### 5.4 Receipts and status

```ts
interface WorkflowResultReceipt {
  version: 1;
  resultKey: string;
  receiptId: string;
  kind: WorkflowResultKind;
  schemaVersion: number;
  acceptedAt: string;
}

type WorkflowResultLifecycle =
  | "open"
  | "accepted"
  | "consumed"
  | "cancelled"
  | "superseded"
  | "failed";

interface WorkflowResultStatus {
  resultKey: string;
  lifecycle: WorkflowResultLifecycle;
  receipt?: WorkflowResultReceipt;
  // Distinct from result acceptance; reported by the backend controller.
  completion: "pending" | "completed" | "blocked";
}
```

Store an internal canonical payload digest for deduplication. It need not be
returned to the model or included in telemetry. Receipt identity and acceptance
time never change on replay. Current lifecycle/completion can change.

Add `get_workflow_result_status` for an authorized worker's own key. It returns
bounded status/receipt metadata, not the complete report or other workers' data.
Controllers read their normal workflow snapshots rather than polling the model's
tool endpoint.

An unknown or expired key is not evidence that a prompt never ran. Return an
explicit unavailable/unknown result requiring reconciliation. Never translate it
into an instruction to repeat implementation or PR creation.

## 6. Validation and feedback

### 6.1 Validation sequence

1. Enforce raw request byte limits before parsing.
2. Authenticate the caller without consulting model-supplied ownership fields.
3. Validate the argument envelope and depth/count limits.
4. Resolve the registered contract and pinned schema version.
5. Verify the caller's identity, owning workflow, result key, and permitted tool.
6. Check whether a durable acceptance already exists. An identical replay uses
   historical receipt-read authority; it does not require reopening write access.
7. For a new acceptance, verify active worker/run write authority and validate
   shape and domain constraints against the slot's context.
8. Under the owning storage mutation lock, re-read the slot and context version,
   recheck authority, and atomically record acceptance or a bounded rejection.
9. Return the receipt only after the storage operation succeeds.

Pure validation may run outside the lock when expensive, but its context version
must be checked again inside the mutation. Do not perform provider or filesystem
probes while holding a workflow storage lock. Stage finalization performs those
probes and checks the revision again before applying its transition.

### 6.2 Reuse and improve validators

- Keep the strict report validator in
  `packages/protocol/src/structured-review/validation.ts` and reuse its error
  paths/codes. Do not replace it with TypeScript casts or schema-only validation.
- Extract pure reconciliation validation/application from
  `looped-review-service.ts` so a submission can be checked without mutating the
  live pool. Apply the validated result only during controller consumption.
- Convert preparation, fix, PR, and validation-plan validation into shared
  diagnostic-returning helpers. Preserve existing throwing wrappers while
  consumers migrate.
- Separate feature/story payload validation from XML-like block extraction.
  The legacy parser can extract a block and call the same validator.
- Preserve semantic failures: omitted finding outcomes, invented pool IDs,
  contradictory completion, unknown consolidation sources, and stale context.
- Validate full payloads; bound the diagnostic response, not the validation.
- Do not convert an honest `complete: false`, limitations, or failing tests into
  a formatting error that pressures the model to claim success.

### 6.3 Error contract

Use an error discriminant and an explicit next action rather than one ambiguous
`retryable` boolean:

```ts
interface WorkflowResultError {
  code:
    | "invalid_result"
    | "result_too_large"
    | "attempt_closed"
    | "stale_context"
    | "submission_conflict"
    | "capability_denied"
    | "correction_budget_exhausted"
    | "storage_unavailable"
    | "result_status_unavailable";
  nextAction: "correct" | "lookup_or_resubmit" | "reconcile" | "stop";
  message: string;
  issues?: Array<{ path: string; code: string; message: string }>;
  omittedIssueCount?: number;
}
```

Example model-visible correction:

```json
{
  "code": "invalid_result",
  "nextAction": "correct",
  "message": "The result was not accepted. Correct these fields and submit again.",
  "issues": [
    {
      "path": "$.result.testResults.total",
      "code": "inconsistent_total",
      "message": "Must equal passed + failed + notRun. Preserve the observed test outcomes."
    }
  ],
  "omittedIssueCount": 0
}
```

For MCP, return correctable execution/validation failures in a tool result with
`isError: true`, with a concise text representation and structured data where
supported. Check the pinned MCP server library's schema-validation behavior:
registration-time validation must not hide the feedback from the model in a
protocol-only error. Do not weaken the advertised schema to avoid fixing that
adapter behavior.

Native adapters must produce the equivalent provider-visible tool error. Tests
must prove that the next model step actually receives it, not merely that the
backend handler constructed an object.

Authentication, malformed wire envelopes, and unknown protocol methods can remain
transport/protocol errors. A connection loss says nothing about whether a result
was saved, so the next action is receipt lookup or identical resubmission.

## 7. Durable storage and concurrency

### 7.1 Store result slots with their owning workflow

For the initial implementation, place bounded result slots and receipts inside
the owning workflow record, using its existing atomic storage boundary:

- Build pipelines: owning pipeline persistence and backend revision.
- Multi-review: workflow storage and controller-fenced consumption.
- Looped review: workflow storage and controller-fenced consumption.
- Feature planning: the feature plan's serialized mutation; the operation ID
  remains the fence for the active exchange.

A slot contains its binding, lifecycle, accepted payload or durable result
reference, immutable receipt, digest, rejection accounting, and timestamps.
Reuse the workflow's existing durable domain result location after consumption
where possible. Do not keep multiple full copies indefinitely.

Feature planning currently removes the active planning record when done. Keep
the completed exchange's compact receipt on a bounded parent-plan collection or
other retained owning record before detaching it. Otherwise a lost tool response
followed by successful application would erase the evidence needed to deduplicate
the replay.

If measured payload volume requires immutable result files, introduce them as a
separate reviewed optimization: write the bounded blob atomically first, commit
its digest/reference with the receipt in the workflow transaction, and garbage
collect unreferenced blobs after a grace period. A blob alone never proves
acceptance. Do not adopt two unrelated JSON writes as an atomic transaction.

### 7.2 Submission writes and controller writes

The submission handler is an authorized writer of a result slot, not the owner
of the workflow controller lease. Add a narrow storage operation that changes
only the permitted slot/rejection metadata under the same mutation queue used
by ordinary workflow saves.

Every controller that holds an in-memory snapshot must handle a revision conflict
by reloading and reconciling. It must never overwrite a newly accepted slot with
its older snapshot. Existing public update commands must not let the renderer
forge, remove, or replace trusted acceptance metadata.

Consumption is a controller-fenced mutation that checks:

- The workflow still owns this stage/round/pass/reviewer.
- The result key, accepted digest, and expected context revision still match.
- No cancellation or supersession won the race.
- Required provider settlement and external checks have completed.
- The receipt has not already been consumed.

Record consumption and the corresponding domain state transition in one owning
workflow mutation. If the transition schedules external work, persist its intent
and use the existing idempotent/reconciled execution path outside the lock.

### 7.3 Canonical payload identity

- Canonicalize JSON object key order recursively; preserve array order.
- Reject unsupported/non-JSON values in native callbacks before hashing.
- Hash the validated submission representation and schema version. Do not hash
  server-added timestamps or random IDs into request identity.
- Do not trim or normalize arbitrary evidence text merely to make different
  submissions compare equal. Preserve domain normalization only where it is an
  explicit, tested contract.
- Two concurrent identical valid submissions produce one receipt.
- Two concurrent different valid submissions cannot both be accepted.
- An identical replay of an accepted payload returns the original receipt even
  after the controller advances, subject to valid receipt-read authority.
- A different payload for an already accepted key is a conflict. Replacement
  requires an explicit new backend-owned attempt; no last-write-wins behavior.
- Rejected inputs do not reserve the accepted payload hash. A corrected payload
  can reuse the still-open result key.

### 7.4 Avoid callback deadlocks

Never wait for the submitting agent's turn to finish inside its result tool.
The agent cannot finish until the tool responds.

Do not hold a controller/session mutex across a provider call when that provider
can call back into a tool requiring the same mutex. Persist dispatch intent,
release storage locks, dispatch, and let callback admission run independently.
Audit the existing workflow `send` paths for this dependency explicitly.

The Codex stdout loop must continue routing notifications while result storage
is pending. Tool handling must not await rendering, SSE delivery, or browser
activity, and every asynchronously launched operation must own its rejection.

## 8. Result lifecycle and retry rules

### 8.1 State transitions

| Existing state | Event | Durable result | Controller behavior |
| --- | --- | --- | --- |
| No slot | Prepare attempt | `open`, binding pinned | Dispatch only after persistence and tool readiness |
| `open` | Invalid input | Remains `open`, bounded diagnostics/accounting | Allow correction within budget |
| `open` | Valid authorized input | `accepted`, payload and receipt saved | Wait for exact turn settlement and final checks |
| `accepted` | Identical replay | Same receipt; no second mutation | Continue existing settlement |
| `accepted` | Different input | Conflict; original remains | Do not replace accepted result |
| `accepted` | Successful turn and valid external state | `consumed` plus domain transition | Advance once |
| `open` | Successful turn with no submission | No fabricated result | Bounded missing-result recovery |
| `open` or `accepted` | Cancel/supersede wins | Closed lifecycle; retain any historical receipt | Do not consume or advance |
| `accepted` | Worker dies or turn errors | Preserve receipt; completion blocked | Reconcile; do not rerun mutations automatically |
| Any nonterminal slot | Observation outage | Preserve state | Retry observation with bounded backoff |

An accepted receipt is historical evidence that data was saved. It does not
override a later cancellation or turn failure. Status reports both facts.

When a replay follows cancellation or supersession, return the historical receipt
with the closed lifecycle, not an unqualified new success. Never tell the worker
to continue changing the repository because its older report had been accepted.

### 8.2 Distinguish four operations

1. **Correct invalid data:** same open result key, changed payload, same worker
   context. No rerun of the review/fix phase.
2. **Recover a lost tool response:** look up the receipt or resend the identical
   payload. Never allocate a new prompt request simply because the tool timed out.
3. **Recover missing submission after a finished turn:** once absence is proven
   from the authoritative open slot and the exact turn is terminal, a bounded
   reporting-only continuation can submit the result. Persist its new dispatch
   ID and explicitly rebind submission authority before sending it.
4. **Repeat work:** an explicit workflow retry after authoritative failure or
   changed context creates a new attempt and result key. Reconcile existing
   commits, validation artifacts, and PRs before deciding what actually needs
   to run again.

For a reporting-only continuation, retain the logical result slot but persist the
authorized dispatch/run binding history with a count bound. A completed old turn
must lose write authority. Do not silently let any later turn in the same session
satisfy the slot. If the provider cannot isolate that authority, replace the
worker and issue a new slot through a documented recovery transition.

### 8.3 Correction budgets

Initial defaults: one initial submission plus three distinct corrected invalid
payloads before automatic correction stops. Use a separate transport retry
budget; network outages and repeated delivery of the same invalid payload must
not spend new model-correction attempts.

Persist a bounded set of rejected payload digests and sanitized diagnostics so
duplicate delivery receives the same error and controller restarts do not reset
the correction budget. Rate-limit identical repeated invalid calls independently.
Retain existing per-workflow repair limits where stricter, and make the effective
budget visible in the prompt/tool feedback.

At most one automatic reporting-only continuation per slot is the initial
missing-submission policy. A second missing result becomes an actionable workflow
failure. Do not create a new slot to reset budgets automatically.

### 8.4 Pause, deadlines, and observation

Preserve the workflow's existing pause semantics. Where pause prevents the next
stage but allows the current turn to finish, keep accepting that authorized
turn's result and retain it while paused. Consumption that advances work waits
for resume. Where an explicit stop aborts the current turn, close its write
authority through the cancellation path. A view becoming inactive is neither
pause nor stop.

Use separate clocks for the worker's progress, a pending submission request,
missing-result recovery, and accepted-result settlement. Repeated reads and
duplicate receipt delivery must not reset progress deadlines. Resume may adjust
only the clocks actually suspended by pause; persist that decision. A backward
wall-clock change must not create an infinite wait.

Initial reporting transport policy: a 10-second bounded server operation and a
15-second client timeout, with no uncancelled storage write silently treated as
absent after timeout. If the operation outcome is uncertain, query the receipt.
Use bounded jittered backoff for connection recovery, starting at 1 second and
capping at 15 seconds, with a 2-minute automatic recovery window before exposing
an actionable unavailable state. Qualify these defaults on the actual storage
and host/container paths; provider turn and cold-attach timeouts remain separate.

For accepted-but-unsettled results, retain existing workflow progress/stall
supervision instead of starting an unrelated short timer that would interrupt
legitimate tool cleanup. A stalled or failed worker leaves its accepted receipt
available for reconciliation and never advances merely because a timer expired.

Receipt lookup is side-effect-free: it must not refresh provider liveness, hydrate
a transcript, reattach an idle thread, or query a tab-facing session/status route.
Use the existing no-touch activity and authoritative run-history mechanisms when
background reconciliation needs provider state. Preserve bounded missing-result
deadlines; neither an empty snapshot nor an unavailable channel is success.

### 8.5 Settlement and external effects

Keep the rule that `cancelling` and `recovering` are not idle. A generic idle
observation alone is not proof of successful completion of the bound run.
Adapters must identify a terminal outcome for that run or report uncertainty.

Before consumption, retain existing checks relevant to the contract:

- Review/verification: pinned commit/range and worktree fingerprint.
- Reconciliation: exact active pool and report revision.
- Consolidation: exact selected source reports and permitted source IDs.
- Validation discovery: expected HEAD and executable plan constraints.
- Fix completion: validation results and existing completion semantics.
- PR completion: `verify_environment_pr` against the expected environment and
  branch, even if the submitted URL is syntactically valid.

If an agent submits and then changes the worktree, invalidate finalization rather
than using evidence against a different checkout. A valid negative verdict or
incomplete fix is consumed as a valid result and follows the existing failure/fix
branch; it is not repeatedly corrected into a positive verdict.

## 9. Authority, connections, and execution policy

### 9.1 Narrow capabilities

Create a workflow-result capability distinct from the general Agent MCP and
Control MCP authority. Bind it to the environment/project, worker session/epoch,
allowed result kind/key, and intended provider connection.

- A tool argument naming another key cannot expand the capability.
- Two reviewers in the same environment cannot submit each other's reports.
- Subagents do not receive the parent's final-submission capability by default.
  They report to their parent; the assigned parent submits the final report.
- Tools cannot approve interactions, start pipelines, alter Kanban, or publish
  changes unless those are separately authorized existing capabilities.
- Submission write authority closes on cancellation, supersession, worker
  replacement, and workflow deletion. Receipt lookup can retain narrower
  historical read authority for recovery.
- Controller lease renewal must not revoke a healthy worker's capability.
- Register only trusted built-in result tools. A repository extension or MCP
  server with the same name must not replace their implementation.

Do not place authentication secrets in prompts, tool arguments, transcript
metadata, public snapshots, command logs, or repository files. Pass them through
existing private bridge configuration or a dedicated private result connection.

### 9.2 Provider contract changes

Add an optional trusted `workflowResult` binding/connection to provider session
creation and send options, distinct from general `agentMcp`. Add a capability
query that reports supported result transport, schema version, and whether
session isolation/reconnect are qualified for the active provider configuration.

The exact API is an implementation decision; the required behavior is:

- Result tools are attached before the prompt can execute.
- Failure during attachment is unambiguous: no prompt journal entry or turn
  dispatch has happened yet.
- The workflow persists the chosen transport and capability version.
- Unknown or older bridge capabilities select legacy transport before dispatch.
- A declared tool path that later fails does not silently switch transports.
- Restore/fork/attach paths cannot inherit another worker's authority.
- Public commands cannot construct trusted bindings by passing arbitrary JSON.

Wire this into workflow session creation in feature planning, looped review,
multi-review, reviewer fanout, and pipeline setup, including resumed sessions.
Do not rely solely on `native-agent-service-provider.ts` or interactive tabs.

### 9.3 Backend restart and credential renewal

The current Agent MCP listener's random port and in-memory credentials cannot be
assumed to survive restart. Tool-mode qualification requires a concrete solution:

1. Prefer provider-private reconfiguration of an existing MCP/native connection
   when it can be proven to work without redispatching the prompt.
2. Where a provider freezes configuration at attach, use a trusted stable relay
   or provider adapter that resolves the current backend endpoint from a private,
   atomically updated descriptor outside the repository.
3. For such a relay, authenticate renewal using durable, narrowly scoped worker
   credentials. Protect credential files and descriptors with owner-only
   permissions; container mounts expose only that worker's required material.
4. Keep accepted receipts durable independently of connection credentials.
   Credential renewal changes connectivity, not result identity or acceptance.
5. If an adapter cannot recover a live callback connection, report it as
   unavailable and enter explicit reconciliation. Do not claim uninterrupted
   restart support for that provider or retry its mutating prompt automatically.

Select and implement one tested strategy per provider in the qualification
phase. A relay is conditional implementation work, not a reason to expose a
general backend credential or assume a fixed port is always available.

### 9.4 Restricted workers

Submitting a report writes Orkestrator's workflow metadata, so do not mislabel the
tool as globally read-only merely to bypass permissions. Give this trusted narrow
operation an explicit allowance within the workflow's reporting policy while
preserving source-file and command restrictions.

For restricted network configurations, route reporting through the trusted tool
transport/bridge. Do not enable unrestricted shell networking as a workaround.
An unavailable result tool must not cause approval timeout or malformed approval
answers to become implicit authorization.

## 10. Provider implementation work

Consult current provider documentation through Context7 before choosing new SDK
methods or MCP configuration shapes. The items below describe required behavior;
they are not claims that an unverified vendor API already supports it. Follow
[`../upgrade-agents.md`](../upgrade-agents.md) if a runtime/protocol upgrade is
actually required.

### 10.1 Claude bridge

Relevant files: `services/session-manager-prompt.ts`, session types, session
routes, MCP runtime configuration, policy/interactions, persistence.

- Extend private MCP configuration with the assigned result capability.
- Register result tools even when project settings/resources are disabled.
- Verify that plan/read-only review policy permits the reporting tool while
  preserving all repository mutation restrictions.
- For tool-bound turns, omit workflow `outputFormat`; do not wait for
  `resultMsg.structured_output` or fail because that field is absent.
- Continue to use the SDK's terminal result/error semantics for settlement.
  `is_error` remains authoritative even when `subtype` says success.
- Prove model-visible validation feedback, duplicate calls, backend outage,
  cancellation, and restored session behavior using the existing fake CLI/SDK
  harness and a small opt-in real-provider probe.
- Preserve the existing structured-output path for legacy bindings and unrelated
  callers. Do not alter session catalogue/control draining behavior.

### 10.2 Codex bridge

Relevant files: `engine/types.ts`, `engine/app-server-engine.ts`,
`app-server-runtime-prompt.ts`, `app-server-runtime-sessions.ts`,
`app-server-runtime-lifecycle.ts`, `app-server-runtime-base.ts`, session
persistence, private MCP configuration, and message rendering.

- Bind result tooling to the assigned session/run using the available private
  MCP mechanism; qualify any dynamic-tool alternative before using it.
- For tool-bound turns, omit `outputSchema` and remove structured-result
  final-message parsing as a completion requirement for that attempt.
- Preserve ordinary final prose and commentary; do not hide it as machine output
  merely because the session previously had a structured turn.
- Preserve at-most-once prompt dispatch and explicit overload handling. A failed
  result callback must not cause an ambiguous `turn/start` to be repeated.
- Keep result tool work off the stdout notification loop.
- Reapply trusted bindings after attach/resume, and reject dead-generation
  callbacks. Never delete a thread as part of this migration.
- Do not persist result credentials in ordinary session config; retain the
  existing care around stripping private `agentMcp` values.
- Use generated protocol types only as generated. Run protocol verification when
  touching protocol integration; never hand-edit the generated directory.

### 10.3 OpenCode

Relevant files: `opencode-provider.ts`, `opencode-messages.ts`, provider helpers,
server configuration, and the matching renderer legacy adapters.

- Keep SDK v2 imports and flat parameters.
- Determine and test how the pinned server attaches trusted tools to the actual
  session without sharing another reviewer's authority. A server-global MCP
  setting with environment-wide credentials does not meet this requirement.
- If session isolation requires a private adapter/proxy or separate provider
  instance, make that cost explicit in the capability implementation.
- For tool-bound sends, stop calling `openCodeStructuredPrompt`; do not require
  `info.structured` or parse assistant text for this result.
- Keep request/message ID reconciliation and the mapping to the exact assistant
  turn for settlement. Tool execution completion is not session completion.
- Retain text/native structured reading for legacy transport. Do not accidentally
  change the renderer's separate format-enabled paths without auditing callers.
- Preserve the SDK abort/cancel rejection patch and its real-SSE regression.
  Adding callback requests introduces additional promises that must be handled
  when their shared abort signal fires.

### 10.4 Pi

Relevant files: `agent-session.ts`, `interactions.ts`, `prompt.ts`, `http.ts`,
`state.ts`, persistence, and the Pi SDK adapter.

- Register trusted result tools with a built-in extension factory during session
  creation, alongside the existing trusted approval extension.
- Forward submission to the same backend service and return provider-native
  success/error feedback. Do not introduce an MCP dependency just for parity if
  the native tool API provides the required contract.
- Update active-tool selection and the `tool_call` read-only gate: allow only the
  trusted reporting tools appropriate to the current binding, not arbitrary
  extension tools or name-based impersonation.
- Keep project extensions disabled in restricted review sessions.
- Pi fixes registrations at session creation, so plan stable trusted tool names
  with binding checks at execution time; qualify any reconfiguration alternative.
- For tool-bound turns, stop appending the schema instruction and stop reading
  `getLastAssistantText()` to obtain the workflow result.
- Exercise in-process callbacks, cancellation, worker replacement, and backend
  connection renewal without enabling project resource discovery.

### 10.5 Cursor SDK bridge

Relevant files: `mcp.ts`, `agent-session.ts`, `http.ts`, `state.ts`, `prompt.ts`,
and persistence.

- Replace the reporting path's dependence on process-wide
  `ORKESTRATOR_AGENT_MCP_*` values with the trusted session binding.
- Merge trusted result configuration without allowing repository config to
  override its server name, credential, or tool implementations.
- Verify SDK tool-result error propagation and frozen/live MCP configuration
  behavior; test two sessions sharing one bridge concurrently.
- Stop appending/parsing final JSON for tool-bound turns.
- Preserve existing `idempotencyKey` prompt behavior and run settlement handling.
- Do not widen unsupported approval behavior merely to make reporting work.

### 10.6 ACP / Grok

Relevant files: `acp-context.ts`, `acp-session.ts`, `acp-persistence.ts`,
`acp-http.ts`, `acp-prompt.ts`, `acp-tools.ts`, and ACP test fixtures.

- Make configured result servers session/attempt scoped through new/load/resume
  and any fork paths, instead of relying on one process environment connection.
- Check the actual advertised agent MCP transport capabilities. Qualify its
  ability to invoke the tool and observe error feedback, not just list a server.
- Preserve dispatch journal semantics: old/ambiguous records remain unknown.
- Stop schema prompt injection/text recovery for tool-bound turns only.
- Ensure internal provider retries do not retain a previous attempt's tool
  authority or treat a lost acceptance response as a reason to repeat work.
- Keep permission handling and ordinary tool/transcript parsing unchanged.

## 11. Workflow migrations

### 11.1 Feature planning and story refinement: first production slice

This is the clearest initial user-visible improvement because prose and JSON are
currently coupled through required terminal tags.

- Split payload validators from `parseFeaturePlannerState` and
  `parseStoryRefinement` while preserving legacy wrappers.
- Define versioned tool schemas matching the existing allowed fields and domain
  checks. Strengthen unknown/duplicate story-ID handling explicitly and test it;
  do not accidentally turn malformed updates into replacement stories.
- Backend-generated story IDs must be durable and stable across replay. Reuse
  existing story IDs on rename; preserve refinement messages and timestamps
  according to the current application semantics.
- Prepare the result slot with the planning operation ID, target feature/story,
  and relevant state revision before dispatch.
- Replace prompts requiring tags with instructions to submit the state and then
  answer the user conversationally. Never ask the model to print the same state
  block as a second authoritative channel.
- Keep the existing confirmation boundary before generating stories. A model's
  claimed phase is not independent evidence of user confirmation. Preserve the
  product's existing confirmation flow and bind any explicit approval signal
  from that flow in backend context rather than accepting a tool boolean.
- Use the acceptance receipt for state application; use authoritative transcript
  identity for the accompanying prose. Prose persistence failure must not lose
  an accepted state result or force redispatch of the original request.
- Apply state, mark the receipt consumed, and detach the active exchange in the
  same feature-plan mutation. Preserve the compact receipt after detachment.
- Do not let an in-flight planner update drag a `building`/`built` feature back to
  discovery. Preserve existing supersession behavior.
- If a story disappears or its relevant version changes before acceptance or
  application, return a conflict/reconcile outcome rather than recreating it.
- Define the missing-final-prose behavior: retain accepted state and show a
  backend-authored receipt/status summary while transcript recovery proceeds;
  do not manufacture an assistant response or rerun feature discovery.
- Update `apps/web/src/lib/feature-planner.ts` and feature UI consumers to read
  persisted state/submission status. Keep tag stripping for old transcripts.

Exit criterion: malformed state can be corrected through the tool; a backend
restart at any persistence boundary creates neither duplicate messages nor
duplicate stories; inactive views catch up from the snapshot.

### 11.2 Independent review reports and multi-review consolidation

- Add one result slot per reviewer/pass, with the immutable review package and
  worktree baseline attached by the backend.
- Route all report acceptance through the shared validator/service, including
  the non-fanout pipeline review path.
- Tool-mode supervisors read accepted slots rather than `provider.structured`.
- Move formatting repair into tool errors. Keep existing repair helpers for
  legacy slots and the explicitly bounded reporting-only continuation.
- Keep one accepted whole report per reviewer; do not append findings directly
  to the active pool while a review is still running.
- Preserve reviewer stop choices, usage accounting, partial fanout results,
  staleness checks, and the selection of which failed reviewers to retry.
- For consolidation, pin the contributing reviewer result identities/revisions.
  Run `deriveConsolidatedProvenance` validation before acceptance and derive
  attribution in backend-owned fields. Unknown source IDs are correctable
  errors; changed source reports require reconciliation/new context.
- Retain all uncertainty and limitations; a valid schema does not make a report
  evidence-backed by itself.

Exit criterion: multi-review and pipeline report behavior match legacy results,
invalid data is corrected without repeating review work, and concurrent reviewers
cannot write each other's slots.

### 11.3 Looped-review reconciliation

- Extract the pure reconciliation contract with structured diagnostics.
- Pin the active pool revision and discovery report receipt for each attempt.
- Validate every report index exactly once, existing pool membership, and the
  correspondence of new/update operations before accepting the submission.
- Keep pool ID allocation backend-owned and make its application transactional
  with consumption so replay cannot duplicate findings.
- Do not use a model-chosen idempotency key for individual findings in this first
  implementation. The whole reconciliation is the transaction.
- Recheck the pool revision during consumption. If it changed, close the stale
  attempt and create a deliberate reconciliation against fresh context.
- Preserve round/pass allowances, stopping rules, pool archival, and fix stages.

Exit criterion: invalid references and omitted outcomes are corrected in the
same worker context; pool updates occur once across concurrency and restarts.

### 11.4 Validation discovery and preparation metadata

- `submit_validation_plan` uses the existing dependency/path/timeout/count checks
  and binds the plan to the expected HEAD.
- After acceptance and turn settlement, the controller starts the existing
  environment-owned validation runner with a durable run ID.
- Preserve the distinction between the agent's proposed commands and the
  backend's observed exit codes, durations, stdout/stderr paths, and hashes.
- Keep `review-validation-service.ts` JSON snapshot parsing and validation.
  Those snapshots are machine-generated process state, not agent final output.
- Support `submit_review_preparation` where a workflow still uses that contract;
  do not require agents to synthesize it when `validationPreparation(run)` can
  derive it from a backend-owned run.
- Preserve artifact existence/integrity checks and package sealing.
- Repeat result submission without starting the runner twice or sealing two
  incompatible packages for the same attempt.

Exit criterion: duplicate submission and restart produce one validation run and
one accepted package identity, with exact authoritative execution evidence.

### 11.5 Fix results, verification, and PR reports

- Reuse fix semantics, including the distinction between informational notes
  and blocking limitations. Give precise feedback for contradictions.
- Keep a valid incomplete fix as a valid negative result. Do not continue asking
  for `complete: true` unless the workflow deliberately dispatches more fix work.
- Verification uses the existing two-field verdict and exact worktree check.
  Submission success means the verdict was recorded, not that validation passed.
- PR result submission reports an existing PR. Keep verification against the
  environment, branch, and target before workflow completion.
- Separate PR creation from report recovery: inspect/reconcile an existing PR
  when a result or acknowledgement is missing; do not blindly rerun creation.
- Review every error/retry branch in these mutating stages for accidental fresh
  prompt dispatch after a receipt exists.

Exit criterion: report correction and delivery retries never repeat commits,
validation runs, fixes, or PR creation solely to recover their result metadata.

## 12. Prompt and schema changes

### 12.1 Shared submission instruction

Introduce one prompt helper per contract plus a shared short lifecycle rule:

> Complete the assigned work, then call the supplied submission tool with the
> complete result. If it reports invalid data, correct only the reported
> contract problems while preserving the evidence and judgments. If delivery is
> uncertain, check the result status or repeat the same submission. After
> acceptance, do not change the reviewed work; finish with a concise prose
> response. The backend decides whether the workflow can advance.

The actual prompt must include the tool name, public result key if needed,
correction budget, and domain-specific rules. It must not include credentials.
Tool descriptions explain valid negative outcomes and distinguish `accepted`
from `passed` or `completed`.

### 12.2 Remove conflicting output instructions by transport

- Do not append “final JSON only” instructions to tool-bound turns.
- Do not pass a workflow final-output schema for a tool-bound turn.
- Remove preparation-specific advice about placing progress sentences in a
  schema field for tool mode. Ordinary commentary can be ordinary prose.
- Keep meaningful taxonomy/evidence guidance even when the schema is available
  through the tool; not all domain rules are expressible in JSON Schema.
- Keep the legacy prompt helpers for persisted legacy attempts.
- Existing conversational follow-ups after workflow completion must remain free
  from the previous machine-output contract.
- Treat reviewer findings, repository content, and validation diagnostics as
  untrusted data when building any reporting-only continuation prompt.

### 12.3 Later schema simplification

After parity and reliability measurements, consider a second schema version:

- Derive totals from submitted detailed observations where the derivation is
  unambiguous. Do not invent missing observations or turn “not run” into “passed”.
- Remove backend-assigned identifiers and provenance fields from model input
  where they can be supplied by the acceptance context.
- Reference backend validation runs instead of repeating their execution data.
- Preserve model-owned judgments, evidence text, limitations, and the supporting
  source IDs required for consolidation.
- Use a deterministic adapter to produce the existing persisted/UI report shape.
- Keep old schema validators for old slots and durable artifacts.

Do not combine broad report redesign with the first transport migration. That
would make behavioral regressions harder to distinguish from delivery changes.

## 13. Bounds, retention, and performance

All limits below are proposed starting values for tool mode, not statements
about existing report limits. Validate them against representative fixtures and
real retained report sizes before rollout. Exceeding a limit must be explicit;
never silently truncate evidence to fit.

| Resource | Initial policy |
| --- | --- |
| Entire MCP HTTP request | Keep the existing 512 KiB cap; include JSON escaping/envelope overhead |
| Canonically serialized result | At most 384 KiB, additionally constrained by the wire cap and any stricter domain limit |
| Validation plan | Preserve the existing 24,000-byte plan and 32-command bounds |
| JSON nesting | At most 32 levels in the new envelope/payload validation path |
| Returned diagnostics | At most 32 issues and 16 KiB total serialized error response |
| Individual diagnostic | At most 256 characters for paths and 512 for messages; report omitted counts |
| Tool admission queue | At most 64 waiting calls and 8 MiB queued decoded data per service instance |
| Calls per result key | Serialize acceptance; allow at most 2 queued duplicate/in-flight requests before backpressure |
| Unconsumed accepted payloads | At most 8 MiB per workflow and 64 MiB service-wide in the active loaded set |
| Active slots | At most 64 per workflow; existing lower fanout limits continue to apply |
| Rejection history | At most 4 distinct invalid payload digests per slot under the default correction budget |
| Receipt/tombstone metadata | At most 4,096 entries and 2 MiB per workflow, subject to existing lower workflow bounds |
| Idle result-status reads | Bounded backoff and per-caller rate limit; no tight model polling loop |

Also set explicit node/collection count limits for each domain schema, not only
depth and bytes. Determine those counts during contract extraction so they do
not accidentally forbid existing allowed review shapes. Load persisted workflow
records through bounded readers; a bounded request does not bound the sum of all
retained accepted results.

Do not evict an unresolved slot or its only acceptance proof to admit more work.
Refuse/backpressure new admission, or archive consumed data through a durable
reference while retaining receipt metadata. Existing long-lived workflow limits
still apply. If a large legitimate review cannot fit, keep that provider/workflow
on legacy mode pending a separately designed bounded artifact/chunk protocol.

Receipts remain for the owning workflow's supported recovery lifetime. Deleted
workflow data, private connection material, and sensitive backups must be cleaned
up using the repository's existing deletion/scrubbing patterns. An expired key
must never be recreated by a late submission.

Do not serialize the full report into status events, error logs, or repeated
receipt responses. Use targeted snapshot updates and bounded result references.
Result handlers should do bounded validation/storage work only; no rendering or
external process execution belongs in them.

## 14. UI and background behavior

Add backend-projected submission status to existing workflow/session snapshots.
Suggested user-facing messages:

- “Preparing report” while the worker is running before submission.
- “Correcting report format” after correctable rejection.
- “Report received; finishing checks” after acceptance before consumption.
- “Report needs attention” after bounded recovery is exhausted.

Do not expose internal credential IDs, lease tokens, digests, or raw SDK errors
in the product flow. A report accepted with a failing verdict must not receive a
green success presentation merely because submission succeeded.

Requirements:

- Render ordinary commentary and the final prose normally for tool-bound turns.
- Show the submission tool as a concise result/status entry; avoid rendering an
  enormous raw report by default. Structured review panels remain the useful
  presentation of the data.
- Persist model-visible validation failures and acceptance identity sufficiently
  for transcript recovery, without logging full reports.
- Rehydrate pending/accepted/failed state from snapshots on mount, activation,
  reconnect, and revision gaps.
- Do not cancel a tool call or workflow when its tab/component unmounts.
- Preserve pending interactions and existing user controls during correction.
- Distinguish “retry report delivery”, “retry work”, and “cancel” internally;
  offer only the recovery actions valid for the authoritative state.
- Keep independent local and remote windows consistent through existing revision
  handling. No new renderer-owned polling controller.

## 15. Compatibility and rollout

### 15.1 Persist transport selection

- New qualified attempts record `tool-v1` with an explicit schema version.
- Old records without transport metadata retain their current behavior:
  structured-output for review/pipeline results, tagged blocks for planning.
- Do not attach tools halfway through an ambiguous legacy dispatch and accept a
  second result channel for it.
- New attempts after a safe workflow boundary may select tool mode even when
  earlier rounds used legacy mode. The boundary and selection must be durable.
- Unknown transport/schema versions must produce an explicit unsupported state;
  do not guess or parse arbitrary prose.

### 15.2 Rollout controls

Use a backend-owned qualification/rollout setting per provider and workflow
kind. Prefer an internal rollout configuration to adding a user-facing transport
choice. Record the selected mode on admission; configuration changes affect new
attempts only.

Recommended order:

1. Shared protocol, diagnostic validators, and storage behind disabled admission.
2. One qualified provider plus feature planning end to end.
3. Reviewer reports and reconciliation on qualified providers.
4. Consolidation, validation discovery/preparation, fix, verification, and PR
   reporting.
5. Remaining provider adapters as each passes conformance.
6. Schema simplification and legacy writer removal after evidence supports it.

### 15.3 Rollback

- Disable new tool-mode admission without rewriting in-flight slots.
- Continue serving tool submissions/receipts for admitted tool-mode work.
- Keep old and new readers during the compatibility period.
- A code rollback to a release that cannot read tool-mode records is not safe
  while those records are active. Drain/cancel them through the current version
  or deploy a compatibility reader; document this release constraint.
- Do not turn an accepted tool result into a synthetic assistant JSON message
  to satisfy an older parser. Adapt the persisted domain result explicitly.

## 16. Implementation sequence and deliverables

Each phase should be a reviewable feature-branch PR. Follow repository policy:
never push directly to `main`, and leave merging to a human maintainer.

### Phase 0 — Inventory and provider qualification design

- [x] Confirm every actual `schema`/`structured` workflow caller and the tagged
  planner consumers against the inventory above.
- [x] Record exact provider/runtime versions and available tool APIs.
- [x] Design the connection renewal/isolation strategy for each provider.
- [x] Check real report sizes and set domain count/byte limits.
- [x] Identify the exact storage mutation boundary for each workflow type.
- [x] Audit locks around provider dispatch for callback deadlocks.
- [x] Record unsupported provider/policy combinations explicitly.

Deliverable: a capability matrix and small executable probes with no production
behavior change. Do not mark tool support qualified based only on documentation.

### Phase 1 — Shared contracts and diagnostic validation

- [x] Add protocol types, schema registry, errors, receipts, and limits.
- [x] Extract planner payload and reconciliation validators.
- [x] Add diagnostic forms for preparation, fix, PR, and validation-plan checks.
- [x] Reuse existing report schema/validation; keep legacy wrappers intact.
- [x] Add canonical digest and bounded error serialization helpers.
- [x] Add validator parity tests and malformed/native callback input tests.

Deliverable: typed, tested result contracts without changing current dispatch.

### Phase 2 — Atomic slots, receipts, and service

- [x] Add result metadata to owning persisted workflow/feature shapes and validators.
- [x] Implement atomic slot admission, acceptance, rejection accounting, lookup,
  cancellation, supersession, and consumption helpers.
- [x] Protect trusted fields from public renderer mutation commands.
- [x] Add controller reload behavior on result-induced revision conflicts.
- [x] Retain planning receipts after active-record detachment.
- [x] Implement retention, quotas, restart loading, and sensitive-data deletion.
- [x] Implement the service without provider calls inside storage transactions.
- [x] Pass crash-window and concurrency tests before exposing real tools.

Deliverable: a durable backend result service tested independently of models.

### Phase 3 — Tool transport and one provider

- [x] Add narrow capability issuance and renewal.
- [x] Register typed tools and status lookup with model-visible errors.
- [x] Extend trusted provider create/send bindings and capability negotiation.
- [x] Wire direct workflow provider/session creation, not just interactive tabs.
- [x] Implement one complete provider adapter, including restricted policy and
  backend restart behavior.
- [x] Verify success, invalid input correction, duplicate delivery, and two-session
  isolation with fake and opt-in live tests.

Deliverable: a qualified reporting channel with admission still controlled.

### Phase 4 — Feature planning pilot

- [x] Prepare slots and update feature/story prompts for tool mode.
- [x] Apply accepted state with operation/revision fencing and stable story IDs.
- [x] Preserve prose, confirmation semantics, and legacy tagged transcripts.
- [x] Add UI projection and inactive-view recovery coverage.
- [x] Enable only the qualified provider/planning combination.

Deliverable: the first complete user workflow with a measured legacy comparison.

### Phase 5 — Review reports and reconciliation

- [x] Migrate fanout and non-fanout pipeline report consumers.
- [x] Migrate multi-review report/consolidation acceptance with provenance checks.
- [x] Migrate looped discovery and reconciliation with pool-version fencing.
- [x] Preserve repair helpers exclusively for legacy/reporting-only recovery.
- [x] Add side-by-side semantic parity fixtures and source-drift tests.

Deliverable: review workflows use one acceptance service and preserve existing
findings, stopping rules, and evidence boundaries.

### Phase 6 — Remaining pipeline result contracts

- [x] Migrate validation-plan and preparation consumers.
- [x] Migrate fix, verification, and PR report consumers where actually used.
- [x] Reconcile external effects before recovery dispatch.
- [x] Prove submission retries do not duplicate command runs, commits, or PRs.

Deliverable: every in-scope workflow result has a qualified tool-mode path.

### Phase 7 — Remaining providers and rollout

- [x] Complete Claude and Codex adapters. OpenCode, Pi, Cursor, and ACP are not
  started: none of them has a per-turn MCP attachment in any path, so enabling
  them needs bridge protocol work before an adapter is meaningful.
- [x] Pass the same transport/concurrency/recovery contract for each enabled
  adapter (`workflow-result-conformance.test.ts`).
- [x] Validate local worktrees, container host addressing, and the restricted
  review policy. Browser/Electron/remote projections read the same snapshot
  field and are covered by component tests, not by a live multi-window probe.
- [x] Enable combinations individually based on evidence
  (`global.workflowResultTools`).
- [x] Document explicit fallback for any unqualified combination.

Deliverable: truthful provider coverage and operational rollback instructions.

### Phase 8 — Simplification and cleanup

- [ ] Compare reliability, correction frequency, latency, and resource usage.
  The metrics needed for this comparison exist (`get_workflow_result_metrics`);
  the pilot measurement itself has not been run.
- [ ] Introduce simpler versioned tool inputs only where domain parity is proven.
  Deliberately deferred: the plan requires measurement first.
- [x] Stop generating legacy output for fully qualified new attempts.
- [x] Remove obsolete callers/helpers only after a reference audit. Nothing was
  removed: every legacy reader is still reachable from a persisted record.
- [x] Retain readers required by persisted workflows, history, and other APIs.
- [x] Update architecture and operational documentation with delivered behavior.

Deliverable: smaller result orchestration without losing compatibility or
weakening validation.

## 17. Test strategy

### 17.1 Shared domain contract tests

Use meaningful fixtures from the existing protocol/workflow suites:

- Valid result for every kind, including empty valid collections and explicit
  negative/incomplete outcomes.
- Wrong types, missing/unknown properties, enum confusion, and boundary values.
- Mismatched totals, duplicate IDs/indexes, missing reconciliation outcomes,
  unknown pool/source IDs, and contradictory fix completion.
- Oversized UTF-8 and escaped strings, excessive nesting/counts, and native
  callback values that cannot be safely represented as JSON.
- All validators run despite diagnostic truncation; error paths remain useful.
- Legacy payload and tool payload produce equivalent accepted domain results.
- No “repair” changes observed failures, limitations, or confidence judgments.

### 17.2 Storage and service failure matrix

| Scenario | Required result |
| --- | --- |
| Invalid submission, then corrected valid input | One acceptance; invalid data never applied |
| Same invalid input delivered twice | Same diagnostic; one distinct correction budget entry |
| Two simultaneous identical valid calls | One receipt and one accepted payload |
| Two simultaneous different valid calls | One winner; other reports conflict |
| Save fails before acceptance | No success receipt; safe lookup/resubmission |
| Save succeeds, tool response is lost | Restart/status lookup returns original receipt |
| Controller holds an older workflow revision | Reloads; cannot erase accepted slot |
| Crash after acceptance, before consumption | Result survives; controller settles and consumes once |
| Crash after consumption, before event delivery | Snapshot shows completed transition; no duplicate action |
| Feature active record detached before duplicate delivery | Retained receipt still proves prior acceptance |
| Cancellation races with acceptance | Serialized winner; cancellation prevents later consumption |
| Workflow pauses while its worker submits | Result retained under the existing pause policy; no next-stage dispatch until resume |
| Worker replacement or dead generation calls back | Rejected without affecting replacement's result |
| Backend lease takeover with same live worker | Legitimate submission remains authorized |
| Old accepted key replayed after stage advances | Original receipt returned, no second transition |
| Unknown/expired key | No fabricated absence proof or redispatch recommendation |
| Context changes between validation and save | Conflict/reconcile, no stale acceptance |
| Context changes between acceptance and consumption | Finalization blocked, accepted history preserved |
| Queue/storage quota reached | Explicit bounded backpressure, no silent event/result loss |
| Backward clock change or repeated status reads | Recovery remains bounded; observations do not manufacture progress |

Use storage fault injection around actual write boundaries and fresh service
instances. Tests that merely call a mock `save` twice do not prove restart safety.

### 17.3 Provider conformance

For each enabled adapter:

1. Tool is available before the first workflow prompt runs.
2. Provider exposes the correct schema and receives errors as tool feedback.
3. Invalid then corrected calls reach one accepted receipt.
4. An accepted result is recoverable when its response is lost.
5. Another session in the same bridge cannot submit it.
6. A subagent cannot inherit submission authority accidentally.
7. Restricted review policy still blocks source mutations and untrusted tools.
8. Backend reconnect/credential renewal works as documented.
9. Provider generation death closes write authority without losing receipts.
10. Final prose is visible and no JSON final message is required.
11. Missing tool invocation reaches bounded recovery rather than an infinite wait.
12. Slow storage does not stall unrelated provider notifications/threads.

Use existing fake provider/CLI/RPC harnesses for deterministic failure injection.
Use small opt-in live probes to verify actual model-visible tool discovery and
correction. Do not make the normal unit suite depend on paid model calls.

### 17.4 Workflow and UI integration

- Feature discovery, user confirmation, story creation, rename, and refinement.
- Feature starts building or story is removed while its planning result is in
  flight; stale state is not applied.
- Multi-review with several successful/failed/stopped reviewers and consolidation.
- Looped review across discovery, reconciliation, fix, and another round.
- Validation discovery with independent/dependent commands and backend artifacts.
- Verification negative verdict follows the existing fix/max-iteration path.
- Fix failure/limitation remains visible and cannot be formatted into completion.
- PR already exists when a reporting-only continuation runs.
- Agent submits a report and then edits the worktree; stage cannot advance.
- Agent submits valid data and then errors; receipt survives, completion blocks.
- Mixed old/new persisted attempts recover without double acceptance.

Mandatory inactive-environment scenario:

1. Start a tool-bound workflow in environment A.
2. Switch to environment B and another tab/view before submission.
3. Let A receive a rejection, correct it, and obtain acceptance.
4. Let it finish or reach an interaction/failure while A is not mounted.
5. Return to A and verify report, messages, pending prompts, controls, and stage.
6. Repeat with renderer reload, backend restart, and a dropped live event.

Also test two desktop/browser windows so a stale projected snapshot cannot clear
result state written by the other connection.

### 17.5 Repository validation commands

Run focused suites as their phases land, using explicit paths. New test filenames
below are planned examples, to be created with the implementation:

```bash
bun test packages/protocol/src/workflow-results.test.ts
bun test apps/backend/src/core/workflow-result-service.test.ts
bun test apps/backend/src/core/workflow-result-tools.test.ts
bun test apps/backend/src/core/feature-planning.test.ts
bun test apps/backend/src/core/storage-feature-planning.test.ts
bun test apps/backend/src/core/looped-review-service.test.ts
bun test apps/backend/src/core/multi-review-service.test.ts
bun test apps/backend/src/core/build-pipeline-review-fanout.test.ts
```

Run the relevant bridge suites with explicit test paths, then repository checks
and the declared aggregate suite when validating the integrated change:

```bash
bun run check
bun run test
```

Do not use bare root `bun test`; it does not run the declared aggregate suite.
If package metadata changes, follow the complete Bun/lockfile workflow in
`AGENTS.md`, including both frozen installs and the version-drift test.

For real-stack UI and provider probes, use isolated profiles and the existing
[`../development/agent-testing.md`](../development/agent-testing.md) runbook.
Record exact executed commands and results in each implementation PR. This plan
does not claim these proposed tests already exist or have passed.

## 18. Observability and success criteria

Collect only bounded, content-free operational metrics:

- Attempts by provider, workflow kind, transport, and schema version.
- Accepted submissions, duplicate replays, conflicts, and rejected submissions
  by a fixed error-code set.
- Distinct correction attempts and reporting-only continuation counts.
- Time from first submission to acceptance and acceptance to consumption.
- Missing submissions and observation/connection recovery outcomes.
- Queue sizes/bytes, validation duration, storage duration, and retained bytes.
- Workflow completion/failure rates and existing usage totals where comparable.

Do not log payloads, prompts, report text, command output, credentials, raw error
values, evidence paths, or payload digests. Avoid per-result IDs as metric labels.
Diagnostics containing evidence belong in authorized persisted workflow data,
not general logs. Test redaction with representative malicious/secret-like input.

Compare tool and legacy modes on equivalent fixture tasks/provider versions.
Separate formatting/schema failure, semantic result rejection, delivery failure,
and actual task failure. A fall in parser errors does not prove reviews improved.

Rollout requirements:

- Zero duplicate domain applications in deterministic concurrency/crash tests.
- Zero automatic repetition of external mutations caused solely by result
  delivery retries in the workflow fault-injection suite.
- Every enabled provider passes discovery, correction, isolation, and its stated
  reconnect behavior.
- No regression in inactive-environment recovery or execution policy.
- Report/pool/verification semantics match legacy fixtures.
- Size and latency remain within declared budgets on representative workloads.
- Formatting/delivery failures improve or are at least no worse in a recorded
  pilot; do not assert a numerical improvement before measurement.

## 19. Definition of done

- [x] Every in-scope contract has a typed submission tool and authoritative
  validator, or an explicitly documented unqualified-provider fallback.
- [x] Tool-mode completion never depends on parsing final assistant JSON.
- [x] Accepted data and receipt survive process restart before acknowledgement.
- [x] Identical retries are deduplicated; conflicting/stale submissions are
  rejected; corrected invalid data can still be accepted.
- [x] Receipt acceptance and workflow completion are distinct in storage and UI.
- [x] Stage transitions preserve existing turn-settlement and external-state
  checks, and consume accepted results once.
- [x] Reporting recovery cannot repeat fixes, commits, validation, or PR creation
  without explicit reconciled workflow intent.
- [x] Restricted workers gain only their narrow reporting capability.
- [x] Concurrent sessions, subagents, and replacement generations cannot write
  another worker's result.
- [x] Queues, payloads, diagnostics, retained data, and recovery loops are bounded.
- [x] Old workflows/transcripts remain readable, and rollback behavior is tested.
- [x] Foreground/background, local/container, and supported UI paths pass the
  relevant integration scenarios.
- [x] Required checks pass and implementation PRs include their evidence.
- [x] Delivered architecture and remaining provider limitations are documented.

## 20. References

- Repository guidance: [`../../AGENTS.md`](../../AGENTS.md).
- Existing provider-neutral structured output:
  [`../../packages/protocol/src/structured-output.ts`](../../packages/protocol/src/structured-output.ts).
- Review schemas and domain validation:
  [`../../packages/protocol/src/structured-review/schema.ts`](../../packages/protocol/src/structured-review/schema.ts)
  and [`validation.ts`](../../packages/protocol/src/structured-review/validation.ts).
- Existing targeted report repair:
  [`../../apps/backend/src/core/build-pipeline-prompts.ts`](../../apps/backend/src/core/build-pipeline-prompts.ts).
- Provider engine architecture:
  [`../technical-architecture/agent-engines.md`](../technical-architecture/agent-engines.md).
- Current agent tool transport:
  [`../../apps/backend/src/core/agent-tools.ts`](../../apps/backend/src/core/agent-tools.ts).
- MCP tool schemas and model-visible execution errors:
  [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
  MCP tool input/output schemas and `isError` feedback are relevant mechanisms;
  application receipt durability, deduplication, and workflow settlement are
  responsibilities defined by this plan.
