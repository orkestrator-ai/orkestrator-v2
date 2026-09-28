# 10 — Resource budgets and usage telemetry

Status: Implemented on branch; awaiting review. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[03](03-image-contracts-and-daemon-preflight.md),
[04](04-runtime-readiness-and-graceful-shutdown.md).
Return to [index](00-index.md).

## Goal

Bound each environment's resource use and show actual Docker measurements with
explicit scope, freshness and uncertainty. Host/VM capacity, installation totals
and individual container usage must not be presented as interchangeable values.

## Integration points

- [Container creation](../../../../apps/backend/src/core/commands-containers.ts),
  [Docker statistics commands](../../../../apps/backend/src/core/commands-registry-docker.ts),
  [process usage](../../../../apps/backend/src/core/environment-process-usage.ts).
- [Backend models](../../../../apps/backend/src/core/models.ts),
  [global config](../../../../apps/backend/src/core/storage-config.ts),
  [web types](../../../../apps/web/src/types/index.ts),
  [Docker client](../../../../apps/web/src/lib/backend/docker-skills.ts).
- [DockerStatsDialog](../../../../apps/web/src/components/docker/DockerStatsDialog.tsx)
  and [format helpers](../../../../apps/web/src/components/docker/docker-stats-format.ts).

## Proposed contracts

`ContainerResourcePolicy` should include CPU quota, memory limit/reservation,
swap behavior, PID limit and shared-memory size, with inheritance source and
policy revision. Validate units as integers/finite numbers and bound each field.
Represent explicit unrestricted settings separately from missing values.

`ContainerUsageSnapshot` should contain immutable runtime identity, sampled
time, scope, CPU cores used, memory usage/limit, PID count, OOM/exit status and
optional storage measurements. Unknown values are nullable with a reason;
missing observations are not zero. Include expected/applied policy revisions.

## Implementation tasks

### Budgets and admission

- [ ] Introduce global defaults plus per-environment overrides. Existing
  containers keep their observed policy until an intentional update/rebuild;
  do not unexpectedly reduce limits on active workloads during upgrade.
- [ ] Benchmark candidate presets before shipping defaults. Initial experiment:
  2 CPU cores, 4 GiB memory, 1,024 PIDs and the existing 1 GiB shared-memory mount
  versus current behavior. These are test inputs, not validated product defaults.
- [ ] Measure browser/build/provider workloads and choose defaults with headroom.
  Shared-memory capacity is not preallocated RAM, but pages used there count
  toward memory pressure. Do not set incompatible memory/shared-memory values.
- [ ] Make swap policy explicit and test its interpretation; do not disable
  the OOM killer or hide OOM events to make a small limit appear successful.
- [ ] Query actual daemon/VM capacity and kernel support. Report unavailable
  enforcement in rootless/unsupported configurations rather than claiming the
  requested budget was applied.
- [ ] Add backend admission limits for concurrent expensive container starts,
  migrations and telemetry subprocesses. Keep these separate from the existing
  repository test scheduler, which is not a global container resource manager.
- [ ] Enforce hard limits in the Docker specification and inspect applied
  values afterward. A failed update cannot advance the stored applied revision.
- [ ] Apply safe live-updatable fields only through the lifecycle service.
  Changes requiring replacement, including shared-memory configuration where
  necessary, use step 06. Avoid lowering memory beneath observed use without a
  clear user-visible consequence and deliberate operation.

### Sampling and presentation

- [ ] Implement one backend sampler for owned active containers, using bounded
  batch stats/inspect calls. Deduplicate callers and cap concurrency. Stop high
  frequency sampling when no consumer needs it, without stopping workloads.
- [ ] Start with a proposed 5-second visible refresh, 30-second background
  refresh and 15-second visible staleness threshold; tune from step 13 results.
  Every subprocess has a deadline and output cap. Store only a bounded recent
  snapshot/ring, not unbounded time series.
- [ ] Express CPU as cores used or clearly label percentage normalization.
  Docker CPU percentages can exceed 100%; do not clamp them and imply one whole
  daemon is only one core. Keep UI denominator and backend calculation aligned.
- [ ] Use daemon totals for daemon capacity and owner-filtered sums for
  installation usage. Never label `os.totalmem()` on the backend host as Desktop
  VM capacity. If Docker cannot provide disk capacity, show unknown.
