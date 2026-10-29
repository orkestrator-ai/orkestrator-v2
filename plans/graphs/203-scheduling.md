---
id: 203
title: "Scheduling"
phase: 2
plan: "P2.3"
status: in-progress
depends_on: [202]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-202-supervisor"
pr: ""
updated: 2026-10-29
---

# 203 · Scheduling

- **Plan:** [P2.3 Scheduling](../composable-graphs.md#p23-scheduling)
- **Decisions:** D3
- **Depends on:** [202](202-supervisor-domain.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Each pass decides which activations may start, without breaking workspace safety or admission budgets.

## Work

- [x] Ready set: activations whose required inputs are live and whose `when` holds, computed under the run lock.
- [x] Workspace locks: one writer at a time; no reader alongside a writer (D3).
- [x] Admission through the work-admission pool and the per-provider caps (4/8/4/16).
- [x] Enforce `limits.maxConcurrentAgents` and `limits.maxAgentSessions` at admission.
- [x] Enforce `limits.maxTokens` (a soft meter over `usage.tokens`) at admission and `limits.maxWallClockMs` in the pass.
- [x] Observe running activations every 3 s plus jitter.
- [x] Skeleton for `graph-run-efficiency.bench.test.ts`.

## Tests

- [x] Ready-set unit tests over small plans.
- [x] Locks keep a writer and a reader apart.
- [x] Admission caps hold under a wide fan-out.
- [x] Token and wall-clock limits: the meter lets running agents finish and then fails the next agent naming it; mock runs are not metered; a run past its wall clock fails and stops its agents and human waits, also when paused or waiting on a person.

## Done when

- [x] Activations start in a safe, bounded order, and the benchmark skeleton runs.

## Notes

**2026-10-29 · Files.** Backend: `graph-run-scheduling.ts` (`planGraphRun` to a fixpoint,
`GraphWorkspaceLocks`, `selectGraphAdmissions`, run activity and settling, required outputs),
`graph-run-ready-set.ts` (`computeGraphReadySet`, input resolution), `graph-run-loops.ts` (loop
progress), `graph-run-view.ts` (indexed read-only view of a run), `graph-run-pass.ts` (the pass's
planning, admission, start and cadence phases), `graph-run-efficiency.bench.test.ts`. Protocol:
`graphs/run-branches.ts` (`graphNodeBranches`, `graphBranchBinding`, exported from
`./graphs/run`). Tests: `graph-run-ready-set.test.ts` (pure, §9.1 and §9.2 examples and
hand-written plans through `compile()`), `graph-run-scheduling.test.ts` (service-level passes with
the pass-through executors of `graph-run-executor-test-support.ts`).

**2026-10-29 · A pass** (under the run's lock; reads only its own row): provision → (cancelling:
cancel admitted, cancel waiting/ready, settle) → hand admitted activations to executors (`recover`
once per process, `start` again while `admitting`, `observe` when due, `cancel` on `timeoutMs`) →
unless paused, up to 16 rounds of: plan to a fixpoint, admit, **save (journal point)**, start the
admitted; another round only when a start settled at once (gates, merges) → derive status → save if
changed. Saves are compare-and-swap; a pass that changed nothing writes nothing.

**2026-10-29 · Ready set** (`graph-run-ready-set.ts`; semantics also in its header).
- Edges deliver per `iterations`: `all`; `first` on iteration 1; `later` from 2 (the compiler turns
  `firstIterationFrom` into this split). Carries (`<loop>#<i>`) deliver from iteration 2, reading
  the producer's previous iteration; on iteration 1 they deliver nothing, so a later-only entry
  (§9.2 `fix`) skips there.
- Producer iteration: same loop → same iteration; producer inside a loop the consumer is not in →
  the loop's last iteration once the loop is done (pending until then); otherwise 1.
- A producer delivers its port's artifact when `complete` (and, from a gate or human outlet, only
  if `outlet` matches); `failed` delivers only a routed output (`onFailure: route`); `skipped`,
  `cancelled` and other outlets deliver nothing (absent); anything not terminal is pending.
- Fan-in (replicated producer into a list port without `zip`) follows the port's collect policy:
  `all-settled` waits for every branch, `quorum`/`first` deliver at `count` successes; fewer than
  `minSuccessful` possible successes fail the port. `zip` reads the same branch. A single-value port
  takes its live producer (the compiler proves producers exclusive); a list port concatenates.
- A position resolves to `skipped` when a required input is absent or its `when` is not true
  (`evaluateGraphPredicate`, three-valued; values loaded on demand), `failed` (`system-error`) when a
  required fan-in cannot meet its policy, else `ready` with its inputs bound. Absent optional
  inputs are left out.
- **Skip propagation (deviation, recorded).** Propagation is computed from the dataflow, not read
  from the plan's `skippable`: a skipped node's outputs are absent, so consumers whose required
  input has no other live producer skip in the same pass, and a consumer with another live
  producer still runs (§9.2 `verify` after a skipped `address`). `skippable` is the compiler's
  static over-approximation; the runtime does not need it.

**2026-10-29 · Implemented here beyond the item text (decisions; 205/206 review and extend).**
Loops: an iteration is settled when every member position at it is terminal; the loop is done at
`maxIterations`, when no member ran (all skipped: not entered), or when `until` holds over
`<member>.<port>` values; otherwise `loopIterations[loop]` moves on. Done is derived, not stored.
Retries: the latest failed activation is retried (new attempt, same inputs) while live attempts <
`retry.attempts` and its cause is in `retry.on`; then `onFailure`: `fail-run` fails the run,
`skip`/`route` let the dataflow decide. `timeoutMs`: the pass cancels the activation (reason
`timeout`) and fails it with cause `timeout`. Branch keys (`graphNodeBranches`): `panel.<n>`
(1-based), `lens.<key>`, `sample.<n>`, a product joined with `+` in axis order; `items` throws
until 401. Left to 205: `first` cancelling the remaining branches, `includeFailures` failure
markers (lists carry successes only). Left to 206: the gate and merge executors (the fake gate in
the test support only evaluates branches), merge semantics, `error@1` artifacts for `route`.

**2026-10-29 · Workspace locks (D3, §6.7).** Holders are admitted activations (`admitting`,
`running`, `awaiting-human`) by their node's `workspaceAccess`. A writer needs no other holder; a
reader needs no writer; `none` needs nothing. Locks are per environment across every run
(`GraphWorkspaceLocks`, an in-memory projection: reserved synchronously at admission before any
await, re-synced to the stored record after every pass, seeded by startup discovery). A blocked
writer is not overtaken by later readers or writers in the same pass. A release wakes the
environment's runs with `advance`/`observe` obligations.

**2026-10-29 · Admission.** In record order (plan order within a round): an agent activation needs
`usage.agentSessions < limits.maxAgentSessions` (counted at admission, retries included; when it can
never be met the activation fails `budget-exceeded`) and fewer than `limits.maxConcurrentAgents`
admitted agent activations; then the workspace lock. The 200 live-activation cap is enforced when
planning appends (`appendGraphActivation`); a refused append fails the run `budget-exceeded`.
Executor calls run under `runBoundedTasks` with `reviewFanoutConcurrency` (4 starting, 8 observing,
4 per provider, ceiling 16; group = the binding's platform for agents, the node kind otherwise).
Each keyed pass holds one `workflow-provider` slot (target = the environment), passed to executors
as `lease` for nested hand-off.

**2026-10-29 · Observation cadence.** Running activations are observed when 3 s have passed since
their last call (`GRAPH_RUN_OBSERVATION_MS`), or an executor's `observeAfterMs` (`null` = only when
flagged), or when flagged (accepted result slot, `requestObservation`). The run's next pass is the
earliest due observation plus `stableSpreadMs(runId, 1 s)` (the stable spread Multi Review uses);
admitting activations retry every 1 s; a run waiting only for a person every 30 s.

**2026-10-29 · Run statuses** (`GRAPH_RUN_STATUS_TRANSITIONS`, `transitionGraphRun`).
`provisioning` → `running` (environment ready) | `failed` | `cancelling` | `cancelled`;
`running`/`waiting`/`paused` → each other (`pause` from running/waiting only, `resume` from paused),
`cancelling`, `complete`, `failed`; `cancelling` → `cancelled` | `failed`. `waiting` = admitted
activations are all `awaiting-human` and nothing is ready. `complete` when every position is
settled, every loop done and every required run output produced (else `failed`, "Required outputs
were not produced: …"). A failure with admitted work goes through `cancelling` (error recorded,
executors stopped with reason `run-failed`) and ends `failed`. Activation transitions:
`GRAPH_ACTIVATION_TRANSITIONS`; an impossible executor report fails that activation
(`system-error`) instead of corrupting the record.

**2026-10-29 · Executor contract** (`graph-run-executors.ts`; lifecycle rules in its header).
Register with `graphRuns.executors.register(executor, {mock?})`; one per kind; a mock run never
falls back to a live `agent` or `system` executor. A kind with no executor fails its activations
(`system-error`, "No executor is registered for <kind> nodes").

```ts
export type GraphExecutableNodeKind = "agent" | "system" | "gate" | "merge" | "human";
export type GraphCancelReason = "run-cancelled" | "run-failed" | "timeout";
export type GraphExecutorOperation = "start" | "observe" | "recover" | "cancel";

export interface GraphActivationFacts {
  session?: GraphActivationSession;
  policy?: NativeAgentExecutionPolicy; // with enforcement, before session
  enforcement?: GraphEnforcementTier;
  enforcementReason?: string;
  baseline?: { headRef: string; pathsDigest: string };
  guards?: GraphGuardResult[]; // replaces; at most 8
  usage?: { tokens: number; cacheReadTokens?: number }; // delta
  observeAfterMs?: number | null; // null: only when woken
}

export type GraphActivationReport =
  | (GraphActivationFacts & { state: "unchanged" })
  | (GraphActivationFacts & { state: "running" })
  | (GraphActivationFacts & { state: "awaiting-human" })
  | (GraphActivationFacts & { state: "complete"; outputs: Record<string, string>; outlet?: string })
  | (GraphActivationFacts & {
      state: "failed"; error: string; cause: GraphErrorCause; outputs?: Record<string, string>;
    })
  | (GraphActivationFacts & { state: "cancelled"; error?: string });

export interface GraphExecutorContext {
  readonly operation: GraphExecutorOperation;
  readonly run: Readonly<GraphRun>;
  readonly node: GraphPlanNode;
  readonly activation: Readonly<NodeActivation>;
  readonly binding?: GraphModelBinding; // agent: the branch's model
  readonly environmentId: string;
  readonly artifacts: GraphArtifactStore; // verify inputs; putValue/putFile outputs
  readonly signal: AbortSignal;
  readonly lease?: AdmissionLease; // pass as `holding` for nested acquisitions
  wake(): void;
  now(): Date;
}

export interface GraphNodeExecutor {
  readonly kind: GraphExecutableNodeKind;
  start(context: GraphExecutorContext): Promise<GraphActivationReport>;
  observe(context: GraphExecutorContext): Promise<GraphActivationReport>;
  cancel(context: GraphExecutorContext, reason: GraphCancelReason): Promise<GraphActivationReport>;
  recover?(context: GraphExecutorContext): Promise<GraphActivationReport>;
}
```

Rules: `start` runs after `admitting` is saved and may run again for the same activation (crash,
lost save, or no `recover`), so it is idempotent per activation key. `recover` runs once per
backend process per admitted activation, before any `observe`. `observe` at most once per pass.
`cancel` reporting `unchanged` is retried; after 3 attempts the pass settles the activation anyway
("could not be confirmed"). Throwing fails the activation with `system-error` and the message
(bounded; keep payloads out); a call that throws while the backend stops is ignored. Outputs are
artifact ids stored first through `context.artifacts` (validated against the frozen plan's
types). Gates and human nodes complete with `outlet` and forward the outlet's input ids as outputs
(`NodeActivation.outlet`).

**2026-10-29 · Benchmark** (`graph-run-efficiency.bench.test.ts`, default tier: deterministic,
manual clock, no waits; `GRAPH_RUN_BENCH_OUT`, `GRAPH_RUN_BENCH_REPORT_ONLY`). Fan-out widths
1–32 with two providers, and 50 retained finished runs. Gates (all met): one run-row read per pass
and no store listing; admission pass saves ≤ 2 and starts every branch; a pass that only observes
unchanged work saves nothing and observes each running branch once; at most 4 starts and 8
observations in flight; retained history changes neither SQLite row fetches nor saves. Measured:
1 row read and 1 SQLite row per running pass at every width; admission 3 SQLite rows, 2 saves.

**2026-10-29 · Token and wall-clock limits** (closes the gap `docs/architecture/graphs.md` listed
under "Known gaps"; branch `graphs-limits-schedules`). Both limits stay optional in the template
(101) and were already compiled into `plan.limits` and shown; now the runtime enforces them.

- `limits.maxTokens` is a soft meter over `run.usage.tokens`, the tokens finished agent
  activations reported (`usage` on their reports, summed by `applyGraphActivationReport`). In
  `selectGraphAdmissions`, once `usage.tokens >= maxTokens` (`graphRunTokensExhausted`) no ready
  agent activation is admitted. While any agent activation of the run is still admitted it is
  blocked (`GraphAdmissionBlock` `token-budget`), so the running agents finish and report; once
  none runs it is `exhausted` and the pass fails it with `budget-exceeded` and
  `graphRunMeterError` ("The run reached its token limit (limits.maxTokens N; M used), so no
  further agent session starts"). Its `onFailure` then decides: the default `fail-run` fails the
  run with that text after "Node X failed: ", `skip`/`route` carry on without it. Gates, merges,
  system and human nodes are never metered. The meter never cancels running work. Mock runs are
  never metered (their executors report no tokens, and the check skips `run.mock`).
  `GraphAdmissionDecision.exhausted` is now `{key, meter: "agent-sessions" | "tokens"}[]`.
- `limits.maxWallClockMs` counts from `startedAt` (paused time included: it bounds the run's
  lifetime; provisioning before the first `running` is not counted). At the start of each pass
  over a `running`, `waiting` or `paused` run, `graphRunWallClockExceeded` fails the run through
  `failRun` with `budget-exceeded` and `graphRunWallClockError` ("The run exceeded its wall-clock
  limit of 2 h (limits.maxWallClockMs)"). That is the ordinary run-failure path: waiting and
  ready activations are cancelled, admitted ones (running agents, human nodes awaiting a person)
  are stopped through their executor's `cancel` with reason `run-failed`, then the run settles
  `failed`. No new cancel reason was needed. The pass's next delay is never later than the
  deadline (plus 1 ms), so a run waiting on a person (30 s cadence) or paused (no cadence) is
  woken in time. Helpers: `graphRunWallClockDeadline`, `graphRunWallClockExceeded`,
  `graphRunWallClockError` in `graph-run-scheduling.ts`.
- Run view: the header summary shows usage against the limits when the template sets them
  ("1m 30s of 1h 0m 0s · 2.5k of 50k tokens"; `components/graph-run/graph-run-summary.ts`); a
  mock run shows no token limit.
- Tests: `apps/backend/src/core/graph-run-limits.test.ts` (9: the meter and its mock exemption,
  blocked then exhausted admission, a running agent finishing before the run fails naming the
  meter with no cancel and no start of the next agent, completion below the meter, a mock run
  past the meter completing, the deadline arithmetic, an over-time run cancelling its agent with
  `run-failed`, a paused run and a run waiting on a person woken at their deadline by the keyed
  supervisor); `graph-run-summary.test.ts` (3). The fake executors take per-node token usage
  (`FakeGraphExecutors.tokens`).

**2026-10-29 · For later items.** 204: implement `agent` against this contract (session facts,
idempotent `start` via the dispatch journal, `recover` via `provider-dispatch-recovery.ts`, report
token usage deltas); the `GraphExecutorContext.binding` is the branch's model. 205: collect gaps
above; keep branch keys stable. 206: gate/merge executors; failure routes. 207: `system` executor;
`prepare-environment` and the `provisioner` hook. 208: `human` executor (`awaiting-human`,
`observeAfterMs: null`, `requestObservation` on answer; `timeoutMs` arrives as `cancel(…,
"timeout")` — report `failed` with the routed `error` output to route it). 209: guard results via
`guards`, enforcement via `policy`/`enforcement`. 210: rewinds supersede activations; the ready set
recreates superseded positions with the next attempt and the same inputs. 213: register mock
executors with `{mock: true}`. Extend the benchmark with real executors and loops.

**2026-10-29 · Audit: D3 across engines.** `GraphWorkspaceLocks` saw only graph
runs. `workspace-writers.ts` now projects every holder of a checkout: Build
Pipelines (Build, Fix, package preparation, Address, Verify, PR, conflict
resolution and setup write; reviewing reads; a running session counts by its
stage) and bespoke Multi Reviews (preparing and fixing write; reviewing and
consolidating read). `selectGraphAdmissions` takes `external` from
`WorkspaceWriters.externalHold` (new block `external-workflow` with
`holder`/`holderAccess`; an unseeded projection blocks as `recovering`).
Decision: graph readers wait for an external writer too (D3: no reader beside a
writer; a read-only node's guard would fail on the other engine's edits). The
pass persists `NodeActivation.blocked` (`GRAPH_ACTIVATION_BLOCK_REASONS`,
`GRAPH_WORKSPACE_HOLDER_KINDS`; validated by `run-guards.ts`) for every block
reason and clears it on admission or settle. Build Pipeline stages claim the
checkout through `WorkspaceWriters.claim` before anything is saved or sent and
wait on `WorkspaceBusyError`, re-derived on the next pass. The projection is
seeded by one scan per store, then kept by record notes and resource changes.
Interactive agent tabs are out of scope; a bespoke Multi Review does not wait
for a graph writer (graphs.md Known gaps). Tests: `workspace-writers.test.ts`,
`build-pipeline-workspace-writers.test.ts`,
`graph-run-external-workspace.test.ts`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Ready set with iterations, carries, outlets, collect and `when`; loops, retries, timeouts; D3 workspace locks across runs; admission limits and per-operation caps; 3 s observation cadence; run statuses; benchmark skeleton; tests. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Enforced `limits.maxTokens` (soft meter at admission) and `limits.maxWallClockMs` (run fails, admitted work cancelled `run-failed`, deadline wakes paused and waiting runs); usage vs limits in the run view header; `graph-run-limits.test.ts`. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · cross-engine workspace holders (`workspace-writers.ts`), persisted admission blocks · awaiting PR
