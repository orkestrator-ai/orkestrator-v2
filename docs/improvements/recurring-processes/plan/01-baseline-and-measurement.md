# 01 — Establish cost and freshness baselines

Status: Partially complete — instrumentation, diagnostics, the deterministic
call-count baseline, latency budgets and trial limits landed (`666a0a76`); the
live isolated freshness/CPU profile (tasks 6–7 busy scenarios and freshness)
is outstanding. Dependencies: none. Supports all later steps.

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

## Completion notes

Landed in `666a0a76` (`feat(backend): add recurring work metrics,
instrumentation and baseline harness`); the artifact and method are in
[`../baseline/`](../baseline/README.md).

**What landed**

- Vocabulary (`packages/protocol/src/recurring-work.ts`, export
  `@orkestrator/protocol/recurring-work`): 53 job kinds covering the backend,
  renderer, bridge and desktop families of the inventory, each with owner,
  trigger, priority class, nominal cadence, in-flight policy, recovery contract
  and inventory IDs; finite work units and error categories; the content-free
  snapshot schema. 29 backend kinds are recorded today (`instrumented`).
- Recorder (`apps/backend/src/core/recurring-work-metrics.ts`):
  `RecurringWorkMetrics` and the process-wide `recurringWorkMetrics`. Per kind:
  requested/coalesced/started/completed/failed/rejected, changed/unchanged,
  cache hits/misses, bytes, work units, duration and queue-delay histograms,
  active attempts with worst age, last success/failure age. Labels outside the
  vocabulary are counted in `droppedLabels` and never retained. Physical work is
  charged to the innermost observed job through `AsyncLocalStorage`, so a nested
  hop is counted once. `observe()` returns the observed promise itself and never
  alters its result; recorder faults are counted, not thrown. Enabled by default
  like gateway metrics; `ORKESTRATOR_RECURRING_METRICS=0` is the rollback.
- Physical boundaries: `runCommandBytes` (every `runCommand` spawn, classified
  git/gh/docker exec/docker CLI/tmux/other), storage `loadJson`/cached stat hit/
  `writeAtomic`, `bridgeFetch`, `buildFileTree` readdir, untracked line counts.
- Owners observed (no cadence change): diff scans, Files-panel list/tree reads
  (`readSharedFileList` extracted unchanged from the two status commands), local
  fetch scheduling, container fetch attempts, PR detection and check rollups,
  native activity/launch/queue/interaction sweeps, Claude state polls and
  reconcile, tmux queue drain, mail presence/injection, pending renames,
  coordinator repair, mail retention, activity lease expiry, tab cleanup,
  build/looped/multi/feature-planning ticks (records scanned/selected), lease
  renewals, system and process usage.
- Diagnostics: `get_recurring_work_diagnostics` command and an additive
  `recurringWork` block on the gateway `/api/metrics` route.
- Harness: `apps/backend/scripts/recurring-baseline.ts` (+ `-harness.ts`),
  deterministic, with `--compare <artifact> [--fail-on-change]` for step 12.

**Measured baseline** (10 min warm idle, deterministic call counts; full table
in the baseline README): one open Files panel adds ~57 `git` spawns and 480
`readdir` per minute for a local environment because the 3 s shared cache
served 5 of 120 reads, and a second client doubles it; container state polls
are one `docker exec` per container per second and dominate container idle
cost; every PR entry, terminal or not, is checked every 20 s; workflow ticks
enumerate every completed record (200 per store → 80,000–120,000 record scans
per 10 min) while doing no work; local fetching is already one fetch per 5 min
per repository. Recorder overhead: 660 ns per observed attempt enabled, 92 ns
disabled, on a heavily loaded host.

**Checks run**: focused suites via `mise run test:logged`
(`recurring-work-metrics`, `recurring-baseline`, protocol `recurring-work`,
and every instrumented owner's existing tests: diff stats, fetch scheduler, PR
monitor, worktree watcher, tmux poll, system usage, agent mail, prompt queue
drainer, build supervisor, looped/multi review, feature planning, native
reconciliation, index boot, file commands) — all pass; `mise run check` passes.
Final `mise run test:changed` at `14f4bd0f`: workspace (including the whole
backend package), bridges and protocol groups pass; the root group had one
timeout (`commands-registry-environments.test.ts` "persists safe cleanup failure
details and permits a backend deletion retry", 7.3 s) under a host load average
of 33–39 from concurrent worktrees. Earlier runs showed the same pattern: every
failure was a 5–10 s timeout, and each owning file passed alone except two
(`coordinator-service.test.ts` "bound discard confirmations",
`commands-io-coverage.test.ts` "reports the HEAD and uncommitted paths"), which
time out identically with the base commit's sources on the same host. No flake
index entry was added: the evidence points at host saturation, not a test.

**Not done / untested constraints**

- Tasks 6–7 busy scenarios and freshness: continuous/burst edits, long Git
  reads, active turn, pending approval, queued prompt, workflow completion,
  outage and client resume, and change-to-visible p50/p95 were not measured.
  The README describes the live isolated `dev:test` profile that must run
  before step 12 claims savings; budgets are written down but unverified.
- Native sweep, queues, mail, coordinator and workflow supervisors are modelled
  from cadence in the harness, not driven; their provider/storage cost per pass
  needs the live profile (the recorder captures it in production).
- OpenCode SDK requests bypass `bridgeFetch` and are not counted as
  `provider-request`; direct `fs` reads outside `loadJson` (e.g. draft buffers,
  kanban images) are not counted as storage reads.
- Renderer and bridge kinds are catalogued but not recorded (steps 06/09/10).
- Real CPU/RSS enabled-vs-disabled comparison of a running backend was not
  measured; only the recorder microbenchmark was.
