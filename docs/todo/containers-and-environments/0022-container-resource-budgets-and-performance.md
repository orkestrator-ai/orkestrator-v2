# Container resource budgets and performance

Checked against `main` at `2459b05c` (2026-10-15).

Per-environment CPU, memory and PID budgets exist but are opt-in. No default
ships, because a default must come from measured browser, build and provider
workloads, which the synthetic benchmarks do not exercise. The benchmark pass
also deferred or rejected several optimisations, each with a reason. This file
holds the default-budget decision and those candidates; revisit each only with
measurements against the regression targets.

## Current state

- `resolveResourceLimits` (`apps/backend/src/core/container-resources.ts`)
  resolves the environment override, then `global.containerResourceLimits`
  (Settings → Container), then `UNRESTRICTED_LIMITS`
  (`packages/protocol/src/container-resources.ts`). The axes are `cpus`,
  `memoryMiB` (swap pinned equal, so no swap) and `pids`. Applied values are
  read back from `docker inspect`, with the axes the daemon cannot enforce
  reported as unsupported.
- `/dev/shm` is `DEFAULT_SHARED_MEMORY_MIB` (1 GiB), or half the memory limit
  when that is smaller (`sharedMemoryMiB`), because shared memory is charged
  to the limit.
- `sampleContainerUsage` is the one shared sampler: owner-filtered
  `docker ps`, one `docker stats --no-stream` and one `docker inspect` per
  sample whatever the container count, deduplicated within 5 s, stale after
  `USAGE_STALE_MS` (15 s), capped at 128 containers. Capacity comes from
  `docker info` (cached 60 s), disk from `docker system df` (cached 5 min).
- `container-admission.ts` runs at most four starts and two preserving copies
  at once; `container-oom-events.ts` follows Docker `oom` events.
- Logs: `ContainerLogService`, Docker's `local` driver at 10 MiB × 3 for new
  runtimes, and `orkestrator-log-writer` at 5 MiB × 3 per bridge or server
  file. Per-environment diagnostic bytes are implied by those per-file bounds
  (six launches × 15 MiB), not tracked.
- The copy verifier hashes the source once per tar member, through
  `tar --to-command` running `sha256sum` (`copy_stream` in
  `docker/orkestrator-migrate.sh`). The destination side already batches 256
  files per `sha256sum` (`verify`).
- `docker/Dockerfile` has no BuildKit `--mount=type=cache`.
- Restricted boots read GitHub's ranges from a backend seed
  (`github-ranges-cache.ts`), which took a benchmark run from 17 GitHub API
  calls to 1.
- The harness is `apps/backend/tests/container-benchmarks.test.ts`, run with
  `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test apps/backend/tests/container-benchmarks.test.ts`.
  It writes JSON under `output/benchmarks/` and removes its own reports older
  than 30 days. The regression targets, set on Linux Engine amd64, are in
  [container-qualification.md](../../development/container-qualification.md)
  ("Benchmarks"); the harness does not assert them, so the report is compared
  by hand. A change that misses a target is fixed or recorded with its reason
  before it merges.

## Outstanding work

### Code

1. Choose and apply a default budget once the workloads below are measured.
   Apply it only to new runtimes; existing containers keep their observed
   policy until an intentional update or rebuild. Record the chosen values
   with their headroom rationale in `container-lifecycle.md` "Resource budgets
   and usage". Report unsupported enforcement (rootless, Desktop) instead of
   claiming it.

### Qualification

- Measure realistic workloads with and without the experiment budget of 2
  CPUs, 4 GiB and 1,024 PIDs (1 GiB shared memory): browser and Chromium
  pages (shared-memory pressure), builds (`bun install`, Turbo), and provider
  turns. Measure on Linux Engine and on Docker Desktop, where the VM's
  capacity is the ceiling.
- Benchmark numbers for Docker Desktop and arm64 against the regression
  targets. UI response under multi-environment load and real provider and
  bridge authentication paths are not measured either.

### Deferred until measured

- An in-process tar hasher to replace per-member `sha256sum` on the source
  side. At about 2.8 ms per file it is now the largest copy cost. It needs
  its own safety review, and the same corruption, symlink-root and Git checks
  must still pass.
- Bun download-cache BuildKit mounts in `docker/Dockerfile`, if image build
  time matters.
- Environment-private dependency cache volumes, only if downloads dominate.
  Key them by architecture, runtime and package-manager compatibility, and
  define eviction and ownership. Sharing across environments needs its own
  cache-poisoning and concurrency analysis.
- Faster usage samples. About 2 s is `docker stats --no-stream`'s own CPU
  sampling interval; samples are shared and the visible refresh is 5 s.
- Aggregate per-environment diagnostic byte accounting.

### Rejected for now

Revisit only if measurements change.

- Reusing verified input revisions. Staging sits inside the create step and is
  not a dominant phase. If it is revisited, revocation must bypass the cache,
  and size or time alone is not proof that secret or configuration contents
  are unchanged.
- A Docker events watcher for status sampling. The sampler costs three calls
  per sample regardless of environment count, and the 3 s status cache
  already batches `docker ps`. Events would only ever be hints: a full owned
  snapshot after every gap, with periodic reconciliation kept as the repair
  path.
- A snapshot or reflink copy fast path. It is not portable across Engine and
  Desktop storage drivers, and the verified streaming copy is the contract.

## Constraints and rationale

- No unbounded memory, disk or follower growth, and no daemon-wide work: the
  sampler is owner-filtered and nothing prunes.
- Never weaken the separate-candidate-copy guarantee. Running setup against
  the only source volume is not an acceptable shortcut.
- No telemetry of paths, hashes, file contents, commands or prompts;
  benchmark artifacts carry none.
- The regression targets are the merge gate.
- Unknown figures are `null`, never zero. Desktop capacity is the VM's from
  `docker info`, never the backend host's `os.totalmem()`.
- Never lower memory on a live container near its current use without the
  user's confirmation (`allowBelowUsage`).
- Never clear a user's global Docker or cache state to manufacture a cold
  run.
- Rolling back an optimisation must leave the storage and lifecycle contract
  intact.

## Open questions

- Which reference host should the regression targets use once Desktop numbers
  exist: per-platform targets, or one reference with a tolerance?
- Should a default budget be a fixed preset or a fraction of the daemon's
  capacity?

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Desktop and arm64 runs, registry pull time),
  [0020-container-state-observation.md](0020-container-state-observation.md) (per-container
  `docker exec` polling), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md).
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks).
- [Container lifecycle](../../architecture/container-lifecycle.md): "Resource
  budgets and usage" and "Bounded logs".

## Replaces

- `docs/improvements/containers/plan/10-resource-budgets-and-usage-telemetry.md`
  (default budget decision)
- `docs/improvements/containers/plan/11-bounded-logs-and-diagnostic-subscriptions.md`
  (aggregate diagnostic accounting)
- `docs/improvements/containers/plan/12-image-build-and-release-delivery.md`
  (Bun cache mounts)
- `docs/improvements/containers/plan/13-performance-baselines-and-targeted-optimization.md`
  (deferred and rejected candidates and their conditions)
- `docs/improvements/containers/benchmarks.md` (decision table and "Not
  measured here"; the targets moved to
  `docs/development/container-qualification.md`, the one-off baseline numbers
  were dropped)
- `docs/improvements/containers/plan/00-index.md` (measured default resource
  profile gate)
- `docs/improvements/containers.md` (findings 7–9, superseded by #877)