- [ ] Measure disk less frequently and distinguish image shared layers,
  per-container writable layers and named-volume data. Do not sum shared image
  bytes once per container. Avoid recursive workspace scans on each UI poll.
- [ ] Capture `.State.OOMKilled`, exit code and relevant events, while noting
  that a child killed by memory pressure need not make container PID 1 exit.
  Preserve provider/bridge failures when Docker cannot confirm an OOM cause.
- [ ] Replace placeholder zero values and creation timestamps in the existing
  command adapters. Use a versioned/additive contract for old clients rather
  than changing a non-null number to null without handling consumers.

## Verification and exit criteria

- [ ] Parser tests cover invalid units, overflow, missing limits, swap edge
  cases, cumulative CPU counters, counter resets and stale snapshots.
- [ ] Real Docker tests confirm limits via inspect and bounded stress fixtures:
  CPU quota, PID exhaustion, memory pressure and multi-process/browser behavior.
- [ ] Verify two environments remain usable when one reaches its limit. Record
  measurements; do not intentionally exhaust the user's host or Desktop VM.
- [ ] UI tests cover multi-core CPU, unknown disk capacity, stale/disconnected
  samples, OOM evidence and configured-versus-applied policy differences.
- [ ] Switch away and back to a stressed environment; status and controls must
  rehydrate even if all telemetry events were missed.

Deliver truthful unknown-state UI before adding the sampler. Rollback disables
sampling or new policy application without inventing zero usage or removing
persisted requested limits. Exit when budgets are measured, applied values are
verified and all displayed usage has an honest scope and freshness indicator.

## Implementation record

- **Contracts.** `packages/protocol/src/container-resources.ts`: limits with
  explicit `null` for unrestricted and bounded validation, policy view
  (requested, source, applied, unsupported), daemon capacity with support flags
  and disk by kind, and installation-scoped usage samples with nullable values.
- **Backend.** `container-resources.ts`: resolution (environment → global →
  none), Docker arguments (swap pinned to memory), applied read-back, capacity
  (`docker info`, `docker system df`), the shared bounded sampler (OOM and exit
  status included) and live update through the lifecycle service.
  `createDockerContainer` applies the resolved budget. Commands:
  `get_environment_resources`, `update_environment_resources`,
  `set_container_resource_limits`, `get_docker_capacity`, `get_container_usage`;
  `get_docker_system_stats` and `get_orkestrator_containers` now report daemon
  capacity, installation usage, real CPU/memory per container, OOM evidence and
  creation time instead of host values and placeholders.
- **UI.** Settings → Container replaces the never-applied sliders with an
  opt-in "Limit resources of new containers" budget. Environment settings show
  requested/applied/in-use side by side and set an override, applying now or at
  the next rebuild. The Docker dialog labels scope and freshness, shows cores,
  unknown disk, per-container memory and out-of-memory exits.
- **Decisions.** No default budget ships: 2 cores / 4 GiB / 1,024 PIDs remain
  experiment inputs until step 13 measures workloads. Shared memory stays at
  the existing 1 GiB. A memory limit is not lowered on a live container close to
  its current use without confirmation.
- **Tests.** `tests/unit/electron/container-resources.test.ts` (validation,
  resolution, arguments, applied read-back incl. `<nil>`, memory units,
  unclamped multi-core CPU, unknown values, daemon capacity and rootless, disk
  kinds, sampler deduplication, owner scoping and daemon-unavailable);
  `EnvironmentResourcesSection.test.tsx`, updated `GlobalSettings.test.tsx`.
  Live (Engine 29.7.2): C24 — limits applied and read back; PID exhaustion
  refused new processes (including `docker exec`) and the container recovered
  once they exited; an allocating process was OOM-killed while PID 1 kept
  running; the sampler reported the memory limit and CPU; a live update was
  applied and read back.
- **Limitations.** Backend admission limits for concurrent expensive starts and
  migrations are not added (the lifecycle queue serializes per environment
  only). Two-environment contention under CPU stress and Docker Desktop/rootless
  enforcement were not exercised on this host.

## Audit follow-up (2026-09-27)

An item-by-item audit of this step's checklist against the code found gaps
the record above did not state. They were closed and are tracked with their
evidence in [remaining-work.md](../remaining-work.md) (items 16, 18, 19, 20, 21, 38);
what could not be done on this host is listed there as environment-limited.
