# 01 — Establish cost and freshness baselines

Status: Not started. Dependencies: none. Supports all later steps.

## Outcome

An implementation should be able to answer which recurring work dominates idle
cost, which consumers duplicate reads, and what latency the current system
delivers. Produce repeatable measurements before selecting final intervals.

## Existing sources and implementation targets

- Backend entry/service owners from [the inventory](../../../imrovements/recurring-processes.md).
- `apps/backend/src/gateway-support-core.ts` and existing gateway metrics.
- `packages/protocol/src/bridge-diagnostics.ts` and existing bounded diagnostics.
- `apps/backend/src/core/commands-runtime-state.ts`, `commands-files.ts`,
  `commands-pr-monitor.ts`, and native/workflow service boundaries.
- `apps/web/src/lib/native/web-gateway.ts` and representative client hooks.
- Existing isolated fixture and test-admission machinery; do not build a second
  production profiling service.

## Implementation tasks

1. Define a fixed enumeration of job kinds matching the report's process
   families. Record owner process, trigger reason, priority class, nominal
   cadence, current in-flight policy, and current recovery contract. Keep a
   distinction between scheduled attempt, command invocation and actual physical
   work; one refresh can issue several commands, and one command can hit cache.
2. Add optional aggregate counters at actual expensive boundaries: Git/gh spawn,
   Docker exec, directory walk, provider request, transcript serialization,
   workflow enumeration/validation, storage read/parse/write and retained buffer
   size. Reuse existing observations instead of double-counting the same hop.
3. For each kind collect requested/coalesced/started/completed/failed, duration,
   queue delay, bytes, cache hit/miss, changed/unchanged and age of last successful
   observation. Use finite labels. Do not use environment IDs, paths, branch
   names, URLs, prompts, stdout or request arguments as metric dimensions.
4. Add a bounded diagnostic summary of active job counts and worst ages. Keep
   raw events optional and bounded; report aggregate counts by kind. Ensure a
   metrics failure cannot reject the work it observes.
5. Create a reproducible fixture workload with 1, 10 and 50 environments;
   local/container mixes; 0, 1 and 2 clients; zero and many completed workflow
   records; one long transcript; no PR/open PR/terminal PR mixes. Live external
   calls need only a small representative run; deterministic provider/gh seams
   should cover the large-count scalability matrix without API spam.
6. Sample warm idle for at least five minutes to include local fetch/resource
   manifest periods. Record startup separately. Exercise continuous file edits,
   burst saves, long Git reads, one active turn, pending approval, queued prompt,
   workflow completion, network outage and client resume.
7. Record freshness from authoritative change time to visible state, separating
   watcher/scheduler/provider/network/render delay where observable. Measure
   pending approval, cancellation, completion, file list, diff badge and PR
   transition p50/p95, plus worst recovery time after a deliberately missed hint.
8. Publish a baseline artifact containing commit, platform/runtime, fixture size,
   duration, flags, measurement overhead and limitations. Avoid storing user
   content. Repeat runs sufficiently to distinguish noise from a meaningful
   change; choose the repeat count based on variability.

## Acceptance criteria

- Idle and busy cost can be attributed by job kind and owning process.
- The report distinguishes small network responses from reduced backend work.
- Opening a second client quantifies marginal reads/spawns, rather than assuming
  every poll doubles physical cost.
- Instrumentation uses bounded memory and does not materially change measured
  cadence; its enabled/disabled overhead is recorded.
- Latency budgets and trial concurrency limits are written down before later
  steps reduce freshness. Do not invent a percentage savings claim in advance.

## Tests and checks

Test label allowlisting, bounds, counter accounting, concurrent operations, and
observer exceptions. Use synthetic strings resembling secrets as inputs and
assert that diagnostics contain no content fields. Verify no reads/spawns are
performed merely to collect metrics. Run representative tests through the
logged runner; performance artifacts should contain aggregate metrics only.

## Delivery and rollback

Ship diagnostics disabled or low-overhead by default according to existing
conventions. The first review unit changes observation only, with no cadence
changes. Rollback disables instrumentation; domain behavior remains identical.
Carry the baseline script/fixture forward to step 12 rather than recreating it.
