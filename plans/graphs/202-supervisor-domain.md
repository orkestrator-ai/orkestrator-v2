---
id: 202
title: "Supervisor domain"
phase: 2
plan: "P2.2"
status: in-progress
depends_on: [201]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-202-supervisor"
pr: ""
updated: 2026-10-29
---

# 202 · Supervisor domain

- **Plan:** [P2.2 Supervisor domain](../composable-graphs.md#p22-supervisor-domain)
- **Decisions:** none
- **Depends on:** [201](201-run-record-and-storage.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Graph runs are driven by the keyed workflow supervisor like the other workflow domains.

## Work

- [x] Add `graph-run` to `KEYED_SCHEDULING_DOMAINS` (`workflow-supervisor.ts`), covered by `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`.
- [x] An obligation classifier for run records; one key per run.
- [x] Wake on the existing reasons; `result-accepted` wakes only the owning run.
- [x] Safety discovery registers runs a wakeup missed.

## Tests

- [x] Discovery registers a run whose wakeup was lost.
- [x] An accepted result wakes only its run.
- [x] The rollback switch disables the domain.

## Done when

- [x] Runs advance after backend restarts without a renderer.

## Notes

**2026-10-29 · Files.** Backend: `graph-run-supervisor.ts` (obligations, discovery, the
result-key index, the supervisor factory), `graph-run-service.ts` (`GraphRunService`: the public
API and the `KeyedWorkflowOwner`), `graph-run-pass.ts` (one pass over one run),
`graph-run-executors.ts` (the node executor contract and registry), `graph-run-transitions.ts`
(pure run and activation transitions), `graph-run-executor-test-support.ts` (pass-through fake
executors and a storage world for tests). Wired in `index.ts` (`context.graphRuns`, a
`GraphArtifactStore` over the environment fence, the shared `workflow-provider` pool, init after
Multi Review, drain on shutdown). Protocol: recurring kind `graph-run-tick` (inventory **B28**,
`recurring-work.ts`); resource kind `graph-run` (`resource-events.ts`, announced by
`storage-graph-runs.ts` on create, save and environment deletion with the run id and project);
`NodeActivation.outlet` (gate and human nodes: the outlet taken). Docs: `recurring-work.md`
(keyed domains, B28, rollback list), `storage.md`. Tests: `graph-run-supervisor.test.ts`.

**2026-10-29 · Obligations** (`graphRunObligation`, one key per run, target = the run's
environment for admission and environment wakes).

| Obligation | Run | Next pass | Provider slot |
| --- | --- | --- | --- |
| `provision` | `provisioning` | 1 s | no |
| `cancel` | `cancelling` | 1 s | yes |
| `observe` | an activation `admitting` or `running` (also while `paused`) | 3 s + stable spread (203); 1 s while admitting | yes |
| `advance` | `running`/`waiting` with ready work or positions still to plan | 1 s, or 3 s while blocked; woken on a lock release (203) | yes |
| `await-human` | only `awaiting-human` activations admitted | 30 s safety | no |

`paused` with nothing admitted, and every terminal status, owe nothing (key dropped; resume wakes).
The delay after a pass comes from the pass itself (`GraphRunMemory.nextDelayMs`).

**2026-10-29 · Wakes.** The existing `WORKFLOW_WAKE_REASONS` only. `result-accepted` is mapped
precisely: `GraphRunResultKeys` indexes `session.resultKeys` of every admitted activation (noted
after every pass, read and discovery) to `{runId, activationKey}`; `index.ts`'s
`workflowResults.onAccepted` calls `graphRuns.resultAccepted(event)`, which flags that activation
for observation and wakes only its run. A key the index lacks (recorded by another process) is
looked up in the environment's stored runs (`listGraphRuns`); a slot no run owns wakes nothing.
`wakeEnvironment(env, "result-accepted")` is ignored by the graph owner (the other owners keep
their environment wake). `provider-transition` and `environment-change` wake the environment's
runs. `requestObservation(runId, activationKey)` flags and wakes (208: an answer arrived).

**2026-10-29 · Recovery.** No renderer is involved: `init()` starts the supervisor, whose first
discovery (`listAllGraphRuns`) registers every run with an obligation, seeds the result-key index
and (once; 203) the workspace lock table from stored admitted activations. Until that first discovery
completes, no activation that reads or writes a workspace is admitted (`recovering`). Each run's
first pass in a process hands every admitted activation to its executor's `recover` (or `start`
for `admitting`, `observe` otherwise) exactly once; `admitting` activations are always restarted
idempotently until they report.

**2026-10-29 · Rollback.** `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=graph-run` (or `all`) disables
the domain: there is no previous driver. `GraphRunService.enabled` is false, no supervisor runs,
`create` throws `GraphRunServiceError` code `disabled`; stored runs stay readable, and `cancel`
still stops one (it runs the pass inline). The desktop already passes the variable through.

**2026-10-29 · Cross-process safety (decision).** Graph runs have no controller lease (Multi
Review's). Every save is revision compare-and-swap; a pass that loses a conflict ends and the next
starts from the stored record. `admitting` is saved before any executor `start`, and starts must be
idempotent per activation key (204's dispatch journal), so a lost save or a second process cannot
send a turn twice.

**2026-10-29 · Service API** (`GraphRunService`, `graph-run-service.ts`).
`create(launch: GraphRunLaunch)` with `{id?, projectId, environmentId?, template, plan, roles,
params?, inputs?: Record<name, value>, mock?}`: checks inputs against the plan (value types only;
reference inputs are refused until a launch surface needs them), roles of every agent node and
branch, fills parameter defaults, creates the run (`running`, or `provisioning` without an
environment), stores inputs as `$input` artifacts, wakes it. A refused input ends the run `failed`
and throws `invalid-launch`. `get`, `list(environmentId)`, `cancel`, `pause`, `resume`,
`advanceNow` (a locked pass now), `wake`, `requestObservation`, `resultAccepted`, `passStats`,
`executors` (registry), `init`, `shutdown`; `wakeEnvironment`, `schedulingStatus`,
`reconcileScheduling`. Errors: `GraphRunServiceError` codes `disabled`, `invalid-launch`,
`not-found`, `invalid-state`. Options: `artifacts` (required), `executors`, `provisioner`
(`GraphRunProvisioner.provision(run, signal)` → pending | ready with environmentId | failed; none
configured fails a provisioning run), `concurrency`, `observationIntervalMs`,
`progressIntervalMs`, `autoAdvance`, `clock`, plus the keyed options.

**2026-10-29 · For later items.**
- 204: result keys must be unique across runs (the index maps keys globally; include the run id),
  reported in `session.resultKeys` with the start report; `policy` and `enforcement` before
  `session`.
- 208: call `requestObservation` when an answer is stored; human executors return
  `observeAfterMs: null`.
- 211: subscribe to `graph-run` (id = run id); read with `graphRuns.get`.
- 214: `GraphRunLaunch` above; register a `provisioner` for runs that create their environment; a
  run that fails before it has an environment is not removed by environment deletion.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · `graph-run` keyed domain, obligations, result-slot wakes, discovery and restart recovery, run service and executor contract; tests. · complete; awaiting PR
